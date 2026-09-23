// worker/play-proxy.js — Cloudflare Workers port of src/routes/stream.js /play
//
// Same contract: GET /play?url=<http(s)> &ref=<referer> &origin=<origin>
// - forwards Referer + Origin + Range + Chrome UA upstream
// - rewrites every URL in HLS playlists to stay on this Worker
// - detects playlists by CONTENT (#EXTM3U), not Content-Type (CDNs lie)
// - CORS * for browser playback, Cache API for playlists + small segments
//
// No Node APIs — pure Web Standards (fetch, Request, Response, caches).

const STREAM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const PLAYLIST_MAX_BYTES = 4 * 1024 * 1024;
const PLAYLIST_TTL_S = 300; // 5 min — tokens renew hourly
const SEGMENT_TTL_S = 300;

// ---- hotlink protection ----
// Signed URLs (minted by /sources and /sign, HMAC-SHA256 over
// url\nref\norigin\nexp) prove the request came from our players.
// REQUIRE_SIGNED=1 -> reject unsigned/invalid (403). Default 0 -> warn
// mode (X-Sig-Status header, still served) for rollout.
const SIG_SKEW_S = 300;
function hexToBytes(hex) {
  const h = String(hex || '').trim();
  if (!/^[0-9a-fA-F]+$/.test(h) || h.length % 2) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
async function sigStatus(env, target, referer, origin, exp, sig) {
  if (!env.PLAY_SIGNING_KEY) return 'no-key';
  if (!exp || !sig) return 'missing';
  const now = Math.floor(Date.now() / 1000);
  if (!/^\d+$/.test(exp) || Number(exp) < now - SIG_SKEW_S) return 'expired';
  const msg = `${target}\n${referer || ''}\n${origin || ''}\n${exp}`;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(env.PLAY_SIGNING_KEY),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sigBytes = hexToBytes(sig);
    if (!sigBytes || sigBytes.length !== 32) return 'bad-sig';
    const ok = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(msg));
    return ok ? 'ok' : 'bad-sig';
  } catch {
    return 'bad-sig';
  }
}

// ---- per-IP rate cap (best-effort, per-isolate): 4000 req / 10 min.
// A 2h movie is ~800-1200 requests; this allows 3 concurrent streams with
// headroom while stopping bulk leeching. Exceed -> 429.
const RATE_MAX = 4000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const rateBuckets = new Map(); // ip -> { count, reset }
function rateLimited(ip) {
  const now = Date.now();
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (v.reset < now) rateBuckets.delete(k);
  }
  let b = rateBuckets.get(ip);
  if (!b || b.reset < now) {
    b = { count: 0, reset: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, b);
  }
  b.count++;
  return b.count > RATE_MAX;
}

function looksLikePlaylistBytes(buf) {
  if (!buf || !buf.length) return false;
  let s = new TextDecoder().decode(buf.subarray(0, 512));
  s = s.replace(/^\uFEFF/, '').trimStart();
  return s.startsWith('#EXTM3U');
}

