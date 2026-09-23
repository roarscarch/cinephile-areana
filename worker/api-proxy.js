// worker/api-proxy.js — single-URL front for the metadata API.
//
// Browser -> https://cinephile-api.<account>.workers.dev/<api-path>
//         -> healthiest backend (Pages mirror / Vercel).
//
// Why: one URL to share, and backend hostnames stay out of DevTools in
// normal operation (forwarding happens server-side). If this proxy itself
// fails, the frontend falls back to the backends directly (api.js) —
// hostnames reappear only in failure mode, availability never depends on us.
//
// Never proxied here (by design):
//   /play     — video bytes go straight to the play Worker (quota clarity)
//   /sign     — same-origin CORS lockdown is the hotlink defense; proxying
//               it with ACAO:* would punch a hole in that
//   /download — page-origin flow (422 explainer / Vercel handoff in Functions)
//
// Quota: ~10-15 requests per watch -> ~7k watches/day on the free 100k/day
// pool (shared account-wide with the play Worker).

const BACKENDS = [
  'https://cinephile-areana.pages.dev',
  'https://cinephilia-vercel.vercel.app',
];
const REFUSE = new Set(['play', 'download', 'sign']);
const UPSTREAM_TIMEOUT_MS = 12000;

let lastGood = 0; // per-isolate backend preference (passive health check)

function cors(extra = {}) {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', ...extra };
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(t);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors({ 'Access-Control-Max-Age': '86400' }) });
    }
    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...cors() },
      });
    }
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, proxy: 'cinephile-api', backends: BACKENDS }), {
        headers: { 'Content-Type': 'application/json', ...cors() },
      });
    }

    const first = url.pathname.split('/').filter(Boolean)[0] || '';
    if (REFUSE.has(first)) {
      return new Response(JSON.stringify({ error: 'Not proxied — use the site origin for this path' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...cors() },
      });
    }

    // Only forward known API shapes; anything else is not ours to serve.
    const KNOWN = /^\/(?:search|info|sources|servers|subtitles|dubs|recent|trending|movies|tv|genre|top-imdb|movie\/embed|tv\/embed)(?:\/|\?|$)/;
    if (!KNOWN.test(url.pathname)) {
      return new Response(JSON.stringify({ error: 'Unknown API path' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...cors() },
      });
    }

    const order = [lastGood, ...BACKENDS.map((_, i) => i).filter((i) => i !== lastGood)];
    let lastErr = null;
    for (const i of order) {
      try {
        const upstream = await fetchWithTimeout(`${BACKENDS[i]}${url.pathname}${url.search}`, UPSTREAM_TIMEOUT_MS);
        // 2xx/4xx are definitive (a 400 fails on the mirror too) — return.
        // 5xx/429 may succeed on the mirror — try next.
        if (upstream.ok || (upstream.status !== 429 && upstream.status < 500)) {
          lastGood = i;
          const headers = new Headers();
          const ct = upstream.headers.get('content-type');
          if (ct) headers.set('Content-Type', ct);
          const cc = upstream.headers.get('cache-control');
          if (cc) headers.set('Cache-Control', cc);
          headers.set('Access-Control-Allow-Origin', '*');
          headers.set('X-Backend', BACKENDS[i]);
          return new Response(upstream.body, { status: upstream.status, headers });
        }
        lastErr = new Error(`backend ${i}: ${upstream.status}`);
      } catch (e) {
        lastErr = e;
      }
    }
    return new Response(JSON.stringify({ error: `All backends failed (${(lastErr && lastErr.message) || 'unknown'})` }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...cors() },
    });
  },
};
