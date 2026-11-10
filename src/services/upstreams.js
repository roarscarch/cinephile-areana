// src/services/upstreams.js — single source of truth for embed-family routing.
//
// Upstream APIs rename hosts/slugs/referers without warning. Before this file,
// those values lived as hardcoded consts in extractor.js (+ a stale-duplicated
// copy in functions/lib/extractor.js) — every rename needed a code edit and a
// 4-target redeploy while the app was down.
//
// Now: `config/upstreams.json` is the source of truth. This loader reads it
// once at boot, caches it, and lets the UPSTREAMS_JSON env var override it at
// runtime — so you can hot-patch a renamed host/slug via env (Vercel dashboard,
// Pages vars, `UPSTREAMS_JSON=... node server.js`) WITHOUT redeploying code.
//
// Shape: { version, families: { peachify: {api, referer, origin, providers[]},
// vidnest: {...} }, canary: {...} }. Unknown families/providers pass through
// validation untouched so a new family never crashes the loader.
const fs = require('fs');
const path = require('path');

let cached = null;
let cachedKey = '';

function normalizeFamily(name, raw) {
  const fam = raw && typeof raw === 'object' ? raw : {};
  const providers = Array.isArray(fam.providers)
    ? fam.providers
        .filter((p) => p && (p.name || p.slug || p.path))
        .map((p) => ({
          name: String(p.name || p.slug || p.path),
          ...(p.slug ? { slug: String(p.slug) } : {}),
          ...(p.path ? { path: String(p.path) } : {}),
        }))
    : [];
  return {
    api: typeof fam.api === 'string' ? fam.api.replace(/\/$/, '') : '',
    referer: typeof fam.referer === 'string' ? fam.referer : '',
    origin: typeof fam.origin === 'string' ? fam.origin : '',
    providers,
  };
}

function normalize(raw) {
  const fams = (raw && raw.families) || {};
  return {
    version: (raw && raw.version) || 1,
    families: {
      peachify: normalizeFamily('peachify', fams.peachify),
      vidnest: normalizeFamily('vidnest', fams.vidnest),
      meowtv: normalizeFamily('meowtv', fams.meowtv),
      byse: normalizeFamily('byse', fams.byse),
      cinejoy: normalizeFamily('cinejoy', fams.cinejoy),
      vidcore: normalizeFamily('vidcore', fams.vidcore),
    },
    canary: (raw && raw.canary) || {},
  };
}

function loadFromDisk() {
  try {
    const p = path.join(__dirname, '..', '..', 'config', 'upstreams.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Load (and cache) the routing table. `opts.reload` re-reads disk+env — used
// by /health/upstreams?refresh=1 and tests, never in the hot path.
function loadUpstreams(opts = {}) {
  const envRaw = process.env.UPSTREAMS_JSON || '';
  const key = `${envRaw.length}:${envRaw.slice(0, 64)}`;
  if (cached && !opts.reload && cachedKey === key) return cached;
  let raw = loadFromDisk();
  if (envRaw) {
    try {
      const override = JSON.parse(envRaw);
      // Shallow family merge: env families replace file families wholesale,
      // non-family keys (canary, version) merge over.
      raw = { ...(raw || {}), ...override, families: { ...((raw || {}).families || {}), ...((override || {}).families || {}) } };
    } catch (e) {
      console.warn(`UPSTREAMS_JSON invalid JSON — ignoring override: ${e.message}`);
    }
  }
  cached = normalize(raw || {});
  cachedKey = key;
  return cached;
}

// Live breaker snapshot for /health/upstreams. Extractor registers its maps
// here so health can report them without importing extractor (no cycle).
let breakerSnapshot = () => ({ dead: 0, families: {} });
function registerBreakerSnapshot(fn) {
  breakerSnapshot = fn;
}

module.exports = { loadUpstreams, registerBreakerSnapshot, getBreakerSnapshot: () => breakerSnapshot() };
