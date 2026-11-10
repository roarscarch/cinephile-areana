// functions/lib/extractor.js — Stream resolver ported to Workers runtime (no Node APIs).
//
// Same logic as src/services/extractor.js:
//   peachify  -> AES-256-GCM (WebCrypto) -> { sources, subtitles }
//   vidnest   -> custom-base64 alphabet    -> 3 shapes normalized to { sources }
// Only the plumbing changed: axios -> fetch, crypto -> subtle, Buffer -> Uint8Array.
//
// ROUTING (hosts/slugs/providers) comes from ./upstreams.json — bundled from
// config/upstreams.json by scripts/sync-upstreams.mjs, overridable at runtime
// via the UPSTREAMS_JSON Pages var. See ./upstreams.js. Never hardcode a new
// slug here; edit config/upstreams.json and re-run the sync.
import { loadUpstreams } from './upstreams.js';

function fams(env) {
  return loadUpstreams(env).families;
}
function peachProviders(env) {
  return fams(env).peachify.providers;
}
function vidnestProviders(env) {
  return fams(env).vidnest.providers;
}
function peachApi(env) {
  return fams(env).peachify.api;
}
function peachReferer(env) {
  return fams(env).peachify.referer || 'https://peachify.top/';
}
function peachOrigin(env) {
  return fams(env).peachify.origin || 'https://peachify.top';
}
function vidApi(env) {
  return fams(env).vidnest.api;
}
function vidReferer(env) {
  return fams(env).vidnest.referer || 'https://vidnest.fun/';
}
function vidOrigin(env) {
  return fams(env).vidnest.origin || 'https://vidnest.fun';
}
function meowProviders(env) {
  return (fams(env).meowtv && fams(env).meowtv.providers) || [];
}
function meowApi(env) {
  return (fams(env).meowtv && fams(env).meowtv.api) || '';
}
function meowReferer(env) {
  return (fams(env).meowtv && fams(env).meowtv.referer) || 'https://meowtv.ru/';
}
function meowOrigin(env) {
  return (fams(env).meowtv && fams(env).meowtv.origin) || 'https://meowtv.ru';
}
function byseProviders(env) {
  return (fams(env).byse && fams(env).byse.providers) || [];
}
function byseApi(env) {
  return (fams(env).byse && fams(env).byse.api) || 'https://0123movie.space';
}
function byseReferer(env) {
  return (fams(env).byse && fams(env).byse.referer) || 'https://0123movie.space/';
}
function cinejoyProviders(env) {
  return (fams(env).cinejoy && fams(env).cinejoy.providers) || [];
}
function cinejoyApi(env) {
  return (fams(env).cinejoy && fams(env).cinejoy.api) || 'https://api.wing.st';
}
function cinejoyReferer(env) {
  return (fams(env).cinejoy && fams(env).cinejoy.referer) || 'https://cinejoy.pk/';
}
function cinejoyOrigin(env) {
  return (fams(env).cinejoy && fams(env).cinejoy.origin) || 'https://cinejoy.pk';
}
function vidcoreProviders(env) {
  return (fams(env).vidcore && fams(env).vidcore.providers) || [];
}
function vidcoreApi(env) {
  return (fams(env).vidcore && fams(env).vidcore.api) || 'https://vidcore.io';
}
function vidcoreReferer(env) {
  return (fams(env).vidcore && fams(env).vidcore.referer) || 'https://vidcore.io/';
}
function vidcoreOrigin(env) {
  return (fams(env).vidcore && fams(env).vidcore.origin) || 'https://vidcore.io';
}

// Legacy named exports — resolved against the BUNDLED config (no env at
// import time on the edge). Live code below takes env and reads fresh.
import bundledTable from './upstreams.json' with { type: 'json' };
export const PROVIDERS = bundledTable.families.peachify.providers;
export const VIDNEST_PROVIDERS = bundledTable.families.vidnest.providers;
export const MEOWTV_PROVIDERS = (bundledTable.families.meowtv && bundledTable.families.meowtv.providers) || [];
export const BYSE_PROVIDERS = (bundledTable.families.byse && bundledTable.families.byse.providers) || [];
export const CINEJOY_PROVIDERS = (bundledTable.families.cinejoy && bundledTable.families.cinejoy.providers) || [];
export const VIDCORE_PROVIDERS = (bundledTable.families.vidcore && bundledTable.families.vidcore.providers) || [];

const PEACHIFY_REFERER = 'https://peachify.top/';
const STREAM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const PROBE_TIMEOUT_MS = 15000;
const PROBE_STREAM_TIMEOUT_MS = 8000;
const SEGMENT_CHECK_TIMEOUT_MS = 6000;
const STREAM_OK_TTL_MS = 60_000;
const DEAD_TTL_MS = 30_000;
const FAMILY_TTL_MS = 60_000;

// ---- per-isolate caches (same role as the Node Maps) ----
const providerCache = new Map();
const vidnestCache = new Map();
const meowtvCache = new Map();
const byseCache = new Map();
const cinejoyCache = new Map();
const vidcoreCache = new Map();
const subsCache = new Map();
const vdrkSubsCache = new Map();
const deadCache = new Map();
const familyDeadUntil = new Map();
const streamOkCache = new Map();

function markDead(family, provider, key) {
  deadCache.set(`${family}:${provider.name}:${key}`, Date.now() + DEAD_TTL_MS);
}
function isDead(family, provider, key) {
  return (deadCache.get(`${family}:${provider.name}:${key}`) || 0) > Date.now();
}
function familyDown(family) {
  return (familyDeadUntil.get(family) || 0) > Date.now();
}
function healFamily(family) {
  familyDeadUntil.delete(family);
}
function titleKey(type, id, season, episode) {
  return type === 'tv' ? `tv/${id}/${season}/${episode}` : `movie/${id}`;
}

