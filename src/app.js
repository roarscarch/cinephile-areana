// src/app.js — Express application setup, SSR, middleware & route mounting
const express = require('express');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const TMDBService = require('./services/tmdb');
const animeService = require('./services/anime');
const Render = require('../public/js/render.js');

const mediaRoutes = require('./routes/media');
const browseRoutes = require('./routes/browse');
const embedRoutes = require('./routes/embed');
const streamRoutes = require('./routes/stream');
const downloadRoutes = require('./routes/download');
const animeRoutes = require('./routes/anime');

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

// 2b. Upstream routing introspection — the self-healing dashboard endpoint.
//   GET /health/upstreams             -> config version, families, provider
//      names, live breaker state (no secrets, no keys, no alphabets).
//   GET /health/upstreams?refresh=1   -> re-read config/upstreams.json +
//      UPSTREAMS_JSON env WITHOUT a restart (hot-patch a renamed host/slug,
//      then hit this once; the next /sources race uses the new table).
//   GET /health/upstreams?probe=1     -> actually race the canary titles
//      through resolveStream (movie/550 + Breaking Bad S1E1). Slower (~2-10s)
//      but proves end-to-end playability, not just config presence.
app.get('/health/upstreams', async (req, res) => {
  try {
    const { loadUpstreams, getBreakerSnapshot } = require('./services/upstreams');
    const ext = require('./services/extractor');
    if (req.query.refresh === '1' || req.query.reload === '1') {
      if (typeof ext.refreshUpstreamConsts === 'function') ext.refreshUpstreamConsts();
      else loadUpstreams({ reload: true });
    }
    const table = loadUpstreams();
    const fams = {};
    for (const [name, fam] of Object.entries(table.families || {})) {
      fams[name] = {
        api: fam.api,
        referer: fam.referer ? '(set)' : '(missing)',
        providers: (fam.providers || []).map((p) => p.name),
        count: (fam.providers || []).length,
      };
    }
    const out = {
      ok: true,
      version: table.version,
      ts: Date.now(),
      uptime: Math.round(process.uptime()),
      families: fams,
      breakers: getBreakerSnapshot(),
      envOverride: Boolean(process.env.UPSTREAMS_JSON),
      canary: table.canary || {},
    };
    if (req.query.probe === '1') {
      const probeOne = async (c) => {
        if (!c || !c.type || !c.id) return { skipped: true };
        const t0 = Date.now();
        try {
          const r = await ext.resolveStream({
            type: c.type, id: String(c.id),
            season: String(c.season || '1'), episode: String(c.episode || '1'),
          });
          return {
            ok: (r.sources || []).length > 0, provider: r.provider || null,
            sources: (r.sources || []).length, ms: Date.now() - t0,
          };
        } catch (e) {
          return { ok: false, error: e.message, ms: Date.now() - t0 };
        }
      };
      const [movie, tv] = await Promise.all([probeOne(table.canary.movie), probeOne(table.canary.tv)]);
      out.probe = { movie, tv };
      out.ok = Boolean((movie && movie.ok) || (tv && tv.ok));
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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

// 3b. SEO + shareable deep links — real path routes. The SAME document is
// served to bots and humans: index.html with per-page <meta>/JSON-LD injected.
// (UA-split HTML poisoned the shared CDN cache — bot markup got served to
// users.) The SPA boots and renders the view; the injected meta makes the
// page crawlable. Hash URLs are legacy-only.
const SHARE_ORIGIN = (process.env.SHARE_ORIGIN || 'https://cinephilia.in').replace(/\/$/, '');
const escAttr = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const stripTags = (v) => String(v || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const SEO_CACHE = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';
const INDEX_PATH = path.join(PUBLIC_DIR, 'index.html');

function appPageWithMeta({ title, description, image, url, jsonLd = null, noindex = false }) {
  const img = image || `${SHARE_ORIGIN}/icons/icon.svg`;
  let html;
  try {
    html = INDEX_HTML || fs.readFileSync(INDEX_PATH, 'utf8');
  } catch (e) {
    html = '<!DOCTYPE html><html lang="en"><head></head><body><main id="view"></main></body></html>';
  }
  const set = (re, replacement) => { html = html.replace(re, replacement); };
  set(/<title>[\s\S]*?<\/title>/, `<title>${escAttr(title)}</title>`);
  set(/<meta name="description"[^>]*>/, `<meta name="description" content="${escAttr(description)}">`);
  set(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${escAttr(url)}">`);
  set(/<meta name="robots"[^>]*>/, `<meta name="robots" content="${noindex ? 'noindex,follow' : 'index,follow'}">`);
  set(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${escAttr(title)}">`);
  set(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${escAttr(description)}">`);
  set(/<meta property="og:url"[^>]*>/, `<meta property="og:url" content="${escAttr(url)}">`);
  set(/<meta property="og:image"[^>]*>/, `<meta property="og:image" content="${escAttr(img)}">`);
  set(/<meta name="twitter:title"[^>]*>/, `<meta name="twitter:title" content="${escAttr(title)}">`);
  set(/<meta name="twitter:description"[^>]*>/, `<meta name="twitter:description" content="${escAttr(description)}">`);
  set(/<meta name="twitter:image"[^>]*>/, `<meta name="twitter:image" content="${escAttr(img)}">`);
  if (jsonLd) {
    set(
      /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
      `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`
    );
  }
  return html;
}

async function detailSeo(req, res, next, kind, id, suffix = '') {
  try {
    if (kind === 'anime') {
      if (!/^\d+$/.test(id || '')) return next();
      let info = null;
      try { info = await animeService.info(id); } catch (e) {}
      const title = info ? info.title : 'Anime';
      const description = info && info.description ? stripTags(info.description).slice(0, 200) : 'Watch anime free — sub & dub, no ads, no login.';
      const url = `${SHARE_ORIGIN}/anime/${id}`;
      const ld = { '@context': 'https://schema.org', '@type': 'TVSeries', name: title, description, url };
      if (info && info.image) ld.image = info.image;
      return res.set('Cache-Control', SEO_CACHE).type('html').send(
        appPageWithMeta({ title: `${title} — Cinephiles Areana`, description, image: info && info.image, url, jsonLd: ld })
      );
    }
    if ((kind !== 'movie' && kind !== 'tv') || !/^\d+$/.test(id || '')) return next();
    let info = null;
    try { info = await tmdb.fetchMediaInfo(`${kind}/${id}`); } catch (e) {}
    const title = info ? info.title : kind === 'movie' ? 'Movie' : 'TV Show';
    const description = info && info.description ? String(info.description).slice(0, 200) : 'Watch free — no ads, no login.';
    const image = info && (info.cover || info.image);
    const url = `${SHARE_ORIGIN}/${kind}/${id}${suffix}`;
    const ld = { '@context': 'https://schema.org', '@type': kind === 'tv' ? 'TVSeries' : 'Movie', name: title, description, url };
    if (image) ld.image = image;
    if (info && info.releaseDate) ld.datePublished = info.releaseDate;
    if (info && info.rating) ld.aggregateRating = { '@type': 'AggregateRating', ratingValue: String(info.rating), bestRating: '10', ratingCount: '1' };
    return res.set('Cache-Control', SEO_CACHE).type('html').send(
      appPageWithMeta({ title: `${title} — Cinephiles Areana`, description, image, url, jsonLd: ld })
    );
  } catch (e) {
    next();
  }
}

app.get('/movie/:id', (req, res, next) => detailSeo(req, res, next, 'movie', req.params.id));
app.get('/tv/:id', (req, res, next) => detailSeo(req, res, next, 'tv', req.params.id));
app.get('/anime/:id', (req, res, next) => detailSeo(req, res, next, 'anime', req.params.id));
app.get('/watch/:type/:id/:ep?', (req, res, next) => {
  const { type, id, ep } = req.params;
  detailSeo(req, res, next, type, id, ep ? `/${ep}` : '');
});

const LISTING_META = {
  movies: { title: 'Movies — Cinephiles Areana', desc: 'Browse and stream popular movies in HD — no ads, no login.' },
  'tv-shows': { title: 'TV Shows — Cinephiles Areana', desc: 'Browse and stream trending TV series — no ads, no login.' },
  'top-rated': { title: 'Top Rated — Cinephiles Areana', desc: 'The highest-rated movies and shows, all in one place.' },
  imdb75: { title: 'IMDb 7.5+ Movies — Cinephiles Areana', desc: 'Critically loved films rated 7.5 or higher.' },
  anime: { title: 'Anime — Cinephiles Areana', desc: 'Stream trending and popular anime, sub & dub.' },
};
for (const [slug, meta] of Object.entries(LISTING_META)) {
  app.get(`/${slug}`, (req, res) => {
    const url = `${SHARE_ORIGIN}/${slug}`;
    res.set('Cache-Control', SEO_CACHE).type('html').send(
      appPageWithMeta({
        title: meta.title,
        description: meta.desc,
        url,
        jsonLd: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: meta.title, description: meta.desc, url },
      })
    );
  });
}
app.get('/genre/:genre', (req, res) => {
  const g = String(req.params.genre || '');
  const title = `${g} Movies — Cinephiles Areana`;
  const desc = `Stream ${g} movies free — no ads, no login.`;
  res.set('Cache-Control', SEO_CACHE).type('html').send(appPageWithMeta({ title, description: desc, url: `${SHARE_ORIGIN}/genre/${encodeURIComponent(g)}` }));
});
app.get('/search', (req, res) => {
  res.set('Cache-Control', SEO_CACHE).type('html').send(
    appPageWithMeta({ title: 'Search — Cinephiles Areana', description: 'Search movies, TV shows and anime.', url: `${SHARE_ORIGIN}/search`, noindex: true })
  );
});

// Sitemap: static sections + genres + trending/recent/top titles + anime.
let SITEMAP_MEMO = { exp: 0, xml: '' };
app.get('/sitemap.xml', async (req, res) => {
  try {
    if (SITEMAP_MEMO.exp > Date.now()) return res.type('application/xml').send(SITEMAP_MEMO.xml);
    const urls = ['/', '/movies', '/tv-shows', '/top-rated', '/imdb75', '/anime'];
    for (const g of ['Action', 'Adventure', 'Comedy', 'Crime', 'Drama', 'Fantasy', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Thriller', 'War']) {
      urls.push(`/genre/${encodeURIComponent(g)}`);
    }
    const pushTitles = (list) => {
      for (const it of list || []) {
        const id = String((it && it.id) || '');
        if (/^(movie|tv)\/\d+$/.test(id)) urls.push(`/${id}`);
      }
    };
    try {
      const [tm, tt, rm, top, an] = await Promise.all([
        tmdb.fetchTrendingMovies(),
        tmdb.fetchTrendingTvShows(),
        tmdb.fetchRecentMovies(),
        tmdb.fetchTopIMDB('all', 1).catch(() => null),
        animeService.trending().catch(() => []),
      ]);
      pushTitles(tm);
      pushTitles(tt);
      pushTitles(rm);
      pushTitles((top && (top.results || top)) || []);
      for (const it of an || []) if (it && it.id) urls.push(`/anime/${it.id}`);
    } catch (e) {}
    const uniq = [...new Set(urls)];
    const today = new Date().toISOString().slice(0, 10);
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
      uniq.map((u) => `<url><loc>${SHARE_ORIGIN}${u}</loc><lastmod>${today}</lastmod></url>`).join('') +
      `</urlset>`;
    SITEMAP_MEMO = { exp: Date.now() + 15 * 60 * 1000, xml };
    res.type('application/xml').send(xml);
  } catch (e) {
    res.status(500).send('sitemap error');
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
app.use(downloadRoutes(tmdb));
app.use(animeRoutes()); // separate anime section (AniList + Megaplay, no TMDB)

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
