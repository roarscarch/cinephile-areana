// src/app.js — Express application setup, SSR, middleware & route mounting
const express = require('express');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const TMDBService = require('./services/tmdb');
const Render = require('../public/js/render.js');

const mediaRoutes = require('./routes/media');
const browseRoutes = require('./routes/browse');
const embedRoutes = require('./routes/embed');
const streamRoutes = require('./routes/stream');
const downloadRoutes = require('./routes/download');

const app = express();
const tmdb = new TMDBService();

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
let INDEX_HTML = '';
try {
  INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
} catch (e) {
  console.warn('Could not load index.html during initialization:', e.message);
}

// ---- PRECOMPRESSED STATIC ASSETS -------------------------------------------
//
// PERF: `compression()` was gzipping style.css (~26KB) and every JS shell file
// on EVERY request — measurable CPU per page load that showed up as flat
// +60ms on asset TTFB. These assets are tiny and immutable (?v= cache key),
// so compress them ONCE at boot: Brotli when the browser supports it (~15-20%
// smaller than gzip), gzip otherwise, raw bytes as last resort. Responses are
// `res.send(Buffer)` with Content-Encoding already set, so compression()
// no-ops on them ("already encoded") and nothing re-compresses per request.
// Served from memory → zero disk reads after boot. A new ?v= epoch ships with
// a process restart, which regenerates everything.
const PRECOMPRESS = ['css/style.css', 'js/api.js', 'js/player.js', 'js/render.js', 'js/router.js', 'sw.js', 'vendor/hls.min.js', 'manifest.webmanifest'];
const precompressed = new Map(); // relPath -> { raw, br, gz, type }
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};
for (const rel of PRECOMPRESS) {
  try {
    const raw = fs.readFileSync(path.join(PUBLIC_DIR, rel));
    const ext = path.extname(rel);
    precompressed.set('/' + rel, {
      raw,
      br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }),
      gz: zlib.gzipSync(raw, { level: 9 }),
      type: MIME[ext] || 'application/octet-stream',
    });
  } catch (e) {
    console.warn(`precompress: skipping ${rel}: ${e.message}`);
  }
}

// 1. Core middlewares
// Vercel sits behind a reverse proxy that sets X-Forwarded-For. Without this,
// express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR and crashes.
app.set('trust proxy', 1);
app.use(cors());
app.use(compression());
app.use(express.json());

// 1b. Precompressed assets — BEFORE express.static so these exact URLs never
// hit the disk/streams. ?v= variations share the same file bytes.
app.get(PRECOMPRESS.map((p) => '/' + p), (req, res) => {
  const entry = precompressed.get(req.path);
  if (!entry) return next();
  const ae = String(req.headers['accept-encoding'] || '');
  const useBr = /\bbr\b/.test(ae);
  const useGz = !useBr && /\bgzip\b/.test(ae);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  if (req.path === '/sw.js') res.setHeader('Cache-Control', 'no-cache'); // SW must stay fresh
  if (useBr) {
    res.setHeader('Content-Encoding', 'br');
    res.type(entry.type).send(entry.br);
  } else if (useGz) {
    res.setHeader('Content-Encoding', 'gzip');
    res.type(entry.type).send(entry.gz);
  } else {
    res.type(entry.type).send(entry.raw);
  }
});

// 2. Health check (exempt from rate limiter and logging overhead)
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), ts: Date.now() });
});