// ---- base64url / hex helpers (no Buffer) ----
function b64urlToBytes(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const PLAY_PROXY_DEFAULT = 'https://cinephile-play.cinephilia-areana.workers.dev';
const PLAY_SIG_TTL_S = 2 * 3600;

function hexEncode(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function hexToBytes(hex) {
  const h = String(hex).trim();
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Server-issued proxy URL, same contract as Node signPlayUrl (HMAC-SHA256
// over url\nref\norigin\nexp). Null when key unset (unsigned fallback).
export async function signPlayUrl(env, { url, referer, origin }) {
  const key = env.PLAY_SIGNING_KEY;
  if (!key || !url) return null;
  const base = (env.PLAY_PROXY_BASE || PLAY_PROXY_DEFAULT).replace(/\/$/, '');
  const ref = referer || PEACHIFY_REFERER;
  const org = origin || '';
  const exp = Math.floor(Date.now() / 1000) + PLAY_SIG_TTL_S;
  const msg = `${url}\n${ref}\n${org}\n${exp}`;
  const ck = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = hexEncode(new Uint8Array(await crypto.subtle.sign('HMAC', ck, new TextEncoder().encode(msg))));
  const params = new URLSearchParams({ ref });
  if (org) params.set('origin', org);
  params.set('url', url);
  params.set('exp', String(exp));
  params.set('sig', sig);
  return `${base}/play?${params.toString()}`;
}

// ---- fetch helpers (axios-shaped errors carry .status) ----
async function fetchJSON(url, { headers = {}, timeout = PROBE_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) {
      const e = new Error(`API ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ---- peachify ----
export async function decryptPayload(payload, keyHex) {
  const [ivB64, ctB64, tagB64] = String(payload).split('.');
  const key = await crypto.subtle.importKey('raw', hexToBytes(keyHex), 'AES-GCM', false, ['decrypt']);
  const iv = b64urlToBytes(ivB64);
  const ct = b64urlToBytes(ctB64);
  const tag = b64urlToBytes(tagB64);
  const combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct, 0);
  combined.set(tag, ct.length);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, combined);
  return JSON.parse(new TextDecoder().decode(plain));
}

async function fetchProvider(env, provider, type, id, season, episode) {
  let url = `${peachApi(env)}/${provider.path}/${type}/${id}`;
  if (type === 'tv') url += `/${season}/${episode}`;
  try {
    const json = await fetchJSON(url, {
      headers: { Referer: peachReferer(env), Origin: peachOrigin(env), 'User-Agent': STREAM_UA },
    });
    if (json && json.isEncrypted) return decryptPayload(json.data, env.PEACHIFY_KEY_HEX);
    return json;
  } catch (err) {
    throw new Error(`peachify ${provider.name} API ${err.status || err.message}`);
  }
}

export async function fetchSubtitles(env, type, id, season, episode) {
  const key = titleKey(type, id, season, episode);
  if (subsCache.has(key)) return subsCache.get(key);
  try {
    let url = `${peachApi(env)}/subs/${type}/${id}`;
    if (type === 'tv') url += `/${season}/${episode}`;
    const raw = await fetchJSON(url, {
      headers: { Referer: peachReferer(env), Origin: peachOrigin(env), 'User-Agent': STREAM_UA },
      timeout: 3000,
    });
    const subs = (Array.isArray(raw) ? raw : [])
      .map((rawSub) => ({
        url: rawSub.url || rawSub.file || rawSub.src,
        label: rawSub.label || rawSub.language || rawSub.lang || 'Unknown',
        lang: rawSub.lang || rawSub.language || null,
      }))
      .filter((sub) => sub.url);
    subsCache.set(key, subs);
    return subs;
  } catch {
    // peachify subs are offline (family dark) — meowtv serves the same shape.
    try {
      const subs = await fetchMeowtvSubtitles(env, type, id, season, episode);
      subsCache.set(key, subs);
      return subs;
    } catch {
      return [];
    }
  }
}

// ---- vidnest ----
export function vidnestDecode(data, alphabet) {
  const codes = [...String(data)].map((c) => alphabet.indexOf(c));
  const bytes = [];
  for (let offset = 0; offset + 3 < codes.length; offset += 4) {
    const n0 = codes[offset], n1 = codes[offset + 1], n2 = codes[offset + 2], n3 = codes[offset + 3];
    if (n0 < 0 || n0 > 63) break;
    bytes.push((n0 << 2) | (n1 >> 4));
    if (n2 !== 64) bytes.push(((n1 & 15) << 4) | (n2 >> 2));
    if (n3 !== 64) bytes.push(((n2 & 3) << 6) | n3);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// vidnest v2: API now answers { d, n, v } — AES-256-GCM payload keyed by
// SHA-256(`${n}|VIDNEST_SECRET`), iv = first 12 bytes of decoded d, tag =
// last 16 bytes of the remainder (matches their bundle's secureDecrypt).
// Requires a `_n` nonce on the request or the API answers 403.
// The old custom-alphabet { data } decode was retired upstream.
const DEFAULT_VIDNEST_SECRET = 'K3p8vQ2mX9rL5wZ0fN7bG1sH4tJ6dC9_y8S3wM1nQ5pL2';

function vidnestNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function vidnestDecryptV2(data, nonce, secretOrKey) {
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${nonce}|${secretOrKey}`))),
    'AES-GCM',
    false,
    ['decrypt']
  );
  const raw = b64urlToBytes(data);
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const body = ct.slice(0, ct.length - 16);
  const tag = ct.slice(ct.length - 16);
  const combined = new Uint8Array(body.length + tag.length);
  combined.set(body, 0);
  combined.set(tag, body.length);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, combined);
  const text = new TextDecoder().decode(plain);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function fetchVidnestProvider(env, provider, type, id, season, episode) {
  const slug = provider.slug || provider.name;
  let url = `${vidApi(env)}/${slug}/${type}/${id}`;
  if (type === 'tv') url += `/${season}/${episode}`;
  url += `?_n=${encodeURIComponent(vidnestNonce())}`;
  try {
    const json = await fetchJSON(url, {
      headers: { Referer: vidReferer(env), Origin: vidOrigin(env), 'User-Agent': STREAM_UA },
    });
    if (!json || !json.d || !json.n) throw new Error(`vidnest ${provider.name}: unexpected response`);
    const secret = env.VIDNEST_SECRET || DEFAULT_VIDNEST_SECRET;
    return await vidnestDecryptV2(json.d, json.n, secret);
  } catch (err) {
    const status = err.status || '';
    if (status === 502 || status === 404) throw new Error(`vidnest ${provider.name}: no source (${status})`);
    throw new Error(`vidnest ${provider.name} API ${status || err.message}`);
  }
}

export function vidnestToResult(provider, data) {
  const items = Array.isArray(data.streams)
    ? data.streams
    : [{ url: data.url, type: data.hls, headers: data.headers, referer: data.referer, label: data.label }];
  const sources = items
    .map((stream) => {
      const url = stream.url || stream.file;
      if (!url) return null;
      return {
        url,
        quality: stream.quality || stream.resolution || stream.label || 'auto',
        isM3U8:
          stream.type === 'hls' ||
          /\.m3u8($|\?)|streamsvr|\/hls\d*\//i.test(url) ||
          /master\.txt($|\?)|\.txt($|\?)/i.test(url),
        headers: stream.headers || null,
        referer: (stream.headers && stream.headers.Referer) || stream.referer || null,
        lang: stream.language || null,
      };
    })
    .filter(Boolean);
  return { provider: provider.name, sources, subtitles: [] };
}

async function resolveVidnest(env, { type, id, season, episode, server }) {
  if (type !== 'movie' && type !== 'tv') throw new Error('type must be movie or tv');
  const ALL = vidnestProviders(env);
  if (server) {
    const provider = ALL.find((candidate) => candidate.name === String(server).toLowerCase());
    if (!provider) throw new Error(`Unknown vidnest provider '${server}'`);
    return vidnestToResult(provider, await fetchVidnestProvider(env, provider, type, id, season, episode));
  }
  const key = titleKey(type, id, season, episode);
  const cachedName = vidnestCache.get(key);
  const cachedProvider = cachedName && ALL.find((candidate) => candidate.name === cachedName);
  const baseOrder = cachedProvider
    ? [cachedProvider, ...ALL.filter((provider) => provider.name !== cachedProvider.name)]
    : ALL;
  const order = baseOrder.filter((provider) => !isDead('vidnest', provider, key));
  let lastError = null;
  const settled = await Promise.allSettled(
    order.map((provider) => fetchVidnestProvider(env, provider, type, id, season, episode).then((payload) => vidnestToResult(provider, payload)))
  );
  for (let i = 0; i < order.length; i++) {
    const provider = order[i];
    const outcome = settled[i];
    if (outcome.status === 'rejected') {
      lastError = outcome.reason;
      markDead('vidnest', provider, key);
      continue;
    }
    if (!outcome.value.sources.length) continue;
    vidnestCache.set(key, provider.name);
    return outcome.value;
  }
  throw new Error(`No vidnest source found${lastError ? ` (${lastError.message})` : ''}`);
}

export async function fetchVidnestSubtitles(type, id, season, episode) {
  const key = titleKey(type, id, season, episode);
  if (vdrkSubsCache.has(key)) return vdrkSubsCache.get(key);
  try {
    let url = `https://sub.vdrk.site/v2/${type}/${id}`;
    if (type === 'tv') url += `/${season}/${episode}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      const list = r.ok ? await r.json() : [];
      const subs = (Array.isArray(list) ? list : [])
        .map((rawSub) => ({ url: rawSub.file || rawSub.url, label: rawSub.label, lang: rawSub.label || null }))
        .filter((sub) => sub.url);
      vdrkSubsCache.set(key, subs);
      return subs;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return [];
  }
}

// ---- startability probe (same contract as Node version) ----
function probeHeaders(src) {
  const headers = { 'User-Agent': STREAM_UA, Referer: src.referer || PEACHIFY_REFERER };
  if (src.origin) headers.Origin = src.origin;
  return headers;
}

function sumDurations(text) {
  let total = 0;
  let count = 0;
  const re = /#EXTINF:([\d.]+)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const seconds = parseFloat(match[1]);
    if (Number.isFinite(seconds)) {
      total += seconds;
      count++;
    }
  }
  return { total, count };
}

const VARIANT_BODY_CAP = 512 * 1024;

async function fetchFull(url, referer, origin) {
  const headers = { 'User-Agent': STREAM_UA, Referer: referer || PEACHIFY_REFERER };
  if (origin) headers.Origin = origin;
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), SEGMENT_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    if (!response || (response.status !== 200 && response.status !== 206)) {
      return { ok: false, status: response ? response.status : 0, body: '', complete: true };
    }
    const full = await response.text();
    return { ok: true, status: response.status, body: full.slice(0, VARIANT_BODY_CAP), complete: full.length <= VARIANT_BODY_CAP };
  } catch {
    return { ok: false, status: 0, body: '', complete: true };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function verifyWinnerSegments(src, minDurationSec = 0) {
  if (src && src.skipVerify) return true;
  const isPlaylist =
    src.isM3U8 ||
    /\.m3u8($|\?)|streamsvr|\/hls\d*\//i.test(src.url) ||
    /master\.txt($|\?)|\.txt($|\?)/i.test(src.url);
  if (!isPlaylist) return true;
  const checkDuration = (body, receivedComplete, label) => {
    const { total, count } = sumDurations(body);
    if (!count || total >= minDurationSec) return true;
    if (!receivedComplete) return true;
    console.error(`[verify] too short (${Math.round(total)}s < ${minDurationSec}s): ${label}`);
    return false;
  };
  const definitiveReject = async (url, range) => {
    const headers = { 'User-Agent': STREAM_UA, Referer: src.referer || PEACHIFY_REFERER };
    if (src.origin) headers.Origin = src.origin;
    if (range) headers.Range = range;
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), SEGMENT_CHECK_TIMEOUT_MS);
    try {
      const response = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(timeoutId);
      if (!response) return { error: false, rejected: false };
      if (response.status === 200 || response.status === 206) {
        return { error: false, rejected: false, body: await response.text() };
      }
      return { error: true, rejected: true, status: response.status };
    } catch (e) {
      clearTimeout(timeoutId);
      return { error: true, rejected: false };
    }
  };
  // Level 0: master, whole (bounded).
  const master = await fetchFull(src.url, src.referer, src.origin);
  if (!master.ok) return true;
  if (!checkDuration(master.body, master.complete, src.url)) return false;
  const childUrl = firstChildUrl(master.body, src.url);
  if (!childUrl) return true;
  // Level 1: classify cheap first; playlists pay for the full bounded body.
  const childProbe = await definitiveReject(childUrl, 'bytes=0-4095');
  if (childProbe.error) {
    if (childProbe.rejected) {
      console.error(`[verify] child ${childProbe.status} for ${src.url}`);
      return false;
    }
    return true;
  }
  if (!/#EXT/i.test(String(childProbe.body || '').slice(0, 300))) return true;
  const variant = await fetchFull(childUrl, src.referer, src.origin);
  if (!variant.ok) return true;
  if (!checkDuration(variant.body, variant.complete, childUrl)) return false;
  const grandchildUrl = firstChildUrl(variant.body, childUrl);
  if (!grandchildUrl) return true;
  const grandchild = await definitiveReject(grandchildUrl, 'bytes=0-0');
  if (grandchild.error) {
    if (grandchild.rejected) {
      console.error(`[verify] segment ${grandchild.status} for ${src.url}`);
      return false;
    }
    return true;
  }
  return true;
}

function firstChildUrl(head, playlistUrl) {
  try {
    const text = String(head || '').slice(0, 4096);
    const mapMatch = text.match(/URI="([^"]+)"/);
    if (mapMatch) return new URL(mapMatch[1], playlistUrl).href;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line && !line.startsWith('#')) return new URL(line, playlistUrl).href;
    }
    return null;
  } catch {
    return null;
  }
}

async function probeStreamPlayable(src) {
  if (!src || !src.url) return false;
  if (src.skipProbe) return true;
  try {
    const headers = probeHeaders(src);
    const isM3U8 =
      src.isM3U8 ||
      /\.m3u8($|\?)|streamsvr|\/hls\d*\//i.test(src.url) ||
      /master\.txt($|\?)|\.txt($|\?)/i.test(src.url);
    // NOTE: masters are plain-GET on purpose — ranged playlist fetches get
    // rejected by relay CDNs and deep-probe bursts get rate-limited,
    // manufacturing the failures the probe exists to prevent.
    if (!isM3U8) headers.Range = 'bytes=0-0';
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), PROBE_STREAM_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(src.url, { headers, signal: ctrl.signal, redirect: 'follow' });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response || (response.status !== 200 && response.status !== 206)) return false;
    if (isM3U8) {
      const head = (await response.text()).slice(0, 300);
      const contentType = response.headers.get('content-type') || '';
      return /#EXT/i.test(head) || contentType.includes('mpegurl');
    }
    return (await response.arrayBuffer()).byteLength > 0;
  } catch {
    return false;
  }
}

// ---- meowtv ----
// api.meowtv.ru: POST /streams/ticket -> GET /streams/{type}/{id}?s={server}
// -> POST enc-dec.app/api/dec-meowtv. Only some servers hold a title (410
// otherwise) — the race + dead-marks own that. Ticket cached 4 min.
const MEOWTV_DECODER = 'https://enc-dec.app/api/dec-meowtv';
const MEOWTV_TICKET_TTL_MS = 4 * 60 * 1000;
let meowtvTicket = null; // { value, exp }

async function getMeowtvTicket(env) {
  if (meowtvTicket && meowtvTicket.exp > Date.now()) return meowtvTicket.value;
  const ticket = await postJson(`${meowApi(env)}/streams/ticket`, undefined, {
    Origin: meowOrigin(env),
    Referer: meowReferer(env),
    'User-Agent': STREAM_UA,
  });
  const value = ticket && ticket.ticket;
  if (!value) throw new Error('meowtv: no ticket');
  meowtvTicket = { value, exp: Date.now() + MEOWTV_TICKET_TTL_MS };
  return value;
}

async function fetchMeowtvProvider(env, provider, type, id, season, episode) {
  const slug = provider.slug || provider.name;
  let url = `${meowApi(env)}/streams/${type}/${id}`;
  if (type === 'tv') url += `/${season}/${episode}`;
  url += `?s=${encodeURIComponent(slug)}`;
  try {
    const ticket = await getMeowtvTicket(env);
    const data = await fetchJSON(url, {
      headers: { Origin: meowOrigin(env), Referer: meowReferer(env), 'User-Agent': STREAM_UA, 'X-Stream-Ticket': ticket },
    });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    let dec;
    try {
      const r = await fetch(MEOWTV_DECODER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
        signal: ctrl.signal,
      });
      dec = await r.json();
    } finally {
      clearTimeout(t);
    }
    if (!dec || dec.status !== 200 || !dec.result) throw new Error(`meowtv ${provider.name}: decoder ${dec && dec.status}`);
    return dec.result;
  } catch (err) {
    const status = err.status || '';
    if (status === 401 || status === 403) meowtvTicket = null;
    throw new Error(`meowtv ${provider.name} ${status || err.message}`);
  }
}

function meowtvToResult(provider, data) {
  if (!data || !data.url) return { provider: provider.name, sources: [], subtitles: [] };
  const url = String(data.url);
  const headers = data.headers && Object.keys(data.headers).length ? data.headers : null;
  const source = {
    url,
    quality: data.quality || data.resolution || data.language || 'auto',
    isM3U8: /\.m3u8($|\?)|\/hls/i.test(url),
    headers,
    referer: (headers && (headers.Referer || headers.referer)) || null,
    origin: (headers && (headers.Origin || headers.origin)) || null,
    lang: data.language || null,
    dub: data.language || null,
  };
  return { provider: provider.name, sources: [source], subtitles: [] };
}

export async function resolveMeowtv(env, { type, id, season, episode, server }) {
  if (type !== 'movie' && type !== 'tv') throw new Error('type must be movie or tv');
  const ALL = meowProviders(env);
  if (server) {
    const provider = ALL.find((candidate) => candidate.name === String(server).toLowerCase());
    if (!provider) throw new Error(`Unknown meowtv server '${server}'`);
    return meowtvToResult(provider, await fetchMeowtvProvider(env, provider, type, id, season, episode));
  }
  const key = titleKey(type, id, season, episode);
  const cachedName = meowtvCache.get(key);
  const cached = cachedName && ALL.find((candidate) => candidate.name === cachedName);
  const order = (cached ? [cached, ...ALL.filter((p) => p.name !== cached.name)] : ALL).filter((p) => !isDead('meowtv', p, key));
  let lastError = null;
  const settled = await Promise.allSettled(
    order.map((p) => fetchMeowtvProvider(env, p, type, id, season, episode).then((payload) => meowtvToResult(p, payload)))
  );
  for (let i = 0; i < order.length; i++) {
    const outcome = settled[i];
    if (outcome.status === 'rejected') {
      lastError = outcome.reason;
      markDead('meowtv', order[i], key);
      continue;
    }
    if (!outcome.value.sources.length) continue;
    meowtvCache.set(key, order[i].name);
    return outcome.value;
  }
  throw new Error(`No meowtv source found${lastError ? ` (${lastError.message})` : ''}`);
}

export async function fetchMeowtvSubtitles(env, type, id, season, episode) {
  let url = `${meowApi(env)}/subs/${type}/${id}`;
  if (type === 'tv') url += `/${season}/${episode}`;
  try {
    const raw = await fetchJSON(url, {
      headers: { Origin: meowOrigin(env), Referer: meowReferer(env), 'User-Agent': STREAM_UA },
      timeout: 3000,
    });
    return (Array.isArray(raw) ? raw : [])
      .map((s) => ({ url: s.file || s.url || s.src, label: s.label || s.language || 'Unknown', lang: s.label || null }))
      .filter((s) => s.url);
  } catch {
    return [];
  }
}

// ---- byse ----
// 0123movie.space maps TMDB -> an embed code, then the byse player gates the
// stream behind: P-256 device attestation -> PoW captcha -> AES-GCM playback
// config. All crypto runs on WebCrypto here (same as the browser bundle).
//
// NOTE: byse is offered as a FORCED server on the edge (?server=byse), not in
// the automatic race. Its hashcash PoW is CPU-bound and Workers free-plan CPU
// limits are tight; racing it on every /sources could trip the isolate. The
// Node/Vercel deployment races it normally.
const BYSE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const BYSE_POW_BLOCKS = 512;
const BYSE_POW_MASK = BYSE_POW_BLOCKS - 1;
const BYSE_POW_ROUNDS = 2;
const BYSE_POW_MUL_A = 2654435761;
const BYSE_POW_MUL_B = 2246822519;
const byseRot = (v, s) => (v << s | v >>> (32 - s)) >>> 0;
function byseMix(st) {
  st[0] = (st[0] + st[1]) >>> 0; st[3] = byseRot(st[3] ^ st[0], 16);
  st[2] = (st[2] + st[3]) >>> 0; st[1] = byseRot(st[1] ^ st[2], 12);
  st[0] = (st[0] + st[1]) >>> 0; st[3] = byseRot(st[3] ^ st[0], 8);
  st[2] = (st[2] + st[3]) >>> 0; st[1] = byseRot(st[1] ^ st[2], 7);
}
function bysePowHash(bytes) {
  const st = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762]);
  for (let i = 0; i < bytes.length; i++) { st[0] = (st[0] + bytes[i]) >>> 0; st[0] = byseRot(st[0], 7); byseMix(st); }
  for (let i = 0; i < 8; i++) byseMix(st);
  const table = new Uint32Array(BYSE_POW_BLOCKS);
  for (let i = 0; i < BYSE_POW_BLOCKS; i++) { byseMix(st); table[i] = (st[0] ^ st[2]) >>> 0; }
  for (let r = 0; r < BYSE_POW_ROUNDS; r++) for (let i = 0; i < BYSE_POW_BLOCKS; i++) {
    const ti = table[i] & BYSE_POW_MASK;
    let v = (table[i] + table[ti]) >>> 0; v = byseRot(v, 13);
    v = (v ^ Math.imul(table[(i + 1) & BYSE_POW_MASK], BYSE_POW_MUL_A)) >>> 0;
    table[i] = v; st[0] = (st[0] ^ v) >>> 0; byseMix(st);
  }
  const out = new Uint32Array(8), width = BYSE_POW_BLOCKS / 8;
  for (let i = 0; i < 8; i++) {
    byseMix(st); let v = st[0];
    for (let j = 0; j < width; j++) {
      const tv = table[i * width + j];
      v = (v + tv) >>> 0; v = byseRot(v, 5); v = (v ^ Math.imul(tv, BYSE_POW_MUL_B)) >>> 0;
    }
    out[i] = (v ^ st[2]) >>> 0;
  }
  return out;
}
function byseLatin1(s) { const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i) & 255; return o; }
function byseLeadingZeros(a) {
  let total = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] === 0) { total += 32; continue; } return total + Math.clz32(a[i]); }
  return total;
}
function byseSolvePow(nonce, difficulty) {
  const prefix = `${nonce}:`;
  for (let counter = 0; counter < 5_000_000; counter++) {
    if (byseLeadingZeros(bysePowHash(byseLatin1(prefix + counter))) >= difficulty) return String(counter);
  }
  throw new Error('byse: PoW exceeded search budget');
}

async function fetchByseImdbId(env, type, id) {
  if (!env.TMDB_API_KEY) return null;
  try {
    const data = await fetchJSON(`https://api.themoviedb.org/3/${type}/${id}/external_ids?api_key=${encodeURIComponent(env.TMDB_API_KEY)}`, { timeout: 4000 });
    return (data && data.imdb_id) || null;
  } catch {
    return null;
  }
}

async function fetchByseConfig(env, { type, id, season, episode, imdbId }) {
  if (type === 'movie' && !imdbId) imdbId = await fetchByseImdbId(env, type, id);
  if (type === 'movie' && !imdbId) throw new Error('byse: movie needs an imdb id');

  const path = type === 'movie' ? `/mv/${imdbId}/${id}/` : `/pl/${id}/${season || 1}/${episode || 1}/`;
  // Follow the redirect and read the final URL (the embed page) — manual
  // redirects are opaque on Workers, response.url is reliable.
  const role = await fetch(`${byseApi(env)}${path}`, {
    redirect: 'follow',
    headers: { 'User-Agent': BYSE_UA, Referer: byseReferer(env) },
  });
  const embedUrl = role.url;
  const mm = String(embedUrl).match(/^(https?:\/\/[^/]+)\/e\/([^/?#]+)/);
  if (!mm) throw new Error(`byse: unsupported embed url ${String(embedUrl).slice(0, 80)}`);
  const origin = mm[1];
  const code = mm[2];
  const embedHeaders = {
    'User-Agent': BYSE_UA,
    Referer: embedUrl,
    Origin: origin,
    'X-Embed-Origin': byseApi(env),
    'X-Embed-Referer': byseReferer(env),
    'X-Embed-Parent': embedUrl,
  };

  await fetchJSON(`${origin}/api/videos/${code}/embed/details`, { headers: embedHeaders });

  // device attestation — P-256 ECDSA over the challenge nonce
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicJwk = await crypto.subtle.exportKey('jwk', publicKey);
  const challenge = await postJson(`${origin}/api/videos/access/challenge`, undefined, { 'User-Agent': BYSE_UA });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: { name: 'SHA-256' } }, privateKey, new TextEncoder().encode(challenge.nonce));
  const viewerId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const attested = await postJson(`${origin}/api/videos/access/attest`, {
    viewer_id: viewerId,
    device_id: deviceId,
    challenge_id: challenge.challenge_id,
    nonce: challenge.nonce,
    signature: bytesToB64url(new Uint8Array(sig)),
    public_key: publicJwk,
    client: {
      user_agent: BYSE_UA, languages: ['en-US', 'en'], timezone: 'America/New_York',
      hardware_concurrency: 8, device_memory: 8, pixel_ratio: 1, screen_width: 1920, screen_height: 1080,
      color_depth: 24, touch_points: 0, webdriver: false, webgl_vendor: 'Google Inc. (NVIDIA)',
      webgl_renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      brand_full_versions: [],
    },
    storage: { cookie: viewerId, local_storage: viewerId, indexed_db: `${viewerId}:${deviceId}`, cache_storage: `${viewerId}:${deviceId}` },
    attributes: { entropy: 'medium' },
  }, { 'User-Agent': BYSE_UA });
  const fingerprint = {
    token: attested.token,
    viewer_id: attested.viewer_id || viewerId,
    device_id: attested.device_id || deviceId,
    confidence: attested.confidence,
  };

  const captcha = await postJson(`${origin}/api/videos/${code}/embed/captcha`, { fingerprint }, embedHeaders);
  const solution = byseSolvePow(captcha.pow_nonce, captcha.pow_difficulty);
  const verified = await postJson(`${origin}/api/videos/${code}/embed/captcha/verify`, { pow_token: captcha.pow_token, solution, fingerprint }, embedHeaders);
  if (!verified || verified.status !== 'ok' || !verified.token) throw new Error('byse: captcha not verified');

  const playback = await postJson(`${origin}/api/videos/${code}/embed/playback`, { fingerprint }, { ...embedHeaders, 'X-Captcha-Token': verified.token });
  const enc = playback.playback || playback.playback_config || playback;
  const parts = Array.isArray(enc.key_parts) ? enc.key_parts : [];
  const ver = parseInt(String(enc.version), 10);
  let selected = parts;
  if (Number.isInteger(ver) && ver >= 1 && ver <= 20) {
    const pick = [ver, 31 - ver].filter((i) => i >= 1 && i <= parts.length).map((i) => parts[i - 1]).filter((x) => typeof x === 'string' && x.length > 0);
    if (pick.length) selected = pick;
  }
  const decoded = selected.map(b64urlToBytes);
  const len = decoded.reduce((a, b) => a + b.length, 0);
  const keyBytes = new Uint8Array(len);
  let off = 0;
  for (const d of decoded) { keyBytes.set(d, off); off += d.length; }
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlToBytes(enc.iv) }, cryptoKey, b64urlToBytes(enc.payload));
  const config = JSON.parse(new TextDecoder().decode(plain));
  return { origin, code, embedUrl, config };
}

async function postJson(url, body, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  const hasBody = body !== undefined;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: hasBody ? { ...headers, 'Content-Type': 'application/json' } : { ...headers },
      body: hasBody ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const e = new Error(`API ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function byseToResult(provider, resolved) {
  const config = (resolved && resolved.config) || {};
  const origin = resolved.origin;
  const sources = (config.sources || [])
    .map((s) => {
      if (!s || !s.url) return null;
      const mime = String(s.mime_type || '');
      const headers = s.headers && typeof s.headers === 'object' ? s.headers : null;
      return {
        url: s.url,
        quality: s.label || s.quality || (s.height ? `${s.height}p` : 'auto'),
        isM3U8: /mpegurl|m3u8/i.test(mime) || /\.m3u8($|\?)/i.test(s.url),
        headers,
        referer: (headers && (headers.Referer || headers.referer)) || origin + '/',
        origin: (headers && (headers.Origin || headers.origin)) || origin,
        lang: s.language || null,
        dub: s.language || null,
      };
    })
    .filter(Boolean);
  return { provider: provider.name, sources, subtitles: [] };
}

export async function resolveByse(env, { type, id, season, episode, imdbId, server }) {
  if (type !== 'movie' && type !== 'tv') throw new Error('type must be movie or tv');
  const ALL = byseProviders(env);
  const provider = server ? ALL.find((c) => c.name === String(server).toLowerCase()) : ALL[0];
  if (!provider) throw new Error(`Unknown byse provider '${server}'`);
  return byseToResult(provider, await fetchByseConfig(env, { type, id, season, episode, imdbId }));
}

// ---- cinejoy ----
// api.wing.st: enc-cinejoy(url) -> POST /g (octet-stream) -> dec-cinejoy.
// Same multi-server design as Node; needs TMDB title/year/imdb metadata.
const CINEJOY_ENC = 'https://enc-dec.app/api/enc-cinejoy';
const CINEJOY_DEC = 'https://enc-dec.app/api/dec-cinejoy';
const tmdbMetaCache = new Map();

async function fetchTitleMeta(env, type, id) {
  const key = `${type}:${id}`;
  if (tmdbMetaCache.has(key)) return tmdbMetaCache.get(key);
  const promise = (async () => {
    if (!env.TMDB_API_KEY) return null;
    try {
      const d = await fetchJSON(
        `https://api.themoviedb.org/3/${type}/${id}?api_key=${encodeURIComponent(env.TMDB_API_KEY)}&append_to_response=external_ids`,
        { timeout: 5000 }
      );
      const date = type === 'movie' ? d.release_date : d.first_air_date;
      return {
        title: type === 'movie' ? d.title : d.name,
        year: date ? String(date).slice(0, 4) : '',
        imdb: (d.external_ids && d.external_ids.imdb_id) || null,
      };
    } catch {
      return null;
    }
  })();
  tmdbMetaCache.set(key, promise);
  const meta = await promise;
  if (!meta) tmdbMetaCache.delete(key);
  return meta;
}

