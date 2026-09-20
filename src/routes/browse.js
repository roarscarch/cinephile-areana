// src/routes/browse.js — /recent/*, /trending/*, /movies, /tv, /genre, /top-imdb
const { Router } = require('express');

module.exports = function browseRoutes(tmdb) {
  const router = Router();

  // Edge-cache catalog browsing routes: 5 min client, 1 hour Edge CDN, 1 day stale-while-revalidate
  router.use((req, res, next) => {
    res.set('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
    next();
  });

  // Recent movies endpoint
  router.get('/recent/movies', async (req, res) => {
    try {
      const movies = await tmdb.fetchRecentMovies();
      res.json(movies);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Recent TV shows endpoint
  router.get('/recent/tv', async (req, res) => {
    try {
      const tvShows = await tmdb.fetchRecentTvShows();
      res.json(tvShows);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Trending movies endpoint
  router.get('/trending/movies', async (req, res) => {
    try {
      const movies = await tmdb.fetchTrendingMovies();
      res.json(movies);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Trending TV shows endpoint
  router.get('/trending/tv', async (req, res) => {
    try {
      const tvShows = await tmdb.fetchTrendingTvShows();
      res.json(tvShows);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Movies by page endpoint
  router.get('/movies', async (req, res) => {
    try {
      const { page = 1 } = req.query;
      const movies = await tmdb.fetchMoviesByPage(parseInt(page));
      res.json(movies);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // TV shows by page endpoint
  router.get('/tv', async (req, res) => {
    try {
      const { page = 1 } = req.query;
      const tvShows = await tmdb.fetchTvShowsByPage(parseInt(page));
      res.json(tvShows);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Genre endpoint
  router.get('/genre/:genre', async (req, res) => {
    try {
      const { genre } = req.params;
      const { page = 1 } = req.query;
      const results = await tmdb.fetchByGenre(genre, parseInt(page));
      res.json(results);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Top IMDB endpoint
  router.get('/top-imdb', async (req, res) => {
    try {
      const { type = 'all', page = 1, minVote } = req.query;
      const results = await tmdb.fetchTopIMDB(type, parseInt(page), minVote ? parseFloat(minVote) : undefined);
      res.json(results);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};
