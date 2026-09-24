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

const PEACHIFY_API = 'https://none.eat-peach.sbs';
const PEACHIFY_KEY_HEX = process.env.PEACHIFY_KEY_HEX;
if (!PEACHIFY_KEY_HEX) throw new Error("PEACHIFY_KEY_HEX env required (see private secrets repo)");
const PEACHIFY_REFERER = 'https://peachify.top/';

// Provider order mirrors the site's own player auto-cycling.
const PROVIDERS = [
  { name: 'horizon', path: 'hr' },
  { name: 'wolf', path: 'air' },
  { name: 'spider', path: 'holly' },
  { name: 'multi', path: 'multi' },
  { name: 'iron', path: 'moviebox' },
];

// vidnest's player bundles all fetch through new.vidnest.fun. Alphabet is a
// reordered base64 from their bundle; `slug` overrides the API path segment
// where it differs from the UI name. vidxyz returned to service (was 502 on
// every title when first wired — re-probed 2026-08: working again, content-
// gated per title like the rest). vidlink is still dead (502 HTML on every title).
const VIDNEST_API = 'https://new.vidnest.fun';
const VIDNEST_REFERER = 'https://vidnest.fun/';
const VIDNEST_ALPHABET = process.env.VIDNEST_ALPHABET;
if (!VIDNEST_ALPHABET) throw new Error("VIDNEST_ALPHABET env required (see private secrets repo)");

const VIDNEST_PROVIDERS = [
  // Direct-first: exact-arrival ties in the auto race resolve to the earliest
  // registered provider, so historically CORS-open (browser-direct, zero proxy
  // cost) providers go first. Relay/gated hosts (proxy-burning) go last.
  { name: 'buzz' },                      // 97bf1.com — CORS-open, direct
  { name: 'vidxyz' },                    // sparkvid relay — CORS-open, direct
  { name: 'ngc', slug: 'nextgencloudfabric' }, // remoteconsultinggroup — ACAO *, direct
  { name: 'videasy' },                     // tiktoks.animanga.fun relay — movie + tv
  { name: 'hollymoviehd' },                // direct mp4/hls streams, per-stream referers
  { name: 'rogflix' },                     // akcloud.animanga.fun relay
];

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
  const base = (process.env.PLAY_PROXY_BASE || PLAY_PROXY_DEFAULT).replace(/\/$/, '');
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

