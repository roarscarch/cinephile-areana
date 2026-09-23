// functions/[[path]].js — Cloudflare Pages Function: entire metadata API.
//
// Same routes as the Express app (src/routes/*.js), same JSON shapes.
// Not ported: SSR home (client hydrates — the no-ssr guard covers it),
// /download (needs ffmpeg — 302s to the Vercel deployment, untouched),
// rate limiter (Cloudflare edge absorbs it).
//
// Static assets + `/` fall through to env.ASSETS (Pages static), so the
// frontend needs ZERO changes: api.js stays same-origin, player.js already
// points at the play Worker.

import { FlixHQ } from './lib/flix.js';
import { fetchSubdlVtt } from './lib/subs.js';

const PLAY_WORKER_DEFAULT = 'https://flixerz-play.cinephilia-areana.workers.dev';
const DOWNLOAD_FALLBACK_DEFAULT = 'https://cinephilia-vercel.vercel.app';

let flix = null;
function getFlix(env) {
  if (!flix) flix = new FlixHQ(env);
  return flix;
}

function json(data, { status = 200, cache = null } = {}) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
  if (cache) headers['Cache-Control'] = cache;
  return new Response(JSON.stringify(data), { status, headers });
}
const err = (message, status = 500) => json({ error: message }, { status });

