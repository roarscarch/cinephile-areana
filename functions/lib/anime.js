// functions/lib/anime.js — anime catalog + streams for the Cloudflare Pages
// mirror (Workers runtime: fetch only, no Node APIs).
//
// Metadata: Jikan (the public MAL API) — AniList deliberately blocks
// Cloudflare Workers egress ("manually blocked"), while Jikan is MAL-native
// and reachable from the edge. Items are keyed by MAL id so links stay valid
// across the Vercel (AniList) and Pages (Jikan) deployments.
//
// Streams: Megaplay MAL-keyed HLS, decrypted via enc-dec.app (identical to
// src/services/anime.js).

// Metadata upstream: AniList AND Jikan both refuse/lag Cloudflare Workers
// egress (AniList returns 403 "manually blocked"), but the Vercel deployment
// (Node runtime) reaches AniList fine. The edge therefore proxies METADATA
// from the canonical Vercel backend, while streams (Megaplay/enc-dec, reached
// natively) are resolved right here. cachedJson at the route layer keeps the
// hop cost amortised, and items are MAL-keyed on both deployments so links
// are interchangeable.
const META_BACKENDS = ['https://cinephilia-vercel.vercel.app', 'https://cinephiles-areana.vercel.app'];
const MEGAPLAY_BASE = 'https://megaplay.buzz';
const ENCDEC_DEC = 'https://enc-dec.app/api/dec-megaplay';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

async function reqJson(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function metaGet(path) {
  let lastErr = null;
  for (const base of META_BACKENDS) {
    try {
      return await reqJson(`${base}${path}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('anime metadata backend unavailable');
}

const trending = (page = 1) => metaGet(`/anime/trending?page=${page}`);
const popular = (page = 1) => metaGet(`/anime/popular?page=${page}`);
const topRated = (page = 1) => metaGet(`/anime/top?page=${page}`);
const search = (term, page = 1) => metaGet(`/anime/search?q=${encodeURIComponent(term)}&page=${page}`);
const info = (id) => metaGet(`/anime/info/${encodeURIComponent(id)}`);

async function resolveSources({ malId, episode = 1, dub = false }) {
  if (!malId) throw new Error('anime sources require a MAL id');
  const voice = dub ? 'dub' : 'sub';
  const headers = {
    'User-Agent': UA,
    Origin: MEGAPLAY_BASE,
    Referer: `${MEGAPLAY_BASE}/`,
    'X-Requested-With': 'XMLHttpRequest',
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const pageRes = await fetch(`${MEGAPLAY_BASE}/stream/mal/${malId}/${episode}/${voice}`, { headers, signal: ctrl.signal });
    const page = await pageRes.text();
    const m = page.match(/<title>(?:File (\d+)|Error) - MegaPlay<\/title>/);
    if (!m || !m[1]) throw new Error(`megaplay: no ${voice} source for episode ${episode}`);
    const contentId = m[1];

    const srcRes = await fetch(`${MEGAPLAY_BASE}/stream/getSources?id=${encodeURIComponent(contentId)}&platform=OTHER`, {
      headers, signal: ctrl.signal,
    });
    const payload = await srcRes.json();
    if (!payload.enc) throw new Error('megaplay: missing encrypted payload');

    const decRes = await fetch(ENCDEC_DEC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: payload.enc }),
      signal: ctrl.signal,
    });
    const dec = await decRes.json();
    if (!dec || dec.status !== 200 || !dec.result) throw new Error('megaplay: decrypt failed');
    const merged = { ...payload, ...dec.result };

    const file =
      merged.file ||
      merged.url ||
      (Array.isArray(merged.sources) && merged.sources[0] && (merged.sources[0].file || merged.sources[0].url));
    if (!file) throw new Error('megaplay: no stream url');

    const subtitles = (merged.tracks || [])
      .filter((t) => t && t.file && String(t.kind || '').toLowerCase() === 'captions')
      .map((t) => ({ url: t.file, label: t.label || 'Subtitles', lang: t.label || null, default: Boolean(t.default) }));

    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const intro = merged.intro ? { start: num(merged.intro.start), end: num(merged.intro.end) } : null;
    const outro = merged.outro ? { start: num(merged.outro.start), end: num(merged.outro.end) } : null;

    return {
      url: file,
      isM3U8: /\.m3u8($|\?)|\/master\./i.test(file),
      subtitles,
      intro,
      outro,
      image: merged.image || null,
      voice,
      referer: `${MEGAPLAY_BASE}/`,
      origin: MEGAPLAY_BASE,
    };
  } finally {
    clearTimeout(timer);
  }
}

export { trending, popular, topRated, search, info, resolveSources };
