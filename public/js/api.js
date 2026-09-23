// Thin client for the Cinephile API.
//
// Free load balancer: every call tries same-origin first, then the mirror
// backend. Either deployment can die and the app keeps working — no LB server
// to host, no request caps, nothing to pay. The winner is pinned per day so
// repeat calls reuse warm caches instead of flapping. (/sign stays
// same-origin by design — see player.js.)
const API = (() => {
  // One-time store rename (myflixerz-* -> cinephile-*): keeps resume
  // positions, volume, and prefs across the rebrand.
  try {
    const pairs = [
      ['myflixerz-progress', 'cinephile-progress'],
      ['myflixerz-volume', 'cinephile-volume'],
      ['myflixerz-quality', 'cinephile-quality'],
      ['myflixerz-audio', 'cinephile-audio'],
      ['myflixerz-subtitle', 'cinephile-subtitle'],
      ['myflixerz-subsync', 'cinephile-subsync'],
      ['myflixerz-api-base', 'cinephile-api-base'],
    ];
    for (const [o, n] of pairs) {
      if (localStorage.getItem(n) === null) {
        const v = localStorage.getItem(o);
        if (v !== null) {
          try {
            localStorage.setItem(n, v);
          } catch {}
        }
      }
    }
  } catch {}
  // Single-URL front (hides backend hostnames in normal operation); direct
  // mirrors are the fallback if the proxy itself ever fails.
  const API_PROXY = 'https://cinephile-api.cinephilia-areana.workers.dev';
  const MIRRORS = ['https://cinephilia-vercel.vercel.app', 'https://cinephile-areana.pages.dev'];
  const PIN_KEY = 'cinephile-api-base';
  const PIN_TTL = 24 * 60 * 60 * 1000;

  function bases() {
    const sameOrigin = (typeof location !== 'undefined' && location.origin) || '';
    const direct = [sameOrigin, ...MIRRORS.filter((mirror) => mirror !== sameOrigin)].filter(Boolean);
    const list = [API_PROXY, ...direct.filter((base) => base !== API_PROXY)];
    let pinned = '';
    try {
      const stored = localStorage.getItem(PIN_KEY);
      if (stored) {
        const { base, savedAt } = JSON.parse(stored);
        if (base && Date.now() - savedAt < PIN_TTL) pinned = base;
      }
    } catch {}
    if (pinned && pinned !== list[0]) return [pinned, ...list.filter((base) => base !== pinned)];
    return list;
  }

  function pin(base) {
    try {
      localStorage.setItem(PIN_KEY, JSON.stringify({ base, savedAt: Date.now() }));
    } catch {}
  }

  async function get(path, opts = {}) {
    const signal = opts.signal;
    let lastError = null;
    for (const base of bases()) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      let response;
      try {
        response = await fetch(base + path, signal ? { signal } : {});
      } catch (error) {
        if (signal && signal.aborted) throw error; // typed-ahead — never fail over
        lastError = error; // network down / backend dead -> try next mirror
        continue;
      }
      if (response.ok) {
        pin(base);
        return response.json();
      }
      // 429/5xx may succeed on the mirror; 4xx will fail everywhere — stop.
      if (response.status !== 429 && response.status < 500) {
        let message = `HTTP ${response.status}`;
        try {
          const body = await response.json();
          if (body.error) message = body.error;
        } catch (e) {}
        throw new Error(message);
      }
      try {
        const body = await response.json();
        lastError = new Error((body && body.error) || `HTTP ${response.status}`);
      } catch (e) {
        lastError = new Error(`HTTP ${response.status}`);
      }
    }
    throw lastError || new Error('All API backends failed');
  }

  return {
    get,
    search: (query, page = 1) => get(`/search?query=${encodeURIComponent(query)}&page=${page}`),
    info: (mediaId) => get(`/info/${mediaId}`),
    sources: (mediaId, episodeId = '1-1', server = null, skip = []) => {
      const params = new URLSearchParams({ mediaId });
      if (server) params.set('server', server);
      if (skip && skip.length) params.set('skip', skip.join(','));
      return get(`/sources/${episodeId}?${params}`);
    },
    // subtitle tracks — fired in parallel with sources(); result attaches late
    subtitles: (mediaId, episodeId = '1-1') =>
      get(`/subtitles/${episodeId}?${new URLSearchParams({ mediaId })}`),
    servers: () => get('/servers/1-1?mediaId=movie/1'),
    dubs: (mediaId, episodeId = '1-1') => get(`/dubs/${episodeId}?mediaId=${mediaId}`),
    row: (kind) => get(`/${kind}`),
    browse: (kind, page = 1) => get(`/${kind}?page=${page}`),
    genre: (genre, page = 1) => get(`/genre/${encodeURIComponent(genre)}?page=${page}`),
    topImdb: (type = 'all', page = 1) => get(`/top-imdb?type=${type}&page=${page}`),
    imdb75: (page = 1) => get(`/top-imdb?type=movie&page=${page}&minVote=7.5`),
  };
})();

// Upgrade a TMDB w500 URL to a bigger rendition.
//
// IMPORTANT: this used to jump straight to /original/, which is the source
// master — real backdrops are 300KB-2MB there, and router.js paints this URL
// as the (blurred, full-bleed) hero background of every detail page. /w1280 is
// visually identical behind a blurred backdrop at ~5x less bandwidth.
// Only upgrades paths that are already w500; anything else is returned as-is.
function hiRes(path) {
  return path ? path.replace('/w500/', '/w1280/') : null;
}
