'use strict';
/*
 * ArtCraft Hub server. Zero npm dependencies.
 *  - serves the dashboard (/), the installed apps (/apps/<id>/) and a small JSON API
 *  - downloads each app's web build from its GitHub releases and keeps it updated
 *  - checks every download before using it, repairs what it can, and falls back to
 *    the newest release that works instead of installing something broken
 *  - never accepts uploads: documents stay in the visitor's browser / on their device
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

// ---------- configuration ----------
const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || '/data';
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const GITHUB_API = (process.env.GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
const GITHUB_RAW = (process.env.GITHUB_RAW || 'https://raw.githubusercontent.com').replace(/\/$/, '');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const UPDATE_HOURS = Number(process.env.UPDATE_INTERVAL_HOURS ?? 6);
const KEEP_VERSIONS = Math.max(1, Number(process.env.KEEP_VERSIONS) || 2);
const MAX_ZIP_BYTES = (Number(process.env.MAX_ZIP_MB) || 400) * 1024 * 1024;
const ISOLATE = process.env.CROSS_ORIGIN_ISOLATION === '1'; // COOP/COEP, only if an app needs threads
const QUIET_APPS = process.env.QUIET_APPS !== '0';          // hide routine log/info/debug chatter from apps
const MAX_TRIES = 4;                                        // releases tried per check before giving up
const DEFAULT_PATTERN = '-web-.*\\.zip$';

const APPS_FILE = path.join(DATA_DIR, 'apps.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const APPS_DIR = path.join(DATA_DIR, 'apps');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const CATS_FILE = path.join(DATA_DIR, 'categories.json');    // group colours chosen in Manage
const SEEN_FILE = path.join(DATA_DIR, 'defaults-seen.json'); // default apps this install has already been offered
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');  // home page footer contact
const LEGACY_DEFAULT_IDS = ['wordcraft', 'gridcraft', 'deckcraft', 'pdfcraft', 'designcraft']; // shipped before defaults sync
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- config + state persistence ----------
let apps = [];
let state = {};
let categories = Object.create(null);
let settings = { contactEnabled: false, contact: '', contactKind: '', contactLabel: '' };

async function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}
const saveApps = () => writeJson(APPS_FILE, apps);
const saveState = () => writeJson(STATE_FILE, state);
const saveCategories = () => writeJson(CATS_FILE, categories);
const saveSettings = () => writeJson(SETTINGS_FILE, settings);

async function loadDefaults() {
  const raw = JSON.parse(await fsp.readFile(path.join(__dirname, 'default-apps.json'), 'utf8'));
  return raw.filter((d) => ID_RE.test(String(d.id || '')) && normaliseRepo(d.repo)).map((d) => ({
    id: d.id, repo: normaliseRepo(d.repo), name: cleanText(d.name, 60) || d.id,
    category: cleanText(d.category, 30) || 'Other', description: cleanText(d.description, 160),
    assetPattern: d.assetPattern ? cleanText(d.assetPattern, 120) : undefined,
  }));
}

async function init() {
  await fsp.mkdir(APPS_DIR, { recursive: true });
  await fsp.rm(TMP_DIR, { recursive: true, force: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  const defaults = await loadDefaults();
  apps = await readJson(APPS_FILE, null);
  if (!apps) { apps = defaults.map((d) => ({ ...d })); await saveApps(); }
  state = await readJson(STATE_FILE, {});
  categories = Object.assign(Object.create(null), await readJson(CATS_FILE, {}));
  settings = { ...settings, ...(await readJson(SETTINGS_FILE, {})) };

  // New apps added to default-apps.json reach existing installs too. An app the owner
  // removed stays removed, because its id is remembered as already offered.
  let seen = await readJson(SEEN_FILE, null);
  if (!Array.isArray(seen)) seen = [...new Set([...apps.map((a) => a.id), ...LEGACY_DEFAULT_IDS])];
  const added = [];
  for (const d of defaults) {
    if (seen.includes(d.id)) continue;
    seen.push(d.id);
    if (!apps.some((a) => a.id === d.id)) { apps.push({ ...d }); added.push(d.name); }
  }
  if (added.length) { await saveApps(); log(`Added new default apps: ${added.join(', ')}`); }
  await writeJson(SEEN_FILE, seen);
}

// ---------- validation ----------
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function normaliseRepo(input) {
  let s = String(input || '').trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '').replace(/\/+$/, '');
  const parts = s.split('/').slice(0, 2);
  s = parts.join('/');
  return REPO_RE.test(s) && parts.every((p) => /[A-Za-z0-9]/.test(p)) ? s : null;
}
function cleanText(v, max) { return String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function normaliseContact(input) {
  const s = cleanText(input, 200);
  if (!s) return { value: '', kind: '' };
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(s)) return { value: s, kind: 'email' };
  let url = s;
  if (!/^https?:\/\//i.test(url) && /^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(url)) url = `https://${url}`;
  try { const u = new URL(url); if (u.protocol === 'https:' || u.protocol === 'http:') return { value: u.href, kind: 'url' }; } catch { /* not a URL */ }
  return null;
}
function safeIconUrl(input) {
  const s = cleanText(input, 300);
  if (!s) return '';
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' || host === 'localhost' || host.endsWith('.local') || /^[\d.]+$/.test(host) || host.includes(':')) return null;
    return u.href;
  } catch { return null; }
}

// ---------- GitHub ----------
class BadRelease extends Error {} // this release can't be used (as opposed to a network hiccup)

