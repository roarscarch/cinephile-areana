# Deployment: Vercel + Cloudflare

## The 30-second version (plain words)

Your site plays movies. The movie video used to flow **through** Vercel's
computers, and Vercel counts every gigabyte that passes through (10 GB free
per month). One movie is ~2 GB, so ~5 movies used it all up.

Now the video flows through **Cloudflare's** computers instead, where
bandwidth is free and unlimited. Vercel only serves the tiny text stuff
(search results, movie info — kilobytes, not gigabytes). Your site address
didn't change and nothing looks different — the video just takes a cheaper
road to reach the viewer.

There are two live copies now:
- `cinephilia-vercel.vercel.app` — the main site (Vercel for text + info,
  Cloudflare for video).
- `cinephile-areana.pages.dev` — a backup copy running 100% on Cloudflare
  (free forever, no Vercel limits at all).

## Why this setup exists (details)

The app used to stream every video byte through Vercel (`/play` proxy in
`src/routes/stream.js`). On Vercel Hobby that burns **Fast Origin Transfer**
(Function -> edge network, 10 GB/month included, resets monthly):

- 1 proxied 1080p movie = ~1.5–2.5 GB origin **and** ~1.5–2.5 GB Fast Data
  (edge -> user, 100 GB/month). ~5 movies killed the 10 GB quota.
- Vercel Functions are stateless, so the in-memory segment/playlist cache
  never hits — every segment re-pays the CDN round-trip.
- Hobby functions time out at 60 s — long MP4s cut mid-movie.

The fix: video bytes ride Cloudflare (free unmetered bandwidth), Vercel keeps
only UI + tiny JSON APIs (~15 KB per watch instead of ~1.5 GB — ~100,000x less
origin). Nothing about the Vercel URL or UX changed.

## Current architecture

```
Browser (stays on https://cinephilia-vercel.vercel.app)
 ├─> Vercel: HTML + /search + /info + /sources + /subtitles + /dubs (KBs)
 ├─> Cloudflare Worker cinephile-play (/play?...): video bytes (GBs, free)
 │     ├─> CORS-open CDN ─> direct (eat-peach.sbs, 97bf1.com, …)
 │     └─> Referer-gated CDN ─> Worker injects Referer, rewrites m3u8
 └─> Vercel /play: 302-redirects to the Worker (guard for stale cached
     players, set via PLAY_PROXY_BASE env — zero video bytes on Vercel)
```

Plus a full Cloudflare mirror (no Vercel involved at all):

```
https://cinephile-areana.pages.dev  (Pages static + Functions API)
  └─> /play 302 ─> cinephile-play Worker
  └─> /download 302 ─> Vercel (needs ffmpeg, can't run on Workers)
```

| Piece | Code | Host | Cost |
|---|---|---|---|
| UI + metadata API | repo as-is | Vercel | ~15 KB origin/watch |
| Stream proxy | `worker/play-proxy.js` | Workers (`cinephile-play`) | free bandwidth, 100k req/day (~125 proxied movies/day; direct plays unlimited) |
| Full mirror | `public/` + `functions/` | Pages (`cinephile-areana`) | free, unlimited bandwidth |

## Deploy the Worker (video proxy)

```bash
cd worker
export CLOUDFLARE_API_TOKEN=<token>     # "Edit Cloudflare Workers" template
export CLOUDFLARE_ACCOUNT_ID=<account-id> # dashboard right sidebar
npx wrangler whoami   # sanity check
npx wrangler deploy   # play proxy -> https://cinephile-play.<you>.workers.dev
npx wrangler deploy -c wrangler.api.toml  # api proxy -> https://cinephile-api.<you>.workers.dev
unset CLOUDFLARE_API_TOKEN
```

The api proxy (`worker/api-proxy.js`, `cinephile-api`) is the single-URL
front for the metadata API: it forwards to the healthy backend
(Pages mirror / Vercel) so backend hostnames stay out of DevTools. It never
proxies `/play` (video goes direct), `/sign` (same-origin lockdown), or
`/download` (page-origin flow). If it fails, `api.js` falls back to the
backends directly. Quota: ~10-15 req/watch -> ~7k watches/day of the free
100k/day pool (shared account-wide with the play Worker).

## Deploy the Pages mirror (full site, optional)

```bash
cd ~/cinephile-areana   # repo root (needs public/ + functions/ together)
npx wrangler pages project create cinephile-areana --production-branch main
./cloudflare/sync-env.sh cinephile-areana   # copies 3 secrets, nothing else
npx wrangler pages deploy public --project-name=cinephile-areana --branch main
# -> https://cinephile-areana.pages.dev
```

`--branch main` is what promotes the deploy to production (otherwise you only
get hashed preview URLs). Env vars apply to new deployments only — after
`secret put`, always redeploy (or `wrangler pages deployment list` + redeploy).

`functions/` is the Express backend ported to Workers runtime (fetch instead
of axios, WebCrypto AES-GCM instead of Node crypto, `DecompressionStream`
instead of zlib). The frontend needs no changes: `api.js` is same-origin and
`player.js` already points at the play Worker.

## Environment variables

