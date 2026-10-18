// src/routes/fojik.js — local-only Fojik bridge (costs $0, never runs on cloud)
//
// Why this exists:
//  - fojik-dl resolves fojik.site chains to direct 4K MKV/MP4 links. A cold
//    resolve takes 5-30s and the file itself is GBs.
//  - Vercel serverless (60s timeout, no ffmpeg, billed egress) and Cloudflare
//    Workers (30s CPU limit, billed egress) both CANNOT do this — proxying
//    download bytes through them would time out and cost money.
//  - So fojik-dl runs ONLY on your machine (http://localhost:5173) and the
//    browser talks to it directly. Zero cloud bytes, zero cost.
//
// What this bridge does (JSON only, never proxies file bytes):
//  - GET /api/fojik/status          -> { enabled, reachable } (UI auto-detect)
//  - GET /api/fojik/resolve/:tmdbId -> forwards to fojik-dl /api/resolve/:id
//    (small JSON: title + quality list). Used when running cinephile locally
//    so the page can stay same-origin. On Vercel FOJIK_BASE is unset -> 503
//    with instructions, and the frontend falls back to direct localhost:5173.
//
// Env:
//  FOJIK_BASE="http://127.0.0.1:5173"  (set in .env.local for local dev only;
//    NEVER set on Vercel/Cloudflare — downloads must not touch the cloud)
const { Router } = require('express');

const FOJIK_BASE = (process.env.FOJIK_BASE || 'http://127.0.0.1:5173').replace(/\/$/, '');
// Explicit kill-switch for cloud deploys: set FOJIK_DISABLED=1 on Vercel.
const DISABLED = process.env.FOJIK_DISABLED === '1' || process.env.VERCEL === '1' && !process.env.FOJIK_BASE;

async function fojikGet(path, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${FOJIK_BASE}${path}`, { signal: ctrl.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* fojik returns JSON; keep raw otherwise */ }
    return { status: r.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

module.exports = function fojikRoutes() {
  const router = Router();

  router.get('/api/fojik/status', async (req, res) => {
    if (DISABLED) {
      return res.json({ enabled: false, reachable: false, reason: 'local-only — start fojik-dl on your machine' });
    }
    try {
      const r = await fojikGet('/api/health', 3000);
      if (r.status === 200 && r.json && r.json.ok) {
        return res.json({ enabled: true, reachable: true, base: FOJIK_BASE, index: r.json.index || 0 });
      }
      return res.json({ enabled: true, reachable: false, base: FOJIK_BASE });
    } catch (e) {
      return res.json({ enabled: true, reachable: false, base: FOJIK_BASE, error: e.message });
    }
  });

  // Same-origin resolve for local dev (avoids CORS entirely on localhost:3000).
  // Cloud: 503 — the frontend then talks to http://localhost:5173 directly.
  router.get('/api/fojik/resolve/:tmdbId', async (req, res) => {
    if (DISABLED) {
      return res.status(503).json({
        ok: false,
        error: 'Fojik is local-only. Run `node server.js` in fojik-dl, then open this page from the same machine.',
      });
    }
    const id = Number(req.params.tmdbId);
    if (!id) return res.status(400).json({ ok: false, error: 'bad tmdb id' });
    try {
      const r = await fojikGet(`/api/resolve/${id}`, 15000);
      if (r.json) return res.status(r.status).json(r.json);
      return res.status(r.status || 502).json({ ok: false, error: r.text.slice(0, 300) || 'fojik resolve failed' });
    } catch (e) {
      const msg = /abort/i.test(e.message) ? 'fojik-dl not running (start it: cd ~/fojik-dl && node server.js)' : e.message;
      return res.status(503).json({ ok: false, error: `fojik unreachable at ${FOJIK_BASE}: ${msg}` });
    }
  });

  return router;
};

// exported for tests
module.exports.FOJIK_BASE = FOJIK_BASE;
