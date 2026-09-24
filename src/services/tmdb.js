const axios = require('axios');
const { TvType } = require('../utils/constants');
const { resolveStream, fetchSubtitles, fetchVidnestSubtitles, PROVIDERS, VIDNEST_PROVIDERS, signPlayUrl } = require('./extractor');
const { fetchEnglishSubtitles } = require('./subtitles'); // primary English subtitle source
const { httpAgent, httpsAgent } = require('../utils/http');

const TMDB_API_KEY = process.env.TMDB_API_KEY;
if (!TMDB_API_KEY) {
  throw new Error("TMDB_API_KEY environment variable is required. Set it via .env.local or Vercel dashboard.");
}
const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

// Stream servers = peachify's internal providers (Horizon/Wolf/Spider/Multi/Iron)
// plus vidnest's (Videasy/HollyMovie/Rogflix/Buzz/NGC). Each is a direct JSON
// API — no scraping, no browser. resolveStream dispatches by name.
const SERVERS = [...PROVIDERS, ...VIDNEST_PROVIDERS];

// Subtitle lookups are ENRICHMENT, never a playback gate: race them against a
// short deadline and serve whatever landed ([] on overrun). The underlying
// fetches stay bounded (extractor) so sockets don't linger either.
function withDeadline(promise, ms) {
  let timeoutId;
  const fallback = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve([]), ms);
  });
  return Promise.race([promise, fallback]).finally(() => clearTimeout(timeoutId));
}

// Validation results are cached per URL so dead tracks only pay their timeout
// once across sessions (they stay dead for the cache TTL, 10 min).
const SUB_VALID_CACHE = new Map(); // url -> { ok: boolean, ts: number }
const SUB_VALID_TTL = 10 * 60 * 1000;

class CinephileHQ {
  constructor() {
    this.name = 'CinephileHQ';
    this.tmdb = axios.create({
      baseURL: TMDB_BASE,
      params: { api_key: TMDB_API_KEY },
      httpAgent,
      httpsAgent,
      timeout: 12000,
    });
    this._genresCache = null;
    this._cache = new Map(); // { key → { exp, promise } } TTL cache, in-flight dedupe
  }

  // ---- helpers ----

  /**
   * TTL cache with in-flight dedupe: concurrent identical calls share one
   * upstream fetch; repeat calls within ttlMs resolve instantly. Rejected
   * promises evict themselves so errors don't get stuck in the cache.
   */
  _cached(key, ttlMs, fetcher) {
    const now = Date.now();
    const hit = this._cache.get(key);
    if (hit) {
      if (hit.exp > now) return hit.promise;
      this._cache.delete(key);
    }
    const pending = Promise.resolve()
      .then(fetcher)
      .then((value) => {
        this._cache.set(key, { exp: Date.now() + ttlMs, promise: Promise.resolve(value) });
        return value;
      })
      .catch((error) => {
        this._cache.delete(key);
        throw error;
      });
    this._cache.set(key, { exp: now + ttlMs, promise: pending });
    if (this._cache.size > 600) {
      const sweepNow = Date.now();
      for (const [cacheKey, entry] of this._cache) if (entry.exp < sweepNow) this._cache.delete(cacheKey);
    }
    return pending;
  }

  // TMDB imdb_id for a title — used by the OpenSubtitles subtitle search.
  // Long cache: an imdb id is stable for the life of the title.
  _imdbId(type, id) {
    return this._cached(`imdb:${type}:${id}`, 7 * 24 * 60 * 60 * 1000, async () => {
      try {
        const { data } = await this.tmdb.get(`/${type}/${id}/external_ids`);
        return data.imdb_id || null;
      } catch (e) {
        return null;
      }
    });
  }

  _img(path) {
    return path ? `${IMAGE_BASE}${path}` : null;
  }

  _item(id, tmdbItem, type) {
    const title = tmdbItem.title || tmdbItem.name;
    return {
      id: `${type}/${tmdbItem.id}`,
      title,
      image: this._img(tmdbItem.poster_path || tmdbItem.backdrop_path),
      releaseDate: (tmdbItem.release_date || tmdbItem.first_air_date || '').split('-')[0] || undefined,
      type: type === 'movie' ? TvType.MOVIE : TvType.TVSERIES,
      rating: tmdbItem.vote_average || 0, // 0–10 score — powers the ★ chip on cards
    };
  }

