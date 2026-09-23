// functions/lib/ex.js — Stream resolver ported to Workers runtime (no Node APIs).
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
  const p = new URLSearchParams({ ref });
  if (org) p.set('origin', org);
  p.set('url', url);
  p.set('exp', String(exp));
  p.set('sig', sig);
  return `${base}/play?${p.toString()}`;
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
      .map((s) => ({
        url: s.url || s.file || s.src,
        label: s.label || s.language || s.lang || 'Unknown',
        lang: s.lang || s.language || null,
      }))
      .filter((s) => s.url);
    subsCache.set(key, subs);
    return subs;
  } catch {
    return [];
  }
}

// ---- vidnest ----
export function vidnestDecode(data, alphabet) {
  const l = [...String(data)].map((c) => alphabet.indexOf(c));
  const bytes = [];
  for (let o = 0; o + 3 < l.length; o += 4) {
    const a = l[o], b = l[o + 1], c = l[o + 2], d = l[o + 3];
    if (a < 0 || a > 63) break;
    bytes.push((a << 2) | (b >> 4));
    if (c !== 64) bytes.push(((b & 15) << 4) | (c >> 2));
    if (d !== 64) bytes.push(((c & 3) << 6) | d);
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
    .map((s) => {
      const url = s.url || s.file;
      if (!url) return null;
      return {
        url,
        quality: s.quality || s.resolution || s.label || 'auto',
        isM3U8:
          s.type === 'hls' ||
          /\.m3u8($|\?)|streamsvr|\/hls\d*\//i.test(url) ||
          /master\.txt($|\?)|\.txt($|\?)/i.test(url),
        headers: s.headers || null,
        referer: (s.headers && s.headers.Referer) || s.referer || null,
        lang: s.language || null,
      };
    })
    .filter(Boolean);
  return { provider: provider.name, sources, subtitles: [] };
}

async function resolveVidnest(env, { type, id, season, episode, server }) {
  if (type !== 'movie' && type !== 'tv') throw new Error('type must be movie or tv');
  if (server) {
    const p = VIDNEST_PROVIDERS.find((x) => x.name === String(server).toLowerCase());
    if (!p) throw new Error(`Unknown vidnest provider '${server}'`);
    return vidnestToResult(p, await fetchVidnestProvider(env, p, type, id, season, episode));
  }
  const key = titleKey(type, id, season, episode);
  const cached = vidnestCache.get(key);
  const baseOrder = cached
    ? [cached, ...VIDNEST_PROVIDERS.filter((p) => p.name !== cached.name)]
    : VIDNEST_PROVIDERS;
  const order = baseOrder.filter((p) => !isDead('vidnest', p, key));
  let lastError = null;
  const settled = await Promise.allSettled(
    order.map((p) => fetchVidnestProvider(env, p, type, id, season, episode).then((d) => vidnestToResult(p, d)))
  );
  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    const s = settled[i];
    if (s.status === 'rejected') {
      lastError = s.reason;
      markDead('vidnest', p, key);
      continue;
    }
    if (!s.value.sources.length) continue;
    vidnestCache.set(key, p.name);
    return s.value;
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
        .map((s) => ({ url: s.file || s.url, label: s.label, lang: s.label || null }))
        .filter((s) => s.url);
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
async function probeStreamPlayable(src) {
  if (!src || !src.url) return false;
  try {
    const headers = { 'User-Agent': STREAM_UA, Referer: src.referer || PEACHIFY_REFERER };
    if (src.origin) headers.Origin = src.origin;
    const isM3U8 =
      src.isM3U8 ||
      /\.m3u8($|\?)|streamsvr|\/hls\d*\//i.test(src.url) ||
      /master\.txt($|\?)|\.txt($|\?)/i.test(src.url);
    if (!isM3U8) headers.Range = 'bytes=0-0';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_STREAM_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(src.url, { headers, signal: ctrl.signal, redirect: 'follow' });
    } finally {
      clearTimeout(t);
    }
    if (!res || (res.status !== 200 && res.status !== 206)) return false;
    if (isM3U8) {
      const head = (await res.text()).slice(0, 300);
      const ct = res.headers.get('content-type') || '';
      return /#EXT/i.test(head) || ct.includes('mpegurl');
    }
    return (await res.arrayBuffer()).byteLength > 0;
  } catch {
    return false;
  }
}

// ---- auto race: first startable stream wins ----
async function autoRace(env, pOrder, vOrder, key, opts) {
  const cand = [];
  for (const p of pOrder) cand.push(['peachify', p]);
  for (const p of vOrder) cand.push(['vidnest', p]);
  return await new Promise((resolve) => {
    let left = cand.length;
    if (!left) return resolve({ won: false, lastErr: {} });
    let done = false;
    const lastErr = {};
    const fails = { peachify: 0, vidnest: 0 };
    const totals = { peachify: pOrder.length, vidnest: vOrder.length };
    const finish = (out) => {
      if (!done) {
        done = true;
        resolve(out);
      }
    };
    for (const [fam, p] of cand) {
      (fam === 'peachify'
        ? fetchProvider(env, p, opts.type, opts.id, opts.season, opts.episode).then((d) =>
            toResult(p, d)
          )
        : fetchVidnestProvider(env, p, opts.type, opts.id, opts.season, opts.episode).then((d) =>
            vidnestToResult(p, d)
          )
      )
        .then((result) => {
          healFamily(fam);
          return { ok: true, fam, p, result };
        })
        .catch((e) => {
          markDead(fam, p, key);
          fails[fam]++;
          lastErr[fam] = e && e.message;
          if (fails[fam] === totals[fam]) familyDeadUntil.set(fam, Date.now() + FAMILY_TTL_MS);
          return { ok: false };
        })
        .then(async (r) => {
          try {
            if (r.ok && r.result.sources.length && !done) {
              const scKey = `${r.fam}:${r.p.name}:${key}`;
              let playable = (streamOkCache.get(scKey) || 0) > Date.now();
              if (!playable) {
                playable = await probeStreamPlayable(r.result.sources[0]);
                if (playable) streamOkCache.set(scKey, Date.now() + STREAM_OK_TTL_MS);
              }
              if (playable) {
                (r.fam === 'peachify' ? providerCache : vidnestCache).set(key, r.p.name);
                return finish({ won: true, result: r.result });
              }
              markDead(r.fam, r.p, key);
              fails[r.fam]++;
              lastErr[r.fam] = `${r.p.name}: stream not startable`;
              if (fails[r.fam] === totals[r.fam]) familyDeadUntil.set(r.fam, Date.now() + FAMILY_TTL_MS);
            }
          } finally {
            left--;
            if (!left && !done) finish({ won: false, lastErr });
          }
        });
    }
  });
}

export async function resolveStream(env, { type, id, season, episode, server, skip }) {
  if (type !== 'movie' && type !== 'tv') throw new Error('type must be movie or tv');
  if (!env.PEACHIFY_KEY_HEX) throw new Error('PEACHIFY_KEY_HEX env required');
  if (!env.VIDNEST_ALPHABET) throw new Error('VIDNEST_ALPHABET env required');
  if (server) {
    const name = String(server).toLowerCase();
    const vid = VIDNEST_PROVIDERS.find((x) => x.name === name);
    if (vid) return resolveVidnest(env, { type, id, season, episode, server: name });
    const p = PROVIDERS.find((x) => x.name === name || x.path === name);
    if (!p) throw new Error(`Unknown provider '${server}'`);
    const data = await fetchProvider(env, p, type, id, season, episode);
    return toResult(p, data);
  }
  const key = titleKey(type, id, season, episode);
  const pc = providerCache.get(key);
  const skipSet = new Set((skip || []).map((s) => String(s).toLowerCase()));
  const pOrder = (pc ? [pc, ...PROVIDERS.filter((p) => p.name !== pc.name)] : PROVIDERS).filter(
    (p) => !skipSet.has(p.name) && !familyDown('peachify') && !isDead('peachify', p, key)
  );
  const vc = vidnestCache.get(key);
  const vOrder = (vc ? [vc, ...VIDNEST_PROVIDERS.filter((p) => p.name !== vc.name)] : VIDNEST_PROVIDERS).filter(
    (p) => !skipSet.has(p.name) && !familyDown('vidnest') && !isDead('vidnest', p, key)
  );
  const out = await autoRace(env, pOrder, vOrder, key, { type, id, season, episode });
  if (out.won) return out.result;
  return { provider: null, sources: [], subtitles: [] };
}

function unwrapProxies(src) {
  if (!src || !src.url || !/\/(?:m3u8|mp4)-proxy/.test(src.url)) return src;
  try {
    const u = new URL(src.url);
    const real = u.searchParams.get('url');
    if (!real) return src;
    let headers = null;
    try {
      const h = JSON.parse(u.searchParams.get('headers') || '{}');
      headers = { ...(h.origin ? { Origin: h.origin } : {}), ...(h.referer ? { Referer: h.referer } : {}) };
    } catch {}
    return { ...src, url: real, headers };
  } catch {
    return src;
  }
}

export function toResult(provider, data) {
  const sources = (data.sources || [])
    .map((s) => {
      const unwrapped = unwrapProxies(s);
      const h = unwrapped.headers || {};
      return {
        url: unwrapped.url || unwrapped.src || unwrapped.file,
        quality: unwrapped.quality || unwrapped.resolution || unwrapped.height || 'auto',
        sizeBytes: unwrapped.sizeBytes || unwrapped.size || null,
        dub: unwrapped.dub || null,
        isM3U8:
          /\.m3u8($|\?)|m3u8-proxy|streamsvr|\/hls\d*\//i.test(unwrapped.url || '') ||
          /master\.txt($|\?)|\.txt($|\?)/i.test(unwrapped.url || ''),
        headers: unwrapped.headers || null,
        referer: h.Referer || h.referer || null,
        origin: h.Origin || h.origin || null,
      };
    })
    .filter((s) => s.url);
  const subtitles = (data.subtitles || [])
    .map((s) => ({
      url: s.url || s.file || s.src,
      label: s.label || s.language || s.lang || 'Unknown',
      lang: s.lang || s.language || null,
      format: s.format || null,
      encoding: s.encoding || null,
    }))
    .filter((s) => s.url);
  return { provider: provider.name, sources, subtitles };
}