async function fetchCinejoyProvider(env, provider, type, id, season, episode, meta) {
  if (!meta || !meta.title) throw new Error('cinejoy: metadata required');
  const server = provider.slug || provider.name;
  let url =
    `${cinejoyApi(env)}/?title=${encodeURIComponent(meta.title)}` +
    `&type=${type === 'movie' ? 'movie' : 'series'}` +
    `&year=${encodeURIComponent(meta.year || '')}` +
    `&imdb=${encodeURIComponent(meta.imdb || '')}` +
    `&tmdb=${encodeURIComponent(id)}&server=${encodeURIComponent(server)}`;
  if (type === 'tv') url += `&season=${encodeURIComponent(season || 1)}&episode=${encodeURIComponent(episode || 1)}`;
  try {
    const enc = await fetchJSON(`${CINEJOY_ENC}?url=${encodeURIComponent(url)}`, { timeout: PROBE_TIMEOUT_MS });
    const body = enc && enc.result;
    if (!body || !body.data) throw new Error('encode failed');
    const raw = b64urlToBytes(body.data);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    let bytes;
    try {
      const g = await fetch(`${cinejoyApi(env)}/g`, {
        method: 'POST',
        headers: {
          Origin: cinejoyOrigin(env),
          Referer: cinejoyReferer(env),
          'User-Agent': STREAM_UA,
          'Content-Type': 'application/octet-stream',
        },
        body: raw,
        signal: ctrl.signal,
      });
      if (!g.ok) throw new Error(`g ${g.status}`);
      bytes = new Uint8Array(await g.arrayBuffer());
    } finally {
      clearTimeout(t);
    }
    const text = bytesToB64url(bytes);
    const dec = await postJson(CINEJOY_DEC, { text, state: body.state }, {});
    if (!dec || dec.status !== 200 || !dec.result) throw new Error('decode failed');
    return dec.result;
  } catch (err) {
    throw new Error(`cinejoy ${provider.name} ${err.status || err.message}`);
  }
}

