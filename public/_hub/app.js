(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);

  // ---------- small helpers ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('hub:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('hub:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function arrowIcon() {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG_NS, 'path');
    for (const [k, v] of Object.entries({ d: 'M12 19V6m0 0l-5 5m5-5l5 5', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) p.setAttribute(k, v);
    s.append(p);
    return s;
  }
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const smooth = () => ({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
  }

  // ---------- state ----------
  let apps = [];
  let categories = {};         // group name -> colour chosen by the owner
  let site = { contact: null };
  let openTabs = [];           // open tabs in order: { tid, app, num }. The same app can be open more than once.
  let tidSeq = 0;
  const lastTab = {};          // app id -> the tab of that app used most recently
  let active = 'home';        // 'home' or a tab id
  const frames = new Map();    // id -> iframe (created lazily, kept alive while the tab is open)
  const wraps = new Map();     // id -> { vp, size, shield } scrollable viewport around each iframe
  const problems = new Map();  // id -> { text } for apps that failed to start
  const appById = (id) => apps.find((a) => a.id === id);
  const tabById = (tid) => openTabs.find((t) => t.tid === tid) || null;
  const activeTab = () => tabById(active);
  const activeApp = () => { const t = activeTab(); return t ? appById(t.app) : null; };
  const tabLabel = (t, a) => (a ? a.name : 'App') + (t.num > 1 ? ` ${t.num}` : '');

  // ---------- group colours ----------
  const DEFAULT_CAT = { Office: 'var(--lav)', Create: 'var(--rose)', Other: 'var(--sage)' };
  const PRESETS = ['#8fa5ff', '#f08fa6', '#8fd1b0', '#f5c26b', '#c4a1ff', '#6fd0e0', '#ff9f7a', '#a6b1c2'];
  const HEX = /^#[0-9a-f]{6}$/i;

  function catColour(name) {
    if (hasOwn(categories, name) && HEX.test(categories[name])) return categories[name];
    if (hasOwn(DEFAULT_CAT, name)) return DEFAULT_CAT[name];
    let n = 0; for (const ch of name) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
    return PRESETS[n % PRESETS.length];
  }
  function inkFor(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#10131a' : '#ffffff';
  }
  // Colours are set through the style API, which the page's strict policy allows.
  function paint(el, cat) {
    const c = catColour(cat || 'Other');
    el.style.setProperty('--cat', c);
    el.style.setProperty('--cat-ink', c.startsWith('#') ? inkFor(c) : 'var(--accent-ink)');
    return el;
  }

  // ---------- theme ----------
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    const next = t === 'dark' ? 'Light theme' : 'Dark theme';
    $('#themeLbl').textContent = next;
    $('#themeBtn').setAttribute('aria-label', `Switch to ${next.toLowerCase()}`);
    $('#themeBtn').title = `Switch to ${next.toLowerCase()}`;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#17171b' : '#ffffff');
  }
  $('#themeBtn').addEventListener('click', () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    store.set('theme', t); applyTheme(t);
  });
  applyTheme(document.documentElement.dataset.theme);

  // The logo goes Home without reloading, so open apps keep their place.
  document.querySelector('.brand')?.addEventListener('click', (e) => { e.preventDefault(); drawerOpen = false; activate('home'); });

  // ---------- dialogs ----------
  document.addEventListener('click', (e) => {
    const closer = e.target.closest && e.target.closest('[data-close]');
    if (closer) closer.closest('dialog')?.close();
  });
  $('#helpBtn').addEventListener('click', () => $('#helpDlg').showModal());

  // ---------- loading the app list, and noticing changes ----------
  let lastSig = '';
  let lastPoll = 0;
  let baseline = null;         // what this page was loaded with: id -> {name, version}
  const snapshot = () => new Map(apps.map((a) => [a.id, { name: a.name, version: a.version || '' }]));

  function checkForChanges() {
    if (!baseline) { baseline = snapshot(); return; }
    const now = snapshot();
    const msgs = [];
    for (const [id, cur] of now) {
      const old = baseline.get(id);
      if (!old) msgs.push(`${cur.name} was added`);
      else if (old.version !== cur.version) msgs.push(cur.version ? `${cur.name} updated to ${cur.version}` : `${cur.name} updated`);
    }
    for (const [id, old] of baseline) if (!now.has(id)) msgs.push(`${old.name} was removed`);
    const bar = $('#updateBanner');
    if (!msgs.length) { bar.hidden = true; return; }
    const shown = msgs.slice(0, 3).join(', ') + (msgs.length > 3 ? ` and ${msgs.length - 3} more` : '');
    $('#updateText').textContent = `${shown}. ${frames.size ? 'Save your work, then refresh' : 'Refresh'} to load the changes.`;
    bar.hidden = false;
  }
  $('#refreshBtn').addEventListener('click', () => location.reload());
  $('#dismissBtn').addEventListener('click', () => { baseline = snapshot(); $('#updateBanner').hidden = true; });

  async function loadApps() {
    let data;
    try {
      const res = await fetch('/api/apps', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      data = await res.json();
    } catch {
      if (!apps.length) $('#groups').replaceChildren(h('p', { class: 'empty', text: 'Could not load the app list. Check your connection and reload.' }));
      return false;
    }
    lastPoll = Date.now();
    apps = data.apps || [];
    categories = data.categories || {};
    site = data.site || { contact: null };
    checkForChanges();
    const sig = JSON.stringify([apps, categories, site]);
    if (sig !== lastSig) { lastSig = sig; renderHome(); renderTabs(); renderContact(); }
    return true;
  }
  setInterval(() => { if (!document.hidden) loadApps(); }, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastPoll > 60 * 1000) loadApps(); });

  // ---------- home ----------
  const catOrder = (names) => {
    const first = ['Office', 'Create'];
    return [...names].sort((a, b) => {
      const ia = first.indexOf(a), ib = first.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
  };

  function renderHome() { renderHomeInner(); layoutHome(); }

  // Every group uses the same columns, so tiles line up across groups. The count is as many as fit
  // the screen, but never more than the biggest group needs. The block stays centred.
  function layoutHome() {
    const block = $('#homeBlock');
    const inner = document.querySelector('.home-inner');
    if (!block || !inner) return;
    const cs = getComputedStyle(inner);
    const avail = inner.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const gap = 0.8 * rem, min = 17 * rem;
    const fit = Math.max(1, Math.floor((avail + gap) / (min + gap)));
    const biggest = Math.max(1, ...[...document.querySelectorAll('#groups .tiles')].map((g) => g.children.length));
    block.style.setProperty('--cols', String(Math.min(fit, biggest)));
  }
  if (typeof ResizeObserver !== 'undefined') { const inner = document.querySelector('.home-inner'); if (inner) new ResizeObserver(() => layoutHome()).observe(inner); }
  window.addEventListener('resize', layoutHome);

  function renderHomeInner() {
    const groups = new Map();
    for (const a of apps) { const c = a.category || 'Other'; if (!groups.has(c)) groups.set(c, []); groups.get(c).push(a); }
    if (!groups.size) {
      $('#groups').replaceChildren(h('p', { class: 'empty', text: 'No apps are installed yet. If you run this server, use Manage to add one. New installs can take a minute to download.' }));
      return;
    }
    $('#groups').replaceChildren(...catOrder(groups.keys()).map((cat) =>
      paint(h('section', { class: 'group' },
        h('h2', {}, h('span', { class: 'dot' }), cat),
        h('div', { class: 'tiles' }, groups.get(cat).map(tile))), cat)));
  }

  function renderContact() {
    const el = $('#contact');
    const c = site && site.contact;
    if (!c || !c.value) { el.hidden = true; return; }
    const shown = c.kind === 'url' ? c.value.replace(/^https?:\/\//, '').replace(/\/$/, '') : c.value;
    const link = c.kind === 'email'
      ? h('a', { href: `mailto:${c.value}` }, shown)
      : c.kind === 'url' ? h('a', { href: c.value, target: '_blank', rel: 'noopener noreferrer' }, shown) : shown;
    el.replaceChildren(`${c.label || 'Questions or problems? Contact'} `, link);
    el.hidden = false;
  }

  // Small inline SVG builder: icon([['path', {d: ...}], ['circle', {...}]], size)
  function icon(parts, size = 18, extra = {}) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('aria-hidden', 'true');
    for (const [k, v] of Object.entries(extra)) s.setAttribute(k, v);
    for (const [tag, attrs] of parts) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries({ fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...attrs })) el.setAttribute(k, v);
      s.append(el);
    }
    return s;
  }
  const EYE = [['path', { d: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z' }], ['circle', { cx: 12, cy: 12, r: 2.8 }]];
  const EYE_OFF = [...EYE, ['path', { d: 'M4 4l16 16' }]];
  const HOME = [['path', { d: 'M4 11l8-6.5 8 6.5v8.5a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z' }]];
  const CLOSE = [['path', { d: 'M6 6l12 12M18 6L6 18' }]];

  function appIcon(a, size, cls = 'ico') {
    const letter = h('span', { class: `${cls} letter`, 'aria-hidden': 'true', text: a.name.slice(0, 1).toUpperCase() });
    return a.icon
      ? h('img', { class: cls, src: `/icons/${a.id}?v=${a.iconV || 0}`, alt: '', width: size, height: size, onerror(e) { e.target.replaceWith(letter); } })
      : letter;
  }
  const badge = (text, cls, title) => h('span', { class: `badge ${cls}`, title: title || null, text });

  function tile(a) {
    const n = openTabs.filter((t) => t.app === a.id).length;
    return h('button', { class: 'tile', type: 'button', onclick: () => openNew(a.id) },
      appIcon(a, 52),
      h('span', { class: 'tx' },
        h('span', { class: 'name-row' },
          h('span', { class: 'name', text: a.name }),
          a.updateAvailable ? badge('Update', 'upd', `A newer version (${a.latest}) is available. The site owner hasn’t installed it yet.`) : null,
          n ? badge(n > 1 ? `Open ×${n}` : 'Open', 'open', n > 1 ? `Open in ${n} tabs. Clicking opens another.` : 'Open in a tab. Clicking opens another.') : null),
        a.description ? h('span', { class: 'desc', text: a.description }) : null,
        a.version ? h('span', { class: 'ver', text: `Version ${a.version}` }) : null));
  }

  // ---------- left launcher, shown while an app is open ----------
  const mqSmall = window.matchMedia ? window.matchMedia('(max-width: 760px)') : { matches: false };
  let drawerOpen = false;       // small screens: the launcher is a drawer that starts closed
  const railWanted = () => active !== 'home' && (mqSmall.matches ? drawerOpen : store.get('rail', 'open') !== 'closed');

  function renderRail() {
    const groups = new Map();
    for (const a of apps) { const c = a.category || 'Other'; if (!groups.has(c)) groups.set(c, []); groups.get(c).push(a); }
    const items = [h('button', { class: 'rail-btn home' + (active === 'home' ? ' active' : ''), type: 'button', title: 'Home', 'aria-label': 'Home', onclick: () => { drawerOpen = false; activate('home'); } }, icon(HOME, 22))];
    for (const cat of catOrder(groups.keys())) {
      items.push(h('span', { class: 'rail-sep', role: 'presentation' }));
      for (const a of groups.get(cat)) {
        const n = openTabs.filter((t) => t.app === a.id).length;
        const here = activeTab()?.app === a.id;
        items.push(paint(h('button', {
          class: 'rail-btn' + (here ? ' active' : '') + (n ? ' open' : ''), type: 'button',
          title: n > 1 ? `${a.name} (${n} tabs open). Shift-click opens another` : a.name,
          'aria-label': a.name + (n ? ` (${n} open)` : ''), 'aria-current': here ? 'true' : null,
          onclick: (e) => { drawerOpen = false; if (e.shiftKey || e.ctrlKey || e.metaKey) openNew(a.id); else openApp(a.id); },
        }, appIcon(a, 34), n > 1 ? h('span', { class: 'rail-count', text: String(n) }) : null), a.category));
      }
    }
    $('#railList').replaceChildren(...items);
  }

  function applyRail() {
    const shown = railWanted();
    $('#rail').hidden = !shown;
    $('#railScrim').hidden = !(shown && mqSmall.matches);
    const btn = $('#railBtn');
    btn.hidden = active === 'home';
    const label = shown ? 'Hide app launcher' : 'Show app launcher';
    btn.setAttribute('aria-expanded', String(shown)); btn.setAttribute('aria-label', label); btn.title = label;
  }
  function toggleRail() {
    if (mqSmall.matches) drawerOpen = !drawerOpen;
    else store.set('rail', railWanted() ? 'closed' : 'open');
    applyRail();
  }
  $('#railBtn').addEventListener('click', toggleRail);
  $('#railScrim').addEventListener('click', () => { drawerOpen = false; applyRail(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mqSmall.matches && drawerOpen) { drawerOpen = false; applyRail(); } });
  if (mqSmall.addEventListener) mqSmall.addEventListener('change', () => { drawerOpen = false; applyRail(); });

  // ---------- title bar above the open app: icon, name, version and close ----------
  function renderAppBar() {
    const win = $('#appwin');
    const t = activeTab();
    const a = t ? appById(t.app) : null;
    win.classList.toggle('off', !a);
    if (!a) return;
    const label = tabLabel(t, a);
    $('#appbarInfo').replaceChildren(
      appIcon(a, 20, 'bico'),
      h('span', { class: 'nm', text: label }),
      a.version ? h('span', { class: 'ver', text: a.version }) : null);
    $('#appbarClose').setAttribute('aria-label', `Close ${label}`);
    $('#appbarClose').title = `Close ${label}`;
    $('#appbarNew').setAttribute('aria-label', `Open another ${a.name} in a new tab`);
    $('#appbarNew').title = `Open another ${a.name} in a new tab`;
  }
  $('#appbarClose').addEventListener('click', () => { if (active !== 'home') closeApp(active); });
  $('#appbarNew').addEventListener('click', () => { const a = activeApp(); if (a) openNew(a.id); });

  // ---------- tabs ----------
  function renderTabs() {
    const chips = [tabEl(null, null)];
    for (const t of openTabs) { const a = appById(t.app); if (a) chips.push(tabEl(t, a)); }
    $('#tabs').replaceChildren(...chips);
    if ($('#groups').children.length) renderHome(); // refresh the "Open" badges
    renderRail();
  }

  function tabEl(t, a) {            // t === null is the Home tab
    const isHome = !t;
    const tid = isHome ? 'home' : t.tid;
    const isActive = active === tid;
    const loaded = !isHome && frames.has(tid);
    const label = isHome ? 'Home' : tabLabel(t, a);
    const status = isHome ? null : h('span', {
      class: 'eye', title: isActive ? 'Showing now' : loaded ? 'Running in the background' : 'Not started yet',
    }, icon(isActive ? EYE : EYE_OFF, 15));
    const main = h('button', {
      class: 'main', type: 'button', role: 'tab', id: `tab-${tid}`, 'aria-selected': String(isActive),
      'aria-controls': isHome ? 'home' : `frame-${tid}`, tabindex: isActive ? '0' : '-1',
      onclick: () => activate(tid), onkeydown: tabKeys,
    }, isHome ? icon(HOME, 16) : appIcon(a, 18, 'tico'), h('span', { class: 'label', text: label }), status);
    const wrap = h('div', { class: 'tab' + (isActive ? ' active' : '') + (!isHome && !loaded ? ' unloaded' : ''), role: 'presentation' }, main);
    if (!isHome) {
      paint(wrap, a.category);
      wrap.append(h('button', { class: 'x', type: 'button', 'aria-label': `Close ${label}`, title: 'Close tab', onclick: (e) => { e.stopPropagation(); closeApp(tid); } }, icon(CLOSE, 13)));
      wrap.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeApp(tid); } });
    }
    return wrap;
  }
  function tabKeys(e) {
    const order = ['home', ...openTabs.map((t) => t.tid)];
    const i = order.indexOf(active);
    let n = null;
    if (e.key === 'ArrowRight') n = order[(i + 1) % order.length];
    else if (e.key === 'ArrowLeft') n = order[(i - 1 + order.length) % order.length];
    else if (e.key === 'Home') n = order[0];
    else if (e.key === 'End') n = order[order.length - 1];
    if (n) { e.preventDefault(); activate(n); $(`#tab-${n}`)?.focus(); }
  }

  // ---------- why an app failed to start ----------
  const IGNORED_ERRORS = /(ResizeObserver|^Script error\.?$|Non-Error promise rejection)/i;

  function looksAlive(f) {
    try {
      const d = f.contentDocument;
      const c = d.querySelector('canvas');
      if (c && c.width > 0 && c.height > 0) return true;
      return ((d.body && d.body.innerText) || '').trim().length > 20;
    } catch { return true; } // can't inspect it, so don't claim it failed
  }

  function setProblem(id, text) {
    if (problems.has(id)) return;
    problems.set(id, { text });
    if (active === id) renderProblem();
  }
  function renderProblem() {
    const bar = $('#problemBar');
    const p = problems.get(active);
    if (active === 'home' || !p) { bar.hidden = true; return; }
    const t = activeTab();
    const a = t ? appById(t.app) : null;
    $('#problemTitle').textContent = `${a ? tabLabel(t, a) : 'This app'} couldn’t start properly.`;
    $('#problemBody').textContent = p.text;
    bar.hidden = false;
  }
  $('#problemDismiss').addEventListener('click', () => { problems.delete(active); renderProblem(); });
  $('#problemReload').addEventListener('click', () => {
    const f = frames.get(active);
    problems.delete(active); renderProblem();
    if (f) { try { f.contentWindow.location.reload(); } catch { f.src = f.src; } }
  });

  function onFrameLoad(id, appId, f) {            // id is the tab, appId the app it runs
    const openedAt = Date.now();
    const errors = [];
    try {
      const w = f.contentWindow;
      for (const ev of ['pointerdown', 'keydown', 'touchstart']) w.addEventListener(ev, onActivity, { capture: true, passive: true });
      w.addEventListener('error', (e) => { if (e.message && !IGNORED_ERRORS.test(e.message)) errors.push(e.message); });
      w.addEventListener('unhandledrejection', (e) => {
        const m = e.reason && (e.reason.message || String(e.reason));
        if (m && !IGNORED_ERRORS.test(m)) errors.push(m);
      });
    } catch { /* not inspectable */ }
    const check = async () => {
      if (frames.get(id) !== f) return;
      try {
        const res = await fetch(`/api/apps/${appId}/problems`, { cache: 'no-store' });
        const data = await res.json();
        const recent = (data.missing || []).filter((m) => m.ageSec <= (Date.now() - openedAt) / 1000 + 3);
        if (recent.length) {
          const more = recent.length > 1 ? ` and ${recent.length - 1} more` : '';
          setProblem(id, `It asked for a file this server doesn’t have: ${recent[0].path}${more}. That is a packaging problem in this release of the app, not something wrong with your device. The site owner can choose another version in Manage.`);
          return;
        }
      } catch { /* offline: fall through to the error check */ }
      if (errors.length && !looksAlive(f)) {
        setProblem(id, `The app reported an error while starting: ${errors[0].slice(0, 200)}. Try Reload this app, and make sure the page is using HTTPS.`);
      }
    };
    setTimeout(check, 2500);
    setTimeout(check, 9000);
  }

  // ---------- opening, switching, closing ----------
  function makeFrame(t) {
    const a = appById(t.app);
    const f = h('iframe', {
      class: 'frame', id: `frame-${t.tid}`, title: tabLabel(t, a),
      allow: 'clipboard-read; clipboard-write; fullscreen; autoplay; encrypted-media', 'data-id': t.app,
    });
    f.addEventListener('load', () => { if (f.getAttribute('src')) onFrameLoad(t.tid, t.app, f); });
    const shield = h('div', { class: 'pan-shield', hidden: true });
    const size = h('div', { class: 'vp-size' }, f, shield);
    const vp = h('div', { class: 'vp' }, size);
    frames.set(t.tid, f); wraps.set(t.tid, { vp, size, shield });
    $('#frames').append(vp);
    layoutAll();
    // Start loading on the next frame so the click that opened the tab returns immediately.
    requestAnimationFrame(() => { f.setAttribute('src', `/apps/${t.app}/`); });
    return f;
  }
  function dropFrame(id) {
    wraps.get(id)?.vp.remove(); wraps.delete(id);
    frames.delete(id); problems.delete(id);
    renderProtection();
  }

  // ---------- small screens: a bigger virtual window, scaled to fit, with zoom and move ----------
  // Apps are desktop-style and need room. On a narrow screen each app gets a window at least
  // MIN_W wide, scaled down to fit. Zooming in magnifies it, and the viewport scrolls.
  const MIN_W = 900;
  const MAX_ZOOM = 2;
  const STEPS = [0.4, 0.5, 0.65, 0.8, 1, 1.25, 1.5, 2];
  const view = { scale: store.get('view', {}).scale ?? null, collapsed: store.get('view', {}).collapsed === true, move: false };
  const saveView = () => store.set('view', { scale: view.scale, collapsed: view.collapsed });

  function metrics() {
    const box = $('#frames');
    const cw = box.clientWidth, ch = box.clientHeight;
    const small = prefs.fit && cw > 0 && cw < MIN_W;
    const fit = small ? cw / MIN_W : 1;
    let s = fit;
    if (small && view.scale != null) s = Math.min(MAX_ZOOM, Math.max(fit, view.scale));
    return { cw, ch, small, fit, s, vw: small ? MIN_W : cw, vh: small ? ch / fit : ch };
  }

  function layoutAll() {
    const m = metrics();
    const zoomed = m.small && m.s > m.fit + 0.01;
    for (const [id, w] of wraps) {
      const f = frames.get(id);
      const set = (el, k, v) => el.style.setProperty(k, v);
      if (!m.small) {
        set(w.size, 'width', '100%'); set(w.size, 'height', '100%');
        set(f, 'width', '100%'); set(f, 'height', '100%'); set(f, 'transform', 'none');
      } else {
        set(w.size, 'width', `${m.vw * m.s}px`); set(w.size, 'height', `${m.vh * m.s}px`);
        set(f, 'width', `${m.vw}px`); set(f, 'height', `${m.vh}px`); set(f, 'transform', `scale(${m.s})`);
      }
      w.shield.hidden = !(zoomed && view.move);
    }
    updateViewbar(m, zoomed);
    return m;
  }

  function updateViewbar(m, zoomed) {
    const bar = $('#viewbar');
    bar.hidden = !(m.small && active !== 'home');
    bar.classList.toggle('collapsed', view.collapsed);
    $('#vbLabel').textContent = `${Math.round(m.s * 100)}%`;
    $('#vbOut').disabled = m.s <= m.fit + 0.01;
    $('#vbIn').disabled = m.s >= MAX_ZOOM - 0.01;
    $('#vbFit').disabled = !zoomed;
    const pan = $('#vbPan');
    pan.hidden = !zoomed;
    pan.setAttribute('aria-pressed', String(view.move));
    pan.textContent = view.move ? 'Use app' : 'Move view';
    const t = $('#vbToggle');
    t.setAttribute('aria-expanded', String(!view.collapsed));
    t.setAttribute('aria-label', view.collapsed ? 'Show view controls' : 'Hide view controls');
    t.title = t.getAttribute('aria-label');
  }

  function setScale(next) {
    const before = metrics();
    const w = wraps.get(active);
    const rx = w ? (w.vp.scrollLeft + before.cw / 2) / Math.max(1, w.size.offsetWidth) : 0;
    const ry = w ? (w.vp.scrollTop + before.ch / 2) / Math.max(1, w.size.offsetHeight) : 0;
    view.scale = next == null || next <= before.fit + 0.01 ? null : Math.min(MAX_ZOOM, next);
    if (view.scale == null) view.move = false;
    saveView();
    const m = layoutAll();
    if (w) { // keep whatever was in the middle of the screen in the middle
      w.vp.scrollLeft = Math.max(0, rx * w.size.offsetWidth - m.cw / 2);
      w.vp.scrollTop = Math.max(0, ry * w.size.offsetHeight - m.ch / 2);
    }
  }
  function zoomStep(dir) {
    const m = metrics();
    const next = dir > 0 ? STEPS.find((x) => x > m.s + 0.01) : [...STEPS].reverse().find((x) => x < m.s - 0.01);
    setScale(next == null ? (dir > 0 ? MAX_ZOOM : null) : next);
  }
  $('#vbIn').addEventListener('click', () => zoomStep(1));
  $('#vbOut').addEventListener('click', () => zoomStep(-1));
  $('#vbFit').addEventListener('click', () => setScale(null));
  $('#vbPan').addEventListener('click', () => { view.move = !view.move; layoutAll(); });
  $('#vbToggle').addEventListener('click', () => { view.collapsed = !view.collapsed; saveView(); layoutAll(); });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => layoutAll()).observe($('#frames'));
  window.addEventListener('orientationchange', () => setTimeout(layoutAll, 250));

  function activate(id) {
    if (id !== 'home') { const t0 = tabById(id); if (!t0 || !appById(t0.app)) id = 'home'; }
    active = id;
    $('#home').hidden = id !== 'home';
    for (const [fid, w] of wraps) {
      const on = fid === id;
      w.vp.classList.toggle('active', on);
      w.vp.inert = !on;
    }
    if (id !== 'home') {
      const t = tabById(id);
      const a = appById(t.app);
      lastTab[t.app] = id;
      const f = frames.get(id) || makeFrame(t);
      const w = wraps.get(id);
      w.vp.classList.add('active'); w.vp.inert = false;
      document.title = `${tabLabel(t, a)} · ArtCraft Hub`;
      requestAnimationFrame(() => { try { f.contentWindow.focus(); } catch { /* not ready */ } });
      keepStorage();
    } else {
      document.title = 'ArtCraft Hub';
      loadApps();
    }
    renderTabs(); renderProblem(); renderAppBar(); saveSession(); applyRail(); layoutAll(); renderProtection();
  }

  // A new tab, even if this app is already open. Numbers are reused: WordCraft, WordCraft 2, ...
  function openNew(appId) {
    const used = new Set(openTabs.filter((t) => t.app === appId).map((t) => t.num));
    let num = 1; while (used.has(num)) num++;
    const t = { tid: `t${++tidSeq}`, app: appId, num };
    openTabs.push(t);
    activate(t.tid);
    return t;
  }
  // Switch to the app's most recent tab, or open one if it is not open yet.
  function openApp(appId) {
    const t = tabById(lastTab[appId]) || openTabs.find((x) => x.app === appId);
    if (t) activate(t.tid); else openNew(appId);
  }

  function closeApp(tid) {
    const t = tabById(tid);
    const a = t ? appById(t.app) : null;
    if (prefs.warn && frames.has(tid) && !confirm(`Close ${t ? tabLabel(t, a) : 'this tab'}?\n\nAnything you haven’t saved to your device will be lost.`)) return;
    const idx = openTabs.findIndex((x) => x.tid === tid);
    openTabs = openTabs.filter((x) => x.tid !== tid);
    dropFrame(tid);
    if (active === tid) activate(openTabs[Math.min(idx, openTabs.length - 1)]?.tid || 'home');
    else { renderTabs(); saveSession(); }
  }

  // ---------- session memory and warnings ----------
  const prefs = { warn: store.get('warn', true), restore: store.get('restore', true), fit: store.get('fit', true) };
  $('#warnPref').checked = prefs.warn;
  $('#restorePref').checked = prefs.restore;
  $('#fitPref').checked = prefs.fit;
  $('#warnPref').addEventListener('change', (e) => { prefs.warn = e.target.checked; store.set('warn', prefs.warn); renderProtection(); });
  $('#restorePref').addEventListener('change', (e) => { prefs.restore = e.target.checked; store.set('restore', prefs.restore); if (!prefs.restore) store.set('session', null); else saveSession(); });

  $('#fitPref').addEventListener('change', (e) => { prefs.fit = e.target.checked; store.set('fit', prefs.fit); layoutAll(); });

  function saveSession() { if (prefs.restore) store.set('session', { tabs: openTabs.map((t) => ({ tid: t.tid, app: t.app, num: t.num })), active, seq: tidSeq }); }

  window.addEventListener('beforeunload', (e) => {
    if (!prefs.warn || !frames.size) return undefined;
    const msg = 'Apps are open. Anything you haven’t saved to your device will be lost.';
    e.preventDefault();
    e.returnValue = msg; // older browsers need a non-empty string
    return msg;
  });

  // Browsers only show the close warning once you have interacted with the page, and most
  // phone browsers never show it. This says which situation you are in, live.
  let lastProtection = '';
  function protectionState() {
    if (!prefs.warn) return 'off';
    if (!frames.size) return 'idle';
    if (window.matchMedia?.('(pointer: coarse)').matches) return 'touch';
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return 'waiting';
    return 'ready';
  }
  const PROTECTION_TEXT = {
    off: 'Close warnings are off. Closing an app tab or this page will not ask first.',
    idle: 'The close warning switches on as soon as you open an app.',
    touch: 'Phone and tablet browsers usually can’t warn when you close the tab, so save to a file before you leave.',
    waiting: 'Click anywhere on this page once. Your browser only shows the close warning after you have interacted with the page.',
    ready: 'Close warning is on. Your browser will ask before the tab or window closes. It cannot warn if the browser or device shuts down or crashes.',
  };
  function renderProtection() {
    const st = protectionState();
    if (st === lastProtection) return;
    lastProtection = st;
    $('#closeNote').textContent = PROTECTION_TEXT[st];
  }
  let activityQueued = false;
  function onActivity() {
    if (activityQueued) return;
    activityQueued = true;
    requestAnimationFrame(() => { activityQueued = false; renderProtection(); });
  }
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, onActivity, { capture: true, passive: true });

  async function keepStorage() {
    if (!navigator.storage?.persist) return;
    try {
      const ok = (await navigator.storage.persisted()) || (await navigator.storage.persist());
      showStorageNote(ok);
    } catch { /* ignore */ }
  }
  async function showStorageNote(known) {
    const note = $('#storageNote');
    if (!window.isSecureContext) {
      note.textContent = 'This page is not using HTTPS, so your browser may block saving to your device and keeping data between visits. Ask the site owner to serve it over HTTPS.';
      return;
    }
    let ok = known;
    if (ok === undefined && navigator.storage?.persisted) { try { ok = await navigator.storage.persisted(); } catch { /* ignore */ } }
    note.textContent = ok
      ? 'Your browser has marked this site’s stored data as protected from automatic clean-up.'
      : 'Your browser may clear this site’s stored data if your device runs low on space. Save important work to a file.';
  }

  // ---------- manage (admin) ----------
  let token = '';              // memory only: never written to storage
  let pollTimer = null;
  let editingId = null;
  let lastAdminList = [];
  const dlg = $('#manageDlg');

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) { const err = new Error(data.error || `Request failed (${res.status})`); err.status = res.status; throw err; }
    return data;
  }

  function showAdmin(on) { $('#loginView').hidden = on; $('#adminView').hidden = !on; }

  $('#manageBtn').addEventListener('click', () => { dlg.showModal(); if (token) refreshAdmin().catch(() => showAdmin(false)); else { showAdmin(false); $('#tokenInput').focus(); } });
  $('#manageClose').addEventListener('click', () => dlg.close());
  $('#howBtn').addEventListener('click', () => $('#helpDlg').showModal());
  dlg.addEventListener('close', () => { clearInterval(pollTimer); pollTimer = null; loadApps(); });
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    token = $('#tokenInput').value; $('#tokenInput').value = ''; $('#loginErr').textContent = '';
    if (!token) return;
    try { await refreshAdmin(); }
    catch (err) { token = ''; $('#loginErr').textContent = err.message; showAdmin(false); }
  });
  $('#logoutBtn').addEventListener('click', () => { token = ''; showAdmin(false); clearInterval(pollTimer); pollTimer = null; });

  async function refreshAdmin() {
    const data = await api('/api/admin/apps');
    categories = data.categories || {};
    lastAdminList = data.apps;
    showAdmin(true);
    $('#adminNote').textContent = data.intervalHours > 0
      ? `Checks GitHub for new releases every ${data.intervalHours} hours, for apps with automatic updates on.`
      : 'Automatic update checks are turned off for this server.';
    renderAdminList(data.apps);
    renderCategoryEditor(data.apps);
    fillSiteForm(data.settings || {});
    $('#catList').replaceChildren(...catOrder(new Set(['Office', 'Create', 'Other', ...data.apps.map((a) => a.category).filter(Boolean)])).map((c) => h('option', { value: c })));
    const busy = data.apps.some((a) => a.installing);
    if (busy && !pollTimer) pollTimer = setInterval(() => refreshAdmin().catch(() => {}), 3000);
    if (!busy && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  const chip = (text, cls, icon) => h('span', { class: `chip ${cls}` }, icon || null, text);

  function appCard(a) {
    let status;
    if (a.installing) status = h('span', { class: 'meta', text: 'Downloading and installing…' });
    else if (a.error) status = h('span', { class: 'bad', text: a.error });
    else if (a.installed) status = h('span', { class: 'meta', text: `Installed ${fmtDate(a.updatedAt)}, last checked ${fmtDate(a.checkedAt)}` });
    else status = h('span', { class: 'meta', text: 'Waiting for the first install…' });

    const chips = [];
    if (a.pin) chips.push(chip(`Pinned to ${a.pin}`, 'pin'));
    if (a.updateAvailable) chips.push(chip(`Update available: ${a.latest}`, 'upd', arrowIcon()));
    else if (a.latest && a.version && a.latest !== a.version && a.badTags.includes(a.latest)) chips.push(chip(`Newest (${a.latest}) can’t run here`, 'warn'));
    if (!a.autoUpdate && !a.pin) chips.push(chip('Manual updates', ''));

    const tags = a.releases.map((r) => r.tag);
    if (a.pin && !tags.includes(a.pin)) tags.unshift(a.pin);
    const select = h('select', { 'aria-label': `Version of ${a.name}`, disabled: !tags.length },
      tags.map((t) => h('option', { value: t, selected: t === (a.pin || a.version) },
        `${t}${t === a.version ? ' (installed)' : ''}${a.badTags.includes(t) ? ' (can’t run here)' : ''}`)));
    const auto = h('input', { type: 'checkbox', checked: a.autoUpdate && !a.pin, disabled: Boolean(a.pin), onchange: (e) => postSettings(a, { autoUpdate: e.target.checked }, `Automatic updates ${e.target.checked ? 'on' : 'off'} for ${a.name}.`) });

    return paint(h('li', {},
      h('div', { class: 'top' },
        h('span', { class: 'nm' }, h('span', { class: 'dot' }), a.name, a.version ? h('span', { class: 'vers', text: a.version }) : null),
        h('span', { class: 'btns' },
          h('button', { class: a.updateAvailable && !a.pin ? 'btn solid' : 'btn', type: 'button', onclick: () => updateOne(a) }, a.updateAvailable && !a.pin ? `Update to ${a.latest}` : 'Check now'),
          h('button', { class: 'btn', type: 'button', onclick: () => editApp(a) }, 'Edit'),
          h('button', { class: 'btn danger', type: 'button', onclick: () => removeApp(a) }, 'Remove'))),
      chips.length ? h('div', { class: 'chips' }, chips) : null,
      h('span', { class: 'meta', text: `${a.repo} · group: ${a.category}` }),
      status,
      a.warning ? h('span', { class: 'warnline', text: a.warning }) : null,
      h('div', { class: 'controls' },
        h('label', { title: a.pin ? 'A pinned app never changes until you unpin it.' : '' }, auto, 'Update automatically'),
        h('span', { class: 'verpick' }, 'Version', select,
          h('button', { class: 'btn', type: 'button', disabled: !tags.length, onclick: () => postSettings(a, { pin: a.pin ? null : select.value }, a.pin ? `Unpinned ${a.name}.` : `Pinning ${a.name} to ${select.value}…`) }, a.pin ? 'Unpin' : 'Pin this version')))), a.category);
  }
  function renderAdminList(list) { $('#adminList').replaceChildren(...list.map(appCard)); }

  async function postSettings(a, body, message) {
    try { await api(`/api/admin/apps/${a.id}/settings`, { method: 'POST', body: JSON.stringify(body) }); toast(message); }
    catch (e) { toast(e.message); }
    await refreshAdmin().catch(() => {});
  }

  function renderCategoryEditor(list) {
    const names = catOrder(new Set(list.map((a) => a.category || 'Other')));
    $('#catEditor').replaceChildren(...names.map((name) => {
      const current = catColour(name);
      const swatches = PRESETS.map((c) => {
        const b = h('button', { class: 'sw', type: 'button', 'aria-label': `Use ${c} for ${name}`, 'aria-pressed': String(current.toLowerCase() === c), onclick: () => setCategoryColour(name, c) });
        b.style.background = c;
        return b;
      });
      const picker = h('input', { type: 'color', 'aria-label': `Custom colour for ${name}`, value: current.startsWith('#') ? current : '#8fa5ff', onchange: (e) => setCategoryColour(name, e.target.value) });
      const input = h('input', { class: 'rename', type: 'text', maxlength: '30', value: name, 'aria-label': `Rename the ${name} group`, onkeydown: (e) => { if (e.key === 'Enter') renameGroup(name, input.value); } });
      return paint(h('div', { class: 'catrow' },
        h('span', { class: 'nm' }, h('span', { class: 'dot' })),
        input,
        h('button', { class: 'btn', type: 'button', onclick: () => renameGroup(name, input.value) }, 'Rename'),
        h('span', { class: 'swatches' }, swatches, picker),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => setCategoryColour(name, '') }, 'Reset colour')), name);
    }));
  }

  async function renameGroup(from, to) {
    to = (to || '').trim();
    if (!to || to === from) return;
    const exists = lastAdminList.some((a) => (a.category || 'Other') === to);
    if (exists && !confirm(`There is already a group called “${to}”. Move the apps from “${from}” into it?`)) return;
    try {
      await api('/api/admin/categories/rename', { method: 'POST', body: JSON.stringify({ from, to }) });
      toast(`Renamed ${from} to ${to}.`);
      await refreshAdmin(); lastSig = ''; await loadApps();
    } catch (e) { toast(e.message); }
  }

  async function setCategoryColour(name, colour) {
    try {
      const data = await api('/api/admin/categories', { method: 'PUT', body: JSON.stringify({ name, color: colour }) });
      categories = data.categories || {};
      lastSig = ''; renderHome(); renderTabs();
      renderAdminList(lastAdminList); renderCategoryEditor(lastAdminList);
      toast(colour ? `Colour saved for ${name}.` : `Colour reset for ${name}.`);
    } catch (e) { toast(e.message); }
  }

  async function updateOne(a) {
    try { await api(`/api/admin/apps/${a.id}/update`, { method: 'POST', body: '{}' }); toast(`Checking ${a.name}…`); await refreshAdmin(); }
    catch (e) { toast(e.message); }
  }
  async function removeApp(a) {
    if (!confirm(`Remove ${a.name}?\n\nIt will disappear from the hub for everyone. You can add it again later.`)) return;
    try {
      await api(`/api/admin/apps/${a.id}`, { method: 'DELETE' });
      const gone = openTabs.filter((t) => t.app === a.id);
      if (gone.length) {
        for (const t of gone) dropFrame(t.tid);
        openTabs = openTabs.filter((t) => t.app !== a.id);
        if (active !== 'home' && !tabById(active)) activate('home'); else { renderTabs(); saveSession(); }
      }
      toast(`Removed ${a.name}.`); await refreshAdmin();
    } catch (e) { toast(e.message); }
  }

  // Edit takes you straight to the form, filled in.
  function editApp(a) {
    editingId = a.id;
    $('#fRepo').value = a.repo; $('#fName').value = a.name; $('#fCat').value = a.category || '';
    $('#fDesc').value = a.description || ''; $('#fPattern').value = a.assetPattern || ''; $('#fIcon').value = a.iconUrl || '';
    $('#formTitle').textContent = `Edit ${a.name}`; $('#saveAppBtn').textContent = 'Save changes';
    $('#cancelEditBtn').hidden = false; $('#formErr').textContent = '';
    const section = $('#appForm');
    section.scrollIntoView(smooth());
    section.classList.add('flash'); setTimeout(() => section.classList.remove('flash'), 1600);
    $('#fRepo').focus({ preventScroll: true });
  }
  function resetForm() {
    editingId = null;
    for (const id of ['fRepo', 'fName', 'fCat', 'fDesc', 'fPattern', 'fIcon']) $('#' + id).value = '';
    $('#formTitle').textContent = 'Add an app'; $('#saveAppBtn').textContent = 'Add app';
    $('#cancelEditBtn').hidden = true; $('#formErr').textContent = '';
  }
  $('#cancelEditBtn').addEventListener('click', resetForm);
  $('#saveAppBtn').addEventListener('click', async () => {
    $('#formErr').textContent = '';
    const body = {
      id: editingId || undefined, repo: $('#fRepo').value, name: $('#fName').value, category: $('#fCat').value,
      description: $('#fDesc').value, assetPattern: $('#fPattern').value, iconUrl: $('#fIcon').value,
    };
    try {
      await api('/api/admin/apps', { method: 'POST', body: JSON.stringify(body) });
      toast(editingId ? 'Saved.' : 'Added. Downloading the newest working release…');
      resetForm(); await refreshAdmin();
      $('#appsHeading').scrollIntoView(smooth());
    } catch (e) { $('#formErr').textContent = e.message; }
  });
  $('#checkAllBtn').addEventListener('click', async () => {
    try { await api('/api/admin/check', { method: 'POST', body: '{}' }); toast('Checking every app for updates…'); setTimeout(() => refreshAdmin().catch(() => {}), 1500); }
    catch (e) { toast(e.message); }
  });

  // ---------- home page footer settings ----------
  function fillSiteForm(s) {
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#siteForm')) return; // don't overwrite typing
    $('#sContactOn').checked = Boolean(s.contactEnabled);
    $('#sContact').value = s.contact || '';
    $('#sLabel').value = s.contactLabel || '';
  }
  $('#saveSiteBtn').addEventListener('click', async () => {
    $('#siteErr').textContent = '';
    try {
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ contactEnabled: $('#sContactOn').checked, contact: $('#sContact').value, contactLabel: $('#sLabel').value }) });
      toast('Footer saved.'); lastSig = ''; await loadApps();
    } catch (e) { $('#siteErr').textContent = e.message; }
  });

  // ---------- start ----------
  (async () => {
    showStorageNote(); renderProtection();
    const ok = await loadApps();
    if (!ok) return;
    const s = prefs.restore ? store.get('session', null) : null;
    if (s && Array.isArray(s.tabs)) {
      tidSeq = Number(s.seq) || 0;
      openTabs = s.tabs.map((x) => (typeof x === 'string' ? { app: x } : x)).filter((x) => x && appById(x.app))
        .map((x) => ({ tid: typeof x.tid === 'string' && /^t\d+$/.test(x.tid) ? x.tid : `t${++tidSeq}`, app: x.app, num: Number(x.num) || 1 }));
      for (const t of openTabs) tidSeq = Math.max(tidSeq, Number(t.tid.slice(1)) || 0);
      if (openTabs.length) {
        let want = s.active;
        if (typeof want === 'string' && !tabById(want)) want = openTabs.find((t) => t.app === want)?.tid || 'home';
        activate(want);
        toast(protectionState() === 'waiting' ? 'Reopened your tabs. Click anywhere to switch on the close warning, and open your files again if an app starts empty.' : 'Reopened your tabs. Open your files again if an app starts empty.');
        return;
      }
    }
    renderTabs();
  })();
})();
