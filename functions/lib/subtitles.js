// functions/lib/subtitles.js — SubDL + OpenSubtitles ported to Workers runtime.
//
// Adaptations vs src/services/subtitles.js:
//   axios            -> fetch
//   Buffer           -> Uint8Array + DataView + TextDecoder
//   zlib.inflateRawSync -> DecompressionStream('deflate-raw')

const SUBDL_BASE = 'https://api.subdl.com/api/v1';
const SUBDL_DL_BASE = 'https://dl.subdl.com';
const OS_BASE = 'https://api.opensubtitles.com/api/v1';
const OS_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let loginToken = null;
let loginExp = 0;
const VTT_CACHE = new Map();
const VTT_CACHE_MAX = 200;

function subdlKey(env) {
  return env.SUBDL_API_KEY || '';
}

export function srtToVtt(srt) {
  if (!srt) return '';
  if (srt.startsWith('WEBVTT')) return srt;
  const cleaned = srt.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const vttTimestamps = cleaned.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${vttTimestamps.trim()}\n`;
}

// Minimal zip reader (local file headers only) over a Uint8Array.
export function extractSrtFromZip(bytes, episode) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  let offset = 0;
  const entries = [];
  while (offset + 30 <= bytes.length) {
    if (view.getUint32(offset, true) !== 0x04034b50) break;
    const method = view.getUint16(offset + 8, true);
    const compSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const filename = dec.decode(bytes.subarray(offset + 30, offset + 30 + nameLen));
    const dataStart = offset + 30 + nameLen + extraLen;
    const data = bytes.subarray(dataStart, dataStart + compSize);
    if (filename.endsWith('.srt') || filename.endsWith('.vtt')) entries.push({ filename, method, data });
    offset = dataStart + compSize;
  }
  if (!entries.length) return null;

  let chosen = entries[0];
  if (episode) {
    const epNum = Number(episode);
    const epPadded = epNum < 10 ? `0${epNum}` : String(epNum);
    const match = entries.find((entry) => {
      const fileName = entry.filename.toLowerCase();
      return (
        fileName.includes(`e${epPadded}`) ||
        fileName.includes(`episode ${epNum}`) ||
        fileName.includes(`ep${epNum}`) ||
        fileName.includes(` ${epPadded} `) ||
        fileName.startsWith(epPadded)
      );
    });
    if (match) chosen = match;
  }

  return (async () => {
    let content;
    if (chosen.method === 0) {
      content = dec.decode(chosen.data);
    } else if (chosen.method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Response(chosen.data, { headers: { 'Content-Type': 'application/octet-stream' } }).body.pipeThrough(ds);
      content = await new Response(stream).text();
    } else {
      return null;
    }
    return { filename: chosen.filename, content };
  })();
}

async function timedFetch(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function fetchSubdlVtt(env, zipUrlPath, episode) {
  const cacheKey = `${zipUrlPath}::${episode || ''}`;
  if (VTT_CACHE.has(cacheKey)) return VTT_CACHE.get(cacheKey);
  const zipResponse = await timedFetch(`${SUBDL_DL_BASE}${zipUrlPath}`, {}, 10000);
  if (!zipResponse.ok) throw new Error(`SubDL zip ${zipResponse.status}`);
  const bytes = new Uint8Array(await zipResponse.arrayBuffer());
  const extracted = await extractSrtFromZip(bytes, episode);
  if (!extracted || !extracted.content) throw new Error('Could not extract subtitle from zip archive');
  const vtt = srtToVtt(extracted.content);
  if (VTT_CACHE.size >= VTT_CACHE_MAX) {
    const firstKey = VTT_CACHE.keys().next().value;
    if (firstKey) VTT_CACHE.delete(firstKey);
  }
  VTT_CACHE.set(cacheKey, vtt);
  return vtt;
}

async function searchSubdl(env, { type, imdbId, season, episode }) {
  const key = subdlKey(env);
  if (!key || !imdbId) return [];
  try {
    const params = new URLSearchParams({ api_key: key, imdb_id: imdbId, languages: 'en' });
    if (type === 'tv' && season && episode) {
      params.set('season_number', String(Number(season)));
      params.set('episode_number', String(Number(episode)));
    }
    const searchResponse = await timedFetch(`${SUBDL_BASE}/subtitles?${params}`);
    if (!searchResponse.ok) return [];
    const data = await searchResponse.json();
    const list = (data && data.subtitles) || [];
    return list
      .slice(0, 4)
      .map((item) => ({
        url: `/subtitles/subdl?zip=${encodeURIComponent(item.url)}&ep=${type === 'tv' ? episode || '' : ''}`,
        label: item.release_name || item.name || 'English (SubDL)',
        lang: 'en',
      }))
      .filter((track) => track.url);
  } catch {
    return [];
  }
}

async function loginOpenSubs(env) {
  const key = env.OPENSUBTITLES_API_KEY;
  const username = env.OPENSUBTITLES_USERNAME;
  const password = env.OPENSUBTITLES_PASSWORD;
  if (!key || !username || !password) throw new Error('opensubtitles credentials missing');
  if (loginToken && Date.now() < loginExp) return loginToken;
  const loginResponse = await timedFetch(
    `${OS_BASE}/login`,
    {
      method: 'POST',
      headers: { 'Api-Key': key, 'User-Agent': OS_UA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    },
    6000
  );
  const data = await loginResponse.json();
  loginToken = data && data.token;
  loginExp = Date.now() + 24 * 60 * 60 * 1000;
  return loginToken;
}

async function searchOpenSubs(env, { type, imdbId, season, episode }) {
  const key = env.OPENSUBTITLES_API_KEY;
  if (!key) return [];
  try {
    const params = new URLSearchParams({ imdb_id: imdbId, languages: 'en' });
    if (type === 'tv' && season && episode) {
      params.set('type', 'episode');
      params.set('season_number', String(Number(season)));
      params.set('episode_number', String(Number(episode)));
    }
    const listResponse = await timedFetch(`${OS_BASE}/subtitles?${params}`, {
      headers: { 'Api-Key': key, 'User-Agent': OS_UA },
    });
    if (!listResponse.ok) return [];
    const data = await listResponse.json();
    const rows = (data && data.data) || [];
    const hits = rows
      .map((row) => {
        const attrs = (row && row.attributes) || {};
        const file = (attrs.files && attrs.files[0]) || {};
        return { fileId: file.file_id, label: attrs.language || 'English', lang: attrs.language_id || 'en' };
      })
      .filter((hit) => hit.fileId);
    const token = await loginOpenSubs(env);
    const subs = [];
    for (const hit of hits.slice(0, 2)) {
      try {
        const downloadResponse = await timedFetch(
          `${OS_BASE}/download`,
          {
            method: 'POST',
            headers: {
              'Api-Key': key,
              Authorization: `Bearer ${token}`,
              'User-Agent': OS_UA,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ file_id: hit.fileId }),
          },
          6000
        );
        const download = await downloadResponse.json();
        if (download && download.link) subs.push({ url: download.link, label: hit.label || 'English (OpenSubtitles)', lang: hit.lang || 'en' });
      } catch {}
    }
    return subs;
  } catch {
    return [];
  }
}

export async function fetchEnglishSubtitles(env, { type, imdbId, season, episode }) {
  if (!imdbId) return [];
  const subdlHits = await searchSubdl(env, { type, imdbId, season, episode });
  if (subdlHits.length > 0) return subdlHits;
  return searchOpenSubs(env, { type, imdbId, season, episode });
}
