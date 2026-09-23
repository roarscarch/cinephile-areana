// src/routes/stream.js — /play proxy with O(1) LRU segment cache & connection reuse
//
// Some source CDNs enforce a Referer or lack CORS for foreign origins. This
// endpoint fetches server-side (with the embed site's referer) and streams back
// with CORS + Range support, rewriting relative HLS segment URLs so the whole
// playlist plays through us. Direct-play URLs (x.eat-peach.sbs proxies) are
// CORS-open and skip this.
const { Router } = require('express');
const { Readable } = require('stream');
// Lazy: extractor throws at import when cipher keys are unset (tests, key-less
// boots). Guard works unsigned until keys exist.
let signPlayUrl = null;
try {
  ({ signPlayUrl } = require('../services/extractor'));
} catch {}

// High-performance O(1) LRU cache for proxied media segments.
// HLS fragments (2-10s video, 0.5-4MB) hit memory on seek-back instead of upstream.
// Map preserves insertion order, so deleting and setting moves keys to MRU,
// and map.keys().next().value yields the true LRU in O(1).
const SEGMENT_CACHE = new Map(); // key → { data, type, ts }
const SEGMENT_CACHE_BUDGET = 25 * 1024 * 1024;
const SEGMENT_CACHE_MAX_ITEM = 4 * 1024 * 1024;
const SEGMENT_CACHE_TTL = 5 * 60 * 1000;
let segmentCacheBytes = 0;

function getCachedSegment(key) {
  const hit = SEGMENT_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > SEGMENT_CACHE_TTL) {
    segmentCacheBytes -= hit.data.length;
    SEGMENT_CACHE.delete(key);
    return null;
  }
  // Refresh LRU position
  SEGMENT_CACHE.delete(key);
  SEGMENT_CACHE.set(key, hit);
  return hit;
}

function cacheSegment(key, data, type) {
  if (!data || data.length > SEGMENT_CACHE_MAX_ITEM) return;
  if (SEGMENT_CACHE.has(key)) {
    segmentCacheBytes -= SEGMENT_CACHE.get(key).data.length;
    SEGMENT_CACHE.delete(key);
  }
  // O(1) eviction of oldest items
  while (SEGMENT_CACHE.size && segmentCacheBytes + data.length > SEGMENT_CACHE_BUDGET) {
    const oldestKey = SEGMENT_CACHE.keys().next().value;
    if (!oldestKey) break;
    segmentCacheBytes -= SEGMENT_CACHE.get(oldestKey).data.length;
    SEGMENT_CACHE.delete(oldestKey);
  }
  SEGMENT_CACHE.set(key, { data, type, ts: Date.now() });
  segmentCacheBytes += data.length;
}

const STREAM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Playlist cache: HLS master/variant playlists are small and mostly stable
// (tokens renew hourly), so cache the REWRITTEN text per URL for a few minutes.
// The startability probe + hls.js both fetch the same master — the second fetch
// is served instantly, making "source selected → first frame" much faster.
const PLAYLIST_CACHE = new Map(); // req.originalUrl -> { text, ts }
const PLAYLIST_CACHE_TTL = 5 * 60 * 1000;
const PLAYLIST_CACHE_MAX = 300;
function getCachedPlaylist(key) {
  const hit = PLAYLIST_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > PLAYLIST_CACHE_TTL) {
    PLAYLIST_CACHE.delete(key);
    return null;
  }
  return hit.text;
}

function cachePlaylist(key, text) {
  if (PLAYLIST_CACHE.size >= PLAYLIST_CACHE_MAX) {
    const oldest = PLAYLIST_CACHE.keys().next().value;
    if (oldest) PLAYLIST_CACHE.delete(oldest);
  }
  PLAYLIST_CACHE.set(key, { text, ts: Date.now() });
}

// Playlists are small (1-200 KB); this only guards against a CDN answering a
// huge binary with a "#EXTM3U" prefix — past the cap we stream it verbatim.
const PLAYLIST_MAX_BYTES = 4 * 1024 * 1024;

