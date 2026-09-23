// functions/lib/flix.js — FlixHQ (TMDB + orchestration) ported to Workers runtime.
//
// Same logic as src/services/tmdb.js. Adaptations:
//   axios instance      -> tmdbGet() on native fetch
//   _validateSubtitles loopback via 127.0.0.1 -> direct fetchSubdlVtt() call
//   env comes from constructor (Pages/Workers bindings), not process.env

import { resolveStream, fetchSubtitles, fetchVidnestSubtitles, PROVIDERS, VIDNEST_PROVIDERS, signPlayUrl } from './ex.js';
import { fetchEnglishSubtitles, fetchSubdlVtt } from './subs.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
const SERVERS = [...PROVIDERS, ...VIDNEST_PROVIDERS];

function withDeadline(promise, ms) {
  let t;
  const cap = new Promise((resolve) => {
    t = setTimeout(() => resolve([]), ms);
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(t));
}

const SUB_VALID_CACHE = new Map();
const SUB_VALID_TTL = 10 * 60 * 1000;

export class FlixHQ {
  constructor(env) {
    if (!env.TMDB_API_KEY) throw new Error('TMDB_API_KEY env required');
    this.env = env;
    this.name = 'MyFlixHQ';
    this.baseUrl = 'https://myflixerfree.to';
    this._genresCache = null;
    this._cache = new Map();
  }

  async tmdbGet(path, params = {}, timeout = 12000) {
    const q = new URLSearchParams({ api_key: this.env.TMDB_API_KEY, ...params });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(`${TMDB_BASE}${path}?${q}`, { signal: ctrl.signal });
      if (!r.ok) {
        const e = new Error(`TMDB ${r.status}`);
        e.status = r.status;
        throw e;
      }
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  _cached(key, ttlMs, fn) {
    const now = Date.now();
    const hit = this._cache.get(key);
    if (hit) {
      if (hit.exp > now) return hit.promise;
      this._cache.delete(key);
    }
    const p = Promise.resolve()
      .then(fn)
      .then((v) => {
        this._cache.set(key, { exp: Date.now() + ttlMs, promise: Promise.resolve(v) });
        return v;
      })
      .catch((e) => {
        this._cache.delete(key);
        throw e;
      });
    this._cache.set(key, { exp: now + ttlMs, promise: p });
    if (this._cache.size > 600) {
      const t = Date.now();
      for (const [k, v] of this._cache) if (v.exp < t) this._cache.delete(k);
    }
    return p;
  }

  _imdbId(type, id) {
    return this._cached(`imdb:${type}:${id}`, 7 * 24 * 60 * 60 * 1000, async () => {
      try {
        const data = await this.tmdbGet(`/${type}/${id}/external_ids`);
        return data.imdb_id || null;
      } catch {
        return null;
      }
    });
  }

  _img(path) {
    return path ? `${IMAGE_BASE}${path}` : null;
  }

  _playerUrl(type, id, title, season, episode) {
    const params = new URLSearchParams({ id, type, title: title || 'Watch Now' });
    if (type === 'tv' && season && episode) {
      params.set('season', season);
      params.set('episode', episode);
    }
    return `${this.baseUrl}/player?${params.toString()}`;
  }

  _item(id, tmdbItem, type) {
    const title = tmdbItem.title || tmdbItem.name;
    return {
      id: `${type}/${tmdbItem.id}`,
      title,
      url: this._playerUrl(type, tmdbItem.id, title),
      image: this._img(tmdbItem.poster_path || tmdbItem.backdrop_path),
      releaseDate: (tmdbItem.release_date || tmdbItem.first_air_date || '').split('-')[0] || undefined,
      type: type === 'movie' ? 'MOVIE' : 'TVSERIES',
      rating: tmdbItem.vote_average || 0,
    };
  }

  async _genres() {
    if (!this._genresCache) {
      const [movies, tv] = await Promise.all([
        this.tmdbGet('/genre/movie/list'),
        this.tmdbGet('/genre/tv/list'),
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
    const key = `discover:${type}:${page}:${JSON.stringify(extra)}`;
    return this._cached(key, 10 * 60 * 1000, async () => {
      const data = await this.tmdbGet(`/discover/${type}`, { page, sort_by: 'popularity.desc', ...extra });
      return {
        currentPage: data.page,
        hasNextPage: data.page < data.total_pages,
        results: data.results.map((r) => this._item(type, r, type)),
      };
    });
  }

  async search(query, page = 1) {
    return this._cached(`search:${query}:${page}`, 5 * 60 * 1000, async () => {
      const data = await this.tmdbGet('/search/multi', { query, page, include_adult: 'false' });
      const results = data.results
        .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
        .map((r) => this._item(r.media_type, r, r.media_type));
      return { currentPage: data.page, hasNextPage: data.page < data.total_pages, results };
    });
  }

  async fetchMediaInfo(mediaId) {
    return this._cached(`info:${mediaId}`, 15 * 60 * 1000, async () => {
      const [type, id] = mediaId.split('/');
      if (type !== 'movie' && type !== 'tv') throw new Error('Invalid media ID format');
      const data = await this.tmdbGet(`/${type}/${id}`, { append_to_response: 'credits,recommendations,videos' });
      const title = data.title || data.name;
      const info = {
        id: `${type}/${data.id}`,
        title,
        url: this._playerUrl(type, data.id, title),
        cover: this._img(data.backdrop_path),
        image: this._img(data.poster_path),
        description: data.overview,
        type: type === 'movie' ? 'MOVIE' : 'TVSERIES',
        releaseDate: data.release_date || data.first_air_date,
        genres: (data.genres || []).map((g) => g.name),
        casts: ((data.credits && data.credits.cast) || []).slice(0, 15).map((c) => c.name),
        production: (data.production_companies || []).slice(0, 3).map((c) => c.name),
        country: (data.production_countries || []).map((c) => c.name),
        duration: type === 'movie' ? `${data.runtime || 0} min` : undefined,
        rating: data.vote_average || 0,
        recommendations: ((data.recommendations && data.recommendations.results) || [])
          .slice(0, 12)
          .map((r) => this._item(type, r, type)),
      };
      if (type === 'tv') {
        const seasonCount = Math.min(data.number_of_seasons || 0, 10);
        const seasonResults = await Promise.all(
          Array.from({ length: seasonCount }, (_, i) =>
            this.tmdbGet(`/tv/${id}/season/${i + 1}`)
              .then((r) => r.episodes || [])
              .catch(() => null)
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
              url: this._playerUrl('tv', data.id, title, s, ep.episode_number),
            });
          }
        });
      } else {
        info.episodes = [{ id, title, number: 1, season: 1, url: this._playerUrl('movie', data.id, title) }];
      }
      return info;
    });
  }

  async fetchEpisodeServers() {
    return SERVERS.map((s) => ({ name: s.name }));
  }

  async fetchEpisodeSources(episodeId, mediaId, server = null, skip = []) {
    const sk = [...(skip || [])].sort().join(',');
    return this._cached(
      `sources:${episodeId}:${mediaId}:${server || 'auto'}:${sk}`,
      60 * 1000,
      () => this._episodeSources(episodeId, mediaId, server, skip)
    );
  }

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

  _mergeSubtitles(osSubs, subs, vsubs) {
    const isEn = (s) => /english|\beng\b|\ben\b/i.test(`${s.label || ''} ${s.lang || ''}`);
    const builtIn = [...subs, ...vsubs].filter(isEn);
    const merged = [...osSubs, ...builtIn];
    const seen = new Set();
    return merged.filter((s) => {
      const k = s.label || s.lang || 'unknown';
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  async _validateSubtitles(subs) {
    const check = async (s) => {
      const cached = SUB_VALID_CACHE.get(s.url);
      if (cached && Date.now() - cached.ts < SUB_VALID_TTL) return cached.ok ? s : null;
      try {
        let head;
        if (s.url.startsWith('/subtitles/subdl?')) {
          // Local route — resolve in-process instead of HTTP loopback.
          const q = new URLSearchParams(s.url.split('?')[1]);
          head = (await fetchSubdlVtt(this.env, q.get('zip'), q.get('ep'))).slice(0, 4000);
        } else {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 5000);
          try {
            const r = await fetch(s.url, { signal: ctrl.signal });
            if (!r.ok) return null;
            head = (await r.text()).slice(0, 4000);
          } finally {
            clearTimeout(t);
          }
        }
        const ok = /^WEBVTT/m.test(head) || /-->/m.test(head);
        SUB_VALID_CACHE.set(s.url, { ok, ts: Date.now() });
        return ok ? s : null;
      } catch {
        SUB_VALID_CACHE.set(s.url, { ok: false, ts: Date.now() });
        return null;
      }
    };
    const results = await Promise.all(subs.slice(0, 8).map(check));
    return results.filter(Boolean).slice(0, 6);
  }

  async fetchEpisodeSubtitles(episodeId, mediaId) {
    const { type, id, season, episode } = this._parseMedia(episodeId, mediaId);
    const budgetMs = 6000;
    const imdbId = await this._imdbId(type, id);
    const [subs, vsubs, osSubs] = await Promise.all([
      withDeadline(fetchSubtitles(this.env, type, id, season, episode), budgetMs),
      withDeadline(fetchVidnestSubtitles(type, id, season, episode), budgetMs),
      imdbId ? withDeadline(fetchEnglishSubtitles(this.env, { type, imdbId, season, episode }), budgetMs) : [],
    ]);
    return this._validateSubtitles(this._mergeSubtitles(osSubs, subs, vsubs));
  }

  async _episodeSources(episodeId, mediaId, server = null, skip = []) {
    const { type, id, season, episode } = this._parseMedia(episodeId, mediaId);
    const stream = await resolveStream(this.env, { type, id, season, episode, server, skip });
    const sources = [];
    for (const s of stream.sources || []) {
      sources.push({
        ...s,
        play: (await signPlayUrl(this.env, { url: s.url, referer: s.referer, origin: s.origin })) || undefined,
      });
    }
    const embedUrl = this._playerUrl(type, id, '', season, episode);
    return {
      headers: { Referer: 'https://peachify.top/' },
      sources,
      subtitles: [],
      provider: stream.provider,
      server: stream.provider,
      embedUrl,
    };
  }

  async fetchMovieEmbedLinks(movieId, serverName = null) {
    const servers = serverName ? SERVERS.filter((s) => s.name === serverName) : SERVERS;
    const results = [];
    for (const s of servers) {
      try {
        const stream = await resolveStream(this.env, { type: 'movie', id: movieId, server: s.name });
        results.push({ server: s.name, url: (stream.sources[0] && stream.sources[0].url) || null, isM3U8: stream.sources[0] ? !!stream.sources[0].isM3U8 : false });
      } catch {}
    }
    return { id: movieId, sources: results };
  }

  async fetchTvEpisodeEmbedLinks(episodeId, serverName = null) {
    const [tvId, se] = episodeId.includes(':') ? episodeId.split(':') : [null, episodeId];
    if (!tvId) throw new Error('episodeId must be tvId:s{e} e.g. 1396:1-3');
    const m = se.match(/^(\d+)-(\d+)$/);
    if (!m) throw new Error('episodeId must be tvId:s{e} e.g. 1396:1-3');
    const [, season, episode] = m;
    const servers = serverName ? SERVERS.filter((s) => s.name === serverName) : SERVERS;
    const results = [];
    for (const s of servers) {
      try {
        const stream = await resolveStream(this.env, { type: 'tv', id: tvId, season, episode, server: s.name });
        results.push({ server: s.name, url: (stream.sources[0] && stream.sources[0].url) || null, isM3U8: stream.sources[0] ? !!stream.sources[0].isM3U8 : false });
      } catch {}
    }
    return { id: episodeId, sources: results };
  }

  async fetchDubs(episodeId, mediaId) {
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
          const res = await resolveStream(this.env, { type, id, season, episode, server });
          out[server] = [...new Set(res.sources.map((s) => s.dub).filter(Boolean))];
        } catch {
          out[server] = [];
        }
      })
    );
    return out;
  }

  async fetchRecentMovies() {
    return this._cached('recent:movies', 10 * 60 * 1000, async () => {
      const data = await this.tmdbGet('/movie/now_playing');
      return data.results.slice(0, 20).map((r) => this._item('movie', r, 'movie'));
    });
  }

  async fetchRecentTvShows() {
    return this._cached('recent:tv', 10 * 60 * 1000, async () => {
      const data = await this.tmdbGet('/tv/on_the_air');
      return data.results.slice(0, 20).map((r) => this._item('tv', r, 'tv'));
    });
  }

  async fetchTrendingMovies() {
    return this._cached('trending:movies', 10 * 60 * 1000, async () => {
      const data = await this.tmdbGet('/trending/movie/week');
      return data.results.slice(0, 20).map((r) => this._item('movie', r, 'movie'));
    });
  }

  async fetchTrendingTvShows() {
    return this._cached('trending:tv', 10 * 60 * 1000, async () => {
      const data = await this.tmdbGet('/trending/tv/week');
      return data.results.slice(0, 20).map((r) => this._item('tv', r, 'tv'));
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
    if (minVote) params['vote_average.gte'] = minVote;
    return this._discover(type, page, params);
  }
}
