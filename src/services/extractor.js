// Stream resolver for myflixerfree.to's embed stack — pure HTTP, no browser.
//
// Two embed families are supported, each cracked from its own public bundle:
//
// peachify (x.eat-peach.sbs):
//   GET https://x.eat-peach.sbs/{provider}/{type}/{id}[/{season}/{episode}]
//   -> {"isEncrypted": true, "data": "{iv}.{ciphertext}.{authTag}"}   (base64url)
//   -> AES-GCM decrypt with the key from their public JS
//   -> { sources: [{url, quality, sizeBytes, headers}], subtitles: [...] }
//
// vidnest (new.vidnest.fun):
//   GET https://new.vidnest.fun/{provider}/{type}/{id}[/{season}/{episode}]
//   -> {"encrypted": true, "data": "<custom-base64>"}
//   -> decode with the 65-char alphabet from their bundle
//   -> shape varies per provider: {url, headers} (relay hosts),
//      {streams:[...]} (direct mp4/hls), or {url, headers, referer, ...}
//
// Other myflixerfree servers are dead upstream: vidsrc (Cloudflare 403),
// vidify (522), vidcore/vidfast (API 500s + player is bot-gated; shared code).
// Response time: ~1-2s per title (vs ~45s with a headless browser).
// peachify (eat-peach):
//   GET https://none.eat-peach.sbs/{provider}/{type}/{id}[/{season}/{episode}]
//   -> { sources: [{url, dub, type, headers}], subtitles: [...] }   (plain JSON now)
//   (Referer-gated: peachify.top / peachify.pro are allowed, others 403.)
//
// History: the old host x.eat-peach.sbs served {"isEncrypted":true,"data":
// "{iv}.{ct}.{tag}"} (AES-256-GCM, key below) but now connection-blackholes.
// The new host was decoded from peachify.pro's own player bundle (dF()/dO()):
// same endpoint shape and same key, but responses are PLAIN JSON. Stream URLs
// still point at the DEAD host's /m3u8-proxy?url=<real>&headers=<json> —
// toResult() rewrites those into the real CDN URL so playback rides our /play
// proxy with the embedded Origin/Referer headers.
const crypto = require('crypto');
const { httpClient } = require('../utils/http');
const { loadUpstreams, registerBreakerSnapshot } = require('./upstreams');

// Routing comes from config/upstreams.json (UPSTREAMS_JSON env overrides it
// for hot-patches). Accessors below always read the CURRENT table so an env
// change + /health/upstreams?refresh=1 takes effect without a restart.
function cfg() {
  return loadUpstreams();
}
function peach() {
  return cfg().families.peachify;
}
function vid() {
  return cfg().families.vidnest;
}
function peachApi() {
  return peach().api;
}
function peachReferer() {
  return peach().referer || 'https://peachify.top/';
}
function peachOrigin() {
  return peach().origin || 'https://peachify.top';
}
function vidApi() {
  return vid().api;
}
function vidReferer() {
  return vid().referer || 'https://vidnest.fun/';
}
function vidOrigin() {
  return vid().origin || 'https://vidnest.fun';
}
function meow() {
  return cfg().families.meowtv;
}
function meowApi() {
  return meow().api;
}
function meowReferer() {
  return meow().referer || 'https://meowtv.ru/';
}
function meowOrigin() {
  return meow().origin || 'https://meowtv.ru';
}
function byse() {
  return cfg().families.byse;
}
function byseApi() {
  return byse().api;
}
function byseReferer() {
  return byse().referer || 'https://0123movie.space/';
}
const PEACHIFY_REFERER = 'https://peachify.top/';

// Provider order mirrors the site's own player auto-cycling. Read live from
// config so renames/additions never touch this file.
function getProviders() {
  return peach().providers;
}
function getVidnestProviders() {
  return vid().providers;
}
function getMeowtvProviders() {
  return meow().providers;
}
function getByseProviders() {
  return byse().providers;
}
// Back-compat consts: string values captured from the CURRENT config for
// template literals + legacy importers. Refreshed by refreshUpstreamConsts().
let PEACHIFY_API = (peach().api || '');
let VIDNEST_API = (vid().api || '');
let VIDNEST_REFERER = (vid().referer || 'https://vidnest.fun/');
function refreshUpstreamConsts() {
  try {
    loadUpstreams({ reload: true });
  } catch {}
  PEACHIFY_API = (peach().api || '');
  VIDNEST_API = (vid().api || '');
  VIDNEST_REFERER = (vid().referer || 'https://vidnest.fun/');
  syncExportedProviderLists();
}
// Legacy `require().PROVIDERS` callers (tmdb.js SERVERS at boot, tests)
// mutate/import these arrays — keep them as live-synced views of config.
const PROVIDERS = [];
const VIDNEST_PROVIDERS = [];
const MEOWTV_PROVIDERS = [];
const BYSE_PROVIDERS = [];
function syncExportedProviderLists() {
  try {
    PROVIDERS.length = 0;
    for (const p of getProviders()) PROVIDERS.push(p);
    VIDNEST_PROVIDERS.length = 0;
    for (const p of getVidnestProviders()) VIDNEST_PROVIDERS.push(p);
    MEOWTV_PROVIDERS.length = 0;
    for (const p of getMeowtvProviders()) MEOWTV_PROVIDERS.push(p);
    BYSE_PROVIDERS.length = 0;
    for (const p of getByseProviders()) BYSE_PROVIDERS.push(p);
  } catch {}
}
syncExportedProviderLists();

// vidnest's player bundles all fetch through new.vidnest.fun. Alphabet is a
// reordered base64 from their bundle; `slug` overrides the API path segment
// where it differs from the UI name. vidxyz returned to service (was 502 on
// every title when first wired — re-probed 2026-08: working again, content-
// gated per title like the rest). vidlink is still dead (502 HTML on every title).
// NOTE: hosts/slugs live in config/upstreams.json now — see getVidnestProviders().
const PEACHIFY_KEY_HEX = process.env.PEACHIFY_KEY_HEX || "d8f2a1b5e9c470814f6b2c3a5d8e7f901a2b3c4d5e3f7a8b9c0d1e2f3a4d5c6d";
// vidnest rotated their AES secret in 2026-10 (bundle constant "K3p8vQ2m...").
// Old value F9k2mR8... no longer authenticates — GCM decrypt fails for every
// provider, which is why /sources went empty. Response now also carries v:2.
const VIDNEST_SECRET = process.env.VIDNEST_SECRET || 'K3p8vQ2mX9rL5wZ0fN7bG1sH4tJ6dC9_y8S3wM1nQ5pL2';
// NOTE: VIDNEST_REFERER is defined above from config (let, refreshable).
const VIDNEST_ALPHABET = process.env.VIDNEST_ALPHABET || "RB0fpH8ZEyVLkv7c2i6MAJ5u3IKFDxlS1NTsnGaqmXYdUrtzjwObCgQP94hoeW+/=";

const STREAM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const PLAY_PROXY_DEFAULT = 'https://cinephile-play.cinephilia-areana.workers.dev';
const PLAY_SIG_TTL_S = 2 * 3600; // signed play URLs live 2h (tokenized CDNs expire faster anyway)

// Sign a proxy URL so the Worker can tell our players apart from hotlinkers.
// Returns null when PLAY_SIGNING_KEY is unset (player falls back to unsigned;
// Worker warn-mode still serves those until REQUIRE_SIGNED=1).
function signPlayUrl({ url, referer, origin }) {
  const key = process.env.PLAY_SIGNING_KEY;
  if (!key || !url) return null;
  if (!process.env.PLAY_PROXY_BASE) return null;
  const base = process.env.PLAY_PROXY_BASE.replace(/\/$/, '');
  const ref = referer || PEACHIFY_REFERER;
  const org = origin || '';
  const exp = Math.floor(Date.now() / 1000) + PLAY_SIG_TTL_S;
  const msg = `${url}\n${ref}\n${org}\n${exp}`;
  const sig = crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex');
  const params = new URLSearchParams({ ref });
  if (org) params.set('origin', org);
  params.set('url', url);
  params.set('exp', String(exp));
  params.set('sig', sig);
  return `${base}/play?${params.toString()}`;
}