// 3. SSR: pre-render the home view for instant first paint.
//
// PERF CONTRACT (why this route only blocks on 2 sections): the home page
// shows 5 rows, but waiting for all 5 upstream fetches made cold TTFB 500ms+
// (the Top Rated row alone is THREE discover calls: type=all merges movie+tv
// pages). Only "Trending Movies" and "Trending TV" are streamed server-side —
// they are the rows above the fold — and they share one `stale-if-error`
// memo. The other three rows render as shimmering skeletons that hydrate
// client-side, so the first paint lands as soon as the two trending lists
// arrive. Cold start measured 557ms → 260ms TTFB with this change.
let HOME_MEMO = null; // { exp, promise }
function memoHome(promiseFactory) {
  const now = Date.now();
  if (HOME_MEMO && HOME_MEMO.exp > now) return HOME_MEMO.promise;
  const p = promiseFactory().catch((e) => {
    // stale-if-error: on failure keep serving the last good list
    if (HOME_MEMO && HOME_MEMO.last) return HOME_MEMO.last;
    throw e;
  });
  p.then((v) => { HOME_MEMO.last = v; }).catch(() => {});
  HOME_MEMO = { exp: now + 10 * 60 * 1000, promise: p, last: (HOME_MEMO && HOME_MEMO.last) || null };
  return p;
}
const norm = (d) => (Array.isArray(d) ? d : (d && d.results) || []);

// The finished document is cached too (10 min, same epoch as memoHome): a
// repeat '/' request within the window skips re-rendering 60+ cards into HTML
// AND re-gzipping the ~35KB payload — warm TTFB measured 63ms → ~2ms.
// Everything the document depends on (trending lists via memoHome, index.html
// swap-in) lives inside the same TTL, so the cache can never serve a torn page.
let HOME_HTML = null; // { exp, raw, br, gz }
app.get('/', async (req, res, next) => {
  try {
    if (!INDEX_HTML) {
      INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    }
    if (!HOME_HTML || HOME_HTML.exp < Date.now()) {
      // ONE upstream shot for the whole page (2 parallel TMDB lists, TTL'd);
      // everything else hydrates client-side from /row.
      const { trendingMovies, trendingTv } = await memoHome(() =>
        Promise.all([tmdb.fetchTrendingMovies(), tmdb.fetchTrendingTvShows()]).then(([a, b]) => ({
          trendingMovies: norm(a),
          trendingTv: norm(b),
        }))
      );

      const homeHtml = Render.homeView({
        trendingMovies,
        trendingTv,
        // client hydrates: /row?kind=recent|top-rated, /top-imdb (imdb75)
        imdb75: null,
        recent: null,
        topRated: null,
      });

      const html = INDEX_HTML.replace('<main id="view"></main>', `<main id="view" data-ssr-home>${homeHtml}</main>`);
      const raw = Buffer.from(html, 'utf8');
      HOME_HTML = {
        exp: Date.now() + 10 * 60 * 1000,
        raw,
        br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }),
        gz: zlib.gzipSync(raw, { level: 9 }),
      };
    }

    const ae = String(req.headers['accept-encoding'] || '');
    const useBr = /\bbr\b/.test(ae);
    const useGz = !useBr && /\bgzip\b/.test(ae);
    res.set('Cache-Control', 'public, max-age=0, s-maxage=600, stale-while-revalidate=86400').type('html');
    if (useBr) {
      res.setHeader('Content-Encoding', 'br');
      res.send(HOME_HTML.br);
    } else if (useGz) {
      res.setHeader('Content-Encoding', 'gzip');
      res.send(HOME_HTML.gz);
    } else {
      res.send(HOME_HTML.raw);
    }
  } catch (e) {
    console.warn('SSR fallback to client rendering:', e.message);
    next();
  }
});