function ghHeaders(extra = {}) {
  const h = { 'User-Agent': 'artcraft-hub', Accept: 'application/vnd.github+json', ...extra };
  if (GITHUB_TOKEN) h.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return h;
}
async function ghJson(apiPath) {
  const res = await fetch(`${GITHUB_API}${apiPath}`, { headers: ghHeaders(), signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) { const e = new Error('Not found on GitHub. Check the repository name, and that it is public.'); e.status = 404; throw e; }
  if (res.status === 403 || res.status === 429) throw new Error('GitHub rate limit reached. Set GITHUB_TOKEN to raise the limit, or try again later.');
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}.`);
  return res.json();
}
const mapRelease = (r) => ({ tag: String(r.tag_name), published: r.published_at || r.created_at || null, assets: r.assets || [] });

async function listReleases(repo) {
  const list = await ghJson(`/repos/${repo}/releases?per_page=30`);
  let rels = list.filter((r) => !r.draft && !r.prerelease).map(mapRelease);
  if (!rels.length) rels = list.filter((r) => !r.draft).map(mapRelease); // projects that only publish pre-releases
  if (!rels.length) throw new Error(`${repo} has no published releases yet.`);
  return rels;
}

// Platform and packaging words that mean "not the web build".
const NOT_WEB = /(windows|win32|win64|\bwin\b|macos|darwin|osx|linux|android|\bios\b|freebsd|x86[_-]?64|\bx64\b|amd64|arm64|aarch64|armv7|\.(msi|exe|dmg|deb|rpm|appimage|flatpak|snap|pkg|apk)\b|portable|installer|\bcli\b|sbom|checksums?|sha256|source|\bsrc\b|docs?\b)/i;

function compilePattern(p) {
  try { return p ? new RegExp(p, 'i') : null; }
  catch { throw new Error('The release file pattern is not a valid regular expression.'); }
}
// Finds the web build among a release's files: the owner's pattern, else the usual
// "-web-*.zip" name, else the most web-looking zip that isn't a platform installer.
function pickAsset(assets, custom) {
  if (custom) return assets.find((a) => custom.test(a.name)) || null;
  const usual = new RegExp(DEFAULT_PATTERN, 'i');
  const hit = assets.find((a) => usual.test(a.name));
  if (hit) return hit;
  const zips = assets.filter((a) => /\.zip$/i.test(a.name) && !NOT_WEB.test(a.name));
  if (!zips.length) return null;
  const score = (n) => (/web/i.test(n) ? 5 : 0) + (/wasm/i.test(n) ? 4 : 0) + (/(static|site|dist|browser|html|pages)/i.test(n) ? 2 : 0);
  zips.sort((a, b) => score(b.name) - score(a.name));
  return score(zips[0].name) > 0 || zips.length === 1 ? zips[0] : null;
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': 'artcraft-hub' }, signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_ZIP_BYTES) throw new BadRelease(`The download is ${(len / 1048576) | 0} MB, over the ${MAX_ZIP_BYTES / 1048576} MB limit.`);
  let seen = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => { seen += c.length; if (seen > MAX_ZIP_BYTES) body.destroy(new BadRelease('The download exceeded the size limit.')); });
  await pipeline(body, fs.createWriteStream(dest));
}
const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { maxBuffer: 1 << 20 }, (err, out, errOut) => (err
    ? reject(Object.assign(new Error(`${cmd}: ${errOut || err.message}`), { code: err.code }))
    : resolve(out))));

// ---------- checking a download ----------
async function findSiteRoot(dir, depth = 0) {
  if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  if (depth >= 2) return null;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      const found = await findSiteRoot(path.join(dir, e.name), depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// Zips can contain symlinks. Links that stay inside the site become real copies (some
// packagers use them to share files); anything pointing elsewhere is removed.
async function flattenLinks(root, dir = root) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      const target = path.resolve(path.dirname(p), await fsp.readlink(p));
      await fsp.rm(p, { force: true });
      const inside = target.startsWith(root + path.sep) && !p.startsWith(target + path.sep);
      if (inside && fs.existsSync(target)) await fsp.cp(target, p, { recursive: true, dereference: false }).catch(() => {});
    } else if (e.isDirectory()) await flattenLinks(root, p);
  }
}

async function listFiles(root, dir = root, out = []) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await listFiles(root, p, out);
    else if (e.isFile()) out.push(path.relative(root, p).split(path.sep).join('/'));
  }
  return out;
}

// Static imports break the whole page when the file is missing, so they must resolve.
const IMPORT_RE = /\b(?:import|export)\b\s*(?:[^'"`;()]*?\bfrom\b\s*)?(['"])(\.{1,2}\/[^'"\n]{1,300}?)\1/g;
const SCRIPT_SRC_RE = /<script\b[^>]*?\ssrc\s*=\s*(["'])([^"']+)\1/gi;

async function missingReferences(root) {
  const files = await listFiles(root);
  const missing = new Set();
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  for (const rel of files) {
    if (!/\.m?js$/i.test(rel)) continue;
    const full = path.join(root, rel);
    if ((await fsp.stat(full)).size > 8 * 1024 * 1024) continue;
    const text = await fsp.readFile(full, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[2].split(/[?#]/)[0]));
      if (!target.startsWith('..') && !exists(target)) missing.add(target);
    }
  }
  if (files.includes('index.html')) {
    const html = await fsp.readFile(path.join(root, 'index.html'), 'utf8');
    for (const m of html.matchAll(SCRIPT_SRC_RE)) {
      const src = m[2].split(/[?#]/)[0];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) continue; // external or data: URLs
      const target = path.posix.normalize(src.startsWith('/') ? src.slice(1) : src);
      if (!target.startsWith('..') && !exists(target)) missing.add(target);
    }
  }
  return [...missing];
}

// Some packages put a folder one level off (for example snippets/ at the top instead of
// inside app/). If the missing file exists elsewhere under the same trailing path, copy it.
async function repairAndCheck(root) {
  let missing = await missingReferences(root);
  for (let pass = 0; pass < 3 && missing.length; pass++) {
    const files = await listFiles(root);
    let fixed = 0;
    for (const m of missing) {
      const segs = m.split('/');
      for (let i = 1; i < segs.length - 1; i++) { // keep at least two trailing segments
        const suffix = segs.slice(i).join('/');
        const src = files.find((f) => f !== m && (f === suffix || f.endsWith(`/${suffix}`)));
        if (src) {
          await fsp.mkdir(path.dirname(path.join(root, m)), { recursive: true });
          await fsp.copyFile(path.join(root, src), path.join(root, m));
          fixed++; break;
        }
      }
    }
    if (!fixed) break;
    missing = await missingReferences(root);
  }
  return missing;
}
function describeMissing(missing) {
  const shown = missing.slice(0, 2).join(', ');
  return `It needs ${missing.length === 1 ? 'a file' : `${missing.length} files`} that ${missing.length === 1 ? "isn't" : "aren't"} in the download (${shown}${missing.length > 2 ? ', …' : ''}). That is a problem with how the project packaged this release.`;
}

const COMPRESSIBLE = /\.(html?|js|mjs|css|json|svg|wasm|txt|webmanifest)$/i;
async function precompress(dir) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { await precompress(p); continue; }
    if (!e.isFile() || !COMPRESSIBLE.test(e.name)) continue;
    const { size } = await fsp.stat(p);
    if (size < 1024) continue;
    await pipeline(fs.createReadStream(p), zlib.createGzip({ level: 9 }), fs.createWriteStream(`${p}.gz`));
    await pipeline(fs.createReadStream(p), zlib.createBrotliCompress({
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size },
    }), fs.createWriteStream(`${p}.br`));
  }
}

// ---------- installing one release ----------
async function installRelease(app, rel) {
  const work = path.join(TMP_DIR, `${app.id}-${Date.now()}`);
  try {
    await fsp.mkdir(work, { recursive: true });
    const zipPath = path.join(work, 'asset.zip');
    log(`[${app.id}] downloading ${rel.tag} (${rel.pick.name})`);
    await download(rel.pick.browser_download_url, zipPath);

    const extracted = path.join(work, 'x');
    await fsp.mkdir(extracted);
    try { await run('unzip', ['-q', '-o', zipPath, '-d', extracted]); }
    catch (e) { if (e.code !== 1) throw new BadRelease('The download is not a valid zip file.'); } // exit 1 = warnings only
    await flattenLinks(extracted);
    const siteRoot = await findSiteRoot(extracted);
    if (!siteRoot) throw new BadRelease('The download has no index.html, so it is not a web build.');
    const missing = await repairAndCheck(siteRoot);
    if (missing.length) throw new BadRelease(describeMissing(missing));
    await precompress(siteRoot);

    const safeTag = rel.tag.replace(/[^A-Za-z0-9._-]/g, '_');
    const base = path.join(APPS_DIR, app.id);
    const dest = path.join(base, 'versions', safeTag);
    await fsp.mkdir(path.join(base, 'versions'), { recursive: true });
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.rename(siteRoot, dest).catch(async () => { await fsp.cp(siteRoot, dest, { recursive: true }); });
    const stamp = new Date();
    await fsp.utimes(dest, stamp, stamp); // unzip keeps the zip's old dates; pruning sorts by this

    const current = path.join(base, 'current');
    const link = `${current}.new`;
    await fsp.rm(link, { force: true });
    await fsp.symlink(path.join('versions', safeTag), link);
    await fsp.rename(link, current); // atomic swap

    const versionsDir = path.join(base, 'versions');
    const dirs = await Promise.all((await fsp.readdir(versionsDir)).map(async (n) =>
      ({ n, t: (await fsp.stat(path.join(versionsDir, n))).mtimeMs })));
    dirs.sort((a, b) => b.t - a.t);
    for (const d of dirs.slice(KEEP_VERSIONS)) await fsp.rm(path.join(versionsDir, d.n), { recursive: true, force: true });
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- icons ----------
const ICON_EXT = ['png', 'svg', 'webp', 'jpg', 'ico'];
const findIcon = (id) => ICON_EXT.map((e) => `icon.${e}`).find((f) => fs.existsSync(path.join(APPS_DIR, id, f))) || null;

function sniffImage(buf) {
  if (buf.length > 1_500_000 || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'ico';
  const head = buf.toString('utf8', 0, 400).toLowerCase();
  if (head.includes('<svg') || (head.includes('<?xml') && buf.toString('utf8').toLowerCase().includes('<svg'))) return 'svg';
  return null;
}
async function fetchImage(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'artcraft-hub' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = sniffImage(buf);
    return ext ? { buf, ext } : null;
  } catch { return null; }
}
async function readImage(file) {
  try {
    const buf = await fsp.readFile(file);
    const ext = sniffImage(buf);
    return ext ? { buf, ext } : null;
  } catch { return null; }
}
const attrsOf = (tag) => Object.fromEntries([...tag.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1].toLowerCase(), m[2] ?? m[3]]));
const sizeOf = (s, ext) => (ext === 'svg' || /any/i.test(s || '') ? 1024 : Math.max(0, ...(String(s || '').match(/\d+/g) || [0]).map(Number)));

// The icons the web build itself declares (apple-touch-icon, web manifest, favicon links).
async function siteIcons(siteDir) {
  const out = [];
  const add = async (baseDir, href, sizes, fallbackSize = 0) => {
    if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return;
    const clean = href.split(/[?#]/)[0];
    const file = path.resolve(clean.startsWith('/') ? path.join(siteDir, clean.slice(1)) : path.join(baseDir, clean));
    if (!file.startsWith(path.resolve(siteDir) + path.sep) || !fs.existsSync(file)) return;
    const ext = path.extname(file).slice(1).toLowerCase().replace('jpeg', 'jpg');
    if (!ICON_EXT.includes(ext)) return;
    out.push({ file, ext, size: sizeOf(sizes, ext) || fallbackSize });
  };
  try {
    const html = await fsp.readFile(path.join(siteDir, 'index.html'), 'utf8');
    for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
      const a = attrsOf(tag);
      const rel = (a.rel || '').toLowerCase();
      if (rel.includes('mask-icon')) continue;
      if (rel.includes('apple-touch-icon')) await add(siteDir, a.href, a.sizes, 180);
      else if (rel.includes('icon')) await add(siteDir, a.href, a.sizes, 0);
      else if (rel.includes('manifest') && a.href) {
        const mf = path.resolve(siteDir, a.href.split(/[?#]/)[0].replace(/^\//, ''));
        try {
          const json = JSON.parse(await fsp.readFile(mf, 'utf8'));
          for (const i of json.icons || []) await add(path.dirname(mf), i.src, i.sizes, 0);
        } catch { /* no usable manifest */ }
      }
    }
  } catch { /* no index.html to read */ }
  for (const n of ['favicon.svg', 'favicon.png', 'favicon.ico', 'icon.png', 'logo.png']) await add(siteDir, n, '', 0);
  return out.sort((a, b) => b.size - a.size);
}

function scoreIconPath(p, name) {
  const lower = p.toLowerCase();
  if (!/\.(png|svg|webp|jpe?g|ico)$/.test(lower)) return -1;
  if (/(^|\/)(node_modules|vendor|tests?|fixtures?|screenshots?|docs?|examples?|sponsors?|demo|\.github|target)\//.test(lower)) return -1;
  const base = lower.split('/').pop().replace(/\.[^.]+$/, '');
  let s = 0;
  if (/(icon|logo)/.test(base)) s += 30;
  if (name && base.includes(name)) s += 25;
  if (/(^|\/)(icons?|app-icon|logos?|branding|brand)(\/|$)/.test(lower)) s += 15;
  if (/hicolor/.test(lower)) s += 8;
  const m = lower.match(/(\d{2,4})x\1/);
  if (m) { const n = Number(m[1]); s += n >= 256 ? 20 : n >= 128 ? 10 : n >= 64 ? 2 : -10; }
  if (/scalable/.test(lower) && lower.endsWith('.svg')) s += 12;
  if (/(windows|android|mipmap|appiconset|iconset|\/ios\/|macos)/.test(lower)) s -= 15;
  if (/(mask|monochrome|symbolic|dark|white|small|banner|social|preview|badge|wordmark)/.test(base)) s -= 12;
  s -= lower.split('/').length - 1;
  s += lower.endsWith('.png') ? 3 : lower.endsWith('.svg') ? 2 : 0;
  return s;
}

const rawUrl = (repo, p) => `${GITHUB_RAW}/${repo}/HEAD/${p.split('/').map(encodeURIComponent).join('/')}`;

async function readmeLogo(repo, name) {
  try {
    const res = await fetch(rawUrl(repo, 'README.md'), { headers: { 'User-Agent': 'artcraft-hub' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const text = (await res.text()).slice(0, 60_000);
    const found = [];
    for (const m of text.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
      found.push({ alt: m[1] || (m[0].match(/alt\s*=\s*["']([^"']*)["']/i) || [])[1] || '', src: m[2] || m[3] });
      if (found.length >= 8) break;
    }
    const repoRe = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const f of found) {
      if (/(shields\.io|badge|camo\.githubusercontent|workflows|trendshift|screenshot|demo|\.gif($|\?))/i.test(f.src)) continue;
      if (!/(icon|logo)/i.test(`${f.src} ${f.alt}`) && !f.src.toLowerCase().includes(name)) continue;
      let url = null;
      if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(f.src)) url = rawUrl(repo, f.src.replace(/^\.?\//, '').split(/[?#]/)[0]);
      else if (new RegExp(`^https://github\\.com/${repoRe}/(?:raw|blob)/[^/]+/`, 'i').test(f.src)) {
        url = f.src.replace(/^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:raw|blob)\/(?:refs\/heads\/)?[^/]+\//i, `${GITHUB_RAW}/${repo}/HEAD/`).split('?')[0];
      } else if (new RegExp(`^https://raw\\.githubusercontent\\.com/${repoRe}/`, 'i').test(f.src)) url = f.src.split('?')[0];
      if (url) { const img = await fetchImage(url); if (img) return img; }
    }
  } catch { /* no readme logo */ }
  return null;
}

async function repoTreeIcon(repo, name) {
  try {
    const meta = await ghJson(`/repos/${repo}`);
    const tree = await ghJson(`/repos/${repo}/git/trees/${encodeURIComponent(meta.default_branch || 'HEAD')}?recursive=1`);
    const best = (tree.tree || []).filter((n) => n.type === 'blob')
      .map((n) => ({ p: n.path, s: scoreIconPath(n.path, name) })).filter((n) => n.s >= 40)
      .sort((a, b) => b.s - a.s)[0];
    return best ? await fetchImage(rawUrl(repo, best.p)) : null;
  } catch { return null; }
}

async function discoverIcon(app, siteDir) {
  const name = app.repo.split('/')[1].toLowerCase();
  if (app.iconUrl) { const img = await fetchImage(app.iconUrl); if (img) return { ...img, source: 'custom address' }; }
  const fromSite = await siteIcons(siteDir);
  const big = fromSite.find((i) => i.size >= 128);
  if (big) { const img = await readImage(big.file); if (img) return { ...img, source: 'the app itself' }; }
  for (const p of [
    `assets/icons/app/linux/exports/hicolor/256x256/apps/ai.storyteller.${name}.png`,
    `assets/app-icon/hicolor/256x256/apps/ai.storyteller.${name}.png`,
    `assets/icons/hicolor/256x256/apps/ai.storyteller.${name}.png`,
    'assets/icon.png', 'assets/logo.png', 'icon.png', 'logo.png',
  ]) { const img = await fetchImage(rawUrl(app.repo, p)); if (img) return { ...img, source: p }; }
  const logo = await readmeLogo(app.repo, name);
  if (logo) return { ...logo, source: 'the README' };
  const tree = await repoTreeIcon(app.repo, name);
  if (tree) return { ...tree, source: 'the repository' };
  for (const i of fromSite) { const img = await readImage(i.file); if (img) return { ...img, source: 'the app (small)' }; }
  return null;
}

async function ensureIcon(app, { force = false } = {}) {
  const st = (state[app.id] ||= {});
  if (!force && findIcon(app.id)) return;
  if (!force && st.iconTriedAt && Date.now() - Date.parse(st.iconTriedAt) < 24 * 3_600_000) return;
  st.iconTriedAt = new Date().toISOString();
  try {
    const found = await discoverIcon(app, path.join(APPS_DIR, app.id, 'current'));
    if (!found) { log(`[${app.id}] no icon found, using a lettered tile`); return; }
    for (const e of ICON_EXT) await fsp.rm(path.join(APPS_DIR, app.id, `icon.${e}`), { force: true });
    await fsp.writeFile(path.join(APPS_DIR, app.id, `icon.${found.ext}`), found.buf);
    st.iconAt = Date.now();
    log(`[${app.id}] icon from ${found.source}`);
  } catch (err) { log(`[${app.id}] icon lookup failed: ${err.message}`); }
}

// ---------- checking and updating an app ----------
const installing = new Set();

// opts.installLatest: install the newest working release now, even if auto-update is off.
// opts.reinstall:     the app's settings changed, so install again from scratch.
async function syncApp(app, opts = {}) {
  if (installing.has(app.id)) return 'busy';
  installing.add(app.id);
  const st = (state[app.id] ||= {});
  try {
    await fsp.mkdir(path.join(APPS_DIR, app.id), { recursive: true });
    st.checkedAt = new Date().toISOString();
    const rels = await listReleases(app.repo);
    const custom = compilePattern(app.assetPattern);
    const usable = rels.map((r) => ({ ...r, pick: pickAsset(r.assets, custom) })).filter((r) => r.pick);
    if (!usable.length) {
      const names = rels[0].assets.map((a) => a.name).slice(0, 12).join(', ') || 'none';
      throw new Error(`${rels[0].tag} has no web build I can recognise. Files in that release: ${names}. Edit the app and set a release file pattern that matches its web zip.`);
    }
    st.releases = usable.slice(0, 20).map((r) => ({ tag: r.tag, published: r.published }));
    st.latest = usable[0].tag;

    const current = path.join(APPS_DIR, app.id, 'current');
    const installed = Boolean(st.version) && fs.existsSync(path.join(current, 'index.html'));
    let candidates;
    if (app.pin) {
      let r = usable.find((x) => x.tag === app.pin);
      if (!r) {
        const one = mapRelease(await ghJson(`/repos/${app.repo}/releases/tags/${encodeURIComponent(app.pin)}`));
        r = { ...one, pick: pickAsset(one.assets, custom) };
        if (!r.pick) throw new Error(`The pinned version ${app.pin} has no web build I can recognise.`);
      }
      candidates = [r];
    } else if (!installed || opts.installLatest || opts.reinstall || app.autoUpdate !== false) {
      candidates = usable.filter((r) => opts.reinstall || opts.installLatest || !st.bad?.[r.tag]).slice(0, MAX_TRIES);
    } else candidates = [];

    const failures = [];
    for (const c of candidates) {
      if (!opts.reinstall && installed && st.version === c.tag) { st.error = null; await ensureIcon(app); return 'up-to-date'; }
      try { await installRelease(app, c); }
      catch (err) {
        if (!(err instanceof BadRelease)) throw err;
        (st.bad ||= {})[c.tag] = err.message;
        failures.push(`${c.tag}: ${err.message}`);
        log(`[${app.id}] ${c.tag} skipped: ${err.message}`);
        continue;
      }
      Object.assign(st, { version: c.tag, asset: c.pick.name, installedAt: new Date().toISOString(), error: null });
      if (st.bad) delete st.bad[c.tag];
      log(`[${app.id}] now on ${c.tag}`);
      await ensureIcon(app, { force: Boolean(opts.reinstall) });
      return 'installed';
    }
    const allBad = !installed && usable.length > 0 && usable.every((r) => st.bad?.[r.tag]);
    if (failures.length || allBad) {
      const lines = failures.length ? failures : usable.slice(0, MAX_TRIES).map((r) => `${r.tag}: ${st.bad[r.tag]}`);
      st.error = `No release could be installed. ${lines.join(' ')}`;
      return 'error';
    }
    st.error = null;
    await ensureIcon(app);
    return 'checked';
  } catch (err) {
    st.error = err.message;
    log(`[${app.id}] ${err.message}`);
    return 'error';
  } finally {
    installing.delete(app.id);
    await saveState().catch(() => {});
  }
}

async function checkAll() {
  for (const app of [...apps]) await syncApp(app);
}

// ---------- launch diagnostics ----------
// Files an app asked for that this server doesn't have, so the page can say why it failed.
const missingLog = new Map(); // id -> [{path, at}]
// Only files an app cannot run without count: scripts, WebAssembly and its parts. Apps ask for
// plenty of optional files (extra fonts, manifests, icons, translations) and carry on without them.
const ESSENTIAL_MISSING = /(\.m?js|\.wasm|\.part-[a-z0-9]+|(^|\/)parts\.txt|(^|\/)index\.html)$/i;
const IGNORED_MISSING = /(\.map$|\/sw\.js$|service-?worker|(^|\/)sw\.js$)/i;
function noteMissing(id, rel) {
  if (!ESSENTIAL_MISSING.test(rel) || IGNORED_MISSING.test(rel)) return;
  const list = missingLog.get(id) || [];
  const hit = list.find((m) => m.path === rel);
  if (hit) hit.at = Date.now(); else list.push({ path: rel, at: Date.now() });
  missingLog.set(id, list.slice(-10));
}

// ---------- HTTP helpers ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
  '.bin': 'application/octet-stream', '.zip': 'application/zip', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const HASHED = /[-_.][0-9a-f]{8,}[-_.]/i; // trunk-style content hashes in file names

const DASH_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-src 'self'; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";
const ICON_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"; // an SVG opened directly can't run script

function baseHeaders(kind) {
  const h = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };
  if (kind === 'dash') { h['Content-Security-Policy'] = DASH_CSP; h['X-Frame-Options'] = 'DENY'; }
  if (kind === 'icon') h['Content-Security-Policy'] = ICON_CSP;
  if (ISOLATE) { h['Cross-Origin-Opener-Policy'] = 'same-origin'; h['Cross-Origin-Embedder-Policy'] = 'require-corp'; }
  return h;
}
function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { ...baseHeaders('dash'), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function sendText(res, code, text) {
  res.writeHead(code, { ...baseHeaders('dash'), 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// The app's own page gets two small, optional touches: root-absolute links that point at
// files inside the site are made relative (so sites built for a domain root still load),
// and routine console chatter from the app is hidden.
const QUIET_TAG = '<script src="/_hub/quiet.js"></script>';
function prepareAppHtml(html, root) {
  html = html.replace(/(\s(?:src|href)\s*=\s*)(["'])\/(?!\/)([^"'#?]+)([^"']*)\2/gi, (m, pre, q, p, rest) =>
    (!p.includes('..') && fs.existsSync(path.join(root, p)) ? `${pre}${q}./${p}${rest}${q}` : m));
  if (QUIET_APPS) html = /<head(?:\s[^>]*)?>/i.test(html) ? html.replace(/<head(?:\s[^>]*)?>/i, (m) => m + QUIET_TAG) : QUIET_TAG + html;
  return html;
}

// Serve a file from `root` for URL path `rel`. Returns false if nothing matched.
async function serveFrom(req, res, root, rel, kind) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { sendText(res, 400, 'Bad request'); return true; }
  if (decoded.includes('\0')) { sendText(res, 400, 'Bad request'); return true; }
  const rootResolved = path.resolve(root);
  let file = path.resolve(rootResolved, '.' + path.posix.normalize('/' + decoded));
  if (file !== rootResolved && !file.startsWith(rootResolved + path.sep)) { sendText(res, 403, 'Forbidden'); return true; }
  let st = await fsp.stat(file).catch(() => null);
  if (st && st.isDirectory()) { file = path.join(file, 'index.html'); st = await fsp.stat(file).catch(() => null); }
  if (!st || !st.isFile()) return false;

  const isApp = kind === 'app';
  const ext = path.extname(file).toLowerCase();
  const headers = { ...baseHeaders(kind), 'Content-Type': MIME[ext] || 'application/octet-stream', Vary: 'Accept-Encoding' };
  headers['Cache-Control'] = kind === 'icon' ? 'no-cache' : HASHED.test(path.basename(file)) ? 'public, max-age=31536000, immutable' : 'no-cache';

  if (isApp && file === path.join(rootResolved, 'index.html') && st.size < 2 * 1024 * 1024) {
    const body = Buffer.from(prepareAppHtml(await fsp.readFile(file, 'utf8'), rootResolved));
    const etag = `W/"i-${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
    headers.ETag = etag;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  let serve = file; let sstat = st;
  const accept = String(req.headers['accept-encoding'] || '');
  if (isApp && COMPRESSIBLE.test(file)) {
    for (const [enc, suffix] of [['br', '.br'], ['gzip', '.gz']]) {
      if (!new RegExp(`\\b${enc}\\b`).test(accept)) continue;
      const cs = await fsp.stat(file + suffix).catch(() => null);
      if (cs && cs.isFile()) { serve = file + suffix; sstat = cs; headers['Content-Encoding'] = enc; break; }
    }
  }
  const etag = `W/"${sstat.size.toString(16)}-${Math.floor(sstat.mtimeMs).toString(16)}${headers['Content-Encoding'] ? '-' + headers['Content-Encoding'] : ''}"`;
  headers.ETag = etag;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
  headers['Content-Length'] = sstat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(serve).on('error', () => res.destroy()).pipe(res);
  return true;
}

// ---------- views ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isInstalled = (id) => fs.existsSync(path.join(APPS_DIR, id, 'current', 'index.html'));
const catsView = () => ({ ...categories });
const updateAvailable = (id) => { const s = state[id] || {}; return Boolean(s.latest && s.version && s.latest !== s.version && !s.bad?.[s.latest]); };
const publicView = (a) => {
  const s = state[a.id] || {};
  return {
    id: a.id, name: a.name, category: a.category, description: a.description,
    version: s.version || null, updatedAt: s.installedAt || null,
    icon: Boolean(findIcon(a.id)), iconV: s.iconAt || 0,
    updateAvailable: updateAvailable(a.id), latest: s.latest || null,
  };
};
const adminView = (a) => {
  const s = state[a.id] || {};
  const latestIssue = s.latest && s.latest !== s.version ? s.bad?.[s.latest] || null : null;
  return {
    ...a, ...publicView(a), installed: isInstalled(a.id), installing: installing.has(a.id),
    autoUpdate: a.autoUpdate !== false, pin: a.pin || null,
    checkedAt: s.checkedAt || null, error: s.error || null, asset: s.asset || null,
    releases: s.releases || [], badTags: Object.keys(s.bad || {}),
    warning: latestIssue && s.version ? `Running ${s.version} because the newest release (${s.latest}) can't run here. ${latestIssue}` : null,
  };
};
const contactView = () => (settings.contactEnabled && settings.contact
  ? { value: settings.contact, kind: settings.contactKind, label: settings.contactLabel || '' } : null);

// ---------- admin ----------
async function authorised(req, res) {
  if (!ADMIN_TOKEN) { sendJson(res, 403, { error: 'Admin is disabled. Set the ADMIN_TOKEN environment variable to enable it.' }); return false; }
  const given = Buffer.from((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(ADMIN_TOKEN);
  if (given.length === want.length && crypto.timingSafeEqual(given, want)) return true;
  await sleep(1000); // slows guessing without letting strangers lock the real admin out
  sendJson(res, 401, { error: 'Wrong admin token.' });
  return false;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 16_384) { reject(new Error('Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('Invalid JSON.')); } });
    req.on('error', reject);
  });
}
const BAD_NAMES = ['__proto__', 'constructor', 'prototype'];

async function handleAdmin(req, res, url) {
  if (!(await authorised(req, res))) return;
  const parts = url.pathname.split('/').filter(Boolean); // api admin <what> [id] [action]
  const [, , what, id, action] = parts;
  try {
    if (what === 'apps' && !id && req.method === 'GET') {
      return sendJson(res, 200, { apps: apps.map(adminView), categories: catsView(), settings: { ...settings }, intervalHours: UPDATE_HOURS });
    }

    if (what === 'apps' && !id && req.method === 'POST') {
      const b = await readBody(req);
      const repo = normaliseRepo(b.repo);
      if (!repo) return sendJson(res, 400, { error: 'Enter a GitHub repository like owner/name or a github.com link.' });
      const repoName = repo.split('/')[1].toLowerCase();
      const newId = cleanText(b.id || repoName, 40).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      if (!ID_RE.test(newId)) return sendJson(res, 400, { error: 'The app id may only contain letters, numbers and hyphens.' });
      if (b.assetPattern) { try { new RegExp(String(b.assetPattern)); } catch { return sendJson(res, 400, { error: 'The release file pattern is not a valid regular expression.' }); } }
      const icon = safeIconUrl(b.iconUrl);
      if (icon === null) return sendJson(res, 400, { error: 'The icon address must be a public https:// link.' });
      const existing = apps.find((a) => a.id === newId);
      const next = {
        id: newId, repo,
        name: cleanText(b.name, 60) || repoName,
        category: cleanText(b.category, 30) || 'Other',
        description: cleanText(b.description, 160),
        assetPattern: cleanText(b.assetPattern, 120) || undefined,
        iconUrl: icon || undefined,
        autoUpdate: existing ? existing.autoUpdate : undefined,
        pin: existing ? existing.pin : undefined,
      };
      const before = existing ? { ...existing } : null;
      if (existing) {
        if (existing.repo !== repo) { delete state[newId]; await fsp.rm(path.join(APPS_DIR, newId), { recursive: true, force: true }); }
        else if (existing.assetPattern !== next.assetPattern) delete (state[newId] || {}).bad;
        Object.assign(existing, next);
      } else apps.push(next);
      await saveApps();
      const app = existing || next;
      if (!existing || before.repo !== repo || (before && before.assetPattern !== next.assetPattern) || !isInstalled(newId)) syncApp(app, { reinstall: true });
      else if (before && before.iconUrl !== next.iconUrl) ensureIcon(app, { force: true }).then(() => saveState().catch(() => {}));
      return sendJson(res, 202, { app: adminView(app) });
    }

    if (what === 'apps' && id && !action && req.method === 'DELETE') {
      if (!ID_RE.test(id) || !apps.some((a) => a.id === id)) return sendJson(res, 404, { error: 'No such app.' });
      apps = apps.filter((a) => a.id !== id);
      delete state[id]; missingLog.delete(id);
      await Promise.all([saveApps(), saveState()]);
      await fsp.rm(path.join(APPS_DIR, id), { recursive: true, force: true });
      return sendJson(res, 200, { ok: true });
    }

    if (what === 'apps' && id && action === 'update' && req.method === 'POST') {
      const app = apps.find((a) => a.id === id);
      if (!app) return sendJson(res, 404, { error: 'No such app.' });
      syncApp(app, { installLatest: !app.pin });
      return sendJson(res, 202, { ok: true });
    }

    if (what === 'apps' && id && action === 'settings' && req.method === 'POST') {
      const app = apps.find((a) => a.id === id);
      if (!app) return sendJson(res, 404, { error: 'No such app.' });
      const b = await readBody(req);
      if ('autoUpdate' in b) app.autoUpdate = b.autoUpdate === false ? false : undefined;
      if ('pin' in b) {
        const tag = cleanText(b.pin, 100);
        app.pin = tag || undefined;
      }
      await saveApps();
      syncApp(app, {});
      return sendJson(res, 202, { app: adminView(app) });
    }

    if (what === 'categories' && !id && req.method === 'PUT') {
      const b = await readBody(req);
      const name = cleanText(b.name, 30);
      if (!name || BAD_NAMES.includes(name)) return sendJson(res, 400, { error: 'Enter a group name.' });
      if (b.color) {
        if (!HEX_RE.test(String(b.color))) return sendJson(res, 400, { error: 'The colour must look like #8fa5ff.' });
        categories[name] = String(b.color).toLowerCase();
      } else delete categories[name];
      await saveCategories();
      return sendJson(res, 200, { categories: catsView() });
    }

    if (what === 'categories' && id === 'rename' && req.method === 'POST') {
      const b = await readBody(req);
      const from = cleanText(b.from, 30), to = cleanText(b.to, 30);
      if (!from || !to || BAD_NAMES.includes(to)) return sendJson(res, 400, { error: 'Enter a new group name.' });
      let moved = 0;
      for (const a of apps) if ((a.category || 'Other') === from) { a.category = to; moved++; }
      if (!moved) return sendJson(res, 404, { error: 'No apps are in that group.' });
      if (from !== to && categories[from] && !categories[to]) categories[to] = categories[from];
      if (from !== to) delete categories[from];
      await Promise.all([saveApps(), saveCategories()]);
      return sendJson(res, 200, { categories: catsView(), moved });
    }

    if (what === 'settings' && !id && req.method === 'PUT') {
      const b = await readBody(req);
      const c = normaliseContact(b.contact);
      if (!c) return sendJson(res, 400, { error: 'Enter an email address or a web address, such as you@example.com or https://example.com/contact.' });
      if (b.contactEnabled && !c.value) return sendJson(res, 400, { error: 'Enter the email address or web address to show.' });
      settings = { contactEnabled: Boolean(b.contactEnabled), contact: c.value, contactKind: c.kind, contactLabel: cleanText(b.contactLabel, 80) };
      await saveSettings();
      return sendJson(res, 200, { settings: { ...settings } });
    }

    if (what === 'check' && req.method === 'POST') { checkAll(); return sendJson(res, 202, { ok: true }); }
    return sendJson(res, 404, { error: 'Not found.' });
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
}

// ---------- routing ----------
const server = http.createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD', 'POST', 'DELETE', 'PUT'].includes(req.method)) return sendText(res, 405, 'Method not allowed');
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/healthz') return sendText(res, 200, 'ok');

    if (p.startsWith('/api/admin/')) return handleAdmin(req, res, url);
    if (p === '/api/apps' && req.method === 'GET') {
      return sendJson(res, 200, { apps: apps.filter((a) => isInstalled(a.id)).map(publicView), categories: catsView(), site: { contact: contactView() } });
    }
    const prob = p.match(/^\/api\/apps\/([a-z0-9-]+)\/problems$/);
    if (prob && req.method === 'GET') {
      const now = Date.now();
      const missing = (missingLog.get(prob[1]) || []).filter((m) => now - m.at < 10 * 60_000)
        .map((m) => ({ path: m.path, ageSec: Math.round((now - m.at) / 1000) }));
      return sendJson(res, 200, { missing });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');

    if (p.startsWith('/apps/')) {
      const m = p.match(/^\/apps\/([a-z0-9-]+)(\/.*)?$/);
      if (!m || !ID_RE.test(m[1])) return sendText(res, 404, 'Not found');
      if (!m[2]) { res.writeHead(301, { Location: `${p}/${url.search}` }); return res.end(); }
      if (await serveFrom(req, res, path.join(APPS_DIR, m[1], 'current'), m[2], 'app')) return;
      noteMissing(m[1], m[2].replace(/^\//, ''));
      return sendText(res, 404, 'Not found');
    }

    const icon = p.match(/^\/icons\/([a-z0-9-]+)(?:\.png)?$/);
    if (icon) {
      const f = findIcon(icon[1]);
      if (f && await serveFrom(req, res, path.join(APPS_DIR, icon[1]), `/${f}`, 'icon')) return;
      return sendText(res, 404, 'Not found');
    }

    if (await serveFrom(req, res, PUBLIC_DIR, p === '/' ? '/index.html' : p, 'dash')) return;
    return sendText(res, 404, 'Not found');
  } catch (err) {
    log('request error', err);
    if (!res.headersSent) sendText(res, 500, 'Server error');
    else res.destroy();
  }
});

// ---------- start ----------
init().then(() => {
  if (!ADMIN_TOKEN) log('ADMIN_TOKEN is not set: the Manage panel is disabled.');
  else if (ADMIN_TOKEN.length < 12) log('Warning: ADMIN_TOKEN is short. Use at least 12 random characters.');
  server.listen(PORT, () => log(`ArtCraft Hub listening on :${PORT}, data in ${DATA_DIR}`));
  setTimeout(checkAll, 5_000);
  if (UPDATE_HOURS > 0) setInterval(checkAll, UPDATE_HOURS * 3_600_000).unref();
});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