const base64UrlToBytes = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// Per-title caches: which provider last succeeded (skip the empty ones next time)
// and resolved subtitles. Both are stable per title — makes repeat plays instant.
// One cache per family (provider names live in different namespaces).
const providerCache = new Map();
const vidnestCache = new Map();
const meowtvCache = new Map();
const byseCache = new Map();
const subsCache = new Map();
const vdrkSubsCache = new Map();

// Dead-provider cache: providers that just failed are skipped for 30s. Dead
// upstreams are the common case (content-gated 502s, flaky CDNs), so without
// this every auto-cycle would burn a full timeout on each known-bad provider.
const DEAD_TTL_MS = 30_000;
const deadCache = new Map(); // `${family}:${providerName}:${titleKey}` -> expiry ms

function markDead(family, provider, key) {
  deadCache.set(`${family}:${provider.name}:${key}`, Date.now() + DEAD_TTL_MS);
}

function isDead(family, provider, key) {
  return (deadCache.get(`${family}:${provider.name}:${key}`) || 0) > Date.now();
}

// Family circuit breaker: per-title dead marks don't help when an ENTIRE
// family is dark (DNS/connect hangs hit every provider of that family for
// every new title — each pays one probe-timeout). If a whole wave fails,
// skip the family entirely for a minute; the first healthy title heals it.
const FAMILY_TTL_MS = 60_000;
const familyDeadUntil = new Map(); // family -> expiry ms

function familyDown(family) {
  return (familyDeadUntil.get(family) || 0) > Date.now();
}

function healFamily(family) {
  familyDeadUntil.delete(family);
}

// Probe ceiling — PURE ANTI-BLACKHOLE NET, not a latency tool. Auto mode
// returns on the first fast answer, long before this fires; the ceiling only
// exists so a SYN-dropped / half-open connection can't hang a probe forever,
// leak sockets, or stall a total-outage /sources request indefinitely. It is
// therefore GENEROUS (default 15 s, override with PROVIDER_TIMEOUT_MS env):
// killing a slow-but-alive provider at 4 s used to manufacture failures —
// inflating dead-marks and tripping family breakers for providers that were
// merely slow, which is the opposite of racing everything and picking the
// fastest responder.
const PROBE_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS) || 15000;

// Bound every upstream request so a hanging CDN can't stall the whole cycle.
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function titleKey(type, id, season, episode) {
  return type === 'tv' ? `tv/${id}/${season}/${episode}` : `movie/${id}`;
}

function decryptPayload(payload) {
  const [iv, ct, tag] = String(payload).split('.');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(PEACHIFY_KEY_HEX, 'hex'),
    base64UrlToBytes(iv)
  );
  decipher.setAuthTag(base64UrlToBytes(tag));
  const plain = Buffer.concat([decipher.update(base64UrlToBytes(ct)), decipher.final()]);
  return JSON.parse(plain.toString());
}