  async _genres() {
    if (!this._genresCache) {
      const [{ data: movies }, { data: tv }] = await Promise.all([
        this.tmdb.get('/genre/movie/list'),
        this.tmdb.get('/genre/tv/list'),
      ]);
      const map = {};
      [...movies.genres, ...tv.genres].forEach((g) => {
        map[g.name.toLowerCase()] = g.id;
      });
      this._genresCache = map;
    }
    return this._genresCache;
  }

  async _discover(type, page, extra = {}) {
    // 10 min TTL — browse pages rarely change minute-to-minute
    const key = `discover:${type}:${page}:${JSON.stringify(extra)}`;
    return this._cached(key, 10 * 60 * 1000, async () => {
      const { data } = await this.tmdb.get(`/discover/${type}`, {
        params: { page, sort_by: 'popularity.desc', ...extra },
      });
      return {
        currentPage: data.page,
        hasNextPage: data.page < data.total_pages,
        results: data.results.map((row) => this._item(type, row, type)),
      };
    });
  }

  // ---- search ----

  async search(query, page = 1) {
    // 5 min TTL — search feels instant on repeat/back-navigation
    return this._cached(`search:${query}:${page}`, 5 * 60 * 1000, async () => {
      const { data } = await this.tmdb.get('/search/multi', {
        params: { query, page, include_adult: 'false' },
      });
      const results = data.results
        .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
        .map((row) => this._item(row.media_type, row, row.media_type));
      return { currentPage: data.page, hasNextPage: data.page < data.total_pages, results };
    });
  }

  // ---- media info ----

  async fetchMediaInfo(mediaId) {
    // 15 min TTL — info pages + their episode lists are the slowest endpoint
    // (TV does one request per season); caching makes repeat visits instant.
    return this._cached(`info:${mediaId}`, 15 * 60 * 1000, async () => {
      const [type, id] = mediaId.split('/');
      if (type !== 'movie' && type !== 'tv') throw new Error('Invalid media ID format');

      const { data } = await this.tmdb.get(`/${type}/${id}`, {
        params: { append_to_response: 'credits,recommendations,videos' },
      });

      const title = data.title || data.name;
      // Trailer: first YouTube Trailer, else Teaser. Already fetched via
      // append_to_response=videos — just surface the key (was dropped).
      const vids = ((data.videos && data.videos.results) || []).filter((v) => v.site === 'YouTube' && v.key);
      const trailer =
        (vids.find((v) => v.type === 'Trailer') || vids.find((v) => v.type === 'Teaser') || {}).key || null;
      // IMDb id powers torrent fallback + subtitle search (cached 7d upstream).
      let imdbId = null;
      try {
        imdbId = await this._imdbId(type, id);
      } catch (e) {}
      const info = {
        id: `${type}/${data.id}`,
        title,
        trailer,
        imdbId,
        cover: this._img(data.backdrop_path),
        image: this._img(data.poster_path),
        description: data.overview,
        type: type === 'movie' ? TvType.MOVIE : TvType.TVSERIES,
        releaseDate: data.release_date || data.first_air_date,
        genres: (data.genres || []).map((g) => g.name),
        casts: (data.credits?.cast || []).slice(0, 15).map((c) => c.name),
        production: (data.production_companies || []).slice(0, 3).map((c) => c.name),
        country: (data.production_countries || []).map((c) => c.name),
        duration: type === 'movie' ? `${data.runtime || 0} min` : undefined,
        rating: data.vote_average || 0,
        recommendations: (data.recommendations?.results || []).slice(0, 12).map((row) => this._item(type, row, type)),
      };

      // episodes for TV — ALL seasons fetched in parallel (was sequential:
      // 8 seasons = 8 round-trips ≈ 2.5s; now ≈ one round-trip)
      if (type === 'tv') {
        const seasonCount = Math.min(data.number_of_seasons || 0, 10);
        const seasonResults = await Promise.all(
          Array.from({ length: seasonCount }, (_, i) =>
            this.tmdb
              .get(`/tv/${id}/season/${i + 1}`)
              .then((season) => season.data.episodes || [])
              .catch(() => null) // season with no episodes — skip, keep the rest
          )
        );
        info.episodes = [];
        seasonResults.forEach((eps, i) => {
          if (!eps) return;
          const s = i + 1;
          for (const ep of eps) {
            info.episodes.push({
              id: `${s}-${ep.episode_number}`,
              title: ep.name,
              number: ep.episode_number,
              season: s,
            });
          }
        });
      } else {
        info.episodes = [{ id, title, number: 1, season: 1 }];
      }

      return info;
    });
  }

