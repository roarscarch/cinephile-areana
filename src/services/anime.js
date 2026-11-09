// src/services/anime.js — self-contained anime catalog + streams.
//
// Deliberately SEPARATE from the TMDB path: anime is keyed by AniList ids
// (which carry the MAL id), browsed/searched through AniList's public GraphQL
// API, and played through Megaplay's MAL-keyed player. Nothing here touches
// the movie/TV tables, so the anime section can never contaminate or be
// contaminated by the TMDB catalog.
//
// Streams: Megaplay serves per-episode HLS. The player page carries an
// internal content id; getSources returns an encrypted blob decrypted by
// enc-dec.app/api/dec-megaplay (same service the ecosystem's clients use),
// alongside subtitle tracks and intro/outro markers. Sub and dub are separate
// voice tracks (same mal id, different path segment).
const { httpClient } = require('../utils/http');

const ANILIST_URL = 'https://graphql.anilist.co';
const MEGAPLAY_BASE = 'https://megaplay.buzz';
const ENCDEC_DEC = 'https://enc-dec.app/api/dec-megaplay';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const MEDIA_FIELDS = `
  id
  idMal
  title { romaji english native }
  coverImage { extraLarge large }
  bannerImage
  averageScore
  startDate { year }
  episodes
  duration
  format
  status
  genres
  description(asHtml: false)
`;

// Tiny TTL memo — AniList is fast but rate-limited, and the home rows are hit
// on every visit.
const cache = new Map(); // key -> { exp, value }
function memo(key, ttlMs, factory) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const promise = factory().catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, { exp: Date.now() + ttlMs, value: promise });
  return promise;
}

async function anilist(query, variables) {
  const res = await httpClient.post(
    ANILIST_URL,
    { query, variables },
    {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
      timeout: 12000,
    }
  );
  const data = res.data;
  if (data && data.errors && data.errors.length) throw new Error(data.errors[0].message || 'AniList error');
  return data && data.data;
}

function normalizeMedia(m) {
  if (!m) return null;
  return {
    // Canonical id = MAL id so links stay valid across deployments (Vercel
    // uses AniList for metadata, the Cloudflare edge uses Jikan/MAL). Both
    // expose the same mal-keyed `id`. anilistId is kept for reference.
    id: m.idMal || m.id,
    anilistId: m.id,
    malId: m.idMal,
    title: (m.title && (m.title.english || m.title.romaji || m.title.native)) || 'Untitled',
    romaji: m.title && m.title.romaji,
    image: m.coverImage && (m.coverImage.extraLarge || m.coverImage.large),
    banner: m.bannerImage || null,
    year: (m.startDate && m.startDate.year) || null,
    rating: m.averageScore ? Math.round((m.averageScore / 10) * 10) / 10 : null,
    episodes: m.episodes || null,
    duration: m.duration || null,
    format: m.format || null,
    status: m.status || null,
    genres: m.genres || [],
    description: m.description || '',
  };
}

// sort: one of AniList's QuerySort values (constant, never user input).
function listMedia(sort, page, perPage) {
  const key = `list:${sort}:${page}`;
  return memo(key, 10 * 60 * 1000, async () => {
    const query = `query($page:Int,$perPage:Int){ Page(page:$page, perPage:$perPage){ media(type:ANIME, sort:${sort}, isAdult:false){ ${MEDIA_FIELDS} } } }`;
    const data = await anilist(query, { page, perPage });
    const media = (data && data.Page && data.Page.media) || [];
    return media.map(normalizeMedia).filter(Boolean);
  });
}

function searchMedia(term, page, perPage) {
  const key = `search:${term.toLowerCase()}:${page}`;
  return memo(key, 5 * 60 * 1000, async () => {
    const query = `query($page:Int,$perPage:Int,$search:String){ Page(page:$page, perPage:$perPage){ media(type:ANIME, search:$search, isAdult:false){ ${MEDIA_FIELDS} } } }`;
    const data = await anilist(query, { page, perPage, search: term });
    const media = (data && data.Page && data.Page.media) || [];
    return media.map(normalizeMedia).filter(Boolean);
  });
}