async function fetchProvider(provider, type, id, season, episode) {
  let url = `${PEACHIFY_API}/${provider.path}/${type}/${id}`;
  if (type === 'tv') url += `/${season}/${episode}`;
  try {
    const res = await httpClient.get(url, {
      headers: {
        Referer: PEACHIFY_REFERER,
        Origin: 'https://peachify.top',
        'User-Agent': STREAM_UA,
      },
      timeout: PROBE_TIMEOUT_MS,
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
    let url = `${PEACHIFY_API}/subs/${type}/${id}`;
    if (type === 'tv') url += `/${season}/${episode}`;
    const response = await httpClient.get(url, {
      headers: {
        Referer: PEACHIFY_REFERER,
        Origin: 'https://peachify.top',
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
    return [];
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

async function fetchVidnestProvider(provider, type, id, season, episode) {
  const slug = provider.slug || provider.name;
  let url = `${VIDNEST_API}/${slug}/${type}/${id}`;
  if (type === 'tv') url += `/${season}/${episode}`;
  try {
    const res = await httpClient.get(url, {
      headers: {
        Referer: VIDNEST_REFERER,
        Origin: 'https://vidnest.fun',
        'User-Agent': STREAM_UA,
      },
      timeout: PROBE_TIMEOUT_MS,
    });
    const json = res.data;
    if (!json || !json.data) throw new Error(`vidnest ${provider.name}: unexpected response`);
    return JSON.parse(vidnestDecode(json.data));
  } catch (err) {
    const status = err.response ? err.response.status : '';
    if (status === 502 || status === 404) {
      throw new Error(`vidnest ${provider.name}: no source (${status})`);
    }
    throw new Error(`vidnest ${provider.name} API ${status || err.message}`);
  }
}

function vidnestToResult(provider, data) {
  // Decrypted payloads come in three shapes:
  //   {url, headers}                    — animanga relay hosts (videasy, rogflix)
  //   {streams: [{url,type,headers,language}]} — direct mp4/hls (hollymoviehd)
  //   {url, headers, referer, ...}      — direct CDNs (buzz, ngc)
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
        // rogflix HLS hides behind /hls\d*/.../master.txt (no .m3u8 in the URL)
        isM3U8: stream.type === 'hls' || /\.m3u8($|\?)|streamsvr|\/hls\d*\//i.test(url)
          || /master\.txt($|\?)|\.txt($|\?)/i.test(url),
        headers: stream.headers || null,
        referer: (stream.headers && stream.headers.Referer) || stream.referer || null,
        lang: stream.language || null,
      };
    })
    .filter(Boolean);

  return { provider: provider.name, sources, subtitles: [] };
}

async function resolveVidnest({ type, id, season, episode, server }) {
  if (type !== 'movie' && type !== 'tv') throw new Error('type must be movie or tv');
  if (server) {
    const provider = VIDNEST_PROVIDERS.find((candidate) => candidate.name === String(server).toLowerCase());
    if (!provider) throw new Error(`Unknown vidnest provider '${server}'`);
    return vidnestToResult(provider, await fetchVidnestProvider(provider, type, id, season, episode));
  }

  // auto: last-known-good provider first, then the rest (some are content-gated
  // and 502 per-title, so cycling matters). Recently-failed providers are skipped.
  const key = titleKey(type, id, season, episode);
  const cachedName = vidnestCache.get(key);
  const cachedProvider = cachedName && VIDNEST_PROVIDERS.find((candidate) => candidate.name === cachedName);
  const baseOrder = cachedProvider
    ? [cachedProvider, ...VIDNEST_PROVIDERS.filter((provider) => provider.name !== cachedProvider.name)]
    : VIDNEST_PROVIDERS;
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

async function probeStreamPlayable(src) {
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
    console.error(`[probe] error for ${src.url}:`, e.message || e);
    return false;
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
async function autoRace(peachifyOrder, vidnestOrder, key, opts) {
  const candidates = [];
  // peachify first: exact-arrival ties resolve to it (registered sooner),
  // preserving brand preference wherever speed doesn't differ.
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
        ? fetchProvider(provider, opts.type, opts.id, opts.season, opts.episode).then((payload) =>
            toResult(provider, payload)
          )
        : fetchVidnestProvider(provider, opts.type, opts.id, opts.season, opts.episode).then((payload) =>
            vidnestToResult(provider, payload)
          )
      )
        .then((result) => {
          healFamily(family); // any HTTP answer means the family is alive
          return { ok: true, family, provider, result };
        })
        .catch((error) => {
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
            // Only the caller-VISIBLE winner records last-known-good: a probe
            // settling after someone else already won must not rewrite the
            // cache with a provider nobody actually played.
            if (outcome.ok && outcome.result.sources.length && !finished) {
              const probeCacheKey = `${outcome.family}:${outcome.provider.name}:${key}`;
              let playable = (streamOkCache.get(probeCacheKey) || 0) > Date.now();
              if (!playable) {
                playable = await probeStreamPlayable(outcome.result.sources[0]);
                if (playable) streamOkCache.set(probeCacheKey, Date.now() + STREAM_OK_TTL_MS);
              }
              if (playable) {
                (outcome.family === 'peachify' ? providerCache : vidnestCache).set(key, outcome.provider.name);
                return finish({ won: true, result: outcome.result });
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
async function resolveStream({ type, id, season, episode, server, skip }) {
  if (type !== 'movie' && type !== 'tv') throw new Error('type must be movie or tv');
  if (server) {
    const name = String(server).toLowerCase();
    // vidnest family first (names don't collide with peachify's)
    const vidnestProvider = VIDNEST_PROVIDERS.find((candidate) => candidate.name === name);
    if (vidnestProvider) return resolveVidnest({ type, id, season, episode, server: name });

    const provider = PROVIDERS.find((candidate) => candidate.name === name || candidate.path === name);
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
  const cachedPeachify = cachedPeachifyName && PROVIDERS.find((provider) => provider.name === cachedPeachifyName);
  const skipSet = new Set((skip || []).map((name) => String(name).toLowerCase()));
  const peachifyOrder = (
    cachedPeachify ? [cachedPeachify, ...PROVIDERS.filter((provider) => provider.name !== cachedPeachify.name)] : PROVIDERS
  ).filter((provider) => !skipSet.has(provider.name) && !familyDown('peachify') && !isDead('peachify', provider, key));
  const cachedVidnestName = vidnestCache.get(key);
  const cachedVidnest = cachedVidnestName && VIDNEST_PROVIDERS.find((provider) => provider.name === cachedVidnestName);
  const vidnestOrder = (
    cachedVidnest ? [cachedVidnest, ...VIDNEST_PROVIDERS.filter((provider) => provider.name !== cachedVidnest.name)] : VIDNEST_PROVIDERS
  ).filter((provider) => !skipSet.has(provider.name) && !familyDown('vidnest') && !isDead('vidnest', provider, key));

  const outcome = await autoRace(peachifyOrder, vidnestOrder, key, { type, id, season, episode });
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
  PROVIDERS,
  VIDNEST_PROVIDERS,
  PEACHIFY_KEY_HEX,
  PEACHIFY_API,
  signPlayUrl,
  PLAY_SIG_TTL_S,
  // internals — exported for the test suite (tests/extractor.test.js)
  decryptPayload,
  vidnestDecode,
  vidnestToResult,
  toResult,
  VIDNEST_ALPHABET,
  probeStreamPlayable,
  firstChildUrl,
};