// Edge-cache wrapper for idempotent GETs (listings, info, subs, dubs).
// /sources is deliberately NOT edge-cached (tokenized per-user URLs).
async function cachedJson(request, ctx, ttlS, fn, extraHeaders = {}) {
  const cache = caches.default;
  try {
    const hit = await cache.match(request);
    if (hit) return hit;
  } catch {}
  const data = await fn();
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=300, s-maxage=${ttlS}`,
    ...extraHeaders,
  };
  const res = new Response(JSON.stringify(data), { headers });
  try {
    ctx.waitUntil(cache.put(request, res.clone()));
  } catch {}
  return res;
}

export async function onRequest({ request, env, params, next, waitUntil }) {
  const ctx = { waitUntil };
  const url = new URL(request.url);
  const seg = url.pathname.split('/').filter(Boolean);
  const q = url.searchParams;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  if (request.method !== 'GET') return err('Method not allowed', 405);

  try {
    const api = getFlix(env);
    const [a, b, c, d] = seg;

    // ---- health ----
    if (seg.length === 1 && a === 'health') {
      return json({ ok: true, edge: 'cinephile-areana', ts: Date.now() });
    }

    // ---- /play: video bytes live on the dedicated Worker, never here ----
    if (a === 'play') {
      const base = (env.PLAY_PROXY_BASE || PLAY_WORKER_DEFAULT).replace(/\/$/, '');
      const target = `${base}${url.pathname}${url.search}`;
      return Response.redirect(target, 302);
    }

    // ---- /download: needs ffmpeg — hand off to the Vercel deployment ----
    if (a === 'download') {
      const base = (env.DOWNLOAD_FALLBACK || DOWNLOAD_FALLBACK_DEFAULT).replace(/\/$/, '');
      return Response.redirect(`${base}${url.pathname}${url.search}`, 302);
    }

    // ---- search ----
    if (a === 'search' && seg.length === 1) {
      const query = q.get('query');
      if (!query) return err('Query parameter is required', 400);
      return json(await api.search(query, parseInt(q.get('page') || '1', 10)));
    }

    // ---- info (mediaId contains a slash: /info/movie/603) ----
    if (a === 'info' && seg.length === 3) {
      const mediaId = `${b}/${c}`;
      if (!/^(movie|tv)\/[\w-]+$/.test(mediaId)) return err('Invalid media ID format', 400);
      const info = await api.fetchMediaInfo(mediaId);
      if (!info) return err('Media not found', 404);
      return cachedJson(request, ctx, 3600, async () => info);
    }

    // ---- sources ----
    if (a === 'sources' && seg.length === 2) {
      const mediaId = q.get('mediaId');
      if (!mediaId) return err('mediaId query parameter is required', 400);
      const skip = q.get('skip') ? String(q.get('skip')).split(',').map((s) => s.trim()).filter(Boolean) : [];
      const sources = await api.fetchEpisodeSources(b, mediaId, q.get('server'), skip);
      if (!sources || !(sources.sources || []).length) {
        return json({
          provider: (sources && sources.provider) || q.get('server') || null,
          sources: [],
          subtitles: [],
          message: 'No sources available — try another server',
        });
      }
      return json(sources);
    }

    // ---- servers ----
    if (a === 'servers' && seg.length === 2) {
      if (!q.get('mediaId')) return err('mediaId query parameter is required', 400);
      const servers = await api.fetchEpisodeServers(b, q.get('mediaId'));
      if (!servers || !servers.length) return err('No servers found', 404);
      return json(servers);
    }

    // ---- subtitles/subdl (zip -> vtt) ----
    if (a === 'subtitles' && b === 'subdl' && seg.length === 2) {
      const zip = q.get('zip');
      if (!zip) return err('zip parameter is required', 400);
      const vtt = await fetchSubdlVtt(env, zip, q.get('ep'));
      return new Response(vtt, {
        headers: {
          'Content-Type': 'text/vtt; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    // ---- subtitles tracks ----
    if (a === 'subtitles' && seg.length === 2) {
      if (!q.get('mediaId')) return err('mediaId query parameter is required', 400);
      return cachedJson(request, ctx, 3600, async () => ({
        subtitles: await api.fetchEpisodeSubtitles(b, q.get('mediaId')),
      }));
    }

    // ---- dubs ----
    if (a === 'dubs' && seg.length === 2) {
      if (!q.get('mediaId')) return err('mediaId query parameter is required', 400);
      return cachedJson(request, ctx, 3600, async () => api.fetchDubs(b, q.get('mediaId')));
    }

    // ---- browse ----
    if (a === 'recent' && (b === 'movies' || b === 'tv') && seg.length === 2) {
      return cachedJson(request, ctx, 3600, async () =>
        b === 'movies' ? api.fetchRecentMovies() : api.fetchRecentTvShows()
      );
    }
    if (a === 'trending' && (b === 'movies' || b === 'tv') && seg.length === 2) {
      return cachedJson(request, ctx, 3600, async () =>
        b === 'movies' ? api.fetchTrendingMovies() : api.fetchTrendingTvShows()
      );
    }
    if ((a === 'movies' || a === 'tv') && seg.length === 1) {
      const page = parseInt(q.get('page') || '1', 10);
      return cachedJson(request, ctx, 3600, async () =>
        a === 'movies' ? api.fetchMoviesByPage(page) : api.fetchTvShowsByPage(page)
      );
    }
    if (a === 'genre' && seg.length === 2) {
      const page = parseInt(q.get('page') || '1', 10);
      return cachedJson(request, ctx, 3600, async () => api.fetchByGenre(b, page));
    }
    if (a === 'top-imdb' && seg.length === 1) {
      const mv = q.get('minVote');
      return cachedJson(request, ctx, 3600, async () =>
        api.fetchTopIMDB(q.get('type') || 'all', parseInt(q.get('page') || '1', 10), mv ? parseFloat(mv) : undefined)
      );
    }

    // ---- embed ----
    if ((a === 'movie' || a === 'tv') && b === 'embed' && (seg.length === 3 || seg.length === 4)) {
      const srv = q.get('server');
      if (seg.length === 4 && !srv) return err('Server parameter is required', 400);
      if (a === 'movie') return json(await api.fetchMovieEmbedLinks(c, srv));
      return json(await api.fetchTvEpisodeEmbedLinks(c, srv));
    }

    // ---- static passthrough (/, assets, sw.js, manifest) ----
    return next();
  } catch (e) {
    // /sources-style graceful empty is handled above; anything else is a 500.
    if (e && /TMDB_API_KEY|PEACHIFY_KEY_HEX|VIDNEST_ALPHABET/.test(e.message || '')) {
      return err(`Server misconfigured: ${e.message}`, 500);
    }
    return err(e.message || 'Something broke!', 500);
  }
}
