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
    const same = (typeof location !== 'undefined' && location.origin) || '';
    const direct = [same, ...MIRRORS.filter((m) => m !== same)].filter(Boolean);
    const list = [API_PROXY, ...direct.filter((b) => b !== API_PROXY)];
    let pinned = '';
    try {
      const raw = localStorage.getItem(PIN_KEY);
      if (raw) {
        const { base, ts } = JSON.parse(raw);
        if (base && Date.now() - ts < PIN_TTL) pinned = base;
      }
    } catch {}
    if (pinned && pinned !== list[0]) return [pinned, ...list.filter((b) => b !== pinned)];
    return list;
  }

  function pin(base) {
    try {
      localStorage.setItem(PIN_KEY, JSON.stringify({ base, ts: Date.now() }));
    } catch {}
  }

  async function get(path) {
    let lastErr = null;
    for (const base of bases()) {
      let res;
      try {
        res = await fetch(base + path);
      } catch (e) {
        lastErr = e; // network down / backend dead -> try next mirror
        continue;
      }
      if (res.ok) {
        pin(base);
        return res.json();
      }
      // 429/5xx may succeed on the mirror; 4xx will fail everywhere — stop.
      if (res.status !== 429 && res.status < 500) {
        let msg = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j.error) msg = j.error;
        } catch (e) {}
        throw new Error(msg);
      }
      try {
        const j = await res.json();
        lastErr = new Error((j && j.error) || `HTTP ${res.status}`);
      } catch (e) {
        lastErr = new Error(`HTTP ${res.status}`);
      }
    }
    throw lastErr || new Error('All API backends failed');
  }

  return {
    get,
    search: (q, page = 1) => get(`/search?query=${encodeURIComponent(q)}&page=${page}`),
    info: (mediaId) => get(`/info/${mediaId}`),
    sources: (mediaId, episodeId = '1-1', server = null, skip = []) => {
      const p = new URLSearchParams({ mediaId });
      if (server) p.set('server', server);
      if (skip && skip.length) p.set('skip', skip.join(','));
      return get(`/sources/${episodeId}?${p}`);
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
