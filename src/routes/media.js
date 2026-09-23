// src/routes/media.js — /search, /info, /sources, /subtitles, /servers, /dubs, /sign
const { Router } = require('express');
const { signPlayUrl } = require('../services/extractor');

// Hosts allowed to mint signatures (same-origin callers). The browser
// enforces this via CORS (no ACAO header below); the Origin check closes
// the curl-with-Origin hole. Extra hosts via ALLOW_ORIGINS="a.com,b.com".
const SIGN_ORIGINS = new Set(
  (process.env.ALLOW_ORIGINS ||
    'cinephilia-vercel.vercel.app,cinephiles-areana.vercel.app,cinephile-areana.pages.dev,localhost,127.0.0.1'
  )
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

function signOriginAllowed(req) {
  const o = req.headers.origin;
  if (!o) return true; // same-origin navigations / no-Origin clients
  try {
    const h = new URL(o).hostname.toLowerCase();
    if (SIGN_ORIGINS.has(h)) return true;
    return [...SIGN_ORIGINS].some((d) => d !== 'localhost' && d !== '127.0.0.1' && (h === d || h.endsWith('.' + d)));
  } catch {
    return false;
  }
}

module.exports = function mediaRoutes(tmdb) {
  const router = Router();

  // Mint a signed proxy URL for an arbitrary media/subtitle URL. Used by the
  // player for subtitle tracks (their referer is only known client-side).
  // Same-origin CORS only — NO Access-Control-Allow-Origin header here.
  router.get('/sign', async (req, res) => {
    try {
      if (!signOriginAllowed(req)) return res.status(403).json({ error: 'Forbidden origin' });
      const { url, ref, origin } = req.query;
      if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Valid url required' });
      const play = signPlayUrl({ url, referer: ref, origin });
      if (!play) return res.status(503).json({ error: 'Signing not configured' });
      res.json({ play });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Search endpoint
  router.get('/search', async (req, res) => {
    try {
      const { query, page = 1 } = req.query;
      if (!query) {
        return res.status(400).json({ error: 'Query parameter is required' });
      }
      const results = await tmdb.search(query, parseInt(page));
      res.json(results);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Media info endpoint with better error handling
  router.get('/info/:mediaId(*)', async (req, res) => {
    try {
      const { mediaId } = req.params;
      if (!mediaId) {
        return res.status(400).json({ error: 'Media ID is required' });
      }
      
      // Validate mediaId format
      if (!mediaId.match(/^(movie|tv)\/[\w-]+$/)) {
        return res.status(400).json({ error: 'Invalid media ID format' });
      }

      const info = await tmdb.fetchMediaInfo(mediaId);
      if (!info) {
        return res.status(404).json({ error: 'Media not found' });
      }
      res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
      res.json(info);
    } catch (error) {
      if (error.message.includes('404')) {
        res.status(404).json({ error: 'Media not found' });
      } else {
        res.status(500).json({ error: error.message });
      }
    }
  });

  // Episode sources endpoint with validation
  router.get('/sources/:episodeId', async (req, res) => {
    try {
      const { episodeId } = req.params;
      const { mediaId, server, skip } = req.query;
      if (!mediaId) {
        return res.status(400).json({ error: 'mediaId query parameter is required' });
      }
      if (!episodeId) {
        return res.status(400).json({ error: 'Episode ID is required' });
      }
      const skipList = skip ? String(skip).split(',').map((s) => s.trim()).filter(Boolean) : [];
      const sources = await tmdb.fetchEpisodeSources(episodeId, mediaId, server, skipList);
      if (!sources || (sources.sources && sources.sources.length === 0)) {
        // Graceful empty result: client handles fallback; no raw server errors
        // shown. Keep the resolved provider name (and echo a forced `server`)
        // so a manual pick can label and highlight the server the user chose
        // instead of silently reverting the UI to Auto.
        return res.status(200).json({
          provider: (sources && sources.provider) || server || null,
          sources: [],
          subtitles: [],
          message: 'No sources available — try another server',
        });
      }
      res.json(sources);
    } catch (error) {
      // Never surface raw provider errors to the user.
      res.status(200).json({ provider: null, sources: [], subtitles: [], message: "No sources available" });
    }
  });

  // Episode servers endpoint with validation
  router.get('/servers/:episodeId', async (req, res) => {
    try {
      const { episodeId } = req.params;
      const { mediaId } = req.query;
      if (!mediaId) {
        return res.status(400).json({ error: 'mediaId query parameter is required' });
      }
      if (!episodeId) {
        return res.status(400).json({ error: 'Episode ID is required' });
      }
      const servers = await tmdb.fetchEpisodeServers(episodeId, mediaId);
      if (!servers || servers.length === 0) {
        return res.status(404).json({ error: 'No servers found' });
      }
      res.json(servers);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Serve unzipped & WebVTT-converted SubDL subtitles
  router.get('/subtitles/subdl', async (req, res) => {
    try {
      const { zip, ep } = req.query;
      if (!zip) return res.status(400).json({ error: 'zip parameter is required' });
      const { fetchSubdlVtt } = require('../services/subtitles');
      const vtt = await fetchSubdlVtt(zip, ep);
      res.set({
        'Content-Type': 'text/vtt; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400',
      });
      res.send(vtt);
    } catch (error) {
      res.status(502).json({ error: `Subtitle fetch error: ${error.message}` });
    }
  });

  // Subtitle tracks only — a SEPARATE endpoint so /sources stays stream-only and
  // answers as fast as possible. The browser fires both in parallel and attaches
  // tracks whenever these arrive (even several seconds after playback started).
  router.get('/subtitles/:episodeId', async (req, res) => {
    try {
      const { episodeId } = req.params;
      const { mediaId } = req.query;
      if (!mediaId) return res.status(400).json({ error: 'mediaId query parameter is required' });
      if (!episodeId) return res.status(400).json({ error: 'Episode ID is required' });
      const subtitles = await tmdb.fetchEpisodeSubtitles(episodeId, mediaId);
      res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
      res.json({ subtitles });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Audio languages across dub-capable servers (populates the audio dropdown)
  router.get('/dubs/:episodeId', async (req, res) => {
    try {
      const { episodeId } = req.params;
      const { mediaId } = req.query;
      if (!mediaId) {
        return res.status(400).json({ error: 'mediaId query parameter is required' });
      }
      const dubs = await tmdb.fetchDubs(episodeId, mediaId);
      res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
      res.json(dubs);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};
