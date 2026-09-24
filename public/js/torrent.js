// Torrent fallback: last resort when every server is dead.
// Movies via YTS public API, TV via EZTV public API — no keys, no hosting.
// Only browser-playable containers (.mp4/.webm; scene .mkv can't MSE-play)
// with at least one seed are returned. Everything else -> null (caller shows
// the normal "no sources" error, nothing changes for server playback).
const Torrent = (() => {
  const YTS_BASE = 'https://yts.mx/api/v2/list_movies.json';
  const EZTV_BASE = 'https://eztv.ag/api/get-torrents';
  const FETCH_TIMEOUT = 9000;

  // Public trackers baked into YTS magnets (YTS API returns bare hashes).
  // Browsers can't use udp:// trackers (no raw sockets) — the wss:// ones
  // below are what actually connect WebRTC peers. WebTorrent also ships
  // defaults, but explicit is better for magnet portability.
  const TRACKERS = [
    'wss://tracker.openwebtorrents.com:443/announce',
    'wss://tracker.btorrent.xyz:443/announce',
    'wss://tracker.fastcast.nz:443/announce',
    'udp://open.demonii.com:1337/announce',
    'udp://tracker.openbittorrent.com:80/announce',
    'udp://tracker.coppersurfer.tk:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.torrent.eu.org:451/announce',
  ];

  async function getJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function ytsMagnet(hash, name) {
    const params = new URLSearchParams({ xt: `urn:btih:${hash}`, dn: name });
    for (const tracker of TRACKERS) params.append('tr', tracker);
    return `magnet:?${params.toString()}`;
  }

  function playableVideoFile(name) {
    return /\.(mp4|webm|m4v)($|\?)/i.test(name || '');
  }

  async function movieTorrents(imdbId) {
    if (!imdbId) return null;
    const data = await getJson(`${YTS_BASE}?query_term=${encodeURIComponent(imdbId)}&sort_by=seeds&limit=5`);
    const movies = (data && data.data && data.data.movies) || [];
    if (!movies.length) return null;
    const torrents = [];
    for (const movie of movies.slice(0, 2)) {
      for (const torrent of movie.torrents || []) {
        if ((torrent.seeds || 0) <= 0) continue;
        torrents.push({
          magnet: ytsMagnet(torrent.hash, `${movie.title_long || movie.title} [${torrent.quality}]`),
          name: `${movie.title} [${torrent.quality}]`,
          quality: torrent.quality || 'auto',
          seeds: torrent.seeds,
          size: torrent.size || '',
        });
      }
    }
    // YTS rips ship .mp4 — playable. Sort best-seeded first.
    torrents.sort((a, b) => b.seeds - a.seeds);
    return torrents[0] || null;
  }

  async function episodeTorrents(imdbId, season, episode) {
    if (!imdbId) return null;
    const numericId = String(imdbId).replace(/^tt/, '');
    const data = await getJson(`${EZTV_BASE}?imdb_id=${encodeURIComponent(numericId)}&limit=100`);
    const rows = (data && data.torrents) || [];
    const seasonNum = Number(season);
    const epNum = Number(episode);
    const matches = [];
    for (const row of rows) {
      if (Number(row.season) !== seasonNum || Number(row.episode) !== epNum) continue;
      if ((row.seeds || 0) <= 0) continue;
      if (!playableVideoFile(row.filename || row.title)) continue; // scene .mkv won't MSE-play
      if (!row.magnet_url) continue;
      matches.push({
        magnet: row.magnet_url,
        name: row.title || row.filename,
        quality: /2160|4k/i.test(row.filename || '') ? '2160p' : /1080/i.test(row.filename || '') ? '1080p' : /720/i.test(row.filename || '') ? '720p' : 'auto',
        seeds: row.seeds,
        size: row.size_bytes ? `${Math.round(row.size_bytes / 1048576)} MB` : '',
      });
    }
    matches.sort((a, b) => b.seeds - a.seeds);
    return matches[0] || null;
  }

  async function resolve({ type, imdbId, season, episode }) {
    try {
      if (!imdbId) return null;
      if (type === 'tv') return await episodeTorrents(imdbId, season, episode);
      return await movieTorrents(imdbId);
    } catch (e) {
      return null;
    }
  }

  return { resolve, movie: movieTorrents, episode: episodeTorrents };
})();