// HLS detection by CONTENT, because Content-Type lies. The mendx437sim-backed
// `multi` provider (and others) serve their master as `text/html` with
// RELATIVE variant paths (./360/index.m3u8). Trusting the header piped the raw
// playlist to the browser, which resolved './360/index.m3u8' against OUR own
// origin → 404 → hls.js fatal → the player declared a healthy server dead.
function looksLikePlaylist(buf) {
  if (!buf || !buf.length) return false;
  const head = buf.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  return head.startsWith('#EXTM3U');
}

// Rewrite every media URL in a playlist so the whole tree rides /play. Relative
// lines, relative/absolute URI="…" attributes, everything — otherwise the
// browser resolves them against our origin and 404s.
function rewritePlaylist(text, url, referer, origin) {
  const toPlay = (u) => {
    try {
      const abs = new URL(u, url).href;
      const params = new URLSearchParams({ ref: referer });
      if (origin) params.set('origin', origin);
      params.set('url', abs);
      return `/play?${params.toString()}`;
    } catch (e) {
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

// Pull the first chunk out of a paused-readable without consuming the rest, so
// an ambiguous response can be classified before we commit to a path.
function readFirstChunk(stream) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => {
      stream.off('data', onData).off('end', onEnd).off('error', onError);
      fn(v);
    };
    const onData = (c) => {
      stream.pause();
      done(resolve, c);
    };
    const onEnd = () => done(resolve, Buffer.alloc(0));
    const onError = (e) => done(reject, e);
    stream.on('data', onData).on('end', onEnd).on('error', onError);
  });
}

// Drain whatever is left, bounded by `cap` bytes.
function readRest(stream, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on('data', (c) => {
      total += c.length;
      if (total <= cap) chunks.push(c);
    });
    stream.on('end', () => resolve({ chunks, total }));
    stream.on('error', reject);
    stream.resume();
  });
}

// mp4 / segments / subtitles: stream through (piped, constant memory) and tee
// small un-ranged bodies into the LRU segment cache as they flow.
async function pipeThrough(res, body, prelude, ct, upstream, range, cacheKey) {
  if (upstream.status === 206) res.status(206);
  const cl = upstream.headers.get('content-length');
  if (cl) res.set('Content-Length', cl);
  if (upstream.headers.get('content-range')) res.set('Content-Range', upstream.headers.get('content-range'));

  await new Promise((resolve, reject) => {
    body.on('error', (e) => {
      res.destroy();
      reject(e);
    });
    res.on('close', resolve);

    // The sniffed prelude must ALWAYS reach the client — the tee below only
    // duplicates it into the segment cache, it doesn't replace the write.
    for (const c of prelude) res.write(c);

    const tee = !range && cl && Number(cl) > 0 && Number(cl) <= SEGMENT_CACHE_MAX_ITEM;
    if (tee) {
      const chunks = [...prelude];
      let total = prelude.reduce((n, c) => n + c.length, 0);
      body.on('data', (c) => {
        total += c.length;
        if (total <= SEGMENT_CACHE_MAX_ITEM) chunks.push(c);
        else chunks.length = 0;
      });
      body.on('end', () => {
        if (chunks.length && total <= SEGMENT_CACHE_MAX_ITEM) {
          cacheSegment(cacheKey, Buffer.concat(chunks), ct);
        }
      });
    }
    body.pipe(res);
  });
}