function cinejoyToResult(env, provider, result) {
  const streams = (result && result.data && result.data.stream) || [];
  const sources = [];
  const subtitles = [];
  for (const s of streams) {
    if (s && s.playlist) {
      sources.push({
        url: s.playlist,
        quality: s.id || 'auto',
        isM3U8: true,
        headers: null,
        referer: cinejoyOrigin(env) + '/',
        origin: cinejoyOrigin(env),
        lang: null,
        dub: null,
        // The cinejoy HLS CDN is not reliably reachable from Cloudflare egress
        // (probe/verify fail even though the stream plays for clients). The API
        // verdict is authoritative here; skip the CDN startability checks.
        skipProbe: true,
        skipVerify: true,
      });
    }
    for (const c of (s && s.captions) || []) {
      if (c && c.url) subtitles.push({ url: c.url, label: c.language || c.id || 'Subtitles', lang: c.language || c.id || null });
    }
  }
  return { provider: provider.name, sources, subtitles };
}

async function resolveCinejoy(env, { type, id, season, episode, server, meta }) {
  if (type !== 'movie' && type !== 'tv') throw new Error('type must be movie or tv');
  const ALL = cinejoyProviders(env);
  if (!ALL.length) throw new Error('cinejoy: no providers configured');
  if (!meta) meta = await fetchTitleMeta(env, type, id);
  if (server) {
    const provider = ALL.find((c) => c.name === String(server).toLowerCase() || c.slug === server);
    if (!provider) throw new Error(`Unknown cinejoy server '${server}'`);
    return cinejoyToResult(env, provider, await fetchCinejoyProvider(env, provider, type, id, season, episode, meta));
  }
  const key = titleKey(type, id, season, episode);
  const cachedName = cinejoyCache.get(key);
  const cached = cachedName && ALL.find((c) => c.name === cachedName);
  const order = (cached ? [cached, ...ALL.filter((p) => p.name !== cached.name)] : ALL).filter(
    (p) => !isDead('cinejoy', p, key) && !familyDown('cinejoy')
  );
  let lastError = null;
  const settled = await Promise.allSettled(
    order.map((p) => fetchCinejoyProvider(env, p, type, id, season, episode, meta).then((r) => cinejoyToResult(env, p, r)))
  );
  for (let i = 0; i < order.length; i++) {
    const o = settled[i];
    if (o.status === 'rejected') {
      lastError = o.reason;
      markDead('cinejoy', order[i], key);
      continue;
    }
    if (!o.value.sources.length) continue;
    cinejoyCache.set(key, order[i].name);
    return o.value;
  }
  throw new Error(`No cinejoy source found${lastError ? ` (${lastError.message})` : ''}`);
}

