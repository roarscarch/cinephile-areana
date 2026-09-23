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

function looksLikePlaylistBytes(buf) {
  if (!buf || !buf.length) return false;
  let s = new TextDecoder().decode(buf.subarray(0, 512));
  s = s.replace(/^\uFEFF/, '').trimStart();
  return s.startsWith('#EXTM3U');
}

// Rewrite every media URL in a playlist to ride this Worker.
// workerOrigin = e.g. https://flixerz-play.xxx.workers.dev
function rewritePlaylist(text, playlistUrl, referer, origin, workerOrigin) {
  const toPlay = (u) => {
    try {
      const abs = new URL(u, playlistUrl).href;
      const params = new URLSearchParams({ ref: referer });
      if (origin) params.set('origin', origin);
      params.set('url', abs);
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
        const rewritten = rewritePlaylist(text, target, referer, origin, workerOrigin);
        const res = new Response(rewritten, {
          headers: corsHeaders({
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': `public, max-age=${PLAYLIST_TTL_S}`,
          }),
        });
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
        return new Response(upstream.body, { status: upstream.status, headers });
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
          workerOrigin
        );
        const res = new Response(rewritten, {
          headers: corsHeaders({
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': `public, max-age=${PLAYLIST_TTL_S}`,
          }),
        });
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
      const res = new Response(buf, { status: upstream.status, headers });
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
