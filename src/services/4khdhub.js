// src/services/4khdhub.js — 4KHDHub download provider (Node only).
//
// 4KHDHub has no streaming API: it is a download site whose files are HEVC/
// x265 MKV (often full BluRay REMUX), so browsers cannot play them — but they
// are perfect for the /download route, which streams bytes to disk and lets
// the user watch in VLC/mpv. This module resolves the same chain the
// Stremio-style scrapers use:
//
//   search -> details page -> greenmotors.club/?id=.. (302)
//   -> obfuscated s('o','<b64>') blob (b64 -> b64 -> rot13 -> b64 -> JSON)
//   -> hubcloud.pw/drive/{id} -> gamerxyt.com/hubcloud.php?.. -> direct file
//
// NOT edge compatible (multi-hop scraping) — intentionally Node/Vercel only.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const FALLBACK_BASE = 'https://4khdhub.one';
const CACHE_MS = 10 * 60 * 1000;
const MAX_ITEMS = 6;

let domainCache = { exp: 0, base: FALLBACK_BASE };
const resultCache = new Map(); // key -> { exp, items }

function b64decode(str) {
  return Buffer.from(String(str || ''), 'base64').toString('utf8');
}

function rot13(str) {
  return String(str || '').replace(/[A-Za-z]/g, (char) => {
    const base = char <= 'Z' ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function decodeRedirectBlob(blob) {
  let json;
  try {
    json = JSON.parse(b64decode(rot13(b64decode(b64decode(blob)))));
  } catch {
    return '';
  }
  if (json && json.o) {
    const url = b64decode(json.o).trim();
    if (/^https?:\/\//i.test(url)) return url;
  }
  if (json && json.data && json.blog_url) {
    return `${json.blog_url}?re=${json.data}`;
  }
  return '';
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&#x0*27;/gi, "'");
}

function textOf(match) {
  const raw = Array.isArray(match) ? match[1] : match;
  return decodeEntities(String(raw || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

async function httpGet(url, { referer, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,*/*',
        ...(referer ? { Referer: referer } : {}),
      },
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text, url: res.url };
  } finally {
    clearTimeout(timer);
  }
}

async function currentBase() {
  if (Date.now() < domainCache.exp) return domainCache.base;
  try {
    const res = await httpGet(DOMAINS_URL, { timeoutMs: 8000 });
    const domains = JSON.parse(res.text);
    const base = String(domains['4khdhub'] || '').replace(/\/$/, '');
    domainCache = { exp: Date.now() + 60 * 60 * 1000, base: /^https?:\/\//.test(base) ? base : FALLBACK_BASE };
  } catch {
    domainCache = { exp: Date.now() + CACHE_MS, base: FALLBACK_BASE };
  }
  return domainCache.base;
}

function parseSearch(html) {
  const results = [];
  const cardRe = /<a href="([^"]+)" class="movie-card"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = cardRe.exec(html || ''))) {
    const body = match[2];
    const title = textOf(body.match(/class="movie-card-title"[^>]*>([\s\S]*?)<\/h3>/));
    const year = textOf(body.match(/class="movie-card-meta"[^>]*>\s*(\d{4})/));
    if (title) results.push({ title, year: year ? parseInt(year, 10) : null, href: match[1] });
  }
  return results;
}

function normTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function pickBest(results, title, year) {
  const want = normTitle(title);
  if (!want) return null;
  let best = null;
  for (const row of results) {
    const got = normTitle(row.title);
    let score = 0;
    if (got === want) score += 4;
    else if (got.startsWith(want) || want.startsWith(got)) score += 2;
    else if (got.includes(want) || want.includes(got)) score += 1;
    else continue;
    if (year && row.year) score += row.year === year ? 3 : Math.abs(row.year - year) <= 1 ? 1 : -1;
    if (!best || score > best.score) best = { ...row, score };
  }
  return best && best.score > 0 ? best : null;
}

function parseDetail(html) {
  const items = [];
  const blocks = String(html || '').split(/<div class="(?:download-item|episode-download-item)\b/).slice(1);
  for (const block of blocks) {
    const filename = textOf(block.match(/class="(?:file-title|episode-file-title)"[^>]*>([\s\S]*?)<\/div>/));
    const header = textOf(block.match(/class="[^"]*font-semibold"[^>]*>([\s\S]*?)<br/));
    const size =
      textOf(block.match(/class="badge-size"[^>]*>([^<]+)</)) ||
      textOf(block.match(/class="badge"[^>]*>\s*(\d+(?:\.\d+)?\s*(?:GB|MB|TB))\s*</i));
    const psa = textOf(block.match(/class="badge-psa"[^>]*>([^<]+)</));
    const links = [];
    const linkRe = /<a[^>]+href="(https?:\/\/greenmotors\.[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    while ((match = linkRe.exec(block))) {
      const hoster = textOf([null, match[2]]).replace(/^Download\s*/i, '');
      if (hoster) links.push({ hoster, url: decodeEntities(match[1]) });
    }
    if (!links.length) continue;
    items.push({ filename: filename || header, header, size, psa, links });
  }
  return items;
}

function seasonEpisodeOf(item) {
  const text = `${item.filename} ${item.header} ${item.psa}`;
  const se = text.match(/(?:^|[^A-Za-z0-9])S(\d{1,2})E(\d{1,2})(?:[^0-9]|$)/i);
  if (se) return { season: parseInt(se[1], 10), episode: parseInt(se[2], 10) };
  return null;
}

function qualityOf(item) {
  const text = `${item.filename} ${item.header}`;
  const res = text.match(/(\d{3,4})p/i);
  if (res) return `${res[1]}p`;
  if (/remux/i.test(text)) return 'REMUX';
  return 'HD';
}

function extOf(filename) {
  const res = String(filename || '').match(/\.(mkv|mp4|avi|webm|mov|m4v)\b/i);
  return res ? res[1].toLowerCase() : 'mkv';
}

async function resolveLink(link) {
  if (!/hubcloud|hubdrive/i.test(link.hoster)) return [];
  const redirect = await httpGet(link.url, { referer: 'https://4khdhub.one/' });
  const blob = (redirect.text.match(/s\('o','([^']+)'/) || [])[1];
  if (!blob) return [];
  const driveUrl = decodeRedirectBlob(blob);
  if (!/^https?:\/\//i.test(driveUrl)) return [];

  const drive = await httpGet(driveUrl, { referer: 'https://greenmotors.cc/' });
  const generator = decodeEntities((drive.text.match(/https:\/\/gamerxyt\.com\/hubcloud\.php\?[^"' ]+/) || [])[0]);
  if (!generator) return [];

  const page = await httpGet(generator, { referer: driveUrl });
  const filename = textOf(page.text.match(/<title>([\s\S]*?)<\/title>/));
  const urls = Array.from(page.text.matchAll(/href="([^"]+)"/g), (m) => decodeEntities(m[1]));
  const out = [];
  for (const raw of urls) {
    if (!/^https?:\/\//i.test(raw)) continue;
    if (/hubcloud\.(?:pw|cx|fans|cloud)\//i.test(raw) || /gamerxyt\.com/i.test(raw)) continue;
    const pixeldrain = raw.match(/^https?:\/\/pixeldrain\.com\/u\/([\w-]+)/i);
    if (pixeldrain) {
      out.push({
        hoster: 'Pixeldrain',
        url: `https://pixeldrain.com/api/file/${pixeldrain[1]}?download`,
        referer: 'https://pixeldrain.com/',
        filename,
      });
      continue;
    }
    if (/cloudflarestorage\.com|r2\.dev|\.mkv(?:\?|$)|\.mp4(?:\?|$)|download/i.test(raw)) {
      out.push({ hoster: 'HubCloud', url: raw, referer: 'https://hubcloud.pw/', filename });
    }
  }
  return out;
}

async function listDownloads({ type, title, year, season, episode }) {
  if (!title) return [];
  const key = `${type}|${normTitle(title)}|${year || ''}|${season || ''}|${episode || ''}`;
  const cached = resultCache.get(key);
  if (cached && cached.exp > Date.now()) return cached.items;

  const base = await currentBase();
  const search = await httpGet(`${base}/?s=${encodeURIComponent(title)}`, { referer: base });
  const match = pickBest(parseSearch(search.text), title, year);
  if (!match) return [];

  const detailUrl = new URL(match.href, base).href;
  const detail = await httpGet(detailUrl, { referer: base });
  let items = parseDetail(detail.text);

  if (type === 'tv') {
    if (!season || !episode) return [];
    items = items.filter((item) => {
      const se = seasonEpisodeOf(item);
      return se && se.season === Number(season) && se.episode === Number(episode);
    });
  }

  const picked = items.slice(0, MAX_ITEMS);
  const settled = await Promise.allSettled(picked.map((item) => resolveLink(item.links[0])));
  const seen = new Set();
  const results = [];
  picked.forEach((item, index) => {
    const resolved = settled[index].status === 'fulfilled' ? settled[index].value : [];
    for (const file of resolved) {
      if (seen.has(file.url)) continue;
      seen.add(file.url);
      results.push({
        quality: qualityOf(item),
        size: item.size || '',
        filename: file.filename || item.filename,
        hoster: file.hoster,
        url: file.url,
        referer: file.referer,
        ext: extOf(file.filename || item.filename),
      });
    }
  });

  resultCache.set(key, { exp: Date.now() + CACHE_MS, items: results });
  if (resultCache.size > 100) resultCache.clear();
  return results;
}

module.exports = {
  listDownloads,
  // exposed for tests
  decodeRedirectBlob,
  parseSearch,
  parseDetail,
  pickBest,
  seasonEpisodeOf,
  qualityOf,
};
