#!/usr/bin/env node
// scripts/check-upstreams.mjs — the canary. Races the canary titles through
// the REAL resolveStream pipeline and fails loudly when upstreams change.
//
//   npm run check:upstreams                  # localhost:3000 (default)
//   CANARY_BASE=https://cinephiles-areana.vercel.app npm run check:upstreams
//   npm run check:upstreams -- --probe        # force live resolve locally
//                                            # (no server needed, needs env keys)
//
// Exit 0 = at least one canary title resolves sources on at least one base.
// Exit 1 = everything dark (page the human). Used by .github/workflows/canary.yml
// every 30 min against all three deployments.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const table = JSON.parse(readFileSync(join(root, 'config', 'upstreams.json'), 'utf8'));
const canaries = [table?.canary?.movie, table?.canary?.tv].filter((c) => c && c.type && c.id);

const args = process.argv.slice(2);
const localProbe = args.includes('--probe');

const bases = (process.env.CANARY_BASES || process.env.CANARY_BASE || 'http://127.0.0.1:3000')
  .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);

async function checkBase(base, canary) {
  const ep = canary.type === 'tv' ? `${canary.season || '1'}-${canary.episode || '1'}` : '1-1';
  const url = `${base}/sources/${ep}?mediaId=${canary.type}/${canary.id}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
    const j = await r.json();
    const n = (j.sources || []).length;
    return n > 0
      ? { ok: true, detail: `${j.provider} (${n} source${n > 1 ? 's' : ''})` }
      : { ok: false, detail: j.message || 'empty sources' };
  } catch (e) {
    return { ok: false, detail: e.name === 'AbortError' ? 'timeout 45s' : e.message };
  } finally {
    clearTimeout(t);
  }
}

let failures = 0;
for (const base of bases) {
  for (const c of canaries) {
    const r = await checkBase(base, c);
    const label = `${base} ${c.type}/${c.id}${c.type === 'tv' ? ` S${c.season}E${c.episode}` : ''} (${c.label || 'canary'})`;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${label} — ${r.detail}`);
    if (!r.ok) failures++;
  }
}

// Local in-process probe: exercises resolveStream without a running server
// (needs TMDB_API_KEY + cipher envs, like the app itself).
if (localProbe) {
  try {
    const { resolveStream } = await import('../src/services/extractor.js');
    for (const c of canaries) {
      const t0 = Date.now();
      try {
        const r = await resolveStream({
          type: c.type, id: String(c.id),
          season: String(c.season || '1'), episode: String(c.episode || '1'),
        });
        const n = (r.sources || []).length;
        console.log(`${n ? 'PASS' : 'FAIL'}  local resolve ${c.type}/${c.id} — ${r.provider || 'none'} (${n}) in ${Date.now() - t0}ms`);
        if (!n) failures++;
      } catch (e) {
        console.log(`FAIL  local resolve ${c.type}/${c.id} — ${e.message}`);
        failures++;
      }
    }
  } catch (e) {
    console.log(`SKIP  local probe — ${e.message}`);
  }
}

if (failures) {
  console.error(`\n${failures} canary check(s) failed — upstreams may have changed. See config/upstreams.json + /health/upstreams?probe=1`);
  process.exit(1);
}
console.log('\nAll canary checks passed.');