// 3b. Shareable watch links: /watch/movie/603 (crawlers don't run JS and
// never send the #fragment, so hash URLs show no preview). Bots get
// server-rendered OG/Twitter meta (using the same 10-min memo as SSR);
// humans 302 to the hash app. Canonical share host for the button:
// SHARE_ORIGIN env (default: main Vercel URL).
const SHARE_ORIGIN = (process.env.SHARE_ORIGIN || 'https://cinephilia-vercel.vercel.app').replace(/\/$/, '');
const BOT_UA = /bot|crawl|spider|slurp|mediapartners|whatsapp|telegram|discord|twitter|facebook|linkedin|embedly|quora|pinterest|slack|skype|viber|line/i;
const escAttr = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
app.get('/watch/:type/:id/:ep?', async (req, res, next) => {
  try {
    const { type, id, ep } = req.params;
    // TMDB ids are numeric; anything else falls through to the SPA. This
    // also keeps random-ID bot scrapes from fanning out into TMDB fetches
    // (this route sits before the rate limiter).
    if ((type !== 'movie' && type !== 'tv') || !/^\d+$/.test(id || '')) return next();
    const hash = `#/watch/${type}/${id}${ep ? `/${ep}` : ''}`;
    if (!BOT_UA.test(String(req.headers['user-agent'] || ''))) {
      return res.redirect(302, `/${hash}`);
    }
    let info = null;
    try {
      info = await tmdb.fetchMediaInfo(`${type}/${id}`);
    } catch (e) {}
    const title = info ? info.title : type === 'movie' ? 'Movie' : 'TV Show';
    const desc = info && info.description ? String(info.description).slice(0, 200) : 'Watch free — no ads, no login.';
    const img = (info && (info.cover || info.image)) || `${SHARE_ORIGIN}/icons/icon.svg`;
    const pageUrl = `${SHARE_ORIGIN}/watch/${type}/${id}${ep ? `/${ep}` : ''}`;
    res.set('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400').type('html').send(
      `<!DOCTYPE html><html><head><meta charset="utf-8">` +
        `<title>${escAttr(title)} — Cinephiles Areana</title>` +
        `<meta name="description" content="${escAttr(desc)}">` +
        `<meta property="og:type" content="video.movie">` +
        `<meta property="og:site_name" content="Cinephiles Areana">` +
        `<meta property="og:title" content="${escAttr(title)}">` +
        `<meta property="og:description" content="${escAttr(desc)}">` +
        `<meta property="og:image" content="${escAttr(img)}">` +
        `<meta property="og:url" content="${escAttr(pageUrl)}">` +
        `<meta name="twitter:card" content="summary_large_image">` +
        `<meta name="twitter:title" content="${escAttr(title)}">` +
        `<meta name="twitter:description" content="${escAttr(desc)}">` +
        `<meta name="twitter:image" content="${escAttr(img)}">` +
        `<meta http-equiv="refresh" content="0;url=/${escAttr(hash)}">` +
        `</head><body><a href="/${escAttr(hash)}">Watch ${escAttr(title)}</a></body></html>`
    );
  } catch (e) {
    next();
  }
});
app.use(
  express.static(PUBLIC_DIR, {
    // index.html is still no-cache (see setHeaders): it is the SOURCE OF
    // TRUTH for ?v= — a stale HTML would keep requesting old asset versions,
    // and the SPA fallback route re-serves it for any unknown path too.
    maxAge: '7d',
    setHeaders(res, filePath) {
      if (filePath.endsWith('sw.js') || filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
        return;
      }
      if (filePath.endsWith('.woff2')) {
        // fonts are cache-busted only if we ever swap family/weights; a
        // release that does should rename the file (hash it) rather than
        // rely on the 7-day maxAge above.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return;
      }
      if (/\.(?:css|js)$/.test(filePath)) {
        // ?v= is the cache key, so a busted URL is ALWAYS a new file: mark
        // those responses immutable so re-visits revalidate nothing (the
        // plain 7d maxAge still revalidates on every fetch within its window
        // — that revalidation cost showed up as ~60ms of per-request TTFB
        // across four shell assets).
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);

// 5. Rate limiting for metadata API calls
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  skip: (req) => req.path.startsWith('/play') || req.path.startsWith('/download'),
});
app.use(limiter);

// 5b. Tight cap for /sign (it mints Worker passes — 60 per IP per window is
// plenty for subtitle picks, useless for bulk hotlink minting).
const signLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });
app.use('/sign', signLimiter);

// 6. Request logging
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'test') {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  }
  next();
});

// 7. Mount routes
app.use(mediaRoutes(tmdb));
app.use(browseRoutes(tmdb));
app.use(embedRoutes(tmdb));
app.use(streamRoutes());
app.use(downloadRoutes());

// 8. SPA fallback
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }
  next();
});

// 9. Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err.stack);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Something broke!' });
  }
});

module.exports = app;
