'use strict';
/*
 * ArtCraft Hub server. Zero npm dependencies.
 *  - serves the dashboard (/), the installed apps (/apps/<id>/) and a small JSON API
 *  - downloads each app's latest "<app>-web-<ver>.zip" GitHub release and keeps it updated
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
const DEFAULT_PATTERN = '-web-.*\\.zip$';

const APPS_FILE = path.join(DATA_DIR, 'apps.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const APPS_DIR = path.join(DATA_DIR, 'apps');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const CATS_FILE = path.join(DATA_DIR, 'categories.json');   // group colours chosen in Manage
const SEEN_FILE = path.join(DATA_DIR, 'defaults-seen.json'); // default apps this install has already been offered
const LEGACY_DEFAULT_IDS = ['wordcraft', 'gridcraft', 'deckcraft', 'pdfcraft', 'designcraft']; // shipped before defaults sync existed
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- config + state persistence ----------
let apps = [];
let state = {};
let categories = Object.create(null);

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

// ---------- GitHub ----------
function ghHeaders(extra = {}) {
  const h = { 'User-Agent': 'artcraft-hub', Accept: 'application/vnd.github+json', ...extra };
  if (GITHUB_TOKEN) h.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return h;
}
async function latestRelease(repo) {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/releases/latest`, {
    headers: ghHeaders(), signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) throw new Error(`No published release found for ${repo}.`);
  if (res.status === 403 || res.status === 429) {
    throw new Error('GitHub rate limit reached. Set GITHUB_TOKEN to raise the limit, or try again later.');
  }
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status} for ${repo}.`);
  return res.json();
}
async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': 'artcraft-hub' }, signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_ZIP_BYTES) throw new Error(`Release asset is ${(len / 1048576) | 0} MB, over the ${MAX_ZIP_BYTES / 1048576} MB limit.`);
  let seen = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => { seen += c.length; if (seen > MAX_ZIP_BYTES) body.destroy(new Error('Download exceeded the size limit.')); });
  await pipeline(body, fs.createWriteStream(dest));
}
const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { maxBuffer: 1 << 20 }, (err, out, errOut) => (err ? reject(new Error(`${cmd}: ${errOut || err.message}`)) : resolve(out))));

// ---------- install / update ----------
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

async function fetchIcon(app) {
  const iconPath = path.join(APPS_DIR, app.id, 'icon.png');
  if (fs.existsSync(iconPath)) return;
  const name = app.repo.split('/')[1];
  const url = `${GITHUB_RAW}/${app.repo}/HEAD/assets/app-icon/hicolor/256x256/apps/ai.storyteller.${name}.png`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.startsWith('image/')) return;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1_000_000) await fsp.writeFile(iconPath, buf);
  } catch { /* the dashboard falls back to a lettered tile */ }
}

const installing = new Set();