  // ---- servers & sources ----

  async fetchEpisodeServers() {
    return SERVERS.map((server) => ({ name: server.name }));
  }

  async fetchEpisodeSources(episodeId, mediaId, server = null, skip = []) {
    // 60s TTL: server-button churn on the watch page is instant, while token
    // expiries are still too short for anything longer. resolveStream already
    // negative-caches dead providers, so a stale hit that 404s just falls
    // through to the auto-cycle. `skip` (providers the client's fallback
    // cascade already failed) is part of the cache key.
    const sk = [...(skip || [])].sort().join(',');
    return this._cached(`sources:${episodeId}:${mediaId}:${server || 'auto'}:${sk}`, 60 * 1000, () => this._episodeSources(episodeId, mediaId, server, skip));
  }

  // Shared mediaId/episodeId parsing for the sources and subtitles endpoints.
  _parseMedia(episodeId, mediaId) {
    const [type, id] = String(mediaId).split('/');
    if (!type || !id) throw new Error('mediaId must be movie/{id} or tv/{id}');

    let season = 1;
    let episode = 1;
    if (type === 'tv') {
      const m = String(episodeId || '').match(/^(?:s)?(\d+)(?:e|[-/])(\d+)$/i);
      if (m) {
        season = m[1];
        episode = m[2];
      } else if (String(episodeId).includes('-')) {
        [season, episode] = String(episodeId).split('-');
      }
    }
    return { type, id, season, episode };
  }

  // Merge English (SubDL/OpenSubtitles — English by API contract) with the
  // built-in family tracks, deduped. ENGLISH-ONLY: built-in non-English tracks
  // are dropped — the app only ever surfaces EN subs. OS/SubDL results pass
  // through untouched since their labels are release names, not language names.
  _mergeSubtitles(osSubs, subs, vsubs) {
    const isEnglish = (track) => /english|\beng\b|\ben\b/i.test(`${track.label || ''} ${track.lang || ''}`);
    const builtIn = [...subs, ...vsubs].filter(isEnglish); // drop non-EN family tracks
    const merged = [...osSubs, ...builtIn];
    const seen = new Set();
    return merged.filter((track) => {
      const dedupeKey = track.label || track.lang || 'unknown';
      if (seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);
      return true;
    });
  }

