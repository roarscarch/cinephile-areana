// Video player: hls.js playback, subtitle tracks, server switching, skip-intro.
const Player = (() => {
  // CORS-open hosts play directly in the browser (verified probing for
  // Access-Control-Allow-Origin + no Referer/Origin gating); everything else
  // goes through /play. When every source on a server dies mid-playback,
  // advance through the server list automatically (vidnest first — its API is
  // the most reliable right now).
  const CORS_OPEN_HOSTS = [
    'eat-peach.sbs',             // (legacy)
    '97bf1.com',                 // buzz
    'cache.vdrk.site',           // vidnest subtitles
    'sparkvid.workers.dev',      // vidxyz
    'remoteconsultinggroup.site' // wolf/ngc — ACAO: *, plays headerless
  ];
  // Display names are compact on purpose (S1..S11) — upstream provider
  // identities stay out of the UI and buttons stay narrow. Numbering follows
  // a fixed alphabetical order so each server keeps its number across
  // deploys; internal names still ride data attributes + API calls untouched.
  // Buttons sort by this order (the API returns direct-first, not numeric).
  const SERVER_ORDER = ['buzz', 'hollymoviehd', 'horizon', 'iron', 'multi', 'ngc', 'rogflix', 'spider', 'videasy', 'vidxyz', 'wolf'];
  const PROVIDER_LABELS = Object.fromEntries(SERVER_ORDER.map((n, i) => [n, `S${i + 1}`]));

  // Option A: video bytes ride the Cloudflare Worker, not Vercel.
  // Override with window.__PLAY_PROXY__ (e.g. in index.html) if the URL changes.
  const PLAY_PROXY_BASE = (window.__PLAY_PROXY__ || 'https://cinephile-play.cinephilia-areana.workers.dev').replace(/\/$/, '');

  // Subtitle cue sizes (applied as video classes, see style.css ::cue rules).
  const SUB_SIZES = ['S', 'M', 'L', 'XL'];

  // Fallback race budget per title load. Each failed provider is added to a
  // skip list and the remainder is re-raced — every attempt is a FRESH server,
  // so we converge on a working one (or a clear error) instead of looping.
  const MAX_RACE_ATTEMPTS = 8;

  // Direct CDN URLs on CORS-open hosts play browser-direct (no /play hop);
  // so do progressive MP4s with their own sign-token auth (a <video src>
  // element has no CORS constraints and can't be Referer-gated by us anyway —
  // if the source demands headers we must proxy). Everything else rides /play.
  function isDirect(url, src) {
    try {
      const u = new URL(url);
      if (CORS_OPEN_HOSTS.some((h) => u.hostname.endsWith(h))) return true;
      if (src && !src.isM3U8 && !src.referer && !src.origin && /\.(mp4|mkv|webm|m4v)($|\?)/i.test(u.pathname + u.search)) return true;
    } catch (e) {
      return false;
    }
    return false;
  }

  // Direct CDNs need our /play proxy (referer + CORS); CORS-open hosts play
  // direct. Sources carrying their OWN referer (buzz: ployan.me, multi:
  // laika422mon, ngc: nextgencloudfabric, goodstream…) MUST keep it end to
  // end — /play's peachify.top default 403/429s their segments. playableUrl
  // forwards the source referer; /play's rewriter propagates it downstream.
  function playableUrl(url, referer, origin, src) {
    // Local API routes (e.g. /subtitles/subdl?zip=…) are same-origin — fetch
    // them directly. /play only proxies absolute http(s) URLs and would 400.
    if (url.startsWith('/')) return url;
    if (isDirect(url, src)) return url;
    // Server-issued signed URL (from /sources): proves to the Worker this
    // request came from our player. Falls back to unsigned below.
    if (src && src.play) return src.play;
    const params = new URLSearchParams({ ref: referer || 'https://peachify.top/' });
    if (origin) params.set('origin', origin);
    params.set('url', url);
    return `${PLAY_PROXY_BASE}/play?${params.toString()}`;
  }

  // Signed subtitle fetch URLs, minted on demand via same-origin GET /sign
  // (their referer is only known here, at pick time). Cached ~100 min.
  const subSignCache = new Map(); // `${url}\n${ref}` -> { play, exp }
  async function signedSubUrl(url, referer, origin) {
    if (url.startsWith('/')) return url;
    if (isDirect(url, null)) return url;
    const ref = referer || 'https://peachify.top/';
    const key = `${url}\n${ref}`;
    const hit = subSignCache.get(key);
    if (hit && hit.exp > Date.now() + 5 * 60 * 1000) return hit.play;
    const p = new URLSearchParams({ url });
    p.set('ref', ref);
    if (origin) p.set('origin', origin);
    const r = await fetch(`/sign?${p.toString()}`);
    if (!r.ok) throw new Error(`sign ${r.status}`);
    const { play } = await r.json();
    if (!play) throw new Error('sign empty');
    if (subSignCache.size > 200) subSignCache.clear();
    subSignCache.set(key, { play, exp: Date.now() + 100 * 60 * 1000 });
    return play;
  }

  function pickBest(sources) {
    if (!sources || !sources.length) return null;
    const ranked = [...sources].sort((first, second) => {
      const qualityOf = (source) => {
        const parsed = parseInt(source.quality || '0', 10);
        return Number.isFinite(parsed) ? parsed : 0;
      };
      // Quality first; among equal quality prefer browser-direct sources
      // (zero proxy cost) over proxied ones; HLS last as before.
      const directRank = (source) => {
        try {
          return isDirect(source.url, source) ? 1 : 0;
        } catch {
          return 0;
        }
      };
      return qualityOf(second) - qualityOf(first) || directRank(second) - directRank(first) || (second.isM3U8 ? 1 : 0) - (first.isM3U8 ? 1 : 0);
    });
    return ranked[0];
  }

  // ---- subtitle helpers ----
  // Subtitle CDNs (e.g. kaoline.workers.dev) rate-limit bursts and send no CORS
  // headers, so we load ONE track at a time, on demand, through /play.

  function srtToVtt(srt) {
    return (
      'WEBVTT\n\n' +
      srt
        .replace(/\r/g, '')
        .replace(/(\d{2}:\d{2}:\d{2})[,.](\d{3})/g, '$1.$2')
        .replace(/^\d+\n(?=\d{2}:)/gm, '')
    );
  }

  function parseVtt(text) {
    const cues = [];
    const blockRe = /(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})[^\n]*\n([\s\S]*?)(?=\n\s*\n|\n\d{2}:\d{2}:\d{2}|$)/g;
    const toSeconds = (stamp) => stamp.split(':').reduce((total, part) => total * 60 + parseFloat(part), 0);
    let match;
    while ((match = blockRe.exec(text)) !== null) {
      try {
        cues.push(new VTTCue(toSeconds(match[1]), toSeconds(match[2]), match[3].trim()));
      } catch (e) {}
    }
    return cues;
  }

  function isSrt(url) {
    return /\.srt($|\?)|format=srt/i.test(url);
  }

  // ---- main player ----
  const PROGRESS_KEY = 'cinephile-progress'; // { [mediaId/episodeId]: {pos,dur,title,type,image,t} }
  const RESUME_MIN = 30; // seconds before we offer a resume
  const UP_NEXT_WINDOW_S = 300; // reveal "Next episode" 5 min before the end

  class MoviePlayer {
    constructor(shell) {
      this.shell = shell;
      this.video = shell.querySelector('video');
      this.hls = null;
      this.sources = null;
      this.mediaId = null;
      this.episodeId = '1-1';
      this.currentIndex = 0;
      this.server = null;
      this.ready = false;
      this._intro = null;
      this._introFired = false;
      this.resumePos = 0;
      this._pendingResume = false;
      this._started = false;
      this._lastSave = 0;
      // Next-episode affordance: supplied by the watch view (TV only).
      this.nextEpisodeId = null;
      this._upNextShown = false;
      // Volume boost beyond 100% (Web Audio). video.volume is capped at 1.0, so
      // once the gain graph is live we hold video.volume=1 and let a GainNode
      // own loudness (up to 2000%). A DynamicsCompressor (near-limiter) clamps
      // boosted peaks so we don't clip — that's what the ✓ boost experiment does.
      this._volume = Math.min(20, Math.max(0.1, Number(localStorage.getItem('cinephile-volume') || '1')));
      this._audioGraph = null; // AudioContext
      this._audioGain = null; // GainNode (dangerously owns loudness > 1)
      this._subtitle = null; // {url,label} — feeds the Download button
      // Subtitle sync state: _subBaseCues holds the RAW cue times from the
      // subtitle file; _subOffset (seconds) and _subScale (fps correction) are
      // applied at add-time so tweaks re-render instantly without refetching.
      this._subBaseCues = null;
      this._subOffset = 0;
      this._subScale = 1;
      this._subAutoDone = false; // auto fps-guess runs once per loaded track
      this._failedSubs = new Set(); // subtitle URLs that errored — never re-picked
      this.video.volume = this._volume > 1 ? 1 : Math.max(0, Math.min(1, this._volume));
      // fps auto-resync needs video.duration — retry when metadata lands
      this.video.addEventListener('loadedmetadata', () => this._maybeAutoSync());
      // a stream that genuinely starts playing means the session is healthy —
      // reset the fallback budget so a real mid-play death can re-race later
      this.video.addEventListener('playing', () => {
        this._racedProviders = new Set();
        this._raceAttempts = 0;
      });

      this.video.addEventListener('timeupdate', () => {
        this._checkIntro();
        this._checkUpNext();
        this._saveProgress(false);
      });
      this.video.addEventListener('ended', () => {
        this._saveProgress(true);
        // surfaced even without the pre-end window firing (short clips, seek-to-end)
        this.shell.dispatchEvent(new CustomEvent('episode-ended'));
      });
      // Web Audio needs a user gesture to start (autoplay policies). We lazily
      // build the gain graph on the first play / any pointer/key interaction.
      this.video.addEventListener('play', () => this._ensureAudioGraph());
      // Watch history: log once per title+episode on first real playback
      // (router renders it as a home row; finished titles leave Continue
      // Watching, history remembers everything).
      this.video.addEventListener('play', () => this._logHistory());
      // Ambient glow theater mode (YouTube-style): throttled frame sampling
      // paints a blurred mirror behind the player. Display-only canvas ops —
      // pixels are never read, so cross-origin video never taints anything.
      if (!window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        this.video.addEventListener('play', () => this._initAmbient(), { once: true });
      }
      this.shell.addEventListener('pointerdown', () => this._ensureAudioGraph());
      this.shell.addEventListener('keydown', () => this._ensureAudioGraph());
      this.video.addEventListener('play', () => this.shell.dispatchEvent(new CustomEvent('play-state', { detail: { playing: true } })));
      this.video.addEventListener('pause', () => this.shell.dispatchEvent(new CustomEvent('play-state', { detail: { playing: false } })));

      // keyboard shortcuts (skip when typing in a field)
      shell.addEventListener('keydown', (e) => {
        const t = e.target;
        if (t && (t.matches('input,select,textarea') || t.isContentEditable)) return;
        switch (e.key) {
          case ' ':
          case 'k':
            this.togglePlay();
            e.preventDefault();
            break;
          case 'ArrowRight':
          case 'l':
            this.video.currentTime = Math.min(this.video.duration || Infinity, this.video.currentTime + 10);
            e.preventDefault();
            break;
          case 'ArrowLeft':
          case 'j':
            this.video.currentTime = Math.max(0, this.video.currentTime - 10);
            e.preventDefault();
            break;
          case 'ArrowUp':
            this.setVolume(this._volume + 0.1);
            e.preventDefault();
            break;
          case 'ArrowDown':
            this.setVolume(this._volume - 0.1);
            e.preventDefault();
            break;
          case 'm':
            this.video.muted = !this.video.muted;
            e.preventDefault();
            break;
          case 'f':
            this.toggleFullscreen();
            e.preventDefault();
            break;
          case '>':
          case '.':
            this.changeSpeed(0.25);
            e.preventDefault();
            break;
          case '<':
          case ',':
            this.changeSpeed(-0.25);
            e.preventDefault();
            break;
          case 'z': // subtitle sync: 0.05s earlier (fine)
            this.setSubtitleOffset((this._subOffset || 0) - 0.05);
            e.preventDefault();
            break;
          case 'x': // subtitle sync: 0.05s later (fine)
            this.setSubtitleOffset((this._subOffset || 0) + 0.05);
            e.preventDefault();
            break;
        }
      });

      // Mobile double-tap seek: two quick taps on the left/right third jump
      // ∓10s (chained taps accumulate); center double-tap toggles play.
      // Native controls still own single taps. Multi-touch and swipes pass
      // through untouched.
      if ('ontouchstart' in window) this._initTouchSeek();
    }

    /**
     * Route wires the hls.js script promise here so the player can hold it and
     * finish attaching only once the stream AND the player library are ready.
     */
    readyWhen(hlsPromise) {
      this._hlsReady = Promise.resolve(hlsPromise).catch(() => {});
    }

    _initTouchSeek() {
      let lastTap = 0;
      let lastX = 0;
      let chain = 0;
      let chainDir = 0;
      let chainTimer = 0;
      let wasPlaying = false;
      let startX = 0;
      let startY = 0;
      let moved = false;
      this.video.addEventListener(
        'touchstart',
        (e) => {
          if (e.touches.length > 1) {
            moved = true;
            return;
          }
          const t = e.touches[0];
          startX = t.clientX;
          startY = t.clientY;
          moved = false;
        },
        { passive: true }
      );
      this.video.addEventListener(
        'touchmove',
        (e) => {
          const t = e.touches[0];
          if (Math.abs(t.clientX - startX) + Math.abs(t.clientY - startY) > 30) moved = true;
        },
        { passive: true }
      );
      this.video.addEventListener('touchend', (e) => {
        if (moved) return;
        const now = Date.now();
        const touch = (e.changedTouches && e.changedTouches[0]) || {};
        const rect = this.video.getBoundingClientRect();
        const x = touch.clientX || 0;
        const third = rect.width ? (x - rect.left) / rect.width : 0.5;
        if (now - lastTap < 300 && Math.abs(x - lastX) < 80) {
          e.preventDefault();
          const dir = third < 0.35 ? -1 : third > 0.65 ? 1 : 0;
          if (!dir) {
            this.togglePlay();
          } else {
            const d = this.video.duration || Infinity;
            this.video.currentTime = Math.min(d, Math.max(0, this.video.currentTime + dir * 10));
            chain = chainDir === dir ? chain + 1 : 1;
            chainDir = dir;
            clearTimeout(chainTimer);
            chainTimer = setTimeout(() => (chain = 0), 800);
            this._flashSeek(dir, chain);
            // the two taps toggled native play state — restore what it was
            setTimeout(() => {
              if (wasPlaying && this.video.paused) this.video.play().catch(() => {});
            }, 350);
          }
          lastTap = 0;
        } else {
          wasPlaying = !this.video.paused;
          lastTap = now;
          lastX = x;
        }
      });
    }

    _flashSeek(dir, chain) {
      let flash = this.shell.querySelector('.seek-flash');
      if (!flash) {
        flash = document.createElement('div');
        flash.className = 'seek-flash';
        flash.setAttribute('aria-hidden', 'true');
        this.shell.appendChild(flash);
      }
      flash.textContent = `${dir < 0 ? '−' : '+'}${10 * chain}s`;
      flash.classList.toggle('left', dir < 0);
      flash.classList.toggle('right', dir > 0);
      flash.classList.remove('show');
      void flash.offsetWidth; // restart the fade animation
      flash.classList.add('show');
    }

    /** Subtitle cue size (S/M/L/XL), persisted across titles. */
    setSubSize(size) {
      const s = SUB_SIZES.includes(size) ? size : 'M';
      this._subSize = s;
      this.video.classList.remove('cue-s', 'cue-m', 'cue-l', 'cue-xl');
      this.video.classList.add('cue-' + s.toLowerCase());
      try {
        localStorage.setItem('cinephile-subsize', s);
      } catch {}
      return s;
    }

    /**
     * Ambient glow: every 800 ms paint the current frame (32×18, cheap)
     * onto a blurred canvas behind the player. Skipped while paused,
     * hidden, or before any frame exists. Display-only — pixels are never
     * read, so cross-origin streams are safe.
     */
    _initAmbient() {
      if (this._ambientTimer) return;
      let canvas = this.shell.querySelector('.ambient-glow');
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.className = 'ambient-glow';
        canvas.width = 32;
        canvas.height = 18;
        canvas.setAttribute('aria-hidden', 'true');
        this.shell.prepend(canvas);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      this._ambientTimer = setInterval(() => {
        try {
          if (this.video.paused || document.hidden || this.video.readyState < 2) return;
          if (this.video.videoWidth) ctx.drawImage(this.video, 0, 0, 32, 18);
        } catch {}
      }, 800);
    }

    load({ mediaId, episodeId = '1-1', title, server = null, image = '', imdbId = null }) {
      this.mediaId = mediaId;
      this.episodeId = episodeId;
      this.server = server;
      this._title = title || '';
      this._image = image;
      this._imdbId = imdbId || null;
      this._destroyTorrent();
      this._torrentTried = false;
      this.quality = localStorage.getItem('cinephile-quality') || 'auto';
      this.audio = localStorage.getItem('cinephile-audio') || 'auto';
      try {
        this.setSubSize(localStorage.getItem('cinephile-subsize') || 'M');
      } catch {
        this.setSubSize('M');
      }
      this._racedProviders = new Set(); // servers already raced & failed — skipped on re-race
      this._raceAttempts = 0; // bounded fallback budget per title (no infinite re-racing)
      this._intro = null;
      this._introFired = false;
      this._started = false;
      this._lastSave = 0;
      this._upNextShown = false; // fresh episode → pre-end window re-arms
      this._historyLogged = false; // fresh episode → log its first play
      this.resumePos = 0;
      // subtitle sync resets per title/episode (each release syncs differently);
      // the watch view re-applies the stored per-title offset right after load()
      this._subBaseCues = null;
      this._subOffset = 0;
      this._subScale = 1;
      this._subAutoDone = false;
      this._failedSubs = new Set(); // fresh title → forget past subtitle failures
      // where we left off on THIS title+episode (resume on first successful attach)
      // TV reads the per-series entry (`tv/1396` + episodeId) with a fallback
      // to the legacy per-episode key (`tv/1396/1-1`) from older saves.
      try {
        const map = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
        const hit = map[mediaId] && String(mediaId).startsWith('tv/')
          ? map[mediaId]
          : map[`${mediaId}/${episodeId}`];
        this.resumePos = (hit || {}).pos || 0;
        // only resume the series entry when it actually belongs to THIS episode
        if (hit && String(mediaId).startsWith('tv/') && hit.episodeId && hit.episodeId !== episodeId) {
          this.resumePos = 0;
        }
      } catch (e) {
        this.resumePos = 0;
      }
      this._pendingResume = this.resumePos > RESUME_MIN;
      this.showLoading('Finding streams…');
      API.sources(mediaId, episodeId, server)
        .then(async (res) => {
          // the hls.js script loads in parallel with this sources fetch —
          // by the time streams arrive it's almost always already on the page
          if (this._hlsReady) await this._hlsReady;
          this.sources = res.sources || [];
          this.provider = res.provider;
          // NOTE: no subtitle work here — /sources is stream-only by contract.
          // Tracks arrive later via setSubtitles() (fired from GET /subtitles).
          this.shell.dispatchEvent(
            new CustomEvent('sources-ready', { detail: { provider: res.provider } })
          );
          this._fetchIntro();
          this._play();
        })
        .catch((e) => this.showError(e.message));
    }

    _play() {
      // Manual pick: the user explicitly chose this server, so it OWNS the
      // player until they pick another one. Empty/dead here must STAY with a
      // clear message — never silently re-race to a different server.
      if (!this.sources.length) {
        if (this._manualServer) {
          this._started = false;
          return this.showError(`No sources on ${PROVIDER_LABELS[this.provider] || this.provider || 'this server'} — pick another server.`);
        }
        return this._autoAdvance(this.provider); // Auto mode: race the rest
      }
      // Torrent-only test/debug switch: ?torrent=1 on the watch hash (or
      // localStorage cinephile-torrent-only=1) jumps straight to peers,
      // skipping servers — for verifying peer playback without killing servers.
      let torrentOnly = false;
      try {
        torrentOnly = window.__TORRENT_ONLY__ === true || localStorage.getItem('cinephile-torrent-only') === '1';
      } catch {}
      if (torrentOnly && !this._manualServer) {
        return this._tryTorrentFallback('Peer fallback failed.');
      }
      this._started = true;
      // respect the stored audio choice (dub) when this server carries it
      let src = null;
      if (this.audio !== 'auto') src = this.sources.find((s) => s.dub === this.audio) || null;
      if (!src) src = pickBest(this.sources);
      this.currentIndex = this.sources.indexOf(src);
      this._attach(src);
    }

    /** User picks an audio language (dub label) — re-attaches the matching source. */
    setAudio(value) {
      this.audio = value;
      localStorage.setItem('cinephile-audio', value);
      if (value === 'auto') return this._play();
      const src = (this.sources || []).find((s) => s.dub === value);
      if (src) {
        this.currentIndex = this.sources.indexOf(src);
        this._attach(src);
      } else {
        this._play();
      }
    }

    // ---- volume boost beyond 100% (Web Audio) ----
    // video.volume tops out at 1.0 (100%). To go louder we route the element
    // through an audio graph: mediaElement → GainNode → DynamicsCompressor
    // (used as a near-limiter so boosted peaks never clip) → destination.
    // Once the graph is live, video.volume is held at 1 and the GainNode owns
    // loudness (1 = 100%, 2 = 200%, 4 = 400%).
    _ensureAudioGraph() {
      if (this._audioGain) {
        if (this._audioGraph && this._audioGraph.state === 'suspended') {
          this._audioGraph.resume().catch(() => {});
        }
        this._audioGain.gain.value = this._volume; // keep in sync
        return;
      }
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      try {
        const ctx = new Ctor();
        const source = ctx.createMediaElementSource(this.video);
        const gainNode = ctx.createGain();
        const limiterNode = ctx.createDynamicsCompressor();
        // Near-limiter: threshold near 0 dB, hard ratio, fast attack, slow
        // release — clamps boosted peaks instead of letting them crackle.
        limiterNode.threshold.value = -1;
        limiterNode.knee.value = 0;
        limiterNode.ratio.value = 16;
        limiterNode.attack.value = 0.002;
        limiterNode.release.value = 0.1;
        gainNode.connect(limiterNode);
        limiterNode.connect(ctx.destination);
        source.connect(gainNode);
        gainNode.gain.value = this._volume;
        this._audioGraph = ctx;
        this._audioGain = gainNode;
        this.video.volume = 1; // gain node now owns loudness (allows > 100%)
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      } catch (e) {
        // Web Audio unavailable — fall back to native volume (capped at 100%).
      }
    }

    /** Set volume in [0.1, 20] (10%–2000%). 1 = 100%, 2 = 200%, 4 = 400%, 20 = 2000%. */
    setVolume(v) {
      this._volume = Math.max(0.1, Math.min(20, Number(v) || 0.1));
      localStorage.setItem('cinephile-volume', String(this._volume));
      if (this._audioGain) {
        this.video.volume = 1;
        this._audioGain.gain.value = this._volume;
      } else {
        // graph not live yet (no gesture): native element caps at 100%
        this.video.volume = Math.max(0, Math.min(1, this._volume));
      }
      this.shell.dispatchEvent(new CustomEvent('volume-change', { detail: { volume: this._volume } }));
    }

    getVolume() {
      return this._volume;
    }

    _attach(src) {
      this._currentSource = src;
      this._destroyTorrent(); // leaving peer mode (if active) for a server stream
      this._attachId = (this._attachId || 0) + 1;
      const attachId = this._attachId; // stale handlers from older attaches are ignored
      // Forward the SOURCE's own referer (buzz: ployan.me, multi: laika422mon…)
      // end-to-end — never the peachify default — or gated CDNs 403/429 the
      // segments even though the master loaded fine.
      const url = playableUrl(src.url, src.referer, src.origin);
      this.hideLoading();

      // mid-playback re-attach (server switch, dead source, audio/quality
      // change): carry the current position over so the new stream resumes
      // here instead of restarting from 0. Skipped on the initial load — no
      // source yet (currentTime 0) or an already-pending localStorage resume.
      if (
        this._started &&
        !this._pendingResume &&
        this.video &&
        isFinite(this.video.currentTime) &&
        this.video.currentTime > RESUME_MIN
      ) {
        this.resumePos = this.video.currentTime;
        this._pendingResume = true;
      }

      // seek to the carried position once the (re)attached source reports a
      // real duration — fires once per _attach call
      this.video.addEventListener(
        'loadedmetadata',
        () => {
          if (!this._pendingResume || !this.video.duration) return;
          if (this.resumePos < this.video.duration - RESUME_MIN) {
            this.video.currentTime = this.resumePos;
            this.shell.dispatchEvent(new CustomEvent('progress-resumed', { detail: { pos: this.resumePos } }));
          }
          this._pendingResume = false;
        },
        { once: true }
      );

      if (this.hls) {
        this.hls.destroy();
        this.hls = null;
      }
      if (this.video.src) {
        this.video.removeAttribute('src');
        this.video.load();
      }

      if (src.isM3U8 && window.Hls && Hls.isSupported()) {
        // High-performance HLS config: Worker-offloaded demuxing, start prefetch, and generous back-buffer
        const conn = (typeof navigator !== 'undefined' && navigator.connection) || {};
        // Slow networks / data-saver: start on the lowest rendition for an
        // instant first frame and let ABR climb (default auto-detection often
        // opens mid-ladder and stalls). Never fetch above screen size.
        const slowStart = conn.saveData || /^(slow-2g|2g)$/.test(conn.effectiveType || '');
        this.hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false, // VOD: LL mode only adds playlist churn
          backBufferLength: 90,
          maxBufferLength: 35,
          maxMaxBufferLength: 60,
          maxBufferHole: 0.5,
          startFragPrefetch: true,
          startLevel: slowStart ? 0 : -1,
          capLevelToPlayerSize: true,
          highBufferWatchdogPeriod: 2,
          fragLoadingMaxRetry: 2,
          fragLoadingRetryDelay: 500,
          levelLoadingMaxRetry: 2,
          levelLoadingRetryDelay: 500,
        });
        this.hls.loadSource(url);
        this.hls.attachMedia(this.video);
        this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
          // expose the manifest's quality levels, re-apply the stored choice
          const heights = [...new Set((this.hls.levels || []).map((l) => l.height).filter(Boolean))];
          this._emitQuality(heights);
          if (this.quality !== 'auto') {
            const idx = (this.hls.levels || []).findIndex((l) => String(l.height) === String(this.quality));
            if (idx >= 0) this.hls.currentLevel = idx;
          }
          this.video.play().catch(() => {});
        });
        this.hls.on(Hls.Events.ERROR, (ev, data) => {
          if (attachId !== this._attachId) return; // ignore stale attach errors
          if (data.fatal) {
            this.hls.destroy();
            this.hls = null;
            this._fallbackNext();
          }
        });
      } else {
        this.video.src = url;
        this.video.play().catch(() => {});
        this.video.addEventListener('error', () => {
          if (attachId === this._attachId) this._fallbackNext();
        }, { once: true });
        // no manifest — quality menu comes from the source labels instead
        const qs = [...new Set((this.sources || []).map((source) => source.quality).filter((quality) => quality && quality !== 'auto'))];
        this._emitQuality(qs);
      }

      // subtitles load on demand via loadSubtitle() — no eager fetches
      [...(this.video.textTracks || [])].forEach((track) => (track.mode = 'hidden'));
    }

    _fallbackNext() {
      this.currentIndex += 1;
      if (this.currentIndex < this.sources.length) {
        this.showLoading('Source failed — trying another…');
        this._attach(this.sources[this.currentIndex]);
      } else if (this._manualServer) {
        // Manual pick exhausted its own sources: STAY, don't race away.
        this.showError(`Couldn't play ${PROVIDER_LABELS[this.provider] || this.provider || 'this server'} — pick another server.`);
      } else {
        this._autoAdvance(this.provider);
      }
    }

    // Watch-position persistence (powers resume + the Continue Watching row).
    // Throttled to one write per 5s; entry is removed once the title is over.
    // TV is keyed per SERIES (mediaId) with the latest episodeId inside, so
    // Continue Watching shows ONE card per show that resumes the last-watched
    // episode — not an E1/E2/E3… fan-out. Movies keep mediaId/episodeId keys.
    _saveProgress(ended) {
      if (!this.mediaId || !this._started) return;
      const now = Date.now();
      if (!ended && this._lastSave && now - this._lastSave < 5000) return;
      this._lastSave = now;
      try {
        const map = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
        const isTv = String(this.mediaId).startsWith('tv/');
        const key = isTv ? this.mediaId : `${this.mediaId}/${this.episodeId}`;
        const pos = this.video.currentTime || 0;
        const dur = this.video.duration || 0;
        if (ended || (dur && pos / dur > 0.95)) {
          delete map[key];
          if (isTv) {
            // also drop any legacy per-episode keys for this series
            for (const k of Object.keys(map)) {
              if (k !== key && k.startsWith(`${this.mediaId}/`)) delete map[k];
            }
          }
        } else if (pos > 5) {
          map[key] = { pos, dur, title: this._title, type: this.mediaId.split('/')[0], image: this._image, episodeId: this.episodeId, t: now };
          if (isTv) {
            // collapse legacy per-episode keys so one series == one entry
            for (const k of Object.keys(map)) {
              if (k !== key && k.startsWith(`${this.mediaId}/`)) delete map[k];
            }
          }
        }
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(map));
      } catch (e) {}
    }

    // ---- playback controls (keyboard + toolbar) ----
    togglePlay() {
      if (this.video.paused) this.video.play().catch(() => {});
      else this.video.pause();
    }

    toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else this.shell.requestFullscreen && this.shell.requestFullscreen().catch(() => {});
    }

    togglePip() {
      if (!this.video.requestPictureInPicture) return;
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
      else this.video.requestPictureInPicture().catch(() => {});
    }

    /** Nudge playback speed by `delta` (0.25), clamped to [0.25, 2]. */
    changeSpeed(delta) {
      const rate = Math.round((this.video.playbackRate + delta) * 100) / 100;
      this.video.playbackRate = Math.min(2, Math.max(0.25, rate));
      this.shell.dispatchEvent(new CustomEvent('speed-change', { detail: { rate: this.video.playbackRate } }));
    }

    /** /download URL for the currently attached source ('' if none loaded). */
    downloadUrl() {
      const src = this._currentSource;
      if (!src) return '';
      const params = new URLSearchParams({ url: src.url, title: this._title || 'cinephiles-download' });
      if (src.referer) params.set('ref', src.referer);
      if (src.isM3U8) params.set('hls', '1');
      // chosen quality: download exactly that variant playlist, not the
      // highest the master would give us
      if (src.isM3U8 && this.hls && this.quality !== 'auto') {
        const level = (this.hls.levels || []).find((rendition) => String(rendition.height) === String(this.quality));
        if (level && level.url) {
          try {
            new URL(level.url); // absolute
            params.set('url', level.url);
          } catch {
            /* relative — keep the master */
          }
        }
      }
      // subtitles: the selected track, or ALL available when none is picked
      const subs = this._subtitle ? [this._subtitle] : (this.subtitles || []);
      if (subs.length) params.set('subs', subs.map((track) => `${track.url}|${track.label || track.lang || ''}`).join(','));
      return `/download?${params.toString()}`;
    }

    _emitQuality(levels) {
      this.shell.dispatchEvent(new CustomEvent('quality-ready', { detail: { levels } }));
    }

    /** User picks a quality: 'auto' (ABR) or a height like 1080. Persisted. */
    setQuality(value) {
      this.quality = value;
      localStorage.setItem('cinephile-quality', value);
      if (this.hls) {
        if (value === 'auto') {
          this.hls.currentLevel = -1;
          return;
        }
        const idx = (this.hls.levels || []).findIndex((rendition) => String(rendition.height) === String(value));
        if (idx >= 0) this.hls.currentLevel = idx;
      } else if (this.sources && this.sources.length > 1) {
        // non-HLS: re-attach the source that carries the chosen quality
        const src = this.sources.find((candidate) => String(candidate.quality) === String(value));
        if (src) {
          this.currentIndex = this.sources.indexOf(src);
          this._attach(src);
        }
      }
    }

    /**
     * A server failed — NEVER hang on the error. Re-race the REMAINING servers
     * (failed ones are skipped server-side) so we converge on a working server
     * instead of re-picking the same broken one forever. Bounded by
     * _raceAttempts: if every available provider has been raced and failed,
     * that's a real outage and worth an actual error message.
     */
    _autoAdvance(failedProvider) {
      // Manual picks never auto-advance: the user owns the server choice.
      if (this._manualServer) {
        return this.showError(`Couldn't play ${PROVIDER_LABELS[this.provider] || this.provider || 'this server'} — pick another server.`);
      }
      if (!this._racedProviders) this._racedProviders = new Set();
      if (failedProvider) this._racedProviders.add(failedProvider);
      if (this._raceAttempts >= MAX_RACE_ATTEMPTS) {
        return this._tryTorrentFallback('All servers failed. Try again later.');
      }
      this._raceAttempts += 1;
      const skip = [...this._racedProviders];
      const who = PROVIDER_LABELS[this.provider || this.server] || this.provider || this.server || 'a server';
      this.showLoading(
        skip.length
          ? `${who} failed — trying the next available server…`
          : 'Racing all servers — playing the fastest…'
      );
      this.switchServer(null, skip);
    }

    /** Torrent fallback: only when Auto exhausted every server. Manual
     * picks stay strict (the user owns that choice). Needs the title's IMDb
     * id (passed via load); without it we fall straight to the error. */
    async _tryTorrentFallback(finalError) {
      if (this._torrentTried || this._manualServer || !this._imdbId || typeof Torrent === 'undefined') {
        return this.showError(finalError);
      }
      this._torrentTried = true;
      this.showLoading('All servers are down — asking peers…');
      try {
        try {
          if (!localStorage.getItem('cinephile-vpn-warned')) {
            localStorage.setItem('cinephile-vpn-warned', '1');
            this.shell.dispatchEvent(new CustomEvent('torrent-vpn'));
          }
        } catch {}
        let season = 1;
        let episode = 1;
        if (String(this.mediaId).startsWith('tv/')) {
          const parts = String(this.episodeId || '1-1').split('-');
          season = parts[0] || 1;
          episode = parts[1] || 1;
        }
        const [type] = String(this.mediaId).split('/');
        const found = await Torrent.resolve({ type, imdbId: this._imdbId, season, episode });
        if (!found) return this.showError(finalError);
        await this._loadTorrentLib();
        this.showLoading(`Peer copy found (${found.seeds} seed${found.seeds === 1 ? '' : 's'}) — connecting…`);
        await this._playTorrent(found);
        this.hideLoading();
        this._started = true;
        this.shell.dispatchEvent(
          new CustomEvent('torrent-ready', { detail: { name: found.name, seeds: found.seeds } })
        );
      } catch (e) {
        this.showError(e && e.message ? `Peer fallback failed: ${e.message}` : finalError);
      }
    }

    _loadTorrentLib() {
      if (window.WebTorrent) return Promise.resolve();
      if (!this._torrentLibPromise) {
        this._torrentLibPromise = new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = '/vendor/webtorrent.min.js';
          script.onload = () => resolve();
          script.onerror = () => {
            this._torrentLibPromise = null;
            reject(new Error('peer library failed to load'));
          };
          document.head.appendChild(script);
        });
      }
      return this._torrentLibPromise;
    }

    _destroyTorrent() {
      try {
        if (this._torrentClient) this._torrentClient.destroy();
      } catch {}
      this._torrentClient = null;
      clearTimeout(this._torrentTimer);
    }

    _playTorrent(found) {
      this._destroyTorrent();
      return new Promise((resolve, reject) => {
        let done = false;
        const finish = (error) => {
          if (done) return;
          done = true;
          clearTimeout(this._torrentTimer);
          if (error) {
            this._destroyTorrent();
            reject(error);
          } else resolve();
        };
        this._torrentTimer = setTimeout(() => finish(new Error('no peers answered in 45s — try again later')), 45000);
        try {
          this._torrentClient = new window.WebTorrent();
          this._torrentClient.add(found.magnet, (torrent) => {
            const playable = (torrent.files || [])
              .filter((file) => /\.(mp4|webm|m4v)($|\?)/i.test(file.name || ''))
              .sort((a, b) => (b.length || 0) - (a.length || 0))[0];
            if (!playable) {
              finish(new Error('no playable file in the peer copy'));
              return;
            }
            playable.renderTo(this.video, (renderError) => {
              if (renderError) finish(new Error('peer playback failed to start'));
              else {
                this.video.play().catch(() => {});
                finish(null);
              }
            });
          });
          this._torrentClient.on('error', (torrentError) => finish(torrentError));
        } catch (error) {
          finish(error);
        }
      });
    }

    async switchServer(name, skip = []) {
      this.server = name;
      this._destroyTorrent();
      this._torrentTried = false;
      // A named server is a MANUAL pick (sticky); null/undefined is Auto (race).
      this._manualServer = !!name;
      this.currentIndex = 0;
      this.showLoading(
        name
          ? `Connecting to ${PROVIDER_LABELS[name] || name}…`
          : skip.length
          ? 'Racing remaining servers — playing the fastest…'
          : 'Racing all servers — playing the fastest…'
      );
      try {
        const res = await API.sources(this.mediaId, this.episodeId, name, skip);
        // hls.js loads in parallel with this fetch; attach only when it's ready
        if (this._hlsReady) await this._hlsReady;
        this.sources = res.sources || [];
        this.provider = res.provider; // subtitle list is title-level & already loaded
        this.shell.dispatchEvent(
          new CustomEvent('sources-ready', { detail: { provider: res.provider } })
        );
        this._play();
      } catch (e) {
        // Manual pick that throws: STAY with a clear message. Auto: race on.
        if (this._manualServer) {
          return this.showError(`Couldn't play ${PROVIDER_LABELS[name || this.provider] || name || this.provider || 'this server'} — pick another server.`);
        }
        // never surface the raw error while other servers may exist
        this._autoAdvance(name || this.provider);
      }
    }

    /**
     * Attach a freshly fetched subtitle list (arrives after playback started).
     * Re-emits so the watch view can populate the picker + auto-show English.
     */
    setSubtitles(list) {
      this.subtitles = Array.isArray(list) ? list : [];
      this.shell.dispatchEvent(
        new CustomEvent('subtitles-ready', { detail: { subtitles: this.subtitles } })
      );
    }

    _fetchIntro() {
      const tmdbId = this.mediaId.split('/')[1];
      fetch(`https://api.theintrodb.org/v2/media?tmdb_id=${tmdbId}`)
        .then((response) => (response.ok ? response.json() : Promise.reject()))
        .then((data) => {
          const intro = (data.intro || [])[0];
          if (intro && intro.end_ms) this._intro = intro;
        })
        .catch(() => {});
    }

    /** Load one subtitle track on demand (called when the user picks it). */
    loadSubtitle(url, label) {
      this._subtitle = url ? { url, label: label || '' } : null; // feeds the Download button
      // TextTracks aren't DOM children and can't be removed via removeChild, so
      // clear + hide every existing track (cues) so they never stack with the new one.
      [...(this.video.textTracks || [])].forEach((existing) => {
        existing.mode = 'hidden';
        const cues = existing.cues;
        if (cues) for (let i = cues.length - 1; i >= 0; i--) cues.remove(cues[i]);
      });
      this._subTrack = null;
      this._subBaseCues = null; // new file → fresh raw cues, reset the fps guess
      this._subScale = 1;
      if (!url) {
        [...(this.video.textTracks || [])].forEach((existing) => (existing.mode = 'hidden'));
        return;
      }
      const track = this.video.addTextTrack('subtitles', label || 'Subtitle', 'en');
      this._subTrack = track;
      track.mode = 'hidden';
      track.addEventListener('cuechange', () => {}); // keep track alive for some engines
      // Subs often live on a CDN that wants the stream's Referer (and no CORS),
      // so fetch them through /play like the media — using the CURRENT source's
      // referer, not the default. This is what makes "subtitles are there but
      // won't show" actually display. Gated tracks use a server-minted signed
      // URL (via /sign); direct/local tracks fetch as before.
      const src = this._currentSource || (this.sources && this.sources[0]);
      const ref = src && src.referer;
      const subFetchUrl = (url.startsWith('/') || isDirect(url, null))
        ? Promise.resolve(playableUrl(url, ref, src && src.origin))
        : signedSubUrl(url, ref, src && src.origin).catch(() => playableUrl(url, ref, src && src.origin));
      Promise.resolve(subFetchUrl)
        .then((fetchUrl) => fetch(fetchUrl))
        .then((response) => (response.ok ? response.text() : Promise.reject(new Error('subtitle fetch failed'))))
        .then((text) => {
          const vtt = isSrt(url) ? srtToVtt(text) : text;
          // stash the RAW cue times — offset/scale are applied in _addSubCues
          // so sync tweaks re-render instantly without refetching the file
          this._subBaseCues = parseVtt(vtt).map((parsed) => ({ start: parsed.startTime, end: parsed.endTime, text: parsed.text }));
          this._addSubCues(track);
          this._maybeAutoSync();
          [...(this.video.textTracks || [])].forEach((other) => (other !== track ? (other.mode = 'hidden') : null));
          track.mode = 'showing';
        })
        .catch((error) => {
          console.warn('subtitle:', error.message);
          this._failedSubs.add(url); // never auto-pick this track again
          this.shell.dispatchEvent(new CustomEvent('subtitle-error', { detail: { label: label || '' } }));
        });
    }

    /** Watch-history log (localStorage, capped). Called on first play per load. */
    _logHistory() {
      if (this._historyLogged || !this.mediaId) return;
      this._historyLogged = true;
      try {
        const KEY = 'cinephile-history';
        const MAX = 30;
        const [type] = String(this.mediaId).split('/');
        const entry = {
          id: this.mediaId,
          episodeId: this.episodeId || '1-1',
          title: this._title || 'Untitled',
          image: this._image || '',
          type,
          t: Date.now(),
        };
        let list = [];
        try {
          const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
          if (Array.isArray(raw)) list = raw;
        } catch {}
        list = list.filter((h) => !(h.id === entry.id && (h.episodeId || '1-1') === entry.episodeId));
        list.unshift(entry);
        localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
      } catch {}
    }

    /** Re-render the active track's cues with the current offset + fps scale. */
    _addSubCues(track) {
      if (!track || !this._subBaseCues) return;
      if (track.cues) for (let i = track.cues.length - 1; i >= 0; i--) track.cues[i].remove();
      const offset = this._subOffset || 0;
      const timeScale = this._subScale || 1;
      for (const baseCue of this._subBaseCues) {
        try {
          track.addCue(new VTTCue(Math.max(0, baseCue.start * timeScale + offset), Math.max(0.05, baseCue.end * timeScale + offset), baseCue.text));
        } catch (e) {}
      }
    }

    /**
     * AUTO fps resync (runs once per loaded track). Subs timed for a different
     * framerate drift — e.g. a 23.976fps-timed SRT on a 25fps PAL stream makes
     * the video run 4.17% short, so cues overshoot increasingly. If
     * (last cue end / video duration) matches a known fps ratio within 1.5%,
     * rescale all cue times. Subs that end EARLY are normal (credits), so we
     * only ever act when they overshoot.
     */
    _maybeAutoSync() {
      if (this._subAutoDone || !this._subBaseCues || !this._subBaseCues.length) return;
      const duration = this.video.duration;
      if (!Number.isFinite(duration) || duration < 600) return; // need a real runtime to judge
      const lastCueEnd = this._subBaseCues[this._subBaseCues.length - 1].end;
      if (!(lastCueEnd > duration)) return;
      const ratio = lastCueEnd / duration;
      const KNOWN_RATIOS = [25 / 23.976, 24 / 23.976, 25 / 24, 29.97 / 23.976, 30 / 23.976, 50 / 23.976];
      const hit = KNOWN_RATIOS.find((known) => Math.abs(ratio - known) / known < 0.015);
      if (!hit) return;
      this._subScale = 1 / hit;
      this._subAutoDone = true;
      this._addSubCues(this._subTrack);
    }

    /**
     * Shift subtitle timing by `sec` seconds (+ = subs show later). Re-renders
     * the active track instantly; emits 'subtitle-sync' so the watch view can
     * update the UI and persist per title+episode.
     */
    setSubtitleOffset(sec) {
      this._subOffset = Math.round((Number(sec) || 0) * 20) / 20; // 0.05s resolution
      this._addSubCues(this._subTrack);
      this.shell.dispatchEvent(new CustomEvent('subtitle-sync', { detail: { offset: this._subOffset } }));
    }

    /** True if a subtitle on this server is (or contains) English. */
    _isEnglishSub(track) {
      return /english|\beng\b|\ben\b|\beng subs?\b/i.test(`${track.label || ''} ${track.lang || ''}`);
    }

    /**
     * Smart default subtitle: return the subtitle to auto-show right now.
     *  - no subtitles -> null (Off)
     *  - stored pref 'off' -> null
     *  - stored pref is a label still present -> that one
     *  - otherwise the first English subtitle, else the first one
     */
    autoSubtitle() {
      // skip tracks that already failed to load this session — never re-pick one
      const subs = (this.subtitles || []).filter((track) => !(this._failedSubs && this._failedSubs.has(track.url)));
      if (!subs.length) return null;
      const pref = localStorage.getItem('cinephile-subtitle') || '';
      if (pref === 'off') return null;
      const kept = pref ? subs.find((track) => track.label === pref) : null;
      if (kept) return kept;
      return subs.find((track) => this._isEnglishSub(track)) || subs[0];
    }

    /**
     * Netflix-style pre-end window: reveal "Next episode" shortly before the
     * current one finishes (once per episode).
     */
    _checkUpNext() {
      if (!this.nextEpisodeId || this._upNextShown) return;
      const duration = this.video.duration;
      if (!Number.isFinite(duration) || !duration) return;
      const remaining = duration - this.video.currentTime;
      if (remaining > 0 && remaining <= UP_NEXT_WINDOW_S) {
        this._upNextShown = true;
        this.shell.dispatchEvent(new CustomEvent('up-next'));
      }
    }

    /** Watch view supplies the next episode id (TV only); null hides everything. */
    setNextEpisode(episodeId) {
      this.nextEpisodeId = episodeId || null;
      this._upNextShown = false;
    }

    _checkIntro() {
      if (!this._intro || this._introFired) return;
      const end = (this._intro.end_ms || 0) / 1000;
      if (this.video.currentTime >= Math.max(0, end - 8) && this.video.currentTime < end) {
        this._introFired = true;
        const skipBtn = this.shell.querySelector('.skip-intro');
        skipBtn.classList.add('show');
        skipBtn.onclick = () => {
          this.video.currentTime = end;
          skipBtn.classList.remove('show');
        };
      }
    }

    showLoading(msg) {
      this.shell.querySelector('.player-loading').hidden = false;
      this.shell.querySelector('.player-loading .pl-text').textContent = msg || 'Loading…';
      this.shell.querySelector('.player-error').hidden = true;
    }
    hideLoading() {
      this.shell.querySelector('.player-loading').hidden = true;
    }
    showError(msg) {
      this.hideLoading();
      const errorBox = this.shell.querySelector('.player-error');
      errorBox.hidden = false;
      errorBox.querySelector('.pe-msg').textContent = msg;
    }
  }

  return { MoviePlayer, PROVIDER_LABELS, SERVER_ORDER };
})();
