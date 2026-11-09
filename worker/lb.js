// worker/lb.js — free front-door load balancer for the custom domain.
//
// Goal: cinephilia.in hits ONE edge Worker that serves the site from a healthy
// backend — Vercel first, Cloudflare Pages as automatic fallback — without
// ever proxying video bytes through it.
//
// Routing:
//   /play*                        -> 302 to the dedicated play Worker (video)
//   everything else (HTML/JS/CSS,
//   /anime, /sources, /sign, …)   -> reverse-proxy to PRIMARY, then FALLBACK
//
// Why reverse-proxy instead of redirect: the browser keeps cinephilia.in (no
// ugly *.vercel.app in the URL). Bytes of video never transit here.
//
// Free tier: 100k requests/day; one subrequest per page/asset/API call. Video
// is offloaded to the play Worker, so this stays tiny.
//
// Bind to the domain by adding the zone to Cloudflare and setting custom-domain
// routes for cinephilia.in + www.cinephilia.in (see wrangler.lb.toml).

const PLAY_DEFAULT = 'https://cinephile-play.cinephilia-areana.workers.dev';
const PRIMARY_DEFAULT = 'https://cinephiles-areana.vercel.app';
const FALLBACK_DEFAULT = 'https://cinephile-areana.pages.dev';
const UPSTREAM_TIMEOUT_MS = 15000;

function base(env, key, fallback) {
  return String((env && env[key]) || fallback).replace(/\/+$/, '');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1) Video bytes: hand off to the play Worker. Never proxy here.
    if (url.pathname === '/play' || url.pathname.startsWith('/play/')) {
      const playBase = base(env, 'PLAY_WORKER', PLAY_DEFAULT);
      return Response.redirect(`${playBase}${url.pathname}${url.search}`, 302);
    }

    // 2) Everything else: active-passive reverse proxy with failover.
    const targets = [base(env, 'PRIMARY', PRIMARY_DEFAULT), base(env, 'FALLBACK', FALLBACK_DEFAULT)];
    const method = request.method;
    const hasBody = method !== 'GET' && method !== 'HEAD';
    // Buffer the body once so we can retry it on the fallback.
    const body = hasBody ? await request.arrayBuffer() : undefined;

    let lastErr = null;
    for (let i = 0; i < targets.length; i++) {
      const target = `${targets[i]}${url.pathname}${url.search}`;
      const headers = new Headers(request.headers);
      // Let fetch set Host for the target; forward the original host/proto.
      headers.delete('host');
      headers.delete('cf-connecting-ip');
      headers.delete('cf-ray');
      headers.set('X-Forwarded-Host', url.host);
      headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
      try {
        const resp = await fetch(target, {
          method,
          headers,
          body: hasBody ? body : undefined,
          redirect: 'manual',
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        // 5xx = backend problem → try the fallback. 2xx/3xx/4xx are definitive.
        if (resp.status >= 500) {
          lastErr = new Error(`backend ${i} -> ${resp.status}`);
          continue;
        }
        const out = new Headers(resp.headers);
        out.set('X-LB-Backend', targets[i]);
        return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: out });
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
      }
    }

    return new Response(
      JSON.stringify({ error: 'All backends unavailable', detail: String((lastErr && lastErr.message) || 'unknown') }),
      { status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
    );
  },
};
