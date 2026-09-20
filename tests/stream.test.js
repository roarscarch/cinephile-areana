// Regression tests for the /play proxy's playlist handling — the half of the
// stack that has to survive CDNs lying about their Content-Type.
//
// The bug these lock down: the mendx437sim-backed `multi` provider serves its
// HLS master as `text/html` with RELATIVE variant paths (./360/index.m3u8).
// Trusting the header piped the raw master through, the browser resolved those
// paths against our own origin, 404'd, and the player declared a perfectly
// healthy server dead ("All servers failed") — while clicking the server
// directly still worked.
const test = require('node:test');
const assert = require('node:assert');
const { looksLikePlaylist, rewritePlaylist, PLAYLIST_MAX_BYTES } = require('../src/routes/stream');

const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x268',
  './360/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x804',
  './1080/index.m3u8',
  '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=60871,URI="iframes-v1-a1.txt"',
  '',
].join('\n');

const REF = 'https://laika422mon.com//play/tt1756855';

test('looksLikePlaylist: detects an HLS master served as text/html', () => {
  assert.strictEqual(looksLikePlaylist(Buffer.from(MASTER)), true);
});

test('looksLikePlaylist: tolerates a UTF-8 BOM and leading whitespace', () => {
  assert.strictEqual(looksLikePlaylist(Buffer.from('\uFEFF\n  #EXTM3U\n')), true);
});

test('looksLikePlaylist: rejects binary bodies (no false positives)', () => {
  const mp4Head = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  assert.strictEqual(looksLikePlaylist(mp4Head), false);
  assert.strictEqual(looksLikePlaylist(Buffer.from('<html><body>404 Not Found')), false);
  assert.strictEqual(looksLikePlaylist(Buffer.alloc(0)), false);
});

test('rewritePlaylist: relative variant lines become absolute /play URLs', () => {
  const out = rewritePlaylist(MASTER, 'https://i-cdn-0.example/stream2/x/TOKEN', REF);
  const lines = out.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.strictEqual(lines.length, 2);
  for (const l of lines) assert.match(l, /^\/play\?/);
  // resolved against the playlist URL, not our own origin
  const first = new URL(lines[0], 'http://localhost');
  assert.strictEqual(first.searchParams.get('url'), 'https://i-cdn-0.example/stream2/x/360/index.m3u8');
  // the source's own referer must survive downstream — peachify.top would 403
  assert.strictEqual(first.searchParams.get('ref'), REF);
});

test('rewritePlaylist: URI="…" attributes on ANY tag are rewritten (I-frame too)', () => {
  const out = rewritePlaylist(MASTER, 'https://i-cdn-0.example/stream2/x/TOKEN', REF);
  const uri = out.match(/URI="([^"]+)"/);
  assert.ok(uri, 'I-frame URI attribute present');
  const u = new URL(uri[1], 'http://localhost');
  assert.strictEqual(u.pathname, '/play');
  assert.strictEqual(u.searchParams.get('url'), 'https://i-cdn-0.example/stream2/x/iframes-v1-a1.txt');
});

test('rewritePlaylist: origin is propagated when the CDN gates on it', () => {
  const out = rewritePlaylist(MASTER, 'https://i-cdn-0.example/stream2/x/TOKEN', REF, 'https://laika422mon.com');
  const u = new URL(out.split('\n').find((l) => l && !l.startsWith('#')), 'http://localhost');
  assert.strictEqual(u.searchParams.get('origin'), 'https://laika422mon.com');
});

test('rewritePlaylist: leaves non-URI # tags and absolute URLs intact', () => {
  const abs = '#EXTM3U\n#EXT-X-VERSION:3\nhttps://cdn.example/hls/v1/index.m3u8\n';
  const out = rewritePlaylist(abs, 'https://cdn.example/hls/master.m3u8', REF);
  assert.match(out, /#EXT-X-VERSION:3/);
  const line = out.split('\n').filter((l) => l && !l.startsWith('#'))[0];
  const u = new URL(line, 'http://localhost');
  assert.strictEqual(u.pathname, '/play');
  assert.strictEqual(u.searchParams.get('url'), 'https://cdn.example/hls/v1/index.m3u8');
});

test('playlist cap is generous enough for real masters but bounded', () => {
  assert.ok(PLAYLIST_MAX_BYTES >= 1024 * 1024, 'masters with many variants must fit');
  assert.ok(PLAYLIST_MAX_BYTES <= 16 * 1024 * 1024, 'must not buffer arbitrary binaries');
});