async function installApp(app, { force = false } = {}) {
  if (installing.has(app.id)) return 'busy';
  installing.add(app.id);
  const st = (state[app.id] ||= {});
  const work = path.join(TMP_DIR, `${app.id}-${Date.now()}`);
  try {
    await fsp.mkdir(path.join(APPS_DIR, app.id, 'versions'), { recursive: true });
    const current = path.join(APPS_DIR, app.id, 'current');
    const rel = await latestRelease(app.repo);
    const tag = String(rel.tag_name || 'unknown');
    st.checkedAt = new Date().toISOString();

    if (!force && st.version === tag && fs.existsSync(current)) { st.error = null; return 'up-to-date'; }

    let re;
    try { re = new RegExp(app.assetPattern || DEFAULT_PATTERN, 'i'); }
    catch { throw new Error('The asset pattern is not a valid regular expression.'); }
    const assets = rel.assets || [];
    const asset = assets.find((a) => re.test(a.name));
    if (!asset) {
      const names = assets.map((a) => a.name).slice(0, 12).join(', ') || 'none';
      throw new Error(`${tag} has no asset matching /${re.source}/. Assets found: ${names}. Edit the app and set a pattern that matches its web zip.`);
    }

    log(`[${app.id}] installing ${tag} (${asset.name})`);
    await fsp.mkdir(work, { recursive: true });
    const zipPath = path.join(work, 'asset.zip');
    await download(asset.browser_download_url, zipPath);

    const extracted = path.join(work, 'x');
    await fsp.mkdir(extracted);
    await run('unzip', ['-q', '-o', zipPath, '-d', extracted]);
    await run('find', [extracted, '-type', 'l', '-delete']); // never trust symlinks from a zip
    const siteRoot = await findSiteRoot(extracted);
    if (!siteRoot) throw new Error('The zip does not contain an index.html, so it is not a web build.');

    await precompress(siteRoot);

    const safeTag = tag.replace(/[^A-Za-z0-9._-]/g, '_');
    const dest = path.join(APPS_DIR, app.id, 'versions', safeTag);
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.rename(siteRoot, dest).catch(async () => { await fsp.cp(siteRoot, dest, { recursive: true }); });

    const link = `${current}.new`;
    await fsp.rm(link, { force: true });
    await fsp.symlink(path.join('versions', safeTag), link);
    await fsp.rename(link, current); // atomic swap

    // keep the newest versions only (SD cards are small)
    const versionsDir = path.join(APPS_DIR, app.id, 'versions');
    const dirs = await Promise.all((await fsp.readdir(versionsDir)).map(async (n) =>
      ({ n, t: (await fsp.stat(path.join(versionsDir, n))).mtimeMs })));
    dirs.sort((a, b) => b.t - a.t);
    for (const d of dirs.slice(KEEP_VERSIONS)) await fsp.rm(path.join(versionsDir, d.n), { recursive: true, force: true });

    Object.assign(st, { version: tag, asset: asset.name, installedAt: new Date().toISOString(), error: null });
    await fetchIcon(app);
    log(`[${app.id}] now on ${tag}`);
    return 'installed';
  } catch (err) {
    st.error = err.message;
    st.checkedAt = new Date().toISOString();
    log(`[${app.id}] ${err.message}`);
    return 'error';
  } finally {
    installing.delete(app.id);
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    await saveState().catch(() => {});
  }
}

