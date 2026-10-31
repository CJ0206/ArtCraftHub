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
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
  }

  // ---------- state ----------
  let apps = [];
  let categories = {};         // group name -> colour chosen by the owner
  let openIds = [];            // tab order
  let active = 'home';
  const frames = new Map();    // id -> iframe (created lazily, kept alive while the tab is open)
  const appById = (id) => apps.find((a) => a.id === id);

  // ---------- group colours ----------
  const DEFAULT_CAT = { Office: 'var(--accent)', Create: 'var(--rose)', Other: 'var(--sage)' };
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
    if (meta) meta.setAttribute('content', t === 'dark' ? '#171a21' : '#f4f5f8');
  }
  $('#themeBtn').addEventListener('click', () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    store.set('theme', t); applyTheme(t);
  });
  applyTheme(document.documentElement.dataset.theme);

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
    checkForChanges();
    const sig = JSON.stringify([apps, categories]);
    if (sig !== lastSig) { lastSig = sig; renderHome(); renderTabs(); }
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

  function renderHome() {
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

  function tile(a) {
    const letter = h('span', { class: 'ico letter', 'aria-hidden': 'true', text: a.name.slice(0, 1).toUpperCase() });
    const icon = a.icon
      ? h('img', { class: 'ico', src: `/icons/${a.id}.png`, alt: '', width: 64, height: 64, onerror(e) { e.target.replaceWith(letter); } })
      : letter;
    const isOpen = openIds.includes(a.id);
    return h('button', { class: 'tile', type: 'button', onclick: () => openApp(a.id) },
      icon,
      h('span', {},
        h('span', { class: 'name', text: a.name }),
        a.description ? h('span', { class: 'desc', text: a.description }) : null,
        h('span', { class: 'ver' }, a.version ? `Version ${a.version}` : '', isOpen ? h('span', { class: 'open-pill', text: 'Open in a tab' }) : null)));
  }

  // ---------- tabs ----------
  function renderTabs() {
    const tabs = [tabEl({ id: 'home', name: 'Home' })];
    for (const id of openIds) { const a = appById(id); if (a) tabs.push(tabEl(a)); }
    $('#tabs').replaceChildren(...tabs);
    if ($('#groups').children.length) renderHome(); // refresh the "Open in a tab" markers
  }

  function tabEl(a) {
    const isHome = a.id === 'home';
    const isActive = active === a.id;
    const main = h('button', {
      class: 'main', type: 'button', role: 'tab', id: `tab-${a.id}`, 'aria-selected': String(isActive),
      'aria-controls': isHome ? 'home' : `frame-${a.id}`, tabindex: isActive ? '0' : '-1',
      onclick: () => activate(a.id), onkeydown: tabKeys,
    }, isHome ? null : h('span', { class: 'dot' }), h('span', { class: 'label', text: a.name }));
    const wrap = h('div', { class: 'tab' + (isActive ? ' active' : '') + (!isHome && !frames.has(a.id) ? ' unloaded' : ''), role: 'presentation' }, main);
    if (!isHome) {
      paint(wrap, a.category);
      wrap.append(h('button', { class: 'x', type: 'button', 'aria-label': `Close ${a.name}`, title: 'Close tab', onclick: (e) => { e.stopPropagation(); closeApp(a.id); } }, '×'));
      wrap.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeApp(a.id); } });
    }
    return wrap;
  }
  function tabKeys(e) {
    const order = ['home', ...openIds];
    const i = order.indexOf(active);
    let n = null;
    if (e.key === 'ArrowRight') n = order[(i + 1) % order.length];
    else if (e.key === 'ArrowLeft') n = order[(i - 1 + order.length) % order.length];
    else if (e.key === 'Home') n = order[0];
    else if (e.key === 'End') n = order[order.length - 1];
    if (n) { e.preventDefault(); activate(n); $(`#tab-${n}`)?.focus(); }
  }

  // ---------- opening, switching, closing ----------
  function makeFrame(a) {
    const f = h('iframe', {
      class: 'frame', id: `frame-${a.id}`, title: a.name, src: `/apps/${a.id}/`,
      allow: 'clipboard-read; clipboard-write; fullscreen; autoplay; encrypted-media',
      allowfullscreen: true, 'data-id': a.id,
    });
    frames.set(a.id, f); $('#frames').append(f);
    return f;
  }

  function activate(id) {
    if (id !== 'home' && !appById(id)) id = 'home';
    active = id;
    $('#home').hidden = id !== 'home';
    for (const [fid, f] of frames) {
      const on = fid === id;
      f.classList.toggle('active', on);
      f.inert = !on;
    }
    if (id !== 'home') {
      const a = appById(id);
      const f = frames.get(id) || makeFrame(a);
      f.classList.add('active'); f.inert = false;
      document.title = `${a.name} · ArtCraft Hub`;
      requestAnimationFrame(() => { try { f.contentWindow.focus(); } catch { /* not ready */ } });
      keepStorage();
    } else {
      document.title = 'ArtCraft Hub';
      loadApps();
    }
    renderTabs(); saveSession();
  }

  function openApp(id) {
    if (!openIds.includes(id)) openIds.push(id);
    activate(id);
  }

  function closeApp(id) {
    const a = appById(id);
    if (frames.has(id) && !confirm(`Close ${a ? a.name : 'this tab'}?\n\nAnything you haven’t saved to your device will be lost.`)) return;
    const idx = openIds.indexOf(id);
    openIds = openIds.filter((x) => x !== id);
    frames.get(id)?.remove(); frames.delete(id);
    if (active === id) activate(openIds[Math.min(idx, openIds.length - 1)] || 'home');
    else { renderTabs(); saveSession(); }
  }

  // ---------- session memory and warnings ----------
  const prefs = { warn: store.get('warn', true), restore: store.get('restore', true) };
  $('#warnPref').checked = prefs.warn;
  $('#restorePref').checked = prefs.restore;
  $('#warnPref').addEventListener('change', (e) => { prefs.warn = e.target.checked; store.set('warn', prefs.warn); });
  $('#restorePref').addEventListener('change', (e) => { prefs.restore = e.target.checked; store.set('restore', prefs.restore); if (!prefs.restore) store.set('session', null); else saveSession(); });

  function saveSession() { if (prefs.restore) store.set('session', { tabs: openIds, active }); }

  window.addEventListener('beforeunload', (e) => {
    if (prefs.warn && frames.size) { e.preventDefault(); e.returnValue = ''; }
  });

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
  $('#tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#loginBtn').click(); });
  $('#loginBtn').addEventListener('click', async () => {
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
      ? `Apps check GitHub for new releases every ${data.intervalHours} hours.`
      : 'Automatic update checks are turned off.';
    renderAdminList(data.apps);
    renderCategoryEditor(data.apps);
    $('#catList').replaceChildren(...catOrder(new Set(['Office', 'Create', 'Other', ...data.apps.map((a) => a.category).filter(Boolean)])).map((c) => h('option', { value: c })));
    const busy = data.apps.some((a) => a.installing);
    if (busy && !pollTimer) pollTimer = setInterval(() => refreshAdmin().catch(() => {}), 3000);
    if (!busy && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function renderAdminList(list) {
    $('#adminList').replaceChildren(...list.map((a) => {
      let status;
      if (a.installing) status = h('span', { class: 'meta', text: 'Downloading and installing…' });
      else if (a.error) status = h('span', { class: 'bad', text: a.error });
      else if (a.installed) status = h('span', { class: 'meta', text: `Version ${a.version}, installed ${fmtDate(a.updatedAt)}, last checked ${fmtDate(a.checkedAt)}` });
      else status = h('span', { class: 'meta', text: 'Waiting for the first install…' });
      return paint(h('li', {},
        h('div', { class: 'top' },
          h('span', { class: 'nm' }, h('span', { class: 'dot' }), a.name),
          h('span', { class: 'btns' },
            h('button', { class: 'btn', type: 'button', onclick: () => updateOne(a) }, 'Update now'),
            h('button', { class: 'btn', type: 'button', onclick: () => editApp(a) }, 'Edit'),
            h('button', { class: 'btn danger', type: 'button', onclick: () => removeApp(a) }, 'Remove'))),
        h('span', { class: 'meta', text: `${a.repo} · group: ${a.category}` }),
        status), a.category);
    }));
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
      return paint(h('div', { class: 'catrow' },
        h('span', { class: 'nm' }, h('span', { class: 'dot' }), name),
        h('span', { class: 'swatches' }, swatches, picker),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => setCategoryColour(name, '') }, 'Reset')), name);
    }));
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
    try { await api(`/api/admin/apps/${a.id}/update`, { method: 'POST', body: '{}' }); toast(`Updating ${a.name}…`); await refreshAdmin(); }
    catch (e) { toast(e.message); }
  }
  async function removeApp(a) {
    if (!confirm(`Remove ${a.name}?\n\nIt will disappear from the hub for everyone. You can add it again later.`)) return;
    try {
      await api(`/api/admin/apps/${a.id}`, { method: 'DELETE' });
      if (openIds.includes(a.id)) { frames.get(a.id)?.remove(); frames.delete(a.id); openIds = openIds.filter((x) => x !== a.id); if (active === a.id) activate('home'); }
      toast(`Removed ${a.name}.`); await refreshAdmin();
    } catch (e) { toast(e.message); }
  }
  function editApp(a) {
    editingId = a.id;
    $('#fRepo').value = a.repo; $('#fName').value = a.name; $('#fCat').value = a.category || '';
    $('#fDesc').value = a.description || ''; $('#fPattern').value = a.assetPattern || '';
    $('#formTitle').textContent = `Edit ${a.name}`; $('#saveAppBtn').textContent = 'Save and reinstall';
    $('#cancelEditBtn').hidden = false; $('#fRepo').focus();
  }
  function resetForm() {
    editingId = null;
    for (const id of ['fRepo', 'fName', 'fCat', 'fDesc', 'fPattern']) $('#' + id).value = '';
    $('#formTitle').textContent = 'Add an app'; $('#saveAppBtn').textContent = 'Add app';
    $('#cancelEditBtn').hidden = true; $('#formErr').textContent = '';
  }
  $('#cancelEditBtn').addEventListener('click', resetForm);
  $('#saveAppBtn').addEventListener('click', async () => {
    $('#formErr').textContent = '';
    const body = {
      id: editingId || undefined, repo: $('#fRepo').value, name: $('#fName').value, category: $('#fCat').value,
      description: $('#fDesc').value, assetPattern: $('#fPattern').value,
    };
    try {
      await api('/api/admin/apps', { method: 'POST', body: JSON.stringify(body) });
      toast(editingId ? 'Saved. Reinstalling…' : 'Added. Downloading the latest release…');
      resetForm(); await refreshAdmin();
    } catch (e) { $('#formErr').textContent = e.message; }
  });
  $('#checkAllBtn').addEventListener('click', async () => {
    try { await api('/api/admin/check', { method: 'POST', body: '{}' }); toast('Checking every app for updates…'); setTimeout(() => refreshAdmin().catch(() => {}), 1500); }
    catch (e) { toast(e.message); }
  });

  // ---------- start ----------
  (async () => {
    showStorageNote();
    const ok = await loadApps();
    if (!ok) return;
    const s = prefs.restore ? store.get('session', null) : null;
    if (s && Array.isArray(s.tabs)) {
      openIds = s.tabs.filter((id) => appById(id));
      if (openIds.length) { activate(openIds.includes(s.active) ? s.active : 'home'); toast('Reopened your tabs. Open your files again if an app starts empty.'); return; }
    }
    renderTabs();
  })();
})();
