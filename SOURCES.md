# Sources & Research

This document explains **how the stream sources in this project were found**, how
each one works, which ones are alive, and how to add a new one safely.

It is a field guide, not a promise: these upstreams rename hosts, rotate ciphers,
and go dark constantly. Everything here can change overnight.

---

## TL;DR

- Sources are **embed-player APIs**, not official APIs. We find them by reading
  the player's own JavaScript (or public reverse-engineering repos) and then
  calling the same endpoints it does.
- Routing lives in [`config/upstreams.json`](config/upstreams.json) — a
  `families` table (`peachify`, `vidnest`, `meowtv`, `byse`, `cinejoy`) consumed by the
  resolver (`src/services/extractor.js`) and mirrored for the edge
  (`functions/lib/extractor.js`).
- Anime is a **separate catalog**: [AniList](https://anilist.co) metadata +
  **Megaplay** streams, exposed under `/anime/*`.
- The canary (`scripts/check-upstreams.mjs`, `GET /health/upstreams?probe=1`)
  tells you whether the table still works.

---

## 1. Where the leads came from

These are the real starting points used while building this project:

| Lead | What it gave us |
|---|---|
| [`smy778/EncDecEndpoints`](https://github.com/smy778/EncDecEndpoints) | A collection of **sample clients** (`samples/*.py`) for embed players. Each sample documents the base host, the request shape, and which decryptor to call. This is where `megaplay`, `byse`, `nexa`, `hexa` and `meowtv` first appeared. |
| [DeepWiki mirror of that repo](https://deepwiki.com/smy778/EncDecEndpoints/3.4-cinejoy-peachify-meowtv-onetouchtv) | Human-readable summaries of the server lists (e.g. Peachify's `Multi/Horizon/Spider/Wolf/Iron`). |
| [`cinepro-org/core`](https://github.com/cinepro-org/core) (PR adding Peachify) | Confirmed Peachify's newer API hosts (`uwu.eat-peach.sbs`, `usa.eat-peach.sbs`) after the old ones died. |
| The embed site itself (DevTools / `curl`) | The authoritative source. Fetch the page, find its JS bundle, read the endpoint names and payload shapes. |
| [enc-dec.app](https://enc-dec.app) | A public decryptor service several of these players rely on (`/api/dec-*`, `/api/enc-*`). Used by `meowtv`, `megaplay` (and had stale `nexa`/`byse` helpers). |

> The tracking repo periodically **removes dead sources**. When Peachify vanished
> it was dropped there with the note "additionaly removed dead" — that matched our
> own probes (every `*.eat-peach.sbs` host answered Cloudflare **523**).

---

## 2. The discovery method (repeatable)

For any new streaming site, the workflow is always the same:

1. **Find the player.** Open a title in the browser, DevTools → Network. The
   `movie/...` XHRs point at the player/embed host (e.g. `new.vidnest.fun`,
   `mfw09.org`, `providers.nexa.mov`).
2. **Grab its bundle.** Fetch the embed HTML and list `<script src>` / module
   chunks. Pretty-print and grep for `api`, `sources`, `playback`, `encrypt`,
   `challenge`, `subtitles`, `m3u8`.
3. **Identify the crypto.** Either the bundle decrypts locally (WebCrypto:
   AES-GCM, ECDSA P-256) or it calls a third-party decoder. Reproduce whichever
   it uses.
4. **Probe the endpoint with `curl`/Node** before writing any app code:
   confirm status codes, list the fields you actually get, and check whether the
   returned stream URL plays.
5. **Verify the bytes.** A fast JSON answer is not a playable stream. Fetch the
   playlist/segment *through the app's `/play` proxy with the correct `Referer`*
   — that is what the browser will see.
6. **Only then** wire it into the resolver.

Useful greppable strings that have paid off:

- `m3u8-proxy`, `/master.txt`, `/hls`, `streamsvr` — HLS shapes.
- `"enc"`, `"data"`, `isEncrypted`, `encrypted` — encrypted payloads.
- `/stream/`, `/streams/`, `/playlist`, `/getSources` — endpoint names.
- `subtle`, `AES-GCM`, `ECDSA`, `P-256`, `importKey`, `atob` — client-side crypto.
- `runtime.json`, `.wasm`, `import(` — dynamically loaded crypto modules.

---

## 3. Source by source

### Vidnest — `new.vidnest.fun` ✅ core source

- Request: `GET /{provider}/{movie|tv}/{id}[/{season}/{episode}]?_n={nonce}`
- Response: `{ d, n, v }`; payload is **AES-256-GCM**, key =
  `SHA-256(nonce | VIDNEST_SECRET)`, `iv` = first 12 bytes, tag = last 16 bytes.
- Providers are UI names mapped to slugs in `config/upstreams.json` (some are
  content-gated per title — the race + dead-marking handles that).
- Why it is primary: in-process decryption, many providers, self-contained.
- Note: on the Cloudflare edge this once silently failed because the port
  passed an **un-awaited** `crypto.subtle.importKey` promise to `decrypt`. Fixed.

### Peachify — `*.eat-peach.sbs` ☠️ dead (kept for shape compatibility)

- Old flow: `GET /{provider}/{type}/{id}` → encrypted (AES-GCM, key from their
  bundle) → `{sources, subtitles}`; streams were wrapped in `/m3u8-proxy?url=…`.
- Discovered via the EncDecEndpoints sample + `cinepro-org/core`.
- As of this build **every host returns Cloudflare 523** and the tracking repo
  removed it. `providers: []` in config, so it costs nothing to leave wired: if
  it ever returns on a new host, add the slug back + `?refresh=1` — no code change.

### MeowTV — `api.meowtv.ru` ✅ added

- Flow: `POST /streams/ticket` → `GET /streams/{type}/{id}[/{s}/{e}]?s={server}`
  with `X-Stream-Ticket` → encrypted JSON → `POST enc-dec.app/api/dec-meowtv`
  → `{ language, url, headers }` (HLS).
- Servers: `english`, `acme`, `dcloud`, `tik`, `hindi`; each title is gated per
  server (others answer **410**), which is exactly what the race is for.
- Bonus: a subtitle endpoint `GET /subs/{type}/{id}[/{s}/{e}]` serving VTT —
  used as the subtitle fallback now that Peachify's subs are gone.

### Byse — reachable via `0123movie.space` ✅ added (forced server on edge)

- `0123movie.space/mv/{imdb}/{tmdb}/` (movies) or `/pl/{tmdb}/{s}/{e}/` (TV)
  → `302` → an embed page like `https://mfw09.org/e/{code}`.
- The player is an SPA; its bundle (`assets/videoPagesBundle-*.js`,
  `assets/pow-*.js`) revealed a three-stage gate:
  1. **Device attestation** — the client generates a **P-256 ECDSA** key, signs
     the server nonce, and posts the public JWK + a browser fingerprint to
     `/api/videos/access/attest` (after `/access/challenge`).
  2. **Hashcash PoW** — `/embed/captcha` returns `pow_nonce` / `pow_difficulty`;
     the client brute-forces a counter whose custom hash clears the difficulty
     (solver ported from `samples/challenge/byse_optimized.js`).
  3. **Playback config** — `/embed/playback` returns `{key_parts, version, iv,
     payload}`; the key is a concatenation of `key_parts` selected by `version`
     (`[v, 31-v]`), then **AES-GCM** decrypts the source list.
- Details matter: the embed path is `/api/videos/{code}/embed/details` (the
  plain `/details` 404s), and requests need `X-Embed-Origin/Referer/Parent`.
- Stream URLs live on `sprintcdn` and are **Referer-gated** — play them through
  `/play` with the embed origin as `Referer`.

### Nexa — `providers.nexa.mov` ⏸ protocol solved, upstream down

- The sample used `enc-dec.app`'s `enc-nexa`, but that now returns
  **`BAD_ENVELOPE`**. Reading the site bundle revealed the real protocol:
  `GET /v1/runtime.json` → `{ moduleUrl: /v1/runtime/sources.mjs, wasmUrl,
  abi: 3 }`. The `.mjs` is an emscripten wrapper exporting
  `createSources` / default, with an ABI of
  `sourcesAbi, catalogue, hasSession, handshake, accept, reset, serving, plan, open`.
  The browser:
  1. builds a **session** envelope (`/v1/session`) from a device report,
  2. **plans** an envelope for the query, and
  3. POSTs it to `/v1/playlist`, then `open()`s the response.
- We drove that WASM directly from Node (pass the wasm as `wasmBinary`, provide a
  plausible fingerprint `report`) and got **sessions accepted** and envelopes
  accepted. The blocker is upstream: movies return **502** from their origin and
  TV returns **NO_STREAM** on every server. Not integrated; revisit if it heals.

### Hexa — `theemoviedb.hexa.su` ⏸ protocol works, catalog empty

- Chain: `POST cap.hexa.su/{id}/challenge` → `enc-dec.app/api/enc-hexa` →
  `POST .../redeem` → `GET theemoviedb.hexa.su/api/tmdb/{type}/{id}/images` with
  `X-Cap-Token` + a random 32-byte hex `X-Api-Key` → `dec-hexa` with the same key.
- Every title answered `{"code":"500","error":"no sources found"}` — their
  backend is dry. Not integrated.

### Cinejoy — `api.wing.st` ✅ added (multi-server)

- Flow: `GET /servers` (registry of embed servers) → `GET
  enc-dec.app/api/enc-cinejoy?url={cinejoy-api-url}` → `POST /g` (octet-stream)
  → `POST enc-dec.app/api/dec-cinejoy {text, state}` →
  `{ data: { stream: [{ type:'hls', playlist, captions:[{url,language}] }] } }`.
- The upstream URL needs **title + year + imdb + tmdb + server** (TMDB metadata),
  so the resolver fetches that once (cached) before racing the servers.
- Servers: `secret`, `Nebula`, `Lisbon`, `Solara`, `Athens`. In practice
  `Nebula` (and sometimes `secret`) carry titles; the rest are content-gated —
  exactly what the race + dead-marks are for.
- Streams are HLS on `lightspeed.st` / `*.bright67.online` with VTT captions,
  Referer-gated to `https://cinejoy.pk/` → played through `/play`.

### Tried, not added (and why)

| Candidate | Endpoint | Verdict |
|---|---|---|
| **Vidlink** | `vidlink.pro/api/b/{type}/{enc}` | Works (MP4 qualities) but the CDN (`bcdn.hakunaymatata.com`) answered **429** for every stream from our network — could not verify playback, so not shipped. |
| **Videasy** | `api.wecollege.net/{server}/sources` | 18 servers incl. 4K, but `api.wecollege.net` returns a **Cloudflare challenge (403)** to our IP; blocked. |
| **Vidfast** | `vidfast.vc` | Two-stage `enc-vidfast` + CSRF token handshake — viable but heavy; deferred. |
| **Vidup** | `vidup.to` | Same two-stage design as Vidfast — deferred. |
| **OneTouchTV** | `api3.devcorp.me/web/vod/{slug}` | Needs a site-specific content **slug** (not TMDB); requires scraping the catalog. |
| **1movies / yflix** | `yflix.to/ajax/*` | Multi-step: scrape page → encrypt ids → parse HTML; also needs `parse-html` decoder. Deferred. |

### Megaplay — `megaplay.buzz` ✅ anime

- Anime-only (MAL / AniList ids). `GET /stream/mal/{malId}/{ep}/{sub|dub}` →
  HTML whose `<title>` carries an internal content id →
  `GET /stream/getSources?id={id}&platform=OTHER` →
  `POST enc-dec.app/api/dec-megaplay` → `{ file, tracks, intro, outro }`.
- Needs `Referer: https://megaplay.buzz/` on the CDN. Subtitle tracks are VTT.

### AniList / Jikan — anime metadata

- [AniList GraphQL](https://graphql.anilist.co) provides trending/popular/top,
  search and detail, and maps to **MAL ids** (`idMal`) which Megaplay needs.
- **AniList blocks Cloudflare Workers egress** ("You have been manually
  blocked" 403), and Jikan was unreachable from the edge too. The Vercel (Node)
  deployment reaches AniList fine, so the **edge proxies anime metadata to
  Vercel** while resolving streams natively. MAL ids are the canonical anime id
  on both deployments so links work everywhere.

---

## 4. How the resolver uses the table

```
config/upstreams.json
   families: { peachify, vidnest, meowtv, byse, cinejoy }  ← hosts, referers, slugs
        │
        ├─ src/services/upstreams.js        (Node: reads config + UPSTREAMS_JSON env)
        └─ functions/lib/upstreams.js       (Edge: bundled JSON + UPSTREAMS_JSON env)
                │
                ▼
        src/services/extractor.js  (Node)      functions/lib/extractor.js  (Edge)
                │                                   │
                └───────────── resolveStream() ─────┘
                                   │
                     first-win race across families
                     (probe → verify → crown)
```

- `resolveStream({ type, id, season, episode, server? })` races every healthy
  provider and returns the **first source whose stream actually starts**
  (a HEAD/GET probe plus a duration check rejects wrong-content stubs).
- `?server={name}` forces one provider (used by the UI server picker and by
  `/sources?server=byse`).
- Per-title "last known good" + 30 s dead-marks + a 60 s family breaker keep bad
  upstreams from slowing every request.
- Routing changes are hot-patchable: edit `config/upstreams.json` (or set
  `UPSTREAMS_JSON`) and hit `GET /health/upstreams?refresh=1`, no restart.

---

## 5. Adding a new source — checklist

1. **Find it.** Same workflow as §2. Get the base host + exact request path.
2. **Confirm it is alive** from both runtimes that matter:
   - Node/local: `curl`/`node -e "fetch(...)"`
   - Edge: `npx wrangler pages dev public` and hit the route (some hosts block
     Cloudflare egress — see AniList above).
3. **Crack the response.** Either in-process crypto (prefer: no third-party
   dependency) or a decoder service. Port it to **both** `src/services/extractor.js`
   (Node: `crypto`, `axios` via `httpClient`) and `functions/lib/extractor.js`
   (edge: `crypto.subtle`, `fetch`, no `Buffer`).
4. **Playback-check** through `/play` with the correct `Referer` before trusting it.
5. **Register the family** in `config/upstreams.json` (`api`, `referer`,
   `origin`, `providers[]`), then run `npm run sync:upstreams` so
   `functions/lib/upstreams.json` matches.
6. **Normalize the output** to the common shape:
   `{ provider, sources: [{ url, quality, isM3U8, headers, referer, origin }], subtitles }`.
7. **Wire into the race** (`autoRace`) and the forced-server branch, with
   dead-marks and a family breaker. On the edge, keep CPU-heavy families
   (like byse's PoW) **forced-only** so they can't trip free-plan CPU limits.
8. **Subtitles:** if the source exposes VTTs, add a `fetch…Subtitles()` and a
   fallback in `fetchSubtitles()`.
9. **Verify:** `npm test`, `npm run check:upstreams`,
   `GET /health/upstreams?probe=1`, and a real browser check.
10. **Deploy both targets** and re-run the canary:
    - Vercel: `vercel --prod`
    - Cloudflare Pages: `npx wrangler pages deploy public --project-name=cinephile-areana --branch main`

---

## 6. Reality checks

- **These APIs are unofficial and hostile by nature.** They rotate secrets
  (`VIDNEST_SECRET` changed in 2026-10), rename hosts, add captchas, and vanish.
  The table + breaker design exists so a rename is a config edit, not an outage.
- **Some crypto is third-party.** `meowtv` and `megaplay` ride `enc-dec.app`;
  if it is down those families fail while Vidnest/byse (self-contained) keep
  working. Prefer self-contained crypto when adding sources.
- **Edge ≠ Node.** Cloudflare Workers have no `Buffer`, `axios`, or Node
  `crypto`, and tight CPU/metadata budgets. Always test both runtimes.
- **Only stream what you have the right to.** This project is a frontend that
  talks to third-party embed endpoints; that is a legal/ethical decision the
  operator makes. The software itself does not host or store any media.

---

*Last updated: this build — families `peachify` (dead, kept for shape),
`vidnest` (core), `meowtv` (added), `byse` (added), `cinejoy` (added);
anime via AniList + Megaplay.*