function info(id) {
  return memo(`info:${id}`, 10 * 60 * 1000, async () => {
    // Look up by MAL id first (the canonical id); fall back to AniList id for
    // the rare entries that have no idMal.
    const detail = `Media(idMal:$id, type:ANIME){
      ${MEDIA_FIELDS}
      recommendations(sort:RATING_DESC, perPage:12){ nodes { mediaRecommendation { ${MEDIA_FIELDS} } } }
    }`;
    let data = await anilist(`query($id:Int){ ${detail} }`, { id: Number(id) });
    let media = data && data.Media;
    if (!media) {
      data = await anilist(`query($id:Int){ Media(id:$id, type:ANIME){ ${MEDIA_FIELDS} } }`, { id: Number(id) });
      media = data && data.Media;
    }
    if (!media) throw new Error('Anime not found');
    const out = normalizeMedia(media);
    const recs = ((media.recommendations && media.recommendations.nodes) || [])
      .map((node) => normalizeMedia(node && node.mediaRecommendation))
      .filter(Boolean);
    out.recommendations = recs;
    return out;
  });
}

// Megaplay player flow: page (content id) -> getSources (enc) -> dec-megaplay.
function resolveSources({ malId, episode = 1, dub = false }) {
  if (!malId) throw new Error('anime sources require a MAL id');
  const voice = dub ? 'dub' : 'sub';
  const key = `src:${malId}:${episode}:${voice}`;
  return memo(key, 5 * 60 * 1000, async () => {
    const headers = {
      'User-Agent': UA,
      Origin: MEGAPLAY_BASE,
      Referer: `${MEGAPLAY_BASE}/`,
      'X-Requested-With': 'XMLHttpRequest',
    };
    const pageRes = await httpClient.get(`${MEGAPLAY_BASE}/stream/mal/${malId}/${episode}/${voice}`, {
      headers, timeout: 12000,
    });
    const page = String(pageRes.data || '');
    const m = page.match(/<title>(?:File (\d+)|Error) - MegaPlay<\/title>/);
    if (!m || !m[1]) throw new Error(`megaplay: no ${voice} source for episode ${episode}`);
    const contentId = m[1];

    const srcRes = await httpClient.get(`${MEGAPLAY_BASE}/stream/getSources`, {
      params: { id: contentId, platform: 'OTHER' },
      headers, timeout: 12000,
    });
    const payload = srcRes.data || {};
    if (!payload.enc) throw new Error('megaplay: missing encrypted payload');

    const decRes = await httpClient.post(
      ENCDEC_DEC,
      { text: payload.enc },
      { headers: { 'Content-Type': 'application/json' }, timeout: 12000 }
    );
    if (!decRes.data || decRes.data.status !== 200 || !decRes.data.result) {
      throw new Error('megaplay: decrypt failed');
    }
    const merged = { ...payload, ...decRes.data.result };

    const file = merged.file || merged.url || (Array.isArray(merged.sources) && merged.sources[0] && (merged.sources[0].file || merged.sources[0].url));
    if (!file) throw new Error('megaplay: no stream url');

    const subtitles = (merged.tracks || [])
      .filter((t) => t && t.file && String(t.kind || '').toLowerCase() === 'captions')
      .map((t) => ({ url: t.file, label: t.label || 'Subtitles', lang: t.label || null, default: Boolean(t.default) }));

    // Intro/outro markers are millisecond positions in the player payload.
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
      // The CDN gate on nexabloom/mysubsplay is Referer: https://megaplay.buzz/
      // (any other value → 403). The player forwards this to /play so both the
      // playlist and its segments carry it end-to-end.
      referer: `${MEGAPLAY_BASE}/`,
      origin: MEGAPLAY_BASE,
    };
  });
}

module.exports = {
  trending: (page = 1, perPage = 24) => listMedia('TRENDING_DESC', page, perPage),
  popular: (page = 1, perPage = 24) => listMedia('POPULARITY_DESC', page, perPage),
  topRated: (page = 1, perPage = 24) => listMedia('SCORE_DESC', page, perPage),
  upcoming: (page = 1, perPage = 24) => listMedia('START_DATE_DESC', page, perPage),
  search: (term, page = 1, perPage = 24) => searchMedia(String(term || '').trim(), page, perPage),
  info,
  resolveSources,
};