module.exports = function streamRoutes() {
  const router = Router();

  router.get('/play', async (req, res) => {
    // Option A guard: when PLAY_PROXY_BASE is set (Vercel), don't proxy bytes
    // here — 302 to the Cloudflare Worker so stale clients (cached player.js)
    // burn zero Fast Origin Transfer. Costs one tiny redirect, no video bytes.
    // The redirect is signed when PLAY_SIGNING_KEY is set (Worker enforce
    // mode); otherwise a plain redirect (local dev / pre-key deploys).
    // Local dev / VPS leave PLAY_PROXY_BASE unset and proxy as before.
    const proxyBase = (process.env.PLAY_PROXY_BASE || '').replace(/\/$/, '');
    if (proxyBase) {
      const { url, ref, origin } = req.query;
      const signed =
        url && signPlayUrl && signPlayUrl({ url, referer: ref, origin });
      if (signed) return res.redirect(302, signed);
      return res.redirect(302, `${proxyBase}${req.originalUrl}`);
    }

    const { url, ref, origin } = req.query;
    if (!url) return res.status(400).json({ error: 'url query parameter is required' });
    const referer = ref || 'https://peachify.top/';
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Invalid url' });

    try {
      const range = req.headers.range;

      // Check LRU segment cache for un-ranged requests (HLS fragments)
      if (!range) {
        const hit = getCachedSegment(req.originalUrl);
        if (hit) {
          return res.set({
            'Content-Type': hit.type,
            'Content-Length': hit.data.length,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
          }).send(hit.data);
        }
      }

      // Cached rewritten playlist (master/variant) — serve BEFORE the upstream
      // fetch so a repeat request never pays the CDN round-trip again.
      const cachedPlaylist = getCachedPlaylist(req.originalUrl);
      if (cachedPlaylist) {
        return res.set({
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
        }).send(cachedPlaylist);
      }

      const upstream = await fetch(url, {
        headers: {
          Referer: referer,
          'User-Agent': STREAM_UA,
          // Some CDNs (peachify's nextgencloudfabric-backed streams) check the
          // Origin header as well as Referer — pass it through when given.
          ...(origin ? { Origin: origin } : {}),
          ...(range ? { Range: range } : {}),
        },
      });
      if (!upstream.ok && upstream.status !== 206) {
        return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });
      }

      const ct = upstream.headers.get('content-type') || 'application/octet-stream';
      res.set({
        'Access-Control-Allow-Origin': '*',
        'Content-Type': ct,
        'Cache-Control': 'no-store',
      });

      if (ct.includes('mpegurl') || ct.includes('m3u8')) {
        // Header says playlist — rewrite and serve (master/variant both).
        const rewritten = rewritePlaylist(await upstream.text(), url, referer, origin);
        cachePlaylist(req.originalUrl, rewritten);
        res.type('application/vnd.apple.mpegurl').send(rewritten);
      } else {
        // Content-Type said "not a playlist" — but it lies. Sniff the body:
        // `multi`'s CDN serves text/html masters with RELATIVE variant paths,
        // and piping those raw is exactly what killed playback on this title.
        const body = Readable.fromWeb(upstream.body);
        const first = await readFirstChunk(body);

        if (looksLikePlaylist(first)) {
          const { chunks, total } = await readRest(body, PLAYLIST_MAX_BYTES);
          if (total <= PLAYLIST_MAX_BYTES) {
            const text = Buffer.concat([first, ...chunks]).toString('utf8');
            const rewritten = rewritePlaylist(text, url, referer, origin);
            cachePlaylist(req.originalUrl, rewritten);
            body.destroy();
            return res.type('application/vnd.apple.mpegurl').send(rewritten);
          }
          // Absurdly large for a playlist — fall through and stream verbatim.
          return pipeThrough(res, body, [first, ...chunks], ct, upstream, range, req.originalUrl);
        }

        return pipeThrough(res, body, first.length ? [first] : [], ct, upstream, range, req.originalUrl);
      }
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ error: `Proxy error: ${e.message}` });
    }
  });

  return router;
};

module.exports.STREAM_UA = STREAM_UA;
// internals — exported for the test suite (tests/stream.test.js)
module.exports.looksLikePlaylist = looksLikePlaylist;
module.exports.rewritePlaylist = rewritePlaylist;
module.exports.PLAYLIST_MAX_BYTES = PLAYLIST_MAX_BYTES;
