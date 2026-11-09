// functions/lib/upstreams.js — edge-runtime twin of src/services/upstreams.js.
// Same contract, no Node APIs: config is bundled at build time by
// scripts/sync-upstreams.mjs (config/upstreams.json -> functions/lib/upstreams.json)
// and UPSTREAMS_JSON env (Pages vars) overrides it at runtime for hot-patches.
import bundled from './upstreams.json' with { type: 'json' };

function normalizeFamily(raw) {
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

export function loadUpstreams(env) {
  let raw = bundled;
  const envRaw = (env && env.UPSTREAMS_JSON) || '';
  if (envRaw) {
    try {
      const override = JSON.parse(envRaw);
      raw = { ...(raw || {}), ...override, families: { ...((raw || {}).families || {}), ...((override || {}).families || {}) } };
    } catch {
      // Invalid override — fall back to the bundled file, never crash.
    }
  }
  const fams = (raw && raw.families) || {};
  return {
    version: (raw && raw.version) || 1,
    families: {
      peachify: normalizeFamily(fams.peachify),
      vidnest: normalizeFamily(fams.vidnest),
      meowtv: normalizeFamily(fams.meowtv),
      byse: normalizeFamily(fams.byse),
    },
    canary: (raw && raw.canary) || {},
  };
}