// ---- vidcore ----
// vidcore.io embeds TMDB-keyed HLS per server (dynamic list). Flow: page ->
// escaped RSC token -> enc-vidcore stage1 -> CSRF'd POST -> stage2 ->
// CSRF'd POSTs (servers, then stream/{data}) -> dec-vidcore. All decryption
// rides enc-dec.app (same dependency as meowtv/cinejoy). The stream CDN
// 403s unless UA + Referer + Origin are ALL sent, so playback rides /play
// with the vidcore referer/origin.
const VIDCORE_ENC = 'https://enc-dec.app/api/enc-vidcore';
const VIDCORE_DEC = 'https://enc-dec.app/api/dec-vidcore';
const VIDCORE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const VIDCORE_MAX_SERVERS = 4;

async function vidcoreRawRequest(url, { method = 'GET', headers = {}, body, timeout = PROBE_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { method, headers, body, signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) {
      const e = new Error(`API ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function vidcoreGetDecoder(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) {
      const e = new Error(`API ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchVidcoreProvider(env, type, id, season, episode) {
  const pagePath = type === 'tv' ? `/tv/${id}/${season || 1}/${episode || 1}/` : `/movie/${id}/`;
  // 1. page -> bootstrap token (escaped JSON inside the RSC flight payload)
  const page = await vidcoreRawRequest(`${vidcoreApi(env)}${pagePath}`, {
    headers: { 'User-Agent': VIDCORE_UA, Referer: vidcoreReferer(env) },
  });
  const tokenMatch = String(page || '').match(/\\"(?:en|token)\\":\\"(.*?)\\"/);
  if (!tokenMatch) throw new Error('vidcore: no token in page');
  // 2. stage1: token -> one-shot bootstrap URL + CSRF
  const s1 = await vidcoreGetDecoder(`${VIDCORE_ENC}?text=${encodeURIComponent(tokenMatch[1])}&stage=1`);
  if (!s1 || s1.status !== 200 || !s1.result || !s1.result.stage1) throw new Error('vidcore: stage1 failed');
  // 3. POST the bootstrap URL (CSRF'd) -> opaque text for stage2
  const stage1Text = await vidcoreRawRequest(s1.result.stage1, {
    method: 'POST',
    headers: { 'User-Agent': VIDCORE_UA, Referer: vidcoreReferer(env), 'X-CSRF-Token': s1.result.token },
  });
  // 4. stage2: text -> servers endpoint + stream base + CSRF for the next POSTs
  const s2 = await vidcoreGetDecoder(`${VIDCORE_ENC}?text=${encodeURIComponent(stage1Text)}&stage=2`);
  if (!s2 || s2.status !== 200 || !s2.result || !s2.result.servers) throw new Error('vidcore: stage2 failed');
  const { servers, stream, token } = s2.result;
  // 5. servers list (CSRF'd POST) -> dec -> [{name, data}]
  const serversText = await vidcoreRawRequest(servers, {
    method: 'POST',
    headers: { 'User-Agent': VIDCORE_UA, Referer: vidcoreReferer(env), 'X-CSRF-Token': token },
  });
  const dec1 = await postJson(VIDCORE_DEC, { text: serversText }, {});
  if (!dec1 || dec1.status !== 200 || !Array.isArray(dec1.result)) throw new Error('vidcore: server list decode failed');
  // 6. walk servers in order; first one holding the title yields the stream
  let lastError = null;
  for (const server of dec1.result.slice(0, VIDCORE_MAX_SERVERS)) {
    try {
      const streamText = await vidcoreRawRequest(`${stream}/${server.data}`, {
        method: 'POST',
        headers: { 'User-Agent': VIDCORE_UA, Referer: vidcoreReferer(env), 'X-CSRF-Token': token },
      });
      const dec2 = await postJson(VIDCORE_DEC, { text: streamText }, {});
      if (!dec2 || dec2.status !== 200 || !dec2.result) throw new Error(`decoder ${dec2 && dec2.status}`);
      if (!dec2.result.url) throw new Error('no url');
      return dec2.result;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`vidcore: no server held the title${lastError ? ` (${lastError.message})` : ''}`);
}

function vidcoreToResult(env, provider, data) {
  if (!data || !data.url) return { provider: provider.name, sources: [], subtitles: [] };
  const url = String(data.url);
  const source = {
    url,
    quality: 'auto',
    isM3U8: /\.m3u8($|\?)/i.test(url),
    headers: null,
    referer: vidcoreReferer(env),
    origin: vidcoreOrigin(env),
    lang: null,
    dub: null,
  };
  const subs = (Array.isArray(data.tracks) ? data.tracks : [])
    .map((t) => ({
      url: t && (t.file || t.url || t.src),
      label: (t && (t.label || t.language || t.lang)) || 'Unknown',
      lang: (t && (t.language || t.lang || t.label)) || null,
    }))
    .filter((sub) => sub.url);
  return { provider: provider.name, sources: [source], subtitles: subs };
}

export async function resolveVidcore(env, { type, id, season, episode, server }) {
  if (type !== 'movie' && type !== 'tv') throw new Error('type must be movie or tv');
  const ALL = vidcoreProviders(env);
  if (server) {
    const provider = ALL.find((candidate) => candidate.name === String(server).toLowerCase());
    if (!provider) throw new Error(`Unknown vidcore server '${server}'`);
    return vidcoreToResult(env, provider, await fetchVidcoreProvider(env, type, id, season, episode));
  }
  const key = titleKey(type, id, season, episode);
  const cachedName = vidcoreCache.get(key);
  const cached = cachedName && ALL.find((c) => c.name === cachedName);
  const order = (cached ? [cached, ...ALL.filter((p) => p.name !== cached.name)] : ALL).filter((p) => !isDead('vidcore', p, key));
  let lastError = null;
  const settled = await Promise.allSettled(
    order.map((p) => fetchVidcoreProvider(env, type, id, season, episode).then((r) => vidcoreToResult(env, p, r)))
  );
  for (let i = 0; i < order.length; i++) {
    const o = settled[i];
    if (o.status === 'rejected') {
      lastError = o.reason;
      markDead('vidcore', order[i], key);
      continue;
    }
    if (!o.value.sources.length) continue;
    vidcoreCache.set(key, order[i].name);
    return o.value;
  }
  throw new Error(`No vidcore source found${lastError ? ` (${lastError.message})` : ''}`);
}

// ---- auto race: first startable stream wins ----
async function autoRace(env, peachifyOrder, vidnestOrder, meowtvOrder, cinejoyOrder, vidcoreOrder, key, opts) {
  const candidates = [];
  for (const provider of peachifyOrder) candidates.push(['peachify', provider]);
  for (const provider of vidnestOrder) candidates.push(['vidnest', provider]);
  for (const provider of meowtvOrder) candidates.push(['meowtv', provider]);
  for (const provider of cinejoyOrder) candidates.push(['cinejoy', provider]);
  for (const provider of vidcoreOrder) candidates.push(['vidcore', provider]);
  return await new Promise((resolve) => {
    let remaining = candidates.length;
    if (!remaining) return resolve({ won: false, lastErr: {} });
    let finished = false;
    const lastErrors = {};
    const failCounts = { peachify: 0, vidnest: 0, meowtv: 0, cinejoy: 0, vidcore: 0 };
    const familySizes = { peachify: peachifyOrder.length, vidnest: vidnestOrder.length, meowtv: meowtvOrder.length, cinejoy: cinejoyOrder.length, vidcore: vidcoreOrder.length };
    const finish = (outcome) => {
      if (!finished) {
        finished = true;
        resolve(outcome);
      }
    };
    for (const [family, provider] of candidates) {
      (family === 'peachify'
        ? fetchProvider(env, provider, opts.type, opts.id, opts.season, opts.episode).then((payload) =>
            toResult(provider, payload)
          )
        : family === 'meowtv'
          ? fetchMeowtvProvider(env, provider, opts.type, opts.id, opts.season, opts.episode).then((payload) =>
              meowtvToResult(provider, payload)
            )
          : family === 'cinejoy'
            ? Promise.resolve(opts.metaPromise)
                .then((meta) => fetchCinejoyProvider(env, provider, opts.type, opts.id, opts.season, opts.episode, meta))
                .then((result) => cinejoyToResult(env, provider, result))
            : family === 'vidcore'
              ? fetchVidcoreProvider(env, opts.type, opts.id, opts.season, opts.episode).then((payload) =>
                  vidcoreToResult(env, provider, payload)
                )
              : fetchVidnestProvider(env, provider, opts.type, opts.id, opts.season, opts.episode).then((payload) =>
                  vidnestToResult(provider, payload)
                )
      )
        .then((result) => {
          healFamily(family);
          return { ok: true, family, provider, result };
        })
        .catch((error) => {
          markDead(family, provider, key);
          failCounts[family]++;
          lastErrors[family] = error && error.message;
          if (failCounts[family] === familySizes[family]) familyDeadUntil.set(family, Date.now() + FAMILY_TTL_MS);
          return { ok: false };
        })
        .then(async (outcome) => {
          try {
            if (outcome.ok && outcome.result.sources.length && !finished) {
              const probeCacheKey = `${outcome.family}:${outcome.provider.name}:${key}`;
              let playable = (streamOkCache.get(probeCacheKey) || 0) > Date.now();
              if (!playable) {
                playable = await probeStreamPlayable(outcome.result.sources[0]);
                if (playable) streamOkCache.set(probeCacheKey, Date.now() + STREAM_OK_TTL_MS);
              }
              if (playable) {
                let minDurationSec;
                try {
                  // Bound the runtime-metadata wait: a wedged/aborted upstream
                  // promise must never stall crowning on the edge.
                  minDurationSec = opts.minDurationPromise
                    ? await Promise.race([
                        opts.minDurationPromise,
                        new Promise((resolve) => setTimeout(() => resolve(undefined), 15000)),
                      ])
                    : undefined;
                } catch (e) {
                  minDurationSec = undefined;
                }
                if (minDurationSec === undefined) minDurationSec = opts.type === 'movie' ? 1200 : 900;
                const verified = await verifyWinnerSegments(outcome.result.sources[0], minDurationSec);
                if (!verified) {
                  markDead(outcome.family, outcome.provider, key);
                  failCounts[outcome.family]++;
                  lastErrors[outcome.family] = `${outcome.provider.name}: verification failed`;
                  if (failCounts[outcome.family] === familySizes[outcome.family]) {
                    familyDeadUntil.set(outcome.family, Date.now() + FAMILY_TTL_MS);
                  }
                } else {
                  if (finished) return;
                  (outcome.family === 'peachify'
                    ? providerCache
                    : outcome.family === 'meowtv'
                      ? meowtvCache
                      : outcome.family === 'cinejoy'
                        ? cinejoyCache
                        : outcome.family === 'vidcore'
                          ? vidcoreCache
                          : vidnestCache
                  ).set(key, outcome.provider.name);
                  return finish({ won: true, result: outcome.result });
                }
              }
              markDead(outcome.family, outcome.provider, key);
              failCounts[outcome.family]++;
              lastErrors[outcome.family] = `${outcome.provider.name}: stream not startable`;
              if (failCounts[outcome.family] === familySizes[outcome.family]) familyDeadUntil.set(outcome.family, Date.now() + FAMILY_TTL_MS);
            }
          } finally {
            remaining--;
            if (!remaining && !finished) finish({ won: false, lastErr: lastErrors });
          }
        });
    }
  });
}

export async function resolveStream(env, { type, id, season, episode, server, skip, minDurationPromise }) {
  if (type !== 'movie' && type !== 'tv') throw new Error('type must be movie or tv');
  if (!env.PEACHIFY_KEY_HEX) throw new Error('PEACHIFY_KEY_HEX env required');
  if (!env.VIDNEST_ALPHABET) throw new Error('VIDNEST_ALPHABET env required');
  const ALL_PEACH = peachProviders(env);
  const ALL_VID = vidnestProviders(env);
  if (server) {
    const name = String(server).toLowerCase();
    const vidnestProvider = ALL_VID.find((candidate) => candidate.name === name);
    if (vidnestProvider) return resolveVidnest(env, { type, id, season, episode, server: name });
    const meowtvProvider = meowProviders(env).find((candidate) => candidate.name === name);
    if (meowtvProvider) return resolveMeowtv(env, { type, id, season, episode, server: name });
    const byseProvider = byseProviders(env).find((candidate) => candidate.name === name);
    if (byseProvider) return resolveByse(env, { type, id, season, episode, server: name });
    const cinejoyProvider = cinejoyProviders(env).find((candidate) => candidate.name === name || candidate.slug === name);
    if (cinejoyProvider) return resolveCinejoy(env, { type, id, season, episode, server: name });
    const vidcoreProvider = vidcoreProviders(env).find((candidate) => candidate.name === name);
    if (vidcoreProvider) return resolveVidcore(env, { type, id, season, episode, server: name });
    const provider = ALL_PEACH.find((candidate) => candidate.name === name || candidate.path === name);
    if (!provider) throw new Error(`Unknown provider '${server}'`);
    const data = await fetchProvider(env, provider, type, id, season, episode);
    return toResult(provider, data);
  }
  const key = titleKey(type, id, season, episode);
  const cachedPeachifyName = providerCache.get(key);
  const cachedPeachify = cachedPeachifyName && ALL_PEACH.find((candidate) => candidate.name === cachedPeachifyName);
  const skipSet = new Set((skip || []).map((name) => String(name).toLowerCase()));
  const peachifyOrder = (cachedPeachify ? [cachedPeachify, ...ALL_PEACH.filter((provider) => provider.name !== cachedPeachify.name)] : ALL_PEACH).filter(
    (provider) => !skipSet.has(provider.name) && !familyDown('peachify') && !isDead('peachify', provider, key)
  );
  const cachedVidnestName = vidnestCache.get(key);
  const cachedVidnest = cachedVidnestName && ALL_VID.find((candidate) => candidate.name === cachedVidnestName);
  const vidnestOrder = (cachedVidnest ? [cachedVidnest, ...ALL_VID.filter((provider) => provider.name !== cachedVidnest.name)] : ALL_VID).filter(
    (provider) => !skipSet.has(provider.name) && !familyDown('vidnest') && !isDead('vidnest', provider, key)
  );
  const ALL_MEOW = meowProviders(env);
  const cachedMeowtvName = meowtvCache.get(key);
  const cachedMeowtv = cachedMeowtvName && ALL_MEOW.find((candidate) => candidate.name === cachedMeowtvName);
  const meowtvOrder = (cachedMeowtv ? [cachedMeowtv, ...ALL_MEOW.filter((p) => p.name !== cachedMeowtv.name)] : ALL_MEOW).filter(
    (provider) => !skipSet.has(provider.name) && !familyDown('meowtv') && !isDead('meowtv', provider, key)
  );
  const ALL_CINEJOY = cinejoyProviders(env);
  const cachedCinejoyName = cinejoyCache.get(key);
  const cachedCinejoy = cachedCinejoyName && ALL_CINEJOY.find((candidate) => candidate.name === cachedCinejoyName);
  const cinejoyOrder = (cachedCinejoy ? [cachedCinejoy, ...ALL_CINEJOY.filter((p) => p.name !== cachedCinejoy.name)] : ALL_CINEJOY).filter(
    (provider) => !skipSet.has(provider.name) && !familyDown('cinejoy') && !isDead('cinejoy', provider, key)
  );
  const metaPromise = cinejoyOrder.length ? fetchTitleMeta(env, type, id) : Promise.resolve(null);
  const ALL_VIDCORE = vidcoreProviders(env);
  const cachedVidcoreName = vidcoreCache.get(key);
  const cachedVidcore = cachedVidcoreName && ALL_VIDCORE.find((candidate) => candidate.name === cachedVidcoreName);
  const vidcoreOrder = (cachedVidcore ? [cachedVidcore, ...ALL_VIDCORE.filter((p) => p.name !== cachedVidcore.name)] : ALL_VIDCORE).filter(
    (p) => !skipSet.has(p.name) && !familyDown('vidcore') && !isDead('vidcore', p, key)
  );
  const outcome = await autoRace(
    env,
    peachifyOrder,
    vidnestOrder,
    meowtvOrder,
    cinejoyOrder,
    vidcoreOrder,
    key,
    { type, id, season, episode, minDurationPromise, metaPromise }
  );
  if (outcome.won) return outcome.result;
  return { provider: null, sources: [], subtitles: [] };
}

function unwrapProxies(src) {
  if (!src || !src.url || !/\/(?:m3u8|mp4)-proxy/.test(src.url)) return src;
  try {
    const proxyUrl = new URL(src.url);
    const targetUrl = proxyUrl.searchParams.get('url');
    if (!targetUrl) return src;
    let headers = null;
    try {
      const embedded = JSON.parse(proxyUrl.searchParams.get('headers') || '{}');
      headers = { ...(embedded.origin ? { Origin: embedded.origin } : {}), ...(embedded.referer ? { Referer: embedded.referer } : {}) };
    } catch {}
    return { ...src, url: targetUrl, headers };
  } catch {
    return src;
  }
}

export function toResult(provider, data) {
  const sources = (data.sources || [])
    .map((rawSource) => {
      const unwrapped = unwrapProxies(rawSource);
      const rawHeaders = unwrapped.headers || {};
      return {
        url: unwrapped.url || unwrapped.src || unwrapped.file,
        quality: unwrapped.quality || unwrapped.resolution || unwrapped.height || 'auto',
        sizeBytes: unwrapped.sizeBytes || unwrapped.size || null,
        dub: unwrapped.dub || null,
        isM3U8:
          /\.m3u8($|\?)|m3u8-proxy|streamsvr|\/hls\d*\//i.test(unwrapped.url || '') ||
          /master\.txt($|\?)|\.txt($|\?)/i.test(unwrapped.url || ''),
        headers: unwrapped.headers || null,
        referer: rawHeaders.Referer || rawHeaders.referer || null,
        origin: rawHeaders.Origin || rawHeaders.origin || null,
      };
    })
    .filter((source) => source.url);
  const subtitles = (data.subtitles || [])
    .map((rawSub) => ({
      url: rawSub.url || rawSub.file || rawSub.src,
      label: rawSub.label || rawSub.language || rawSub.lang || 'Unknown',
      lang: rawSub.lang || rawSub.language || null,
      format: rawSub.format || null,
      encoding: rawSub.encoding || null,
    }))
    .filter((sub) => sub.url);
  return { provider: provider.name, sources, subtitles };
}