// Rewrite every media URL in a playlist to ride this Worker.
// workerOrigin = e.g. https://flixerz-play.xxx.workers.dev
// auth = { exp, sig } inherited from the parent request so child segment
// fetches pass signature enforcement too (same 2h window).
function rewritePlaylist(text, playlistUrl, referer, origin, workerOrigin, auth = null) {
  const toPlay = (u) => {
    try {
      const abs = new URL(u, playlistUrl).href;
      const params = new URLSearchParams({ ref: referer });
      if (origin) params.set('origin', origin);
      params.set('url', abs);
      if (auth && auth.exp && auth.sig) {
        params.set('exp', auth.exp);
        params.set('sig', auth.sig);
      }
      return `${workerOrigin}/play?${params.toString()}`;
    } catch {
      return null;
    }
  };
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        if (/URI="/i.test(t)) {
          return line.replace(/URI="([^"]+)"/g, (m, u) => {
            const r = toPlay(u);
            return r ? `URI="${r}"` : m;
          });
        }
        return line;
      }
      return toPlay(t) || line;
    })
    .join('\n');
}

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type',
    ...extra,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, proxy: 'flixerz-play' }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders({
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Max-Age': '86400',
        }),
      });
    }

    if (url.pathname !== '/play') {
      return new Response(JSON.stringify({ error: 'use /play?url=...' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    const target = url.searchParams.get('url');
    const referer = url.searchParams.get('ref') || 'https://peachify.top/';
    const origin = url.searchParams.get('origin') || '';
    const exp = url.searchParams.get('exp') || '';
    const sig = url.searchParams.get('sig') || '';
    if (!target) {
      return new Response(JSON.stringify({ error: 'url query parameter is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }
    if (!/^https?:\/\//i.test(target)) {
      return new Response(JSON.stringify({ error: 'Invalid url' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    // Rate cap first (cheapest), then signature.
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (rateLimited(ip)) {
      return new Response(JSON.stringify({ error: 'Rate limited — slow down' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }
    const sigState = await sigStatus(env, target, url.searchParams.get('ref') || '', origin, exp, sig);
    if (env.REQUIRE_SIGNED === '1' && sigState !== 'ok') {
      return new Response(JSON.stringify({ error: `Forbidden (${sigState})` }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }
    // Rollout observability: every served response carries the verdict.
    const mark = (res) => {
      try {
        res.headers.set('X-Sig-Status', sigState);
      } catch {}
      return res;
    };
    const childAuth = exp && sig ? { exp, sig } : null;

    const cache = caches.default;
    const range = request.headers.get('Range');

    try {
      // 1. Cache hit — playlists + small segments (GET without Range only).
      // Range requests are unique per seek position; never cache those.
      if (request.method === 'GET' && !range) {
        const hit = await cache.match(request);
        if (hit) return hit;
      }

      const upstream = await fetch(target, {
        headers: {
          Referer: referer,
          'User-Agent': STREAM_UA,
          ...(origin ? { Origin: origin } : {}),
          ...(range ? { Range: range } : {}),
        },
        // follow redirects (CDNs 302 to signed hosts)
        redirect: 'follow',
      });

      if (!upstream.ok && upstream.status !== 206) {
        return new Response(JSON.stringify({ error: `Upstream ${upstream.status}` }), {
          status: upstream.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
      }

      const ct = upstream.headers.get('content-type') || 'application/octet-stream';
      const workerOrigin = url.origin;
      const baseHeaders = corsHeaders({ 'Cache-Control': 'no-store' });

      // 2a. Header says playlist — rewrite, cache, serve.
      if (ct.includes('mpegurl') || ct.includes('m3u8')) {
        const text = await upstream.text();
        const rewritten = rewritePlaylist(text, target, referer, origin, workerOrigin, childAuth);
        const res = mark(
          new Response(rewritten, {
            headers: corsHeaders({
              'Content-Type': 'application/vnd.apple.mpegurl',
              'Cache-Control': `public, max-age=${PLAYLIST_TTL_S}`,
            }),
          })
        );
        if (request.method === 'GET') {
          // caches.default requires a cloned request/response pair; fire-and-forget
          try {
            await cache.put(request, res.clone());
          } catch {}
        }
        return res;
      }

      // 2b. Range request for bytes (mp4/segments) — stream straight through,
      // never buffer (movies are GBs; Workers memory is 128MB).
      const cl = upstream.headers.get('content-length');
      const clNum = cl ? Number(cl) : NaN;
      if (range || (Number.isFinite(clNum) && clNum > PLAYLIST_MAX_BYTES)) {
        const headers = new Headers(baseHeaders);
        headers.set('Content-Type', ct);
        if (cl) headers.set('Content-Length', cl);
        const cr = upstream.headers.get('content-range');
        if (cr) headers.set('Content-Range', cr);
        return mark(new Response(upstream.body, { status: upstream.status, headers }));
      }

      // 2c. Ambiguous small body — header lies sometimes (text/html masters
      // with relative paths). Buffer (bounded) and sniff for #EXTM3U.
      const buf = new Uint8Array(await upstream.arrayBuffer());
      if (buf.length <= PLAYLIST_MAX_BYTES && looksLikePlaylistBytes(buf)) {
        const rewritten = rewritePlaylist(
          new TextDecoder().decode(buf),
          target,
          referer,
          origin,
          workerOrigin,
          childAuth
        );
        const res = new Response(rewritten, {
          headers: corsHeaders({
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': `public, max-age=${PLAYLIST_TTL_S}`,
          }),
        });
        mark(res);
        if (request.method === 'GET') {
          try {
            await cache.put(request, res.clone());
          } catch {}
        }
        return res;
      }

      // 2d. Plain segment / subtitle / key — pass through + cache small ones.
      const headers = new Headers(baseHeaders);
      headers.set('Content-Type', ct);
      headers.set('Content-Length', String(buf.length));
      if (buf.length <= PLAYLIST_MAX_BYTES) {
        headers.set('Cache-Control', `public, max-age=${SEGMENT_TTL_S}`);
      }
      const res = mark(new Response(buf, { status: upstream.status, headers }));
      if (request.method === 'GET' && buf.length <= PLAYLIST_MAX_BYTES && buf.length > 0) {
        try {
          await cache.put(request, res.clone());
        } catch {}
      }
      return res;
    } catch (e) {
      return new Response(JSON.stringify({ error: `Proxy error: ${e.message}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }
  },
};