async function checkAll() {
  for (const app of [...apps]) await installApp(app);
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

function baseHeaders(isApp) {
  const h = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };
  if (!isApp) { h['Content-Security-Policy'] = DASH_CSP; h['X-Frame-Options'] = 'DENY'; }
  if (ISOLATE) { h['Cross-Origin-Opener-Policy'] = 'same-origin'; h['Cross-Origin-Embedder-Policy'] = 'require-corp'; }
  return h;
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { ...baseHeaders(false), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function sendText(res, code, text) {
  res.writeHead(code, { ...baseHeaders(false), 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// Serve a file from `root` for URL path `rel`. Returns false if nothing matched.
async function serveFrom(req, res, root, rel, isApp) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { sendText(res, 400, 'Bad request'); return true; }
  if (decoded.includes('\0')) { sendText(res, 400, 'Bad request'); return true; }
  const rootResolved = path.resolve(root);
  let file = path.resolve(rootResolved, '.' + path.posix.normalize('/' + decoded));
  if (file !== rootResolved && !file.startsWith(rootResolved + path.sep)) { sendText(res, 403, 'Forbidden'); return true; }
  let st = await fsp.stat(file).catch(() => null);
  if (st && st.isDirectory()) { file = path.join(file, 'index.html'); st = await fsp.stat(file).catch(() => null); }
  if (!st || !st.isFile()) return false;

  const ext = path.extname(file).toLowerCase();
  const headers = { ...baseHeaders(isApp), 'Content-Type': MIME[ext] || 'application/octet-stream', Vary: 'Accept-Encoding' };
  headers['Cache-Control'] = HASHED.test(path.basename(file)) ? 'public, max-age=31536000, immutable' : 'no-cache';

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

// ---------- admin ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const isInstalled = (id) => fs.existsSync(path.join(APPS_DIR, id, 'current', 'index.html'));
const hasIcon = (id) => fs.existsSync(path.join(APPS_DIR, id, 'icon.png'));
const publicView = (a) => ({
  id: a.id, name: a.name, category: a.category, description: a.description,
  version: state[a.id]?.version || null, updatedAt: state[a.id]?.installedAt || null, icon: hasIcon(a.id),
});
const catsView = () => ({ ...categories });
const adminView = (a) => ({
  ...a, ...publicView(a), installed: isInstalled(a.id), installing: installing.has(a.id),
  checkedAt: state[a.id]?.checkedAt || null, error: state[a.id]?.error || null, asset: state[a.id]?.asset || null,
});

async function handleAdmin(req, res, url) {
  if (!(await authorised(req, res))) return;
  const parts = url.pathname.split('/').filter(Boolean); // api admin apps [id] [action]
  const [, , what, id, action] = parts;
  try {
    if (what === 'apps' && !id && req.method === 'GET') return sendJson(res, 200, { apps: apps.map(adminView), categories: catsView(), intervalHours: UPDATE_HOURS });

    if (what === 'apps' && !id && req.method === 'POST') {
      const b = await readBody(req);
      const repo = normaliseRepo(b.repo);
      if (!repo) return sendJson(res, 400, { error: 'Enter a GitHub repository like owner/name or a github.com link.' });
      const repoName = repo.split('/')[1].toLowerCase();
      const newId = cleanText(b.id || repoName, 40).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      if (!ID_RE.test(newId)) return sendJson(res, 400, { error: 'The app id may only contain letters, numbers and hyphens.' });
      if (b.assetPattern) { try { new RegExp(String(b.assetPattern)); } catch { return sendJson(res, 400, { error: 'The asset pattern is not a valid regular expression.' }); } }
      const existing = apps.find((a) => a.id === newId);
      const app = {
        id: newId, repo,
        name: cleanText(b.name, 60) || repoName,
        category: cleanText(b.category, 30) || 'Other',
        description: cleanText(b.description, 160),
        assetPattern: cleanText(b.assetPattern, 120) || undefined,
      };
      if (existing) Object.assign(existing, app); else apps.push(app);
      await saveApps();
      installApp(existing || app, { force: true });
      return sendJson(res, 202, { app: adminView(existing || app) });
    }

    if (what === 'apps' && id && !action && req.method === 'DELETE') {
      if (!ID_RE.test(id) || !apps.some((a) => a.id === id)) return sendJson(res, 404, { error: 'No such app.' });
      apps = apps.filter((a) => a.id !== id);
      delete state[id];
      await Promise.all([saveApps(), saveState()]);
      await fsp.rm(path.join(APPS_DIR, id), { recursive: true, force: true });
      return sendJson(res, 200, { ok: true });
    }

    if (what === 'apps' && id && action === 'update' && req.method === 'POST') {
      const app = apps.find((a) => a.id === id);
      if (!app) return sendJson(res, 404, { error: 'No such app.' });
      installApp(app, { force: true });
      return sendJson(res, 202, { ok: true });
    }

    if (what === 'categories' && !id && req.method === 'PUT') {
      const b = await readBody(req);
      const name = cleanText(b.name, 30);
      if (!name || ['__proto__', 'constructor', 'prototype'].includes(name)) return sendJson(res, 400, { error: 'Enter a group name.' });
      if (b.color) {
        if (!HEX_RE.test(String(b.color))) return sendJson(res, 400, { error: 'The colour must look like #8fa5ff.' });
        categories[name] = String(b.color).toLowerCase();
      } else delete categories[name];
      await saveCategories();
      return sendJson(res, 200, { categories: catsView() });
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
      return sendJson(res, 200, { apps: apps.filter((a) => isInstalled(a.id)).map(publicView), categories: catsView() });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');

    if (p.startsWith('/apps/')) {
      const m = p.match(/^\/apps\/([a-z0-9-]+)(\/.*)?$/);
      if (!m || !ID_RE.test(m[1])) return sendText(res, 404, 'Not found');
      if (!m[2]) { res.writeHead(301, { Location: `${p}/${url.search}` }); return res.end(); }
      if (await serveFrom(req, res, path.join(APPS_DIR, m[1], 'current'), m[2], true)) return;
      return sendText(res, 404, 'Not found');
    }

    const icon = p.match(/^\/icons\/([a-z0-9-]+)\.png$/);
    if (icon) {
      if (await serveFrom(req, res, path.join(APPS_DIR, icon[1]), '/icon.png', false)) return;
      return sendText(res, 404, 'Not found');
    }

    if (await serveFrom(req, res, PUBLIC_DIR, p === '/' ? '/index.html' : p, false)) return;
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