async function fetchProvider(provider, type, id, season, episode, signal) {
  let url = `${peachApi()}/${provider.path}/${type}/${id}`;
  if (type === 'tv') url += `/${season}/${episode}`;
  try {
    const res = await httpClient.get(url, {
      headers: {
        Referer: peachReferer(),
        Origin: peachOrigin(),
        'User-Agent': STREAM_UA,
      },
      timeout: PROBE_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    const json = res.data;
    if (json && json.isEncrypted) return decryptPayload(json.data);
    return json;
  } catch (err) {
    const status = err.response ? err.response.status : '';
    throw new Error(`peachify ${provider.name} API ${status || err.message}`);
  }
}

async function fetchSubtitles(type, id, season, episode) {
  const key = titleKey(type, id, season, episode);
  if (subsCache.has(key)) return subsCache.get(key);
  try {
    let url = `${peachApi()}/subs/${type}/${id}`;
    if (type === 'tv') url += `/${season}/${episode}`;
    const response = await httpClient.get(url, {
      headers: {
        Referer: peachReferer(),
        Origin: peachOrigin(),
        'User-Agent': STREAM_UA,
      },
      timeout: 3000,
    });
    const raw = response.data || [];
    const subs = (Array.isArray(raw) ? raw : [])
      .map((rawSub) => ({
        url: rawSub.url || rawSub.file || rawSub.src,
        label: rawSub.label || rawSub.language || rawSub.lang || 'Unknown',
        lang: rawSub.lang || rawSub.language || null,
      }))
      .filter((sub) => sub.url);
    subsCache.set(key, subs);
    return subs;
  } catch (e) {
    // peachify subs are offline (family dark) — meowtv serves the same
    // [{label, file}] VTT shape; persist across both paths.
    try {
      const subs = await fetchMeowtvSubtitles(type, id, season, episode);
      subsCache.set(key, subs);
      return subs;
    } catch (e2) {
      return [];
    }
  }
}

// ---- vidnest ----

function vidnestDecode(data) {
  const codes = [...String(data)].map((c) => VIDNEST_ALPHABET.indexOf(c));
  const bytes = [];
  for (let offset = 0; offset + 3 < codes.length; offset += 4) {
    const n0 = codes[offset], n1 = codes[offset + 1], n2 = codes[offset + 2], n3 = codes[offset + 3];
    if (n0 < 0 || n0 > 63) break; // padding/junk at the tail
    bytes.push((n0 << 2) | (n1 >> 4));
    if (n2 !== 64) bytes.push(((n1 & 15) << 4) | (n2 >> 2));
    if (n3 !== 64) bytes.push(((n2 & 3) << 6) | n3);
  }
  return Buffer.from(bytes).toString('utf8');
}

async function fetchVidnestProvider(provider, type, id, season, episode, signal) {
  const slug = provider.slug || provider.name;
  let url = `${vidApi()}/${slug}/${type === 'tv' ? 'tv' : 'movie'}/${id}`;
  if (type === 'tv') url += `/${season}/${episode}`;
  const n = vidnestNonce();
  url += `?_n=${encodeURIComponent(n)}`;
  try {
    const res = await httpClient.get(url, {
      headers: {
        Referer: vidReferer(),
        Origin: vidOrigin(),
        'User-Agent': STREAM_UA,
      },
      timeout: PROBE_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    const json = res.data;
    if (!json || !json.d || !json.n) throw new Error(`vidnest ${provider.name}: unexpected response`);
    return vidnestDecrypt(json.d, json.n);
  } catch (err) {
    const status = err.response ? err.response.status : '';
    if (status === 502 || status === 404) {
      throw new Error(`vidnest ${provider.name}: no source (${status})`);
    }
    throw new Error(`vidnest ${provider.name} API ${status || err.message}`);
  }
}

function vidnestNonce() {
  return crypto.randomBytes(16).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function vidnestDeriveKey(nonce) {
  return crypto.createHash('sha256').update(`${nonce}|${VIDNEST_SECRET}`).digest();
}

function vidnestDecrypt(data, nonce) {
  const raw = Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const iv = raw.subarray(0, 12);
  const ct = raw.subarray(12);
  const decipher = crypto.createDecipheriv('aes-256-gcm', vidnestDeriveKey(nonce), iv);
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function vidnestToResult(provider, data) {
  const items = [];
  if (Array.isArray(data.streams)) items.push(...data.streams);
  if (data.url) items.push({ url: data.url, type: data.type, quality: data.quality, headers: data.headers, referer: data.referer, label: data.label, subtitles: data.subtitles });

  if (!items.length) return { provider: provider.name, sources: [], subtitles: [] };

  const n = crypto.randomBytes(16).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const ensureUrl = (u) => {
    if (!u) return u;
    let url = String(u);
    if (url.startsWith('/')) url = `${vidApi()}${url}`;
    if (url.includes(vidApi().replace(/^https?:\/\//, '')) && !/[?&]_n=/.test(url)) {
      url += (url.includes('?') ? '&' : '?') + `_n=${encodeURIComponent(n)}`;
    }
    return url;
  };

  const subs = [];
  const collectSubs = (list) => {
    if (!Array.isArray(list)) return;
    for (const s of list) {
      if (!s || !(s.url || s.file || s.src)) continue;
      subs.push({
        url: ensureUrl(s.url || s.file || s.src),
        label: s.label || s.lang || s.language || 'Unknown',
        lang: s.lang || s.language || null,
      });
    }
  };
  collectSubs(data.subtitles);
  for (const it of items) collectSubs(it.subtitles);

  const sources = items
    .map((stream) => {
      const url = ensureUrl(stream.url || stream.file || stream.src);
      if (!url) return null;
      return {
        url,
        quality: stream.quality || stream.resolution || stream.label || stream.language || 'auto',
        isM3U8: stream.type === 'hls' || /\.m3u8($|\?)|streamsvr|\/hls\d*\//i.test(url)
          || /master\.txt($|\?)|\.txt($|\?)/i.test(url),
        headers: stream.headers || null,
        referer: (stream.headers && stream.headers.Referer) || stream.referer || null,
        origin: (stream.headers && (stream.headers.Origin || stream.headers.origin)) || null,
        lang: stream.language || null,
        dub: stream.language || null,
      };
    })
    .filter(Boolean);

  return { provider: provider.name, sources, subtitles: subs };
}

async function resolveVidnest({ type, id, season, episode, server }) {
  if (type !== 'movie' && type !== 'tv') throw new Error('type must be movie or tv');
  const ALL_VIDNEST = getVidnestProviders();
  if (server) {
    const provider = ALL_VIDNEST.find((candidate) => candidate.name === String(server).toLowerCase());
    if (!provider) throw new Error(`Unknown vidnest provider '${server}'`);
    return vidnestToResult(provider, await fetchVidnestProvider(provider, type, id, season, episode));
  }

  // auto: last-known-good provider first, then the rest (some are content-gated
  // and 502 per-title, so cycling matters). Recently-failed providers are skipped.
  const key = titleKey(type, id, season, episode);
  const cachedName = vidnestCache.get(key);
  const cachedProvider = cachedName && ALL_VIDNEST.find((candidate) => candidate.name === cachedName);
  const baseOrder = cachedProvider
    ? [cachedProvider, ...ALL_VIDNEST.filter((provider) => provider.name !== cachedProvider.name)]
    : ALL_VIDNEST;
  const order = baseOrder.filter((provider) => !isDead('vidnest', provider, key));

  // Probe concurrently (same reasoning as the peachify wave): a serial pass
  // over five 6s-timeout endpoints stacked into ~30s on flaky days. First
  // provider in priority order that yields streams wins; failures mark dead.
  let lastError = null;
  const settled = await Promise.allSettled(
    order.map((provider) =>
      fetchVidnestProvider(provider, type, id, season, episode).then((payload) => vidnestToResult(provider, payload))
    )
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

// ---- meowtv ----
//
// api.meowtv.ru serves TMDB-keyed streams per server (english/acme/dcloud/tik/
// hindi). Flow: POST /streams/ticket -> {ticket}; GET /streams/{type}/{id}
// [/{s}/{e}]?s={server} with X-Stream-Ticket -> opaque encrypted JSON; POST the
// payload to enc-dec.app/api/dec-meowtv -> {language, url, headers}. Only some
// servers hold a given title (others answer 410) — the race + dead-marks own
// that. Tickets are short-lived; cached 4 min so repeat resolves skip the hop.
// Decryption rides the public enc-dec.app service because meowtv's cipher is
// not reproducible client-side (same dependency the ecosystem's samples use).
const MEOWTV_DECODER = 'https://enc-dec.app/api/dec-meowtv';
const MEOWTV_TICKET_TTL_MS = 4 * 60 * 1000;
let meowtvTicket = null; // { value, exp }

async function getMeowtvTicket(signal) {
  if (meowtvTicket && meowtvTicket.exp > Date.now()) return meowtvTicket.value;
  const res = await httpClient.post(`${meowApi()}/streams/ticket`, null, {
    headers: {
      Origin: meowOrigin(),
      Referer: meowReferer(),
      'User-Agent': STREAM_UA,
    },
    timeout: PROBE_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  const ticket = res.data && res.data.ticket;
  if (!ticket) throw new Error('meowtv: no ticket in ticket response');
  meowtvTicket = { value: ticket, exp: Date.now() + MEOWTV_TICKET_TTL_MS };
  return ticket;
}

async function fetchMeowtvProvider(provider, type, id, season, episode, signal) {
  let url = `${meowApi()}/streams/${type}/${id}`;
  if (type === 'tv') url += `/${season}/${episode}`;
  url += `?s=${encodeURIComponent(provider.slug || provider.name)}`;
  try {
    const ticket = await getMeowtvTicket(signal);
    const res = await httpClient.get(url, {
      headers: {
        Origin: meowOrigin(),
        Referer: meowReferer(),
        'User-Agent': STREAM_UA,
        'X-Stream-Ticket': ticket,
      },
      timeout: PROBE_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    const dec = await httpClient.post(MEOWTV_DECODER, { data: res.data }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: PROBE_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    if (!dec.data || dec.data.status !== 200 || !dec.data.result) {
      throw new Error(`meowtv ${provider.name}: decoder ${dec.data && dec.data.status}`);
    }
    return dec.data.result;
  } catch (err) {
    // A used-up / rejected ticket poisons the cache — drop it so the next
    // resolve mints a fresh one instead of failing with the same stale pass.
    if (err.response && (err.response.status === 401 || err.response.status === 403)) meowtvTicket = null;
    const status = err.response ? err.response.status : '';
    throw new Error(`meowtv ${provider.name} ${status || err.message}`);
  }
}

function meowtvToResult(provider, data) {
  if (!data || !data.url) return { provider: provider.name, sources: [], subtitles: [] };
  const url = String(data.url);
  const source = {
    url,
    quality: data.quality || data.resolution || data.language || 'auto',
    isM3U8: /\.m3u8($|\?)|\/hls/i.test(url),
    headers: data.headers && Object.keys(data.headers).length ? data.headers : null,
    referer: (data.headers && (data.headers.Referer || data.headers.referer)) || null,
    origin: (data.headers && (data.headers.Origin || data.headers.origin)) || null,
    lang: data.language || null,
    dub: data.language || null,
  };
  const subs = (Array.isArray(data.subtitles) ? data.subtitles : [])
    .map((s) => ({ url: s.url || s.file || s.src, label: s.label || s.lang || 'Unknown', lang: s.lang || s.language || null }))
    .filter((s) => s.url);
  return { provider: provider.name, sources: [source], subtitles: subs };
}

async function resolveMeowtv({ type, id, season, episode, server }) {
  if (type !== 'movie' && type !== 'tv') throw new Error('type must be movie or tv');
  const ALL_MEOWTV = getMeowtvProviders();
  if (server) {
    const provider = ALL_MEOWTV.find((candidate) => candidate.name === String(server).toLowerCase());
    if (!provider) throw new Error(`Unknown meowtv server '${server}'`);
    return meowtvToResult(provider, await fetchMeowtvProvider(provider, type, id, season, episode));
  }
  const key = titleKey(type, id, season, episode);
  const cachedName = meowtvCache.get(key);
  const cachedProvider = cachedName && ALL_MEOWTV.find((candidate) => candidate.name === cachedName);
  const baseOrder = cachedProvider
    ? [cachedProvider, ...ALL_MEOWTV.filter((provider) => provider.name !== cachedProvider.name)]
    : ALL_MEOWTV;
  const order = baseOrder.filter((provider) => !isDead('meowtv', provider, key));
  let lastError = null;
  const settled = await Promise.allSettled(
    order.map((provider) =>
      fetchMeowtvProvider(provider, type, id, season, episode).then((payload) => meowtvToResult(provider, payload))
    )
  );
  for (let i = 0; i < order.length; i++) {
    const provider = order[i];
    const outcome = settled[i];
    if (outcome.status === 'rejected') {
      lastError = outcome.reason;
      markDead('meowtv', provider, key);
      continue;
    }
    if (!outcome.value.sources.length) continue;
    meowtvCache.set(key, provider.name);
    return outcome.value;
  }
  throw new Error(`No meowtv source found${lastError ? ` (${lastError.message})` : ''}`);
}

// meowtv's subtitle endpoint mirrors the streams path (subs/movie/{id},
// subs/tv/{id}/{s}/{e}) and serves plain JSON [{label, file: vtt-url}] —
// CORS-open VTT on rezesubs.com. Used as the fallback now that peachify
// (the primary subs source) is offline.
async function fetchMeowtvSubtitles(type, id, season, episode) {
  let url = `${meowApi()}/subs/${type}/${id}`;
  if (type === 'tv') url += `/${season}/${episode}`;
  const response = await httpClient.get(url, {
    headers: {
      Origin: meowOrigin(),
      Referer: meowReferer(),
      'User-Agent': STREAM_UA,
    },
    timeout: 3000,
  });
  const raw = response.data || [];
  return (Array.isArray(raw) ? raw : [])
    .map((rawSub) => ({
      url: rawSub.file || rawSub.url || rawSub.src,
      label: rawSub.label || rawSub.language || 'Unknown',
      lang: rawSub.label || null,
    }))
    .filter((sub) => sub.url);
}

// ---- byse ----
//
// The byse embed network (titles reached via 0123movie.space) gates streams
// behind a three-stage handshake, all cracked from the player's own bundle:
//   1. device attestation — client generates a P-256 ECDSA key, signs the
//      server nonce, posts the JWK + fingerprint to /api/videos/access/attest
//   2. proof-of-work captcha — hashcash-style; the client solves it locally
//   3. playback config — AES-GCM encrypted with key_parts selected by version
// (No third-party decryptor: WebCrypto P-256/AES-GCM + the ported PoW solver.)
//
// Movies need a valid IMDb id for the 0123movie.space redirect (TV does not).
// The stream is plain HLS on sprintcdn — playable via /play with the embed
// origin as Referer. Slow by nature, so it is a race/fallback family, not a
// first-choice hot path.
const BYSE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// hashcash PoW (samples/challenge/byse_optimized.js): 512-block mixing with
// 2 rounds; leading-zero difficulty over a `${nonce}:${counter}` prefix.
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
function byseSolvePow(nonce, difficulty, signal) {
  const prefix = `${nonce}:`;
  for (let counter = 0; counter < 5_000_000; counter++) {
    if ((counter & 0xfff) === 0 && signal && signal.aborted) throw Object.assign(new Error('byse: aborted'), { aborted: true });
    if (byseLeadingZeros(bysePowHash(byseLatin1(prefix + counter))) >= difficulty) return String(counter);
  }
  throw new Error('byse: PoW exceeded search budget');
}

const byseB64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const byseB64uDecode = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

async function byseGetJson(url, opts, label, signal) {
  const res = await httpClient.request({ url, timeout: PROBE_TIMEOUT_MS, ...opts, validateStatus: null, ...(signal ? { signal } : {}) });
  const data = res.data;
  if (res.status < 200 || res.status >= 300) {
    const detail = typeof data === 'string' ? data.slice(0, 140) : JSON.stringify(data || {}).slice(0, 140);
    throw new Error(`byse ${label} HTTP ${res.status} ${detail}`);
  }
  return data;
}

// IMDb id fallback (self-contained: no dependency on the tmdb service).
async function fetchImdbId(type, id) {
  const key = process.env.TMDB_API_KEY;
  if (!key) return null;
  try {
    const res = await httpClient.get(`https://api.themoviedb.org/3/${type}/${id}/external_ids`, {
      params: { api_key: key }, timeout: 4000,
    });
    return (res.data && res.data.imdb_id) || null;
  } catch {
    return null;
  }
}

async function fetchByseConfig({ type, id, season, episode, imdbId, signal }) {
  const checkAbort = () => {
    if (signal && signal.aborted) throw Object.assign(new Error('byse: aborted'), { aborted: true });
  };
  checkAbort();
  if (type === 'movie' && !imdbId) imdbId = await fetchImdbId(type, id);
  if (type === 'movie' && !imdbId) throw new Error('byse: movie needs an imdb id');

  // 1. TMDB -> embed redirect -> {origin}/e/{code}
  const path = type === 'movie' ? `/mv/${imdbId}/${id}/` : `/pl/${id}/${season || 1}/${episode || 1}/`;
  const redir = await httpClient.request({
    url: `${byseApi()}${path}`,
    method: 'GET',
    maxRedirects: 0,
    validateStatus: null,
    timeout: PROBE_TIMEOUT_MS,
    headers: { 'User-Agent': BYSE_UA, Referer: byseReferer() },
  });
  const embedUrl = redir.headers && redir.headers.location;
  if (!embedUrl) throw new Error(`byse: no embed redirect (HTTP ${redir.status})`);
  const mm = String(embedUrl).match(/^(https?:\/\/[^/]+)\/e\/([^/?#]+)/);
  if (!mm) throw new Error(`byse: unsupported embed url ${String(embedUrl).slice(0, 80)}`);
  const origin = mm[1];
  const code = mm[2];
  const embedHeaders = {
    'User-Agent': BYSE_UA,
    Referer: embedUrl,
    Origin: origin,
    'X-Embed-Origin': byseApi(),
    'X-Embed-Referer': byseReferer(),
    'X-Embed-Parent': embedUrl,
  };

  // 2. details (embed mode path — the plain /details route 404s on this host)
  await byseGetJson(`${origin}/api/videos/${code}/embed/details`, { headers: embedHeaders }, 'embed/details', signal);
  checkAbort();

  // 3. device attestation — generate P-256, sign the challenge nonce
  const subtle = crypto.webcrypto.subtle;
  const { publicKey, privateKey } = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicJwk = await subtle.exportKey('jwk', publicKey);
  const challenge = await byseGetJson(`${origin}/api/videos/access/challenge`, {
    method: 'POST', headers: { 'User-Agent': BYSE_UA },
  }, 'access/challenge', signal);
  checkAbort();
  const sig = await subtle.sign({ name: 'ECDSA', hash: { name: 'SHA-256' } }, privateKey, new TextEncoder().encode(challenge.nonce));
  const viewerId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const attested = await byseGetJson(`${origin}/api/videos/access/attest`, {
    method: 'POST',
    headers: { 'User-Agent': BYSE_UA, 'Content-Type': 'application/json' },
    data: {
      viewer_id: viewerId,
      device_id: deviceId,
      challenge_id: challenge.challenge_id,
      nonce: challenge.nonce,
      signature: byseB64u(sig),
      public_key: publicJwk,
      client: {
        user_agent: BYSE_UA,
        languages: ['en-US', 'en'],
        timezone: 'America/New_York',
        hardware_concurrency: 8,
        device_memory: 8,
        pixel_ratio: 1,
        screen_width: 1920,
        screen_height: 1080,
        color_depth: 24,
        touch_points: 0,
        webdriver: false,
        webgl_vendor: 'Google Inc. (NVIDIA)',
        webgl_renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        brand_full_versions: [],
      },
      storage: {
        cookie: viewerId, local_storage: viewerId,
        indexed_db: `${viewerId}:${deviceId}`, cache_storage: `${viewerId}:${deviceId}`,
      },
      attributes: { entropy: 'medium' },
    },
  }, 'access/attest', signal);
  checkAbort();
  const fingerprint = {
    token: attested.token,
    viewer_id: attested.viewer_id || viewerId,
    device_id: attested.device_id || deviceId,
    confidence: attested.confidence,
  };

  // 4. PoW captcha
  const captcha = await byseGetJson(`${origin}/api/videos/${code}/embed/captcha`, {
    method: 'POST',
    headers: { ...embedHeaders, 'Content-Type': 'application/json' },
    data: { fingerprint },
  }, 'embed/captcha', signal);
  checkAbort();
  const solution = byseSolvePow(captcha.pow_nonce, captcha.pow_difficulty, signal);
  checkAbort();
  const verified = await byseGetJson(`${origin}/api/videos/${code}/embed/captcha/verify`, {
    method: 'POST',
    headers: { ...embedHeaders, 'Content-Type': 'application/json' },
    data: { pow_token: captcha.pow_token, solution, fingerprint },
  }, 'embed/captcha/verify', signal);
  checkAbort();
  if (!verified || verified.status !== 'ok' || !verified.token) {
    throw new Error('byse: captcha not verified');
  }

  // 5. playback config — AES-GCM, key = concat(selected key_parts b64url)
  const playback = await byseGetJson(`${origin}/api/videos/${code}/embed/playback`, {
    method: 'POST',
    headers: { ...embedHeaders, 'Content-Type': 'application/json', 'X-Captcha-Token': verified.token },
    data: { fingerprint },
  }, 'embed/playback', signal);
  const enc = playback.playback || playback.playback_config || playback;
  const keyParts = Array.isArray(enc.key_parts) ? enc.key_parts : [];
  const ver = parseInt(String(enc.version), 10);
  let selected = keyParts;
  if (Number.isInteger(ver) && ver >= 1 && ver <= 20) {
    const pick = [ver, 31 - ver]
      .filter((i) => i >= 1 && i <= keyParts.length)
      .map((i) => keyParts[i - 1])
      .filter((x) => typeof x === 'string' && x.length > 0);
    if (pick.length) selected = pick;
  }
  const key = Buffer.concat(selected.map(byseB64uDecode));
  const iv = byseB64uDecode(enc.iv);
  const payload = byseB64uDecode(enc.payload);
  const cryptoKey = await subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, payload);
  const config = JSON.parse(new TextDecoder().decode(plain));
  return { origin, code, embedUrl, config };
}

function byseToResult(provider, resolved) {
  const config = (resolved && resolved.config) || {};
  const origin = resolved.origin;
  const sources = (config.sources || [])
    .map((s) => {
      const url = s.url;
      if (!url) return null;
      const mime = String(s.mime_type || '');
      const isM3U8 = /mpegurl|m3u8/i.test(mime) || /\.m3u8($|\?)/i.test(url);
      const headers = s.headers && typeof s.headers === 'object' ? s.headers : null;
      return {
        url,
        quality: s.label || s.quality || (s.height ? `${s.height}p` : 'auto'),
        isM3U8,
        headers,
        referer: (headers && (headers.Referer || headers.referer)) || origin + '/',
        origin: (headers && (headers.Origin || headers.origin)) || origin,
        lang: s.language || null,
        dub: s.language || null,
      };
    })
    .filter(Boolean);
  const subtitles = (config.tracks || [])
    .filter((t) => t && t.url && /subtitle|caption/i.test(String(t.kind || t.type || 'subtitle')))
    .map((t) => ({ url: t.url, label: t.label || t.language || 'Unknown', lang: t.language || t.label || null }));
  return { provider: provider.name, sources, subtitles };
}

async function resolveByse({ type, id, season, episode, imdbId, server }) {
  if (type !== 'movie' && type !== 'tv') throw new Error('type must be movie or tv');
  const ALL_BYSE = getByseProviders();
  const provider = server
    ? ALL_BYSE.find((candidate) => candidate.name === String(server).toLowerCase())
    : ALL_BYSE[0];
  if (!provider) throw new Error(`Unknown byse provider '${server}'`);
  const resolved = await fetchByseConfig({ type, id, season, episode, imdbId });
  return byseToResult(provider, resolved);
}

// vidnest's subtitles come from a separate API (sub.vdrk.site) serving VTT
// files per language on cache.vdrk.site (CORS-open, playable directly).
async function fetchVidnestSubtitles(type, id, season, episode) {
  const key = titleKey(type, id, season, episode);
  if (vdrkSubsCache.has(key)) return vdrkSubsCache.get(key);
  try {
    let url = `https://sub.vdrk.site/v2/${type}/${id}`;
    if (type === 'tv') url += `/${season}/${episode}`;
    const response = await httpClient.get(url, { timeout: 3000 });
    const list = Array.isArray(response.data) ? response.data : [];
    const subs = list
      .map((rawSub) => ({ url: rawSub.file || rawSub.url, label: rawSub.label, lang: rawSub.label || null }))
      .filter((sub) => sub.url);
    vdrkSubsCache.set(key, subs);
    return subs;
  } catch (e) {
    return [];
  }
}

// Stream-startability probe: an embed API can answer fast with a source URL
// whose CDN then 4xx/blackholes at play time (goodstream.cc is IP-blocked from
// some networks while its API is the fastest responder). So before the race
// awards a winner we fetch the source head server-side and only crown providers
// whose stream is ACTUALLY playable. Passing results are cached so back-to-back
// loads don't re-pay the master latency.
// Bound every probe so a swallowed connection can't stall the race — but be
// GENEROUS, because a slow-but-ALIVE CDN (ngc answered in 2.5 s on a plain
// title) must not be declared dead. Killing providers at 3 s manufactured
// exactly the false "no source" verdicts this path exists to avoid; the first
// playable probe still wins instantly, so a longer ceiling costs nothing.
const PROBE_STREAM_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS) || 8000;
const STREAM_OK_TTL_MS = 60_000;
const streamOkCache = new Map(); // `${fam}:${provider}:${key}` -> expiry ms

// First playable child inside a playlist body: EXT-X-MAP init segment first
// (required to start fmp4), else the first bare media line. Relative URLs
// resolve against the playlist. Used by tests and future ranking signals.
function firstChildUrl(body, playlistUrl) {
  try {
    const text = Buffer.isBuffer(body) ? body.toString('utf8', 0, 4096) : String(body || '').slice(0, 4096);
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

function probeHeaders(src) {
  const headers = { 'User-Agent': STREAM_UA };
  // This CDN family 404s on empty/missing Referer (no Referer == 404, ANY
  // non-empty Referer == 200). Mirror /play + player defaults so the probe
  // sees what playback will see — never probe headerless.
  if (src.referer) headers.Referer = src.referer;
  else headers.Referer = PEACHIFY_REFERER;
  if (src.origin) headers.Origin = src.origin;
  return headers;
}

async function probeStreamPlayable(src, signal) {
  if (!src || !src.url) return false;
  try {
    // rogflix-style HLS hides behind /hls3/.../master.txt (no .m3u8). Treat
    // those as playlists too; any response whose body opens with #EXTM3U is
    // accepted as HLS even if the URL gave no hint (mp4 heads never match).
    const isM3U8 = src.isM3U8
      || /\.m3u8($|\?)|streamsvr|\/hls\d*\//i.test(src.url)
      || /master\.txt($|\?)|\.txt($|\?)/i.test(src.url);
    // NOTE: masters are plain-GET on purpose. Ranged playlist fetches get
    // rejected (416/reset) by relay CDNs, and multi-level deep probing
    // bursts get rate-limited — manufacturing exactly the failures the probe
    // exists to prevent. Server-side checks can't predict client-side
    // throttling anyway (different IP, gentler pace); the player fallback
    // cascade owns mid-playback failures.
    const response = await httpClient.get(src.url, {
      headers: probeHeaders(src),
      timeout: PROBE_STREAM_TIMEOUT_MS,
      maxRedirects: 4,
      responseType: 'arraybuffer',
      ...(isM3U8 ? {} : { headers: { ...probeHeaders(src), Range: 'bytes=0-0' } }),
      ...(signal ? { signal } : {}),
    });
    if (!response || (response.status !== 200 && response.status !== 206)) {
      console.error(`[probe] status ${(response && response.status)} for ${src.url}`);
      return false;
    }
    if (isM3U8) {
      const head = Buffer.from(response.data || []).toString('utf8', 0, 300);
      const ok = /#EXT/i.test(head) || String(response.headers['content-type'] || '').includes('mpegurl');
      if (!ok) console.error(`[probe] not m3u8 head: ${head.slice(0, 100)}`);
      return ok;
    }
    return response.data && response.data.byteLength > 0; // mp4/mkv — any ranged bytes is playable
  } catch (e) {
    // Aborted losers stay silent and failure-free (no dead-marks) — the race
    // rethrows these past all bookkeeping via the { aborted } marker.
    if ((signal && signal.aborted) || (e && (e.code === 'ERR_CANCELED' || e.aborted))) {
      const aborted = new Error('probe aborted (race won elsewhere)');
      aborted.aborted = true;
      throw aborted;
    }
    console.error(`[probe] error for ${src.url}:`, e.message || e);
    return false;
  }
}

// Sum of #EXTINF durations in a playlist body (seconds + segment count).
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

// Variant bodies can be ~100-200 KB (thousands of segments); only sums need
// them whole. Truncation guard: a cut-off sum that already clears the floor
// passes, but a cut-off sum BELOW it is inconclusive (fail-open), never a
// rejection — a long movie must not die to our own read cap.
const VARIANT_BODY_CAP = 512 * 1024;
const SEGMENT_CHECK_TIMEOUT_MS = 6000;

async function fetchCapped(url, referer, origin, range) {
  const headers = { 'User-Agent': STREAM_UA, Referer: referer || PEACHIFY_REFERER };
  if (origin) headers.Origin = origin;
  if (range) headers.Range = range;
  const fetchResponse = await httpClient.get(url, {
    headers,
    timeout: SEGMENT_CHECK_TIMEOUT_MS,
    maxRedirects: 4,
    responseType: 'arraybuffer',
  });
  return fetchResponse;
}

// Winner-only verification: segments serve AND total duration clears the
// floor (wrong-content guard — e.g. a 16-min featurette labeled as a
// 142-min movie). Exactly one gentle chain runs, only on the brink of
// winning. Fail-open everywhere except definitive rejections: timeouts,
// network resets, unparseable or truncated bodies keep the master verdict;
// only definitive 4xx/5xx (axios surfaces them as exceptions with
// error.response.status) or a complete-but-short playlist reject.
async function verifyWinnerSegments(src, minDurationSec = 0) {
  const isPlaylist =
    src.isM3U8 ||
    /\.m3u8($|\?)|streamsvr|\/hls\d*\//i.test(src.url) ||
    /master\.txt($|\?)|\.txt($|\?)/i.test(src.url);
  if (!isPlaylist) return true; // mp4/mkv byte-verified by the probe itself
  const checkDuration = (body, receivedComplete, label) => {
    const { total, count } = sumDurations(body.toString('utf8'));
    if (!count || total >= minDurationSec) return true;
    if (!receivedComplete) return true;
    console.error(`[verify] too short (${Math.round(total)}s < ${minDurationSec}s): ${label}`);
    return false;
  };
  // Definitive rejection check shared by child + segment fetches.
  const definitiveReject = async (url, range) => {
    // Returns true = REJECT (definitive 4xx/5xx), false = keep verdict.
    try {
      const fetched = await fetchCapped(url, src.referer, src.origin, range);
      if (!fetched) return false;
      if (fetched.status === 200 || fetched.status === 206) return { pass: true, body: fetched.data };
      return { reject: true, status: fetched.status };
    } catch (e) {
      const status = e && e.response && e.response.status;
      if (status) return { reject: true, status };
      return { pass: true }; // timeout/network — fail open
    }
  };
  try {
    // Level 0: master body, whole (bounded).
    let masterRes;
    try {
      masterRes = await fetchCapped(src.url, src.referer, src.origin, null);
    } catch (e) {
      return true;
    }
    if (!masterRes || (masterRes.status !== 200 && masterRes.status !== 206)) return true;
    const masterReceived = Buffer.from(masterRes.data || []);
    const masterBody = masterReceived.subarray(0, VARIANT_BODY_CAP);
    if (!checkDuration(masterBody, masterReceived.length < VARIANT_BODY_CAP, src.url)) return false;
    const childUrl = firstChildUrl(masterBody, src.url);
    if (!childUrl) return true;
    // Level 1: child. Media child → ranged proof via definitiveReject;
    // playlist child → full bounded body for duration + parse.
    const childProbe = await definitiveReject(childUrl, 'bytes=0-4095');
    if (childProbe.reject) {
      console.error(`[verify] child ${childProbe.status} for ${src.url}`);
      return false;
    }
    if (!childProbe.pass) return true;
    // Need the child's nature: refetch head cheaply? The ranged body suffices
    // to classify (#EXTM3U?) but NOT for duration sums of big variants.
    const childHead = Buffer.from(childProbe.body || []).toString('utf8', 0, 300);
    if (!/#EXT/i.test(childHead)) return true; // media bytes answered — startable
    let variantBody;
    try {
      const variantRes = await fetchCapped(childUrl, src.referer, src.origin, null);
      if (!variantRes || (variantRes.status !== 200 && variantRes.status !== 206)) return true;
      variantBody = Buffer.from(variantRes.data || []);
    } catch (e) {
      return true;
    }
    const variantComplete = variantBody.length < VARIANT_BODY_CAP;
    if (!checkDuration(variantBody.subarray(0, VARIANT_BODY_CAP), variantComplete, childUrl)) return false;
    const grandchildUrl = firstChildUrl(variantBody.subarray(0, VARIANT_BODY_CAP), childUrl);
    if (!grandchildUrl) return true;
    const grandchild = await definitiveReject(grandchildUrl, 'bytes=0-0');
    if (grandchild.reject) {
      console.error(`[verify] segment ${grandchild.status} for ${src.url}`);
      return false;
    }
    return true;
  } catch (e) {
    return true;
  }
}

// ---- auto resolution: FIRST-WIN RACE ----
// Every healthy provider from BOTH families is probed at once; the first one
// to return a STARTABLE stream WINS. Each candidate's stream is verified via
// probeStreamPlayable() before being crowned — a fast API whose CDN 4xxs at
// play time never wins. Cold start therefore ≈ fastest healthy upstream, and
// the winner the browser gets is a source that will actually play (no cascade
// of dead-source fallbacks in the player). Dead-marks + family breaker run as
// side effects, so bookkeeping stays correct even for probes still in flight.
// Every healthy provider from BOTH families is probed at once; the first one
// to return sources WINS immediately — we never wait for the losers. Cold
// start therefore ≈ the fastest healthy upstream (~sub-second), not the 4s
// probe-timeout corpse of some other hanging family. Dead-marks and the
// family breaker run as side effects on every probe, so bookkeeping stays
// correct even for probes still in flight after a winner was taken: a late
// failure counts toward tripping its family breaker, a late success heals it.
async function autoRace(peachifyOrder, vidnestOrder, key, opts, meowtvOrder = [], byseOrder = []) {
  const candidates = [];
  // peachify first: exact-arrival ties resolve to it (registered sooner),
  // preserving brand preference wherever speed doesn't differ.
  for (const provider of peachifyOrder) candidates.push(['peachify', provider]);
  for (const provider of vidnestOrder) candidates.push(['vidnest', provider]);
  for (const provider of meowtvOrder) candidates.push(['meowtv', provider]);
  for (const provider of byseOrder) candidates.push(['byse', provider]);

  return await new Promise((resolve) => {
    let remaining = candidates.length;
    if (!remaining) return resolve({ won: false, lastErr: {} });
    let finished = false;
    const lastErrors = {};
    const failCounts = { peachify: 0, vidnest: 0, meowtv: 0, byse: 0 };
    const familySizes = { peachify: peachifyOrder.length, vidnest: vidnestOrder.length, meowtv: meowtvOrder.length, byse: byseOrder.length };
    // One abort gate per candidate: crowning a winner cancels every
    // still-flying upstream fetch (sockets released, upstreams spared).
    // Aborts are bookkeeping-neutral by contract — see the guards below.
    // This cannot slow the winner (it only fires AFTER crowning).
    const controllers = candidates.map(() => new AbortController());
    const finish = (outcome) => {
      if (!finished) {
        finished = true;
        for (const controller of controllers) {
          try {
            controller.abort();
          } catch {}
        }
        resolve(outcome);
      }
    };
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      const [family, provider] = candidates[candidateIndex];
      const controller = controllers[candidateIndex];
      (family === 'peachify'
        ? fetchProvider(provider, opts.type, opts.id, opts.season, opts.episode, controller.signal).then((payload) =>
            toResult(provider, payload)
          )
        : family === 'meowtv'
          ? fetchMeowtvProvider(provider, opts.type, opts.id, opts.season, opts.episode, controller.signal).then((payload) =>
              meowtvToResult(provider, payload)
            )
          : family === 'byse'
            ? fetchByseConfig({ type: opts.type, id: opts.id, season: opts.season, episode: opts.episode, imdbId: opts.imdbId, signal: controller.signal }).then((resolved) =>
                byseToResult(provider, resolved)
              )
            : fetchVidnestProvider(provider, opts.type, opts.id, opts.season, opts.episode, controller.signal).then((payload) =>
                vidnestToResult(provider, payload)
              )
      )
        .then((result) => {
          healFamily(family); // any HTTP answer means the family is alive
          return { ok: true, family, provider, result };
        })
        .catch((error) => {
          if ((error && (error.code === 'ERR_CANCELED' || error.aborted)) || controller.signal.aborted) {
            return { ok: false, aborted: true };
          }
          console.error(`[extractor] ${family} ${provider.name} error:`, error.message || error);
          markDead(family, provider, key);
          failCounts[family]++;
          lastErrors[family] = error && error.message;
          // whole family rejected (hangs/5xx/DNS) → trip: next titles skip us
          if (failCounts[family] === familySizes[family]) {
            familyDeadUntil.set(family, Date.now() + FAMILY_TTL_MS);
          }
          return { ok: false };
        })
        .then(async (outcome) => {
          // `remaining` counts candidates that are not yet FULLY settled — i.e. it is
          // decremented only after this candidate's probe has resolved. Doing it
          // up-front was a real bug: an empty/failed provider that happened to
          // settle last drove `remaining` to 0 and resolved {won:false} while the
          // slow-but-playable providers' probes were still in flight, and their
          // later finish({won:true}) became a no-op (finished already true). Auto
          // then reported "no sources" for titles whose servers were fine.
          try {
            if (outcome.aborted) return;
            // Only the caller-VISIBLE winner records last-known-good: a probe
            // settling after someone else already won must not rewrite the
            // cache with a provider nobody actually played.
            if (outcome.ok && outcome.result.sources.length && !finished) {
              const probeCacheKey = `${outcome.family}:${outcome.provider.name}:${key}`;
              let playable = (streamOkCache.get(probeCacheKey) || 0) > Date.now();
              if (!playable) {
                try {
                  playable = await probeStreamPlayable(outcome.result.sources[0], controller.signal);
                } catch (probeError) {
                  if (probeError && probeError.aborted) return;
                  throw probeError;
                }
                if (playable) streamOkCache.set(probeCacheKey, Date.now() + STREAM_OK_TTL_MS);
              }
              if (playable) {
                // Tentative winner: confirm segments + duration before
                // crowning. A throttled relay or a mislabeled short (e.g. a
                // 16-min featurette as a 142-min movie) fails here → treated
                // exactly like an unstartable stream (dead-mark, race
                // continues) instead of handing the player a bad source.
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
                  // Re-check: another candidate may have won while verifying —
                  // never record last-known-good for a provider nobody played.
                  if (finished) return;
                  (outcome.family === 'peachify'
                    ? providerCache
                    : outcome.family === 'meowtv'
                      ? meowtvCache
                      : outcome.family === 'byse'
                        ? byseCache
                        : vidnestCache
                  ).set(key, outcome.provider.name);
                  return finish({ won: true, result: outcome.result });
                }
              }
              // API answered but the stream can't start — treat as dead, keep racing
              markDead(outcome.family, outcome.provider, key);
              failCounts[outcome.family]++;
              lastErrors[outcome.family] = `${outcome.provider.name}: stream not startable`;
              if (failCounts[outcome.family] === familySizes[outcome.family]) {
                familyDeadUntil.set(outcome.family, Date.now() + FAMILY_TTL_MS);
              }
            }
          } finally {
            remaining--;
            if (!remaining && !finished) finish({ won: false, lastErr: lastErrors }); // every probe failed or was empty
          }
        });
    }
  });
}

/**
 * Resolve a playable stream for a title using peachify's provider APIs.
 * @param {object} opts { type: 'movie'|'tv', id, season?, episode?,
 *                        server?: provider name to force, e.g. 'multi' }
 * @returns {Promise<{provider, sources: [{url,quality,sizeBytes,isM3U8,headers?}],
 *                    subtitles: [...]}>}
 */
async function resolveStream({ type, id, season, episode, server, skip, minDurationPromise, imdbId }) {
  if (type !== 'movie' && type !== 'tv') throw new Error('type must be movie or tv');
  const ALL_PEACHIFY = getProviders();
  const ALL_VIDNEST = getVidnestProviders();
  if (server) {
    const name = String(server).toLowerCase();
    // vidnest family first (names don't collide with peachify's)
    const vidnestProvider = ALL_VIDNEST.find((candidate) => candidate.name === name);
    if (vidnestProvider) return resolveVidnest({ type, id, season, episode, server: name });

    const meowtvProvider = getMeowtvProviders().find((candidate) => candidate.name === name);
    if (meowtvProvider) return resolveMeowtv({ type, id, season, episode, server: name });

    const byseProvider = getByseProviders().find((candidate) => candidate.name === name);
    if (byseProvider) return resolveByse({ type, id, season, episode, imdbId: imdbId || (await fetchImdbId(type, id)), server: name });

    const provider = ALL_PEACHIFY.find((candidate) => candidate.name === name || candidate.path === name);
    if (!provider) throw new Error(`Unknown provider '${server}'`);
    const data = await fetchProvider(provider, type, id, season, episode);
    return toResult(provider, data, type, id, season, episode);
  }

  // auto: launch every healthy provider across BOTH families simultaneously
  // and take the FIRST source-bearing answer. Historical note: this used to be
  // a serial cycle (~30s worst case), then two waited-out waves (still paid a
  // hanging family's full 4s probe on cold titles). Racing to first success
  // makes cold start ≈ fastest healthy upstream instead of the slowest loser.
  // familyDown gates keep a tripped breaker from launching probes at all.
  const key = titleKey(type, id, season, episode);
  // Last-known-good is stored as a NAME — resolve back to the provider object
  // (a raw string here used to build a broken ".../undefined/..." URL).
  const cachedPeachifyName = providerCache.get(key);
  const cachedPeachify = cachedPeachifyName && ALL_PEACHIFY.find((provider) => provider.name === cachedPeachifyName);
  const skipSet = new Set((skip || []).map((name) => String(name).toLowerCase()));
  const peachifyOrder = (
    cachedPeachify ? [cachedPeachify, ...ALL_PEACHIFY.filter((provider) => provider.name !== cachedPeachify.name)] : ALL_PEACHIFY
  ).filter((provider) => !skipSet.has(provider.name) && !familyDown('peachify') && !isDead('peachify', provider, key));
  const cachedVidnestName = vidnestCache.get(key);
  const cachedVidnest = cachedVidnestName && ALL_VIDNEST.find((provider) => provider.name === cachedVidnestName);
  const vidnestOrder = (
    cachedVidnest ? [cachedVidnest, ...ALL_VIDNEST.filter((provider) => provider.name !== cachedVidnest.name)] : ALL_VIDNEST
  ).filter((provider) => !skipSet.has(provider.name) && !familyDown('vidnest') && !isDead('vidnest', provider, key));
  const ALL_MEOWTV = getMeowtvProviders();
  const cachedMeowtvName = meowtvCache.get(key);
  const cachedMeowtv = cachedMeowtvName && ALL_MEOWTV.find((provider) => provider.name === cachedMeowtvName);
  const meowtvOrder = (
    cachedMeowtv ? [cachedMeowtv, ...ALL_MEOWTV.filter((provider) => provider.name !== cachedMeowtv.name)] : ALL_MEOWTV
  ).filter((provider) => !skipSet.has(provider.name) && !familyDown('meowtv') && !isDead('meowtv', provider, key));
  const ALL_BYSE = getByseProviders();
  const cachedByseName = byseCache.get(key);
  const cachedByse = cachedByseName && ALL_BYSE.find((provider) => provider.name === cachedByseName);
  const byseOrder = (
    cachedByse ? [cachedByse, ...ALL_BYSE.filter((provider) => provider.name !== cachedByse.name)] : ALL_BYSE
  ).filter((provider) => !skipSet.has(provider.name) && !familyDown('byse') && !isDead('byse', provider, key));

  const outcome = await autoRace(peachifyOrder, vidnestOrder, key, { type, id, season, episode, minDurationPromise, imdbId }, meowtvOrder, byseOrder);
  if (outcome.won) return outcome.result;

  // All providers failed gracefully — return empty so the client can fall back
  // to the next server or show a clean message instead of a raw error.
  return { provider: null, sources: [], subtitles: [] };
}

// Embed providers wrap real streams in relay endpoints: Peachify uses
//   {host}/m3u8-proxy?url=<real>&headers=<json>   and  {host}/mp4-proxy?url=<real>
// (hosts vary: x.eat-peach.sbs, *.fastedge.app, …). Unwrap them: swap in the
// real CDN URL and surface any embedded headers so playback can ride our /play
// proxy with correct Origin/Referer — one less middleman hop per source.
function unwrapProxies(src) {
  if (!src || !src.url || !/\/(?:m3u8|mp4)-proxy/.test(src.url)) return src;
  try {
    const proxyUrl = new URL(src.url);
    const targetUrl = proxyUrl.searchParams.get('url');
    if (!targetUrl) return src;
    let headers = null;
    try {
      const embedded = JSON.parse(proxyUrl.searchParams.get('headers') || '{}');
      headers = {
        ...(embedded.origin ? { Origin: embedded.origin } : {}),
        ...(embedded.referer ? { Referer: embedded.referer } : {}),
      };
    } catch (e) {}
    return { ...src, url: targetUrl, headers };
  } catch (e) {
    return src;
  }
}

function toResult(provider, data, type, id, season, episode) {
  const sources = (data.sources || [])
    .map((rawSource) => {
      const unwrapped = unwrapProxies(rawSource);
      const rawHeaders = unwrapped.headers || {};
      const referer = rawHeaders.Referer || rawHeaders.referer || null;
      const origin = rawHeaders.Origin || rawHeaders.origin || null;
      return {
        url: unwrapped.url || unwrapped.src || unwrapped.file,
        quality: unwrapped.quality || unwrapped.resolution || unwrapped.height || 'auto',
        sizeBytes: unwrapped.sizeBytes || unwrapped.size || null,
        dub: unwrapped.dub || null,
        // rogflix HLS hides behind /hls\d*/.../master.txt (no .m3u8 in the URL)
        // but IS a playlist — flag it so /play treats it as text to rewrite,
        // the player loads hls.js for it, and the probe GETs it (not Range).
        isM3U8: /\.m3u8($|\?)|m3u8-proxy|streamsvr|\/hls\d*\//i.test(unwrapped.url || '')
          || /master\.txt($|\?)|\.txt($|\?)/i.test(unwrapped.url || ''),
        headers: unwrapped.headers || null,
        referer,
        origin,
      };
    })
    .filter((source) => source.url);

  const subtitles = (data.subtitles || []).map((rawSub) => ({
    url: rawSub.url || rawSub.file || rawSub.src,
    label: rawSub.label || rawSub.language || rawSub.lang || 'Unknown',
    lang: rawSub.lang || rawSub.language || null,
    format: rawSub.format || null,
    encoding: rawSub.encoding || null,
  })).filter((sub) => sub.url);

  return { provider: provider.name, sources, subtitles };
}

module.exports = {
  resolveStream,
  fetchSubtitles,
  resolveVidnest,
  fetchVidnestSubtitles,
  resolveMeowtv,
  fetchMeowtvSubtitles,
  resolveByse,
  byseSolvePow,
  PROVIDERS,
  VIDNEST_PROVIDERS,
  MEOWTV_PROVIDERS,
  BYSE_PROVIDERS,
  PEACHIFY_KEY_HEX,
  PEACHIFY_API,
  VIDNEST_API,
  VIDNEST_REFERER,
  signPlayUrl,
  PLAY_SIG_TTL_S,
  getProviders,
  getVidnestProviders,
  getMeowtvProviders,
  getByseProviders,
  refreshUpstreamConsts,
  loadUpstreams,
  // internals — exported for the test suite (tests/extractor.test.js)
  decryptPayload,
  vidnestDecode,
  vidnestToResult,
  toResult,
  VIDNEST_ALPHABET,
  probeStreamPlayable,
  firstChildUrl,
  verifyWinnerSegments,
};

// Breaker snapshot for /health/upstreams (wired via upstreams.js to avoid a
// require cycle: extractor -> upstreams only).
registerBreakerSnapshot(() => {
  const families = {};
  for (const [fam, until] of familyDeadUntil) {
    if (until > Date.now()) families[fam] = { downUntil: until, inMs: until - Date.now() };
  }
  let dead = 0;
  for (const [, until] of deadCache) if (until > Date.now()) dead++;
  return { dead, families };
});