| Var | Where | Required | Notes |
|---|---|---|---|
| `TMDB_API_KEY` | Vercel + Pages | yes | TMDB read key |
| `PEACHIFY_KEY_HEX` | Vercel + Pages | yes | 64 hex chars, AES key |
| `VIDNEST_ALPHABET` | Vercel + Pages | yes | 65-char alphabet |
| `PLAY_PROXY_BASE` | Vercel only | yes | Worker URL — turns Vercel `/play` into a 302 guard |
| `SUBDL_API_KEY` etc. | Pages/Vercel | no | OpenSubtitles creds; SubDL has built-in fallback key |

`sync-env.sh` copies only the secret keys from `.env.local` — never
`VERCEL_OIDC_TOKEN`.

## Hotlink protection (signed play URLs + rate cap)

`/play` URLs carry `exp` (2h expiry) + `sig` (HMAC-SHA256 over
`url + ref + origin + exp`) so the Worker can tell our players apart from
hotlinkers. Media URLs are signed server-side in `/sources`; subtitle tracks
are signed on demand via same-origin `GET /sign?url=&ref=` (their referer is
only known client-side). The Worker also caps each IP at 4000 req/10 min.

Setup (all three deployments share one key):

```bash
openssl rand -hex 32   # -> PLAY_SIGNING_KEY
```

- Worker: `wrangler secret put PLAY_SIGNING_KEY` (in `worker/`)
- Pages: `wrangler pages secret put PLAY_SIGNING_KEY --project-name=cinephile-areana`
  (or add to `.env.local` and re-run `sync-env.sh`), then redeploy
- Vercel: env var `PLAY_SIGNING_KEY` on each project, then redeploy

Rollout is two-phase (Worker default is warn mode — serves everything, tags
responses with `X-Sig-Status: ok|missing|expired|bad-sig`):

1. Deploy everything with the key set. Players (v20+) use signed URLs;
   watch `X-Sig-Status` — when `missing` disappears, all clients migrated.
2. Flip enforcement: set Worker env `REQUIRE_SIGNED=1` (`wrangler secret put
   REQUIRE_SIGNED` + redeploy worker). Unsigned requests then get 403.

Extra origins for `/sign` via `ALLOW_ORIGINS="a.com,b.com"` (defaults cover
both Vercel projects + Pages + localhost).

## Cloudflare token permissions

Create at Dashboard -> My Profile -> API Tokens -> **Edit Cloudflare Workers**
template, then scope it:

- **Account Resources -> Include -> your account.** This is what actually
  limits the token. Don't leave it on All.
- **Zone Resources -> Include -> All zones.** `workers.dev`/`pages.dev`
  deploys use no zone; the form just won't submit without it. Grants nothing
  extra beyond routes.
- **Permissions -> leave all defaults.** Wrangler needs Workers Scripts:Edit
  to deploy, plus Account Settings / User Details / Memberships to auth.
  Unchecking causes `10000 auth failed`. KV/R2/Pages/Routes/Tail entries are
  harmless (this project uses Scripts + Pages).
- **Client IP filtering -> blank** (unless you have a static IP).
- **TTL -> blank**, then **revoke the token after deploying** (API Tokens ->
  Delete). Never commit it — it stays in env vars only.

## Vercel side

No token needed: `npx vercel login` (or existing CLI auth) + linked project,
or connect the GitHub repo (Settings -> Git) so pushes auto-deploy. Set
`PLAY_PROXY_BASE=https://cinephile-play.<you>.workers.dev` in Project Settings
-> Environment Variables (Production), then redeploy once.

## Verify

```bash
curl "https://<your-pages>.pages.dev/health"            # {"ok":true,...}
curl "https://<your-vercel>.vercel.app/" | grep player.js  # expect ?v=19+
# /play must 302, never proxy bytes:
curl -o /dev/null -w "%{http_code} -> %{redirect_url}\n" \
  "https://<your-vercel>.vercel.app/play?url=https%3A%2F%2Fexample.com%2Fa.m3u8&ref=https%3A%2F%2Fpeachify.top%2F"
# expect: 302 -> https://cinephile-play.<you>.workers.dev/play?...
```

In the browser: DevTools Network during playback — segments load from
`cinephile-play...workers.dev`, not Vercel. Vercel usage (Fast Origin Transfer)
goes flat except API JSON.

## Troubleshooting (errors we actually hit)

| Symptom | Cause | Fix |
|---|---|---|
| `wrangler pages project list` shows nothing | No Pages project created yet | `wrangler pages project create cinephile-areana --production-branch main` |
| Deploy prints a hashed URL (`b7b9bd0f...pages.dev`) instead of `cinephile-areana.pages.dev` | That was a preview deploy | Redeploy with `--branch main` to promote to production |
| `/health` says a key is missing | Secrets were set but no redeploy happened after | Secrets apply to new deployments only — redeploy |
| `sync-env.sh` prints `skip X (not in .env.local)` | That key isn't in your `.env.local` | Only the 3 main secrets are required; SubDL/OpenSubtitles are optional fallbacks |
| Video segment returns `{"error":"Upstream 429"}` | The video CDN rate-limited a burst of requests | Normal — the player auto-switches to another server; not a bug in the proxy |
| `*.pages.dev` won't open from one network but opens elsewhere | Local network/TLS issue, not the site | Try another network or browser; check `/health` first |

## Limits cheat sheet

- Vercel Hobby: 10 GB origin + 100 GB data + 1M invocations / month.
- After the move: ~15 KB origin + ~10 invocations per watch.
- Worker free: 100k req/day (~800 per proxied movie = ~125/day shared;
  direct-play movies cost 0).
- Pages free: unlimited bandwidth/requests.
