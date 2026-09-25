// functions/lib/extractor.js — Stream resolver ported to Workers runtime (no Node APIs).
//
// Same logic as src/services/extractor.js:
//   peachify  -> AES-256-GCM (WebCrypto) -> { sources, subtitles }
//   vidnest   -> custom-base64 alphabet    -> 3 shapes normalized to { sources }
// Only the plumbing changed: axios -> fetch, crypto -> subtle, Buffer -> Uint8Array.

export const PROVIDERS = [
  { name: 'horizon', path: 'hr' },
  { name: 'wolf', path: 'air' },
  { name: 'spider', path: 'holly' },
  { name: 'multi', path: 'multi' },
  { name: 'iron', path: 'moviebox' },
];

export const VIDNEST_PROVIDERS = [
  // Direct-first: exact-arrival ties in the auto race resolve to the earliest
  // registered provider, so historically CORS-open (browser-direct, zero proxy
  // cost) providers go first. Relay/gated hosts (proxy-burning) go last.
  { name: 'buzz' }, // 97bf1.com — CORS-open, direct
  { name: 'vidxyz' }, // sparkvid relay — CORS-open, direct
  { name: 'ngc', slug: 'nextgencloudfabric' }, // remoteconsultinggroup — ACAO *, direct
  { name: 'videasy' }, // tiktoks.animanga.fun relay — movie + tv
  { name: 'hollymoviehd' }, // direct mp4/hls streams, per-stream referers
  { name: 'rogflix' }, // akcloud.animanga.fun relay
];

const PEACHIFY_API = 'https://none.eat-peach.sbs';
const PEACHIFY_REFERER = 'https://peachify.top/';
const VIDNEST_API = 'https://new.vidnest.fun';
const VIDNEST_REFERER = 'https://vidnest.fun/';
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
  let url = `${PEACHIFY_API}/${provider.path}/${type}/${id}`;
  if (type === 'tv') url += `/${season}/${episode}`;
  try {
    const json = await fetchJSON(url, {
      headers: { Referer: PEACHIFY_REFERER, Origin: 'https://peachify.top', 'User-Agent': STREAM_UA },
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
    let url = `${PEACHIFY_API}/subs/${type}/${id}`;
    if (type === 'tv') url += `/${season}/${episode}`;
    const raw = await fetchJSON(url, {
      headers: { Referer: PEACHIFY_REFERER, Origin: 'https://peachify.top', 'User-Agent': STREAM_UA },
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
    return [];
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

async function fetchVidnestProvider(env, provider, type, id, season, episode) {
  const slug = provider.slug || provider.name;
  let url = `${VIDNEST_API}/${slug}/${type}/${id}`;
  if (type === 'tv') url += `/${season}/${episode}`;
  try {
    const json = await fetchJSON(url, {
      headers: { Referer: VIDNEST_REFERER, Origin: 'https://vidnest.fun', 'User-Agent': STREAM_UA },
    });
    if (!json || !json.data) throw new Error(`vidnest ${provider.name}: unexpected response`);
    return JSON.parse(vidnestDecode(json.data, env.VIDNEST_ALPHABET));
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
  if (server) {
    const provider = VIDNEST_PROVIDERS.find((candidate) => candidate.name === String(server).toLowerCase());
    if (!provider) throw new Error(`Unknown vidnest provider '${server}'`);
    return vidnestToResult(provider, await fetchVidnestProvider(provider, type, id, season, episode));
  }
  const key = titleKey(type, id, season, episode);
  const cachedName = vidnestCache.get(key);
  const cachedProvider = cachedName && VIDNEST_PROVIDERS.find((candidate) => candidate.name === cachedName);
  const baseOrder = cachedProvider
    ? [cachedProvider, ...VIDNEST_PROVIDERS.filter((provider) => provider.name !== cachedProvider.name)]
    : VIDNEST_PROVIDERS;
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
  if (!/#EXT/i.test(childProbe.body || '').slice(0, 300)) return true;
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

// ---- auto race: first startable stream wins ----
async function autoRace(env, peachifyOrder, vidnestOrder, key, opts) {
  const candidates = [];
  for (const provider of peachifyOrder) candidates.push(['peachify', provider]);
  for (const provider of vidnestOrder) candidates.push(['vidnest', provider]);
  return await new Promise((resolve) => {
    let remaining = candidates.length;
    if (!remaining) return resolve({ won: false, lastErr: {} });
    let finished = false;
    const lastErrors = {};
    const failCounts = { peachify: 0, vidnest: 0 };
    const familySizes = { peachify: peachifyOrder.length, vidnest: vidnestOrder.length };
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
                  minDurationSec = (opts.minDurationPromise && (await opts.minDurationPromise)) || undefined;
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
                  (outcome.family === 'peachify' ? providerCache : vidnestCache).set(key, outcome.provider.name);
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
  if (server) {
    const name = String(server).toLowerCase();
    const vidnestProvider = VIDNEST_PROVIDERS.find((candidate) => candidate.name === name);
    if (vidnestProvider) return resolveVidnest(env, { type, id, season, episode, server: name });
    const provider = PROVIDERS.find((candidate) => candidate.name === name || candidate.path === name);
    if (!provider) throw new Error(`Unknown provider '${server}'`);
    const data = await fetchProvider(env, provider, type, id, season, episode);
    return toResult(provider, data);
  }
  const key = titleKey(type, id, season, episode);
  const cachedPeachifyName = providerCache.get(key);
  const cachedPeachify = cachedPeachifyName && PROVIDERS.find((candidate) => candidate.name === cachedPeachifyName);
  const skipSet = new Set((skip || []).map((name) => String(name).toLowerCase()));
  const peachifyOrder = (cachedPeachify ? [cachedPeachify, ...PROVIDERS.filter((provider) => provider.name !== cachedPeachify.name)] : PROVIDERS).filter(
    (provider) => !skipSet.has(provider.name) && !familyDown('peachify') && !isDead('peachify', provider, key)
  );
  const cachedVidnestName = vidnestCache.get(key);
  const cachedVidnest = cachedVidnestName && VIDNEST_PROVIDERS.find((candidate) => candidate.name === cachedVidnestName);
  const vidnestOrder = (cachedVidnest ? [cachedVidnest, ...VIDNEST_PROVIDERS.filter((provider) => provider.name !== cachedVidnest.name)] : VIDNEST_PROVIDERS).filter(
    (provider) => !skipSet.has(provider.name) && !familyDown('vidnest') && !isDead('vidnest', provider, key)
  );
  const outcome = await autoRace(env, peachifyOrder, vidnestOrder, key, { type, id, season, episode, minDurationPromise });
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
