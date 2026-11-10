// src/routes/download.js — /download endpoint
//
// Saves the current stream to disk:
//  - direct sources, no subs: streamed through (constant memory, no ffmpeg)
//  - anything with subs= (or hls=1): remuxed by ffmpeg into a playable .mp4 —
//    video copied (never re-encoded), audio re-encoded to AAC for HLS (copied
//    for direct sources), subtitle tracks converted to mp4 text (mov_text),
//    fragmented moov so a partial file is still playable.
// `subs` = "url|label" pairs, comma-separated. If a subtitle input fails,
// the download retries once without subs rather than dying.
const { Router } = require('express');
const path = require('path');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const { STREAM_UA } = require('./stream');
const { listDownloads } = require('../services/4khdhub');

module.exports = function downloadRoutes(tmdb) {
  const router = Router();

  // 4KHDHub download files (2160p/1080p MKV — for saving, not playback).
  // Node/Vercel only: the resolver needs multi-hop scraping (see service).
  router.get('/downloads', async (req, res) => {
    const mediaId = String(req.query.mediaId || '');
    if (!/^(movie|tv)\/[\w-]+$/.test(mediaId)) {
      return res.status(400).json({ error: 'mediaId query parameter must be movie/<id> or tv/<id>' });
    }
    const [type] = mediaId.split('/');
    const season = parseInt(req.query.season, 10) || null;
    const episode = parseInt(req.query.episode, 10) || null;
    try {
      let title = String(req.query.title || '');
      let year = parseInt(req.query.year, 10) || null;
      if ((!title || !year) && tmdb) {
        try {
          const info = await tmdb.fetchMediaInfo(mediaId);
          if (info) {
            title = title || info.title || '';
            year = year || parseInt(String(info.releaseDate || '').slice(0, 4), 10) || null;
          }
        } catch (e) {}
      }
      if (!title) return res.status(404).json({ error: 'Title unavailable for this mediaId' });
      const items = await listDownloads({ type, title, year, season, episode });
      res.set('Cache-Control', 'no-store');
      res.json({ items });
    } catch (error) {
      res.status(502).json({ error: `4KHDHub lookup failed: ${error.message}` });
    }
  });

  router.get('/download', (req, res) => {
    const { url, ref, title, hls, subs, ext } = req.query;
    if (!url) return res.status(400).json({ error: 'url query parameter is required' });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Invalid url' });
    const referer = ref || 'https://peachify.top/';
    const base = String(title || 'cinephiles-download')
      .replace(/[^\w\- ]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'cinephiles-download';
    const tracks = String(subs || '')
      .split(',')
      .map((pair, index) => {
        const [trackUrl, ...rest] = pair.split('|');
        if (!trackUrl || !/^https?:\/\//i.test(trackUrl)) return null;
        return { url: trackUrl, label: rest.join('|').slice(0, 60) || `Subtitle ${index + 1}` };
      })
      .filter(Boolean)
      .slice(0, 12); // cap the track count — no point muxing 50 languages
    const remux = hls === '1' || tracks.length > 0;
    const safeExt = /^(mkv|mp4|avi|webm|mov|m4v)$/i.test(String(ext || '')) ? String(ext).toLowerCase() : null;

    res.set({
      'Content-Disposition': `attachment; filename="${base}.${remux ? 'mp4' : (safeExt || path.extname(new URL(url).pathname).replace(/[^a-z0-9]/gi, '') || 'mp4')}"`,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });

    if (!remux) {
      // direct source, no subs: stream through like /play, flagged as a download.
      // Range is forwarded so big files (4KHDHub REMUXes) resume instead of restarting.
      const upstreamHeaders = { Referer: referer, 'User-Agent': STREAM_UA };
      if (req.headers.range) upstreamHeaders.Range = req.headers.range;
      fetch(url, { headers: upstreamHeaders })
        .then((upstream) => {
          if (!upstream.ok && upstream.status !== 206) return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });
          if (upstream.status === 206) res.status(206);
          res.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
          res.set('Accept-Ranges', 'bytes');
          for (const header of ['content-length', 'content-range']) {
            const value = upstream.headers.get(header);
            if (value) res.set(header, value);
          }
          return new Promise((resolve, reject) => {
            const body = Readable.fromWeb(upstream.body);
            body.on('error', (streamError) => {
              res.destroy();
              reject(streamError);
            });
            res.on('close', resolve);
            body.pipe(res);
          });
        })
        .catch((e) => {
          if (!res.headersSent) res.status(502).json({ error: `Proxy error: ${e.message}` });
        });
      return;
    }

    res.set('Content-Type', 'video/mp4');
    const headers = `Referer: ${referer}\r\nUser-Agent: ${STREAM_UA}\r\n`;
    const buildArgs = (includeSubs) => {
      const args = ['-hide_banner', '-loglevel', 'error', '-headers', headers, '-i', url];
      if (includeSubs) for (const track of tracks) args.push('-i', track.url);
      args.push('-map', '0:v:0', '-map', '0:a?');
      if (includeSubs) tracks.forEach((_, index) => args.push('-map', `${index + 1}:0`));
      args.push('-c:v', 'copy', '-c:a', hls === '1' ? 'aac' : 'copy');
      if (includeSubs) {
        args.push('-c:s', 'mov_text');
        tracks.forEach((track, index) => args.push(`-metadata:s:s:${index}`, `title=${track.label}`));
      }
      args.push('-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1');
      return args;
    };

    let stderr = '';
    let aborted = false;
    let ffmpegProc = null;

    const start = (includeSubs) => {
      ffmpegProc = spawn('ffmpeg', buildArgs(includeSubs), { stdio: ['ignore', 'pipe', 'pipe'] });
      stderr = '';
      ffmpegProc.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2048)));
      ffmpegProc.stdout.on('error', () => {});
      ffmpegProc.on('error', (spawnError) => {
        // ENOENT = ffmpeg not installed
        if (res.headersSent) return;
        res.status(spawnError.code === 'ENOENT' ? 503 : 502).json({
          error:
            spawnError.code === 'ENOENT'
              ? 'ffmpeg is not installed on this server — downloads with subtitles need it (sudo apt install ffmpeg)'
              : `ffmpeg failed to start: ${spawnError.message}`,
        });
      });
      ffmpegProc.on('close', (code) => {
        if (aborted) return;
        if (res.headersSent) return res.end();
        // failed before producing output: if subtitle inputs were involved,
        // one of them is probably dead — retry once without them
        if (includeSubs) return start(false);
        res.status(502).json({ error: `ffmpeg exited before producing output (code ${code}): ${stderr.slice(-400)}` });
      });
      ffmpegProc.stdout.pipe(res);
    };

    res.on('close', () => {
      aborted = true;
      if (ffmpegProc && !ffmpegProc.killed) ffmpegProc.kill();
    });
    start(tracks.length > 0);
  });

  return router;
};
