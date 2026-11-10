// tests/4khdhub.test.js — decode chain + detail-page parsing (no network).
const test = require('node:test');
const assert = require('node:assert');
const {
  decodeRedirectBlob,
  parseSearch,
  parseDetail,
  pickBest,
  seasonEpisodeOf,
  qualityOf,
} = require('../src/services/4khdhub');

// Real blob from greenmotors.cc redirect page (Fight Club details page).
const BLOB =
  "Y214WE0xWjNZbXRhVUdwMmIxQldObFo2ZFRCeFZVOXRRbmxxYVV0UU9XRndla2w1YjNveGFYRlVPV3h3YkRWM1RERnFhVzVVT1dkTlNtdDFiM3BGZVhCNWFtbFdkbXAyYjJ4V05sWjZVMVpJZDA5M1JsSXdNa2RWZURWdk1rVkxSbnBqZGtWdGVHdEtlRm94Y1RKRk5VSktaM2R2U21wc1NubGFOWEI1ZVdkeFZVbDRTVzFFYTAxVGRWaHhWRnBzUlhwMWRtOUtXamxXWVRBOQ==";

test('decodeRedirectBlob unwraps the b64/rot13 chain', () => {
  assert.strictEqual(decodeRedirectBlob(BLOB), 'https://hubcloud.pw/drive/kbknun5urmsaang');
});

test('decodeRedirectBlob rejects garbage', () => {
  assert.strictEqual(decodeRedirectBlob('not-a-blob'), '');
});

test('parseSearch extracts title/year/href from cards', () => {
  const html = `
    <a href="/fight-club-movie-540/" class="movie-card" aria-label="Fight Club details">
      <div class="movie-card-content">
        <h3 class="movie-card-title">Fight Club</h3>
        <p class="movie-card-meta">1999 </p>
      </div>
    </a>`;
  const results = parseSearch(html);
  assert.deepStrictEqual(results, [{ title: 'Fight Club', year: 1999, href: '/fight-club-movie-540/' }]);
});

test('pickBest prefers exact title + matching year', () => {
  const results = [
    { title: 'Fight Club', year: 1999, href: '/a/' },
    { title: 'Fight Club 2', year: 2020, href: '/b/' },
    { title: 'Fight', year: 1999, href: '/c/' },
  ];
  assert.strictEqual(pickBest(results, 'Fight Club', 1999).href, '/a/');
  assert.strictEqual(pickBest(results, 'Nothing Here', 1999), null);
});

test('parseDetail reads episode blocks (filename, size, hoster links)', () => {
  const html = `
    <div class="episode-download-item">
      <div class="episode-file-title"> Breaking Bad S05E01 (2012) 1080p BluRay HEVC x265.mkv </div>
      <div class="episode-file-info" data-has-pack="true">
        <span class="badge-psa">Episode-01</span>
        <span class="badge-size">1.65 GB</span>
      </div>
      <div class="episode-links">
        <a href="https://greenmotors.club/?id=abc">Download HubCloud&nbsp;</a>
        <a href="https://greenmotors.club/?id=def">Download HubDrive&nbsp;</a>
      </div>
    </div>`;
  const items = parseDetail(html);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].size, '1.65 GB');
  assert.strictEqual(items[0].links.length, 2);
  assert.strictEqual(items[0].links[0].hoster, 'HubCloud');
  assert.deepStrictEqual(seasonEpisodeOf(items[0]), { season: 5, episode: 1 });
  assert.strictEqual(qualityOf(items[0]), '1080p');
});

test('parseDetail reads movie blocks (file-title + size badge)', () => {
  const html = `
    <div class="download-item border rounded-lg">
      <div class="download-header px-4 py-3" data-file-id="file1">
        <div class="flex-1 text-left font-semibold"> Fight Club (2160p BluRay REMUX HDR H265) <br>
          <code><span class="badge">66.39 GB</span></code>
        </div>
      </div>
      <div id="content-file1">
        <div class="file-title">Fight Club (1999) 2160p BluRay REMUX HEVC.mkv</div>
        <div class="grid"><a href="https://greenmotors.club/?id=xyz">Download HubCloud&nbsp;</a></div>
      </div>
    </div>`;
  const items = parseDetail(html);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].size, '66.39 GB');
  assert.strictEqual(qualityOf(items[0]), '2160p');
  assert.strictEqual(seasonEpisodeOf(items[0]), null);
});
