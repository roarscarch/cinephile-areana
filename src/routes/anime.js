// src/routes/anime.js — anime section API (AniList metadata + Megaplay streams).
//
// Entirely separate from the TMDB routes: anime is browsed by AniList id and
// played by MAL id. Kept under /anime/* so the SPA fallback and the movie/TV
// handlers never overlap it.
const { Router } = require('express');
const anime = require('../services/anime');

module.exports = function animeRoutes() {
  const router = Router();

  // Catalog is cheap to cache; stream URLs carry short-lived tokens so a
  // shorter client cache + server stale-while-revalidate.
  router.use((req, res, next) => {
    res.set('Cache-Control', 'public, max-age=300, s-maxage=1800, stale-while-revalidate=86400');
    next();
  });

  const pageOf = (req) => Math.max(1, parseInt(req.query.page, 10) || 1);

  router.get('/anime/trending', async (req, res) => {
    try {
      res.json(await anime.trending(pageOf(req)));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  router.get('/anime/popular', async (req, res) => {
    try {
      res.json(await anime.popular(pageOf(req)));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  router.get('/anime/top', async (req, res) => {
    try {
      res.json(await anime.topRated(pageOf(req)));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  router.get('/anime/upcoming', async (req, res) => {
    try {
      res.json(await anime.upcoming(pageOf(req)));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  router.get('/anime/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    try {
      res.json(await anime.search(q, pageOf(req)));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  router.get('/anime/info/:id', async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'invalid anime id' });
    try {
      res.json(await anime.info(req.params.id));
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  router.get('/anime/sources/:malId', async (req, res) => {
    const { malId } = req.params;
    if (!/^\d+$/.test(malId)) return res.status(400).json({ error: 'invalid mal id' });
    const episode = parseInt(req.query.ep, 10) || 1;
    const dub = req.query.dub === '1' || req.query.dub === 'true';
    try {
      res.json(await anime.resolveSources({ malId, episode, dub }));
    } catch (e) {
      // Graceful empty result — the client falls back to sub, then shows a
      // clean message. Never leak raw upstream errors as a 500 to the player.
      res.status(200).json({ url: null, isM3U8: false, subtitles: [], intro: null, outro: null, error: e.message });
    }
  });

  return router;
};