  /**
   * Serve only VERIFIED-working subtitle tracks: fetch the head of each URL and
   * keep tracks that answer with actual subtitle text (VTT header or SRT cue
   * arrows). Dead hosts, expiring links, rate-limit responses and binary zips
   * are dropped — the player's dropdown then only lists tracks that load.
   * Runs on the /subtitles path only (never blocks playback).
   */
  async _validateSubtitles(subs) {
    const SELF = `http://127.0.0.1:${process.env.PORT || 3000}`; // for local routes (/subtitles/subdl)
    const check = async (track) => {
      const cached = SUB_VALID_CACHE.get(track.url);
      if (cached && Date.now() - cached.ts < SUB_VALID_TTL) return cached.ok ? track : null;
      try {
        const url = track.url.startsWith('/') ? SELF + track.url : track.url;
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) return null;
        const head = (await response.text()).slice(0, 4000);
        const ok = /^WEBVTT/m.test(head) || /-->/m.test(head); // subtitle text, not a zip/html/error
        SUB_VALID_CACHE.set(track.url, { ok, ts: Date.now() });
        return ok ? track : null;
      } catch (e) {
        SUB_VALID_CACHE.set(track.url, { ok: false, ts: Date.now() });
        return null;
      }
    };
    const results = await Promise.all(subs.slice(0, 8).map(check));
    return results.filter(Boolean).slice(0, 6);
  }

  /**
   * Subtitle tracks ONLY. The browser fires this IN PARALLEL with playback and
   * attaches tracks whenever it lands — so unlike /sources there is no reason
   * to be stingy: generous-but-bounded budget, never blocking first frame.
   * Every returned track is validated server-side first.
   */
  async fetchEpisodeSubtitles(episodeId, mediaId) {
    const { type, id, season, episode } = this._parseMedia(episodeId, mediaId);
    const budgetMs = 6000;
    const imdbId = await this._imdbId(type, id);
    const [subs, vsubs, osSubs] = await Promise.all([
      withDeadline(fetchSubtitles(type, id, season, episode), budgetMs),
      withDeadline(fetchVidnestSubtitles(type, id, season, episode), budgetMs),
      imdbId ? withDeadline(fetchEnglishSubtitles({ type, imdbId, season, episode }), budgetMs) : [],
    ]);
    const valid = await this._validateSubtitles(this._mergeSubtitles(osSubs, subs, vsubs));
    // NOTE: no pre-signed `play` here — proxied tracks are fetched with the
    // CURRENT source's referer, known only client-side at pick time. The
    // player mints those on demand via GET /sign (same-origin CORS).
    return valid;
  }

  async _episodeSources(episodeId, mediaId, server = null, skip = []) {
    const { type, id, season, episode } = this._parseMedia(episodeId, mediaId);

    // FIRST FRAME IS THE ONLY CONTRACT ON THIS PATH. Zero subtitle work — not
    // even deadline-raced. Tracks are decoration the browser pulls separately
    // from GET /subtitles (fetchEpisodeSubtitles) and attaches after playback
    // starts, so even a fully dead subtitle API cannot delay one frame here.
    const stream = await resolveStream({ type, id, season, episode, server, skip });

    // Pre-sign proxy URLs so the Worker can reject hotlinkers. Unsigned
    // fallback stays working while PLAY_SIGNING_KEY is unset or the Worker
    // runs in warn mode (REQUIRE_SIGNED!=1).
    const sources = (stream.sources || []).map((source) => ({
      ...source,
      play: signPlayUrl({ url: source.url, referer: source.referer, origin: source.origin }) || undefined,
    }));

    // NOTE: no embedUrl — the old myflixerfree.to referral links were unused
    // by the frontend (navigation uses hash routes + media IDs).
    return {
      headers: { Referer: 'https://peachify.top/' },
      sources,
      subtitles: [], // intentionally empty — tracks come from /subtitles
      provider: stream.provider,
      server: stream.provider,
    };
  }

  async fetchMovieEmbedLinks(movieId, serverName = null) {
    const servers = serverName ? SERVERS.filter((server) => server.name === serverName) : SERVERS;
    const results = [];
    for (const server of servers) {
      try {
        const stream = await resolveStream({ type: 'movie', id: movieId, server: server.name });
        results.push({
          server: server.name,
          url: stream.sources[0]?.url || null,
          isM3U8: stream.sources[0]?.isM3U8 ?? false,
        });
      } catch (error) {
        console.error(`[embed] ${server.name} failed for ${movieId}:`, error.message);
      }
    }
    return { id: movieId, sources: results };
  }

  async fetchTvEpisodeEmbedLinks(episodeId, serverName = null) {
    // episodeId format: {season}-{episode}?{tvId} -> tvId comes from mediaId query in server.js;
    // here we parse "tvId:s-e" when passed directly.
    const [tvId, se] = episodeId.includes(':') ? episodeId.split(':') : [null, episodeId];
    if (!tvId) throw new Error('episodeId must be tvId:s{e} e.g. 1396:1-3');
    const m = se.match(/^(\d+)-(\d+)$/);
    if (!m) throw new Error('episodeId must be tvId:s{e} e.g. 1396:1-3');
    const [, season, episode] = m;

    const servers = serverName ? SERVERS.filter((server) => server.name === serverName) : SERVERS;
    const results = [];
    for (const server of servers) {
      try {
        const stream = await resolveStream({ type: 'tv', id: tvId, season, episode, server: server.name });
        results.push({
          server: server.name,
          url: stream.sources[0]?.url || null,
          isM3U8: stream.sources[0]?.isM3U8 ?? false,
        });
      } catch (error) {
        console.error(`[embed] ${server.name} failed for tv ${tvId} ${se}:`, error.message);
      }
    }
    return { id: episodeId, sources: results };
  }

  // Audio languages across the dub-capable peachify servers (iron/multi serve
  // the same title in Original Audio/Hindi/French/... variants). Lets the audio
  // dropdown offer a language even when the current server has only one track.
  async fetchDubs(episodeId, mediaId) {
    // 10 min TTL — the dub list is title-level, doesn't change often
    return this._cached(`dubs:${episodeId}:${mediaId}`, 10 * 60 * 1000, () => this._fetchDubs(episodeId, mediaId));
  }

  async _fetchDubs(episodeId, mediaId) {
    const [type, id] = mediaId.split('/');
    if (!type || !id) throw new Error('mediaId must be movie/{id} or tv/{id}');

    let season = 1;
    let episode = 1;
    if (type === 'tv') {
      const m = String(episodeId || '').match(/^(?:s)?(\d+)(?:e|[-/])(\d+)$/i);
      if (m) {
        season = m[1];
        episode = m[2];
      } else if (episodeId.includes('-')) {
        [season, episode] = episodeId.split('-');
      }
    }

    const out = {};
    await Promise.all(
      ['iron', 'multi'].map(async (server) => {
        try {
          const stream = await resolveStream({ type, id, season, episode, server });
          out[server] = [...new Set(stream.sources.map((source) => source.dub).filter(Boolean))];
        } catch (e) {
          out[server] = [];
        }
      })
    );
    return out;
  }

  // ---- listings ----

  async fetchRecentMovies() {
    // 10 min TTL — home-page sections resolve instantly on revisit
    return this._cached('recent:movies', 10 * 60 * 1000, async () => {
      const { data } = await this.tmdb.get('/movie/now_playing');
      return data.results.slice(0, 20).map((row) => this._item('movie', row, 'movie'));
    });
  }

  async fetchRecentTvShows() {
    return this._cached('recent:tv', 10 * 60 * 1000, async () => {
      const { data } = await this.tmdb.get('/tv/on_the_air');
      return data.results.slice(0, 20).map((row) => this._item('tv', row, 'tv'));
    });
  }

  async fetchTrendingMovies() {
    return this._cached('trending:movies', 10 * 60 * 1000, async () => {
      const { data } = await this.tmdb.get('/trending/movie/week');
      return data.results.slice(0, 20).map((row) => this._item('movie', row, 'movie'));
    });
  }

  async fetchTrendingTvShows() {
    return this._cached('trending:tv', 10 * 60 * 1000, async () => {
      const { data } = await this.tmdb.get('/trending/tv/week');
      return data.results.slice(0, 20).map((row) => this._item('tv', row, 'tv'));
    });
  }

  async fetchMoviesByPage(page = 1) {
    return this._discover('movie', page);
  }

  async fetchTvShowsByPage(page = 1) {
    return this._discover('tv', page);
  }

  async fetchByGenre(genre, page = 1) {
    const genres = await this._genres();
    const id = genres[String(genre).toLowerCase()];
    if (!id) throw new Error(`Genre '${genre}' not found`);
    return this._discover('movie', page, { with_genres: id });
  }

  async fetchTopIMDB(type = 'all', page = 1, minVote) {
    if (type === 'all') {
      // merge movie + tv pages (page 1 of each)
      const [movies, tv] = await Promise.all([
        this._discover('movie', 1, { sort_by: 'vote_average.desc', 'vote_count.gte': 500 }),
        this._discover('tv', 1, { sort_by: 'vote_average.desc', 'vote_count.gte': 500 }),
      ]);
      return {
        currentPage: page,
        hasNextPage: false,
        results: [...movies.results, ...tv.results].sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, 40),
      };
    }
    if (type !== 'movie' && type !== 'tv') throw new Error("type must be 'movie', 'tv' or 'all'");
    const params = { sort_by: 'vote_average.desc', 'vote_count.gte': 500 };
    if (minVote) params['vote_average.gte'] = minVote; // e.g. 7.5 → "IMDb 7.5+" list
    return this._discover(type, page, params);
  }
}

module.exports = CinephileHQ;
