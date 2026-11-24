/* LightSSH renderer — Termius-style layout, Hark-style surfaces */
const VERSION = '1.6.0';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DEFAULTS = { lang: '', fontSize: 14, fontFamily: 'Cascadia Mono', theme: 'system', termTheme: 'dark', cursorStyle: 'bar', copyOnSelect: true };
let settings = { ...DEFAULTS };
let hosts = [];
let snippets = [];
let forwards = [];
const fwdState = new Map();
const groups = new Map(); // gid -> [sid]
let gseq = 0;
let nav = 'hosts';
const tabs = new Map();
let activeTab = 'home';

hydrateIcons();
$('#ver').textContent = VERSION;

// ---------- i18n ----------
function t(k, ...a) {
  let s = (I18N[settings.lang] || I18N.en)[k] ?? I18N.en[k] ?? k;
  a.forEach((v, i) => { s = s.replace(`{${i}}`, v); });
  return s;
}
function applyI18n(root = document) {
  document.documentElement.lang = settings.lang === 'zh' ? 'zh-CN' : 'en';
  $$('[data-i18n]', root).forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-ph]', root).forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  $$('[data-i18n-title]', root).forEach((el) => { el.title = t(el.dataset.i18nTitle); });
}
function refreshTexts() {
  applyI18n();
  $('#homeTabLabel').textContent = t(nav);
  renderKeys();
  renderHosts(); renderSnippets(); renderLive();
  for (const tab of tabs.values()) { updateStatus(tab); if (tab.files) renderFiles(tab); }
}

// ---------- theme ----------
const mq = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => settings.theme === 'dark' || (settings.theme === 'system' && mq.matches);
const TERM_DARK = {
  background: '#161617', foreground: '#d6d5cf', cursor: '#d6d5cf', cursorAccent: '#161617', selectionBackground: 'rgba(214,213,207,0.18)',
  black: '#2a2928', red: '#d9695c', green: '#97a849', yellow: '#d6ad3a', blue: '#5c95c7', magenta: '#cf6f9f', cyan: '#4fb3a8', white: '#bdbbb3',
  brightBlack: '#6f6e69', brightRed: '#ea8a7e', brightGreen: '#b0bf68', brightYellow: '#e5c35e', brightBlue: '#7fb0d9', brightMagenta: '#e091b8', brightCyan: '#74c7bd', brightWhite: '#f4f3ee',
};
const TERM_LIGHT = {
  background: '#f7f6f3', foreground: '#1f1f21', cursor: '#1f1f21', cursorAccent: '#f7f6f3', selectionBackground: 'rgba(46,79,255,0.14)',
  black: '#1f1f21', red: '#b13a2f', green: '#5f7a12', yellow: '#9a7406', blue: '#2a63a8', magenta: '#a3356f', cyan: '#237f77', white: '#8a8983',
  brightBlack: '#6f6e69', brightRed: '#c9483c', brightGreen: '#6f8c17', brightYellow: '#ad8301', brightBlue: '#3471bd', brightMagenta: '#b8407e', brightCyan: '#2b938a', brightWhite: '#100f0f',
};
const termTheme = () => (settings.termTheme === 'match' && !isDark() ? TERM_LIGHT : TERM_DARK);
function applyTheme() {
  const dark = isDark();
  document.body.classList.toggle('dark', dark);
  document.body.classList.toggle('term-light', termTheme() === TERM_LIGHT);
  api.setTheme?.(dark);
  for (const tab of tabs.values()) tab.term.options.theme = termTheme();
}
mq.addEventListener('change', () => { if (settings.theme === 'system') applyTheme(); });

// ---------- settings ----------
const termFont = () => `"${settings.fontFamily}", "Cascadia Mono", Consolas, "Sarasa Mono SC", "Microsoft YaHei", monospace`;
const saveSettings = () => api.settings.set(settings);
function applySettings() {
  applyTheme();
  for (const tab of tabs.values()) {
    Object.assign(tab.term.options, { fontSize: settings.fontSize, fontFamily: termFont(), cursorStyle: settings.cursorStyle });
    fit(tab);
  }
}
function syncSettingsUI() {
  $$('#setTheme button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.theme));
  $$('#setLang button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.lang));
  $$('#setTermTheme button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.termTheme));
  $$('#setCursor button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.cursorStyle));
  $('#setFont').value = settings.fontSize; $('#setFontV').textContent = settings.fontSize;
  $('#setFamily').value = settings.fontFamily;
  $('#setCopySel').checked = settings.copyOnSelect;
}
$('#setTheme').onclick = (e) => { const v = e.target.dataset.v; if (!v) return; settings.theme = v; saveSettings(); applySettings(); syncSettingsUI(); };
$('#setLang').onclick = (e) => { const v = e.target.dataset.v; if (!v) return; settings.lang = v; saveSettings(); syncSettingsUI(); refreshTexts(); };
$('#setTermTheme').onclick = (e) => { const v = e.target.dataset.v; if (!v) return; settings.termTheme = v; saveSettings(); applySettings(); syncSettingsUI(); };
$('#setCursor').onclick = (e) => { const v = e.target.dataset.v; if (!v) return; settings.cursorStyle = v; saveSettings(); applySettings(); syncSettingsUI(); };
$('#setFont').oninput = (e) => { settings.fontSize = +e.target.value; $('#setFontV').textContent = settings.fontSize; applySettings(); };
$('#setFont').onchange = saveSettings;
$('#setFamily').onchange = (e) => { settings.fontFamily = e.target.value; applySettings(); saveSettings(); };
$('#setCopySel').onchange = (e) => { settings.copyOnSelect = e.target.checked; saveSettings(); };
function renderKeys() {
  const rows = [['kPalette', 'Ctrl K'], ['kFind', 'Ctrl F'], ['kCopy', 'Ctrl Shift C / V'], ['kTab', 'Ctrl Tab'], ['kSplit', 'Ctrl Shift D'], ['kClose', 'Ctrl Shift W'], ['kHome', 'Ctrl Shift T'], ['kFont', 'Ctrl + / − / 0'], ['kRe', 'Enter']];
  $('#keysList').innerHTML = rows.map(([k, v]) => `<div class="key-row"><span>${t(k)}</span><span>${v.split(' ').map((x) => x === '/' ? '<i>/</i>' : `<kbd>${x}</kbd>`).join('')}</span></div>`).join('');
}

// ---------- toast / prompt / drawers ----------
let toastTimer;
function toast(msg, err) {
  const el = $('#toast');
  el.textContent = msg; el.className = err ? 'err' : '';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}
// prompts are queued: if two sessions ask at the same time, the second waits for the first
let askChain = Promise.resolve();
function ask(title, opts) {
  const run = askChain.then(() => askNow(title, opts));
  askChain = run.catch(() => {});
  return run;
}
function askNow(title, { value = '', type = 'text', confirmOnly = false, danger = false } = {}) {
  return new Promise((resolve) => {
    const m = $('#prompt'), inp = $('#promptInput'), ok = $('#promptOk');
    $('#promptTitle').textContent = title;
    inp.classList.toggle('hidden', confirmOnly);
    inp.type = type; inp.value = value;
    ok.textContent = danger ? t('delete') : t('ok');
    ok.className = 'btn ' + (danger ? 'red' : 'dark');
    m.classList.remove('hidden');
    setTimeout(() => { if (confirmOnly) ok.focus(); else { inp.focus(); inp.select(); } }, 0);
    const done = (v) => { m.classList.add('hidden'); $('#promptForm').onsubmit = null; $('#promptCancel').onclick = null; m._cancel = null; resolve(v); };
    $('#promptForm').onsubmit = (e) => { e.preventDefault(); done(confirmOnly ? true : inp.value); };
    $('#promptCancel').onclick = () => done(confirmOnly ? false : null);
    m._cancel = () => done(confirmOnly ? false : null);
  });
}
const confirmBox = (msg) => ask(msg, { confirmOnly: true, danger: true });
const openDrawer = (sel) => { closeDrawers(); $(sel).classList.add('open'); };
const closeDrawers = () => $$('.drawer').forEach((d) => d.classList.remove('open'));
document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeDrawers(); });

// ---------- context menu ----------
function showMenu(x, y, items) {
  const el = $('#ctx');
  el.innerHTML = items.map((it, i) => it === '-' ? '<div class="sep"></div>'
    : `<button data-i="${i}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>${icon(it.icon)}<span>${esc(it.label)}</span>${it.hint ? `<kbd>${it.hint}</kbd>` : ''}</button>`).join('');
  el.classList.remove('hidden');
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 6)) + 'px';
  el.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 6)) + 'px';
  el.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; hideMenu(); items[b.dataset.i].run(); };
}
function hideMenu() { $('#ctx').classList.add('hidden'); }
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctx')) hideMenu(); });
window.addEventListener('blur', hideMenu);

// ---------- data ----------
async function loadHosts() { hosts = await api.hosts.list(); renderHosts(); renderLive(); if (forwards.length) renderForwards(); }
async function loadSnippets() { snippets = await api.snippets.list(); renderSnippets(); }
async function loadForwards() { forwards = await api.fwd.list(); forwards.forEach((f) => { if (!fwdState.has(f.id) || f.state === 'running') fwdState.set(f.id, f.state); }); renderForwards(); }

const hue = (s) => { let h = 7; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const avatar = (h, cls = '') => `<div class="av ${cls}" style="--h:${hue(h.name + h.host)}">${icon('server')}</div>`;
const groupBy = (list) => {
  const g = {}; list.forEach((h) => { (g[h.group || ''] ||= []).push(h); });
  return Object.keys(g).sort((a, b) => (a === '') - (b === '') || a.localeCompare(b)).map((k) => [k, g[k]]);
};
const liveHostIds = () => new Set([...tabs.values()].filter((x) => x.state === 'connected').map((x) => x.hostId));
const jumpName = (h) => (h.jumpHostId ? hosts.find((x) => x.id === h.jumpHostId)?.name || '' : '');
const hostAddr = (h) => `${h.username}@${h.host}${h.port != 22 ? ':' + h.port : ''}`;

// ---------- navigation ----------
function setNav(n) {
  nav = n;
  $$('#sidebar .nav').forEach((b) => b.classList.toggle('on', b.dataset.nav === n));
  $$('#views .page').forEach((v) => v.classList.toggle('active', v.id === 'view-' + n && activeTab === 'home'));
  $('#homeTabLabel').textContent = t(n);
  $('#homeTabIcon').innerHTML = icon({ hosts: 'server', snippets: 'zap', forwards: 'forward', settings: 'sliders' }[n]);
  if (n === 'settings') syncSettingsUI();
  switchTab('home');
}
$$('#sidebar .nav').forEach((b) => b.onclick = () => setNav(b.dataset.nav));

// ---------- sidebar: live sessions ----------
function renderLive() {
  const list = [...tabs.values()];
  $('#liveLabel').classList.toggle('hidden', !list.length);
  const vis = activeTab !== 'home' ? paneList(activeTab) : [];
  $('#liveList').innerHTML = list.map((tab) => `
    <button class="live ${tab.sid === activeTab ? 'on' : vis.includes(tab.sid) ? 'vis' : ''}" data-sid="${tab.sid}">
      <span class="st" data-state="${tab.state}"></span><span class="tl">${esc(tab.label)}</span>
    </button>`).join('');
  $('#navHostCount').textContent = hosts.length || '';
  $('#navSnipCount').textContent = snippets.length || '';
  const nRun = [...fwdState.values()].filter((s) => s === 'running').length;
  $('#navFwdCount').innerHTML = nRun ? `<span class="run-dot"></span>${nRun}` : (forwards.length || '');
}
$('#liveList').addEventListener('click', (e) => { const b = e.target.closest('.live'); if (b) switchTab(b.dataset.sid); });

// ---------- hosts page ----------
function renderHosts() {
  const q = $('#omni').value.trim().toLowerCase();
  const list = hosts.filter((h) => !q || [h.name, h.host, h.username, h.group].join(' ').toLowerCase().includes(q));
  const el = $('#hostsContent');
  const live = liveHostIds();
  $('#hostsSub').textContent = t('hostsSub', hosts.length) + (live.size ? ' · ' + t('hostsLive', live.size) : '');
  if (!hosts.length) {
    el.innerHTML = `<div class="empty">
      <div class="empty-ic">${icon('server')}</div><h3>${t('emptyTip')}</h3><p>${t('emptySub')}</p>
      <div class="row center"><button class="btn dark" data-home="new">${icon('plus')}<span>${t('newHost')}</span></button>
      <button class="btn" data-home="import">${icon('download')}<span>${t('importSsh')}</span></button></div></div>`;
    return;
  }
  const card = (h) => `
    <div class="hcard" data-id="${h.id}">
      ${avatar(h)}
      <div class="hc-text"><div class="hc-name">${esc(h.name)}${live.has(h.id) ? '<span class="live-dot"></span>' : ''}</div>
        <div class="hc-addr">${esc(hostAddr(h))}</div>
        <div class="chips"><span class="chip">${icon(h.authType === 'key' ? 'key' : 'lock')}${h.authType === 'key' ? t('authKey') : t('authPwd')}</span>${jumpName(h) ? `<span class="chip">${icon('route')}${esc(jumpName(h))}</span>` : ''}</div></div>
      <button class="ib hc-edit" data-act="edit" title="${t('edit')}">${icon('edit')}</button>
    </div>`;
  const recent = !q && hosts.length > 6 ? hosts.filter((h) => h.lastUsed).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 3) : [];
  el.innerHTML = `
    ${recent.length ? `<div class="sec-title">${t('recent')}</div><div class="hgrid">${recent.map(card).join('')}</div>` : ''}
    ${groupBy(list).map(([g, hs]) => `<div class="sec-title">${esc(g || (recent.length ? t('allHosts') : t('ungrouped')))}<em>${hs.length}</em></div><div class="hgrid">${hs.map(card).join('')}</div>`).join('')}
    ${!list.length ? `<div class="none">${esc(q)} · ${t('badQuick')}</div>` : ''}`;
}
$('#hostsContent').addEventListener('click', (e) => {
  if (e.target.closest('[data-home="new"]')) return openHostEditor(null);
  if (e.target.closest('[data-home="import"]')) return importSshConfig(false);
  const c = e.target.closest('.hcard'); if (!c) return;
  const h = hosts.find((x) => x.id === c.dataset.id);
  if (e.target.closest('[data-act="edit"]')) openHostEditor(h); else openSession(h.id);
});
$('#hostsContent').addEventListener('contextmenu', (e) => {
  const c = e.target.closest('.hcard'); if (!c) return;
  e.preventDefault(); hostMenu(e.clientX, e.clientY, hosts.find((x) => x.id === c.dataset.id));
});
$('#btnNewHost').onclick = () => openHostEditor(null);
$('#btnImport').onclick = () => importSshConfig(false);
async function importSshConfig(pick) {
  try {
    const r = await api.hosts.importSshConfig(pick);
    if (!r) return;
    await loadHosts();
    toast(t('imported', r.added, r.skipped));
  } catch (err) { toast(t('failed', cleanErr(err)), true); }
}
$('#omni').addEventListener('input', renderHosts);
$('#omni').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const v = e.target.value.trim(); if (!v) return;
  const m = v.match(/^(?:ssh\s+)?(?:-p\s*(\d+)\s+)?([^@\s]+)@([^:\s]+)(?::(\d+))?(?:\s+-p\s*(\d+))?$/);
  if (m) { openSession(null, { username: m[2], host: m[3], port: Number(m[4] || m[1] || m[5]) || 22 }); e.target.value = ''; renderHosts(); return; }
  const q = v.toLowerCase();
  const hit = hosts.filter((h) => [h.name, h.host, h.username, h.group].join(' ').toLowerCase().includes(q));
  if (hit.length === 1) { openSession(hit[0].id); e.target.value = ''; renderHosts(); } else if (!hit.length) toast(t('badQuick'), true);
});

function hostMenu(x, y, h) {
  showMenu(x, y, [
    { icon: 'terminal', label: t('connect'), run: () => openSession(h.id) },
    { icon: 'edit', label: t('edit'), run: () => openHostEditor(h) },
    { icon: 'copy', label: t('duplicate'), run: () => openHostEditor(h, true) },
    '-',
    { icon: 'trash', label: t('delete'), danger: true, run: () => deleteHost(h) },
  ]);
}
async function deleteHost(h) {
  if (await confirmBox(t('confirmDelHost', h.name))) { await api.hosts.remove(h.id); closeDrawers(); loadHosts(); }
}

// ---------- snippets page ----------
function renderSnippets() {
  const q = $('#snipSearch').value.trim().toLowerCase();
  const list = snippets.filter((s) => !q || (s.name + ' ' + s.command).toLowerCase().includes(q));
  $('#snipContent').innerHTML = !snippets.length
    ? `<div class="empty"><div class="empty-ic">${icon('zap')}</div><h3>${t('snippets')}</h3><p>${t('emptySnip')}</p>
        <button class="btn dark" data-snip="new">${icon('plus')}<span>${t('newSnippet')}</span></button></div>`
    : `<div class="sgrid">${list.map((s) => `
      <div class="scard" data-sid="${s.id}">
        <div class="sc-head"><span class="sn-ic">${icon('zap')}</span><span class="hc-name">${esc(s.name)}</span>
          <span class="hc-meta">${t('snipCount', s.command.split('\n').length)}</span>
          <button class="ib hc-edit" data-act="edit" title="${t('edit')}">${icon('edit')}</button></div>
        <pre class="sn-cmd">${esc(s.command)}</pre>
      </div>`).join('')}</div>`;
  renderLive();
}
$('#snipSearch').addEventListener('input', renderSnippets);
$('#btnNewSnip').onclick = () => openSnipEditor(null);
$('#snipContent').addEventListener('click', (e) => {
  if (e.target.closest('[data-snip="new"]')) return openSnipEditor(null);
  const c = e.target.closest('.scard'); if (c) openSnipEditor(snippets.find((x) => x.id === c.dataset.sid));
});
$('#snipContent').addEventListener('contextmenu', (e) => {
  const c = e.target.closest('.scard'); if (!c) return;
  e.preventDefault();
  const s = snippets.find((x) => x.id === c.dataset.sid);
  showMenu(e.clientX, e.clientY, [
    { icon: 'edit', label: t('edit'), run: () => openSnipEditor(s) },
    { icon: 'copy', label: t('copy'), run: () => { api.clip.write(s.command); toast(t('copied')); } },
    '-',
    { icon: 'trash', label: t('delete'), danger: true, run: async () => { if (await confirmBox(t('confirmDelSnip', s.name))) { await api.snippets.remove(s.id); loadSnippets(); } } },
  ]);
});
function runSnippet(tab, s, run = true) {
  if (!tab || tab.state !== 'connected') return toast(t('noSession'), true);
  api.ssh.write(tab.sid, s.command.replace(/\r?\n/g, '\r') + (run ? '\r' : ''));
  tab.term.focus();
}

// ---------- host editor (drawer) ----------
const form = $('#hostForm'), fe = form.elements;
let connectAfterSave = false;
function setAuthUI() {
  const key = fe.authType.value === 'key';
  $('.auth-pwd', form).classList.toggle('hidden', key);
  $('.auth-key', form).classList.toggle('hidden', !key);
}
function openHostEditor(h, duplicate = false) {
  form.reset();
  $('#formTitle').textContent = h && !duplicate ? t('editHost') : t('addHost');
  fe.id.value = h && !duplicate ? h.id : '';
  fe.copyFrom.value = duplicate ? h.id : '';
  fe.name.value = h ? h.name + (duplicate ? ' (2)' : '') : '';
  fe.group.value = h?.group || '';
  fe.host.value = h?.host || '';
  fe.port.value = h?.port || 22;
  fe.username.value = h?.username || '';
  fe.authType.value = h?.authType || 'password';
  fe.keyPath.value = h?.keyPath || '';
  fe.password.placeholder = h?.hasPassword ? t('fPwdKeep') : t('fPwdPh');
  fe.passphrase.placeholder = h?.hasPassphrase ? t('fPwdKeep') : '';
  $('#jumpSelect').innerHTML = `<option value="">${t('noJump')}</option>` + hosts.filter((x) => !h || duplicate || x.id !== h.id)
    .map((x) => `<option value="${x.id}">${esc(x.name)} · ${esc(hostAddr(x))}</option>`).join('');
  fe.jumpHostId.value = h?.jumpHostId || '';
  $('#groupList').innerHTML = [...new Set(hosts.map((x) => x.group).filter(Boolean))].map((g) => `<option value="${esc(g)}">`).join('');
  $('#btnDel').classList.toggle('hidden', !h || duplicate);
  $('#btnDup').classList.toggle('hidden', !h || duplicate);
  setAuthUI();
  openDrawer('#hostDrawer');
  setTimeout(() => (h ? fe.name : fe.host).focus(), 180);
}
form.addEventListener('change', (e) => { if (e.target.name === 'authType') setAuthUI(); });
$('#btnPickKey').onclick = async () => { const p = await api.pickKey(); if (p) fe.keyPath.value = p; };
$('#btnDel').onclick = () => { const h = hosts.find((x) => x.id === fe.id.value); if (h) deleteHost(h); };
$('#btnDup').onclick = () => { const h = hosts.find((x) => x.id === fe.id.value); if (h) openHostEditor(h, true); };
$('#btnSaveConnect').onclick = () => { connectAfterSave = true; form.requestSubmit(); };
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const go = connectAfterSave; connectAfterSave = false;
  const saved = await api.hosts.save(Object.fromEntries(new FormData(form).entries()));
  closeDrawers();
  await loadHosts();
  if (go && saved?.id) openSession(saved.id); else toast(t('saved'));
});

// ---------- snippet editor (drawer) ----------
const sform = $('#snipForm'), se = sform.elements;
function openSnipEditor(s) {
  sform.reset();
  $('#snipTitle').textContent = s ? t('editSnippet') : t('addSnippet');
  se.id.value = s?.id || ''; se.name.value = s?.name || ''; se.command.value = s?.command || '';
  $('#snipDel').classList.toggle('hidden', !s);
  openDrawer('#snipDrawer');
  setTimeout(() => (s ? se.name : se.command).focus(), 180);
}
$('#snipDel').onclick = async () => {
  const s = snippets.find((x) => x.id === se.id.value);
  if (s && await confirmBox(t('confirmDelSnip', s.name))) { await api.snippets.remove(s.id); closeDrawers(); loadSnippets(); }
};
sform.addEventListener('submit', async (e) => {
  e.preventDefault();
  await api.snippets.save(Object.fromEntries(new FormData(sform).entries()));
  closeDrawers();
  loadSnippets();
});

// ---------- tabs ----------
const paneList = (sid) => { const tb = tabs.get(sid); return tb?.gid ? groups.get(tb.gid) : [sid]; };
function layoutPanes(list) {
  const n = list.length;
  const R = n === 2 ? [[0, 0, 50, 100], [50, 0, 50, 100]]
    : n === 3 ? [[0, 0, 50, 100], [50, 0, 50, 50], [50, 50, 50, 50]]
    : n === 4 ? [[0, 0, 50, 50], [50, 0, 50, 50], [0, 50, 50, 50], [50, 50, 50, 50]] : null;
  list.forEach((sid, i) => {
    const v = tabs.get(sid).view;
    v.classList.toggle('pane', !!R);
    if (R) { const [x, y, w, hh] = R[i]; Object.assign(v.style, { left: x + '%', top: y + '%', width: w + '%', height: hh + '%' }); }
    else v.removeAttribute('style');
  });
}
function markFocus() {
  const list = activeTab === 'home' ? [] : paneList(activeTab);
  $$('#tabbar .tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.tab === activeTab);
    el.classList.toggle('shown', el.dataset.tab !== activeTab && list.includes(el.dataset.tab));
  });
  for (const tb of tabs.values()) tb.view.classList.toggle('focused', list.length > 1 && tb.sid === activeTab);
  renderLive();
}
function switchTab(id) {
  activeTab = id;
  const list = id === 'home' ? [] : paneList(id);
  $$('#views .view').forEach((el) => el.classList.toggle('active', id === 'home' ? el.id === 'view-' + nav : list.some((s) => el.id === 'view-' + s)));
  $$('#sidebar .nav').forEach((b) => b.classList.toggle('on', id === 'home' && b.dataset.nav === nav));
  if (list.length) layoutPanes(list);
  markFocus();
  const tab = tabs.get(id);
  if (tab) { closeDrawers(); setTimeout(() => { list.forEach((s) => fit(tabs.get(s))); tab.term.focus(); }, 0); }
  else if (nav === 'hosts') setTimeout(() => $('#omni').focus(), 0);
}
function focusPane(sid) { if (activeTab === sid) return; activeTab = sid; markFocus(); }
function splitWith(a, b) {
  const A = tabs.get(a), B = tabs.get(b);
  if (!A || !B || a === b) return;
  if (B.gid) detach(b, false);
  let gid = A.gid;
  if (!gid) { gid = 'g' + (++gseq); A.gid = gid; groups.set(gid, [a]); }
  const g = groups.get(gid);
  if (g.length >= 4) return toast(t('maxPanes'), true);
  g.push(b); B.gid = gid;
  tabs.get(g[g.length - 2]).tabEl.after(B.tabEl);
  g.forEach((s) => tabs.get(s).tabEl.classList.add('grouped'));
  switchTab(b);
}
function detach(sid, show = true) {
  const tb = tabs.get(sid); if (!tb?.gid) return;
  const g = groups.get(tb.gid);
  g.splice(g.indexOf(sid), 1);
  tb.gid = null; tb.tabEl.classList.remove('grouped'); tb.view.classList.remove('pane', 'focused'); tb.view.removeAttribute('style');
  if (g.length === 1) { const o = tabs.get(g[0]); o.gid = null; o.tabEl.classList.remove('grouped'); o.view.classList.remove('pane', 'focused'); o.view.removeAttribute('style'); groups.delete([...groups].find(([, v]) => v === g)[0]); }
  if (show) switchTab(sid);
}
function splitMenu(tab, x, y) {
  const mine = paneList(tab.sid);
  const others = [...tabs.values()].filter((o) => !mine.includes(o.sid));
  showMenu(x, y, [
    { icon: 'split', label: t('splitNew'), hint: 'Ctrl+Shift+D', disabled: mine.length >= 4, run: () => openSession(tab.hostId, tab.quick, tab.sid) },
    ...others.map((o) => ({ icon: 'terminal', label: t('splitWith', o.label), disabled: mine.length >= 4, run: () => splitWith(tab.sid, o.sid) })),
    ...(tab.gid ? ['-', { icon: 'unsplit', label: t('unsplit'), run: () => detach(tab.sid) }] : []),
  ]);
}
$('#tabbar').addEventListener('click', (e) => {
  const el = e.target.closest('.tab'); if (!el) return;
  if (e.target.closest('.x')) return closeTab(el.dataset.tab);
  switchTab(el.dataset.tab);
});
$('#tabbar').addEventListener('auxclick', (e) => { const el = e.target.closest('.tab'); if (e.button === 1 && el && el.dataset.tab !== 'home') closeTab(el.dataset.tab); });
$('#tabbar').addEventListener('contextmenu', (e) => {
  const el = e.target.closest('.tab'); if (!el || el.dataset.tab === 'home') return;
  e.preventDefault();
  const tab = tabs.get(el.dataset.tab);
  showMenu(e.clientX, e.clientY, [
    { icon: 'refresh', label: t('reconnect'), disabled: tab.state === 'connecting', run: () => reconnect(tab) },
    { icon: 'copy', label: t('duplicate'), run: () => openSession(tab.hostId, tab.quick) },
    { icon: 'split', label: t('splitNew'), hint: 'Ctrl+Shift+D', run: () => openSession(tab.hostId, tab.quick, tab.sid) },
    ...(tab.gid ? [{ icon: 'unsplit', label: t('unsplit'), run: () => detach(tab.sid) }] : []),
    '-',
    { icon: 'x', label: t('close'), hint: 'Ctrl+Shift+W', run: () => closeTab(tab.sid) },
  ]);
});
function closeTab(sid) {
  const tab = tabs.get(sid); if (!tab) return;
  const mates = paneList(sid).filter((s) => s !== sid);
  if (tab.gid) detach(sid, false);
  api.ssh.close(sid);
  cancelAnimationFrame(tab.fitRaf); tab.ro.disconnect(); tab.term.dispose();
  tab.tabEl.remove(); tab.view.remove();
  tabs.delete(sid);
  if (activeTab === sid || mates.includes(activeTab)) switchTab(mates[0] || [...tabs.keys()].pop() || 'home');
  renderLive(); renderHosts();
}

// ---------- sessions ----------
let seq = 0;
function openSession(hostId, quick, splitFrom) {
  const h = hostId ? hosts.find((x) => x.id === hostId) : null;
  const label = h ? h.name : `${quick.username}@${quick.host}`;
  const addr = h ? `${h.username}@${h.host}:${h.port}` : `${quick.username}@${quick.host}:${quick.port}`;
  const sid = 's' + (++seq) + '_' + Date.now();

  const tabEl = document.createElement('div');
  tabEl.className = 'tab'; tabEl.dataset.tab = sid;
  tabEl.innerHTML = `<span class="st"></span><span class="tl">${esc(label)}</span><span class="x">${icon('x')}</span>`;
  $('#tabbar').appendChild(tabEl);
  tabEl.scrollIntoView({ inline: 'nearest' });

  const view = document.createElement('section');
  view.className = 'view session'; view.id = 'view-' + sid;
  view.innerHTML = `
    <div class="term-wrap">
      <div class="term-bar">
        <span class="status"></span><span class="addr">${esc(addr)}</span><span class="grow"></span>
        <button class="ib" data-act="snips" title="${t('snippets')}">${icon('zap')}</button>
        <button class="ib" data-act="find" title="${t('find')} (Ctrl+F)">${icon('search')}</button>
        <button class="ib" data-act="reconnect" title="${t('reconnect')}">${icon('refresh')}</button>
        <button class="ib" data-act="sftp" title="${t('sftp')}">${icon('folder')}</button>
        <button class="ib" data-act="split" title="${t('split')}">${icon('split')}</button>
        <button class="ib pane-x" data-act="close" title="${t('close')}">${icon('x')}</button>
      </div>
      <div class="findbar hidden">
        ${icon('search')}<input spellcheck="false"><span class="fcount"></span>
        <button class="ib" data-f="prev">${icon('chevUp')}</button><button class="ib" data-f="next">${icon('chevDown')}</button><button class="ib" data-f="close">${icon('x')}</button>
      </div>
      <div class="snip-pop hidden"></div>
      <div class="term-shell"><div class="term"></div></div>
    </div>
    <div class="sftp hidden">
      <div class="sftp-head">
        <div class="card-label">${icon('folder')}<span>SFTP • ${esc(label)}</span></div>
        <div class="sftp-bar">
          <button class="ib" data-s="up" title="${t('up')}">${icon('up')}</button>
          <input class="input path mono" spellcheck="false">
          <button class="ib" data-s="refresh" title="${t('refresh')}">${icon('refresh')}</button>
          <button class="ib tg" data-s="hidden" title="${t('hidden')}">${icon('eye')}</button>
        </div>
      </div>
      <div class="files"></div>
      <div class="sftp-foot">
        <button class="btn dark sm" data-s="upload">${icon('upload')}<span>${t('upload')}</span></button>
        <button class="ib" data-s="uploadDir" title="${t('uploadFolder')}">${icon('folderUp')}</button>
        <button class="btn sm" data-s="mkdir">${icon('folderPlus')}<span>${t('mkdir')}</span></button>
        <span class="grow"></span><span class="fcnt"></span>
      </div>
      <div class="prog hidden"><div class="prog-bar"></div><span></span></div>
      <div class="drop-hint">${icon('upload')}<span>${t('dropHere')}</span></div>
    </div>`;
  $('#views').appendChild(view);

  const term = new Terminal({
    fontFamily: termFont(), fontSize: settings.fontSize, lineHeight: 1.2,
    cursorBlink: true, cursorStyle: settings.cursorStyle, cursorInactiveStyle: 'outline',
    allowProposedApi: true, scrollback: 10000, smoothScrollDuration: 80,
    theme: termTheme(),
  });
  const fitAddon = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(search);
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_ev, uri) => window.open(uri)));
  term.open($('.term', view));
  // GPU renderer: much faster than the DOM renderer for heavy output; falls back to DOM if WebGL is unavailable or lost
  if (window.WebglAddon) {
    try { const gl = new WebglAddon.WebglAddon(); gl.onContextLoss(() => gl.dispose()); term.loadAddon(gl); } catch {}
  }

  const tab = { sid, hostId, quick, label, term, fitAddon, search, view, tabEl, state: 'connecting', cwd: '', files: null, showHidden: false, password: null, passphrase: null, fitRaf: 0 };
  tabs.set(sid, tab);

  const paste = () => { const txt = api.clip.read(); if (txt && tab.state === 'connected') term.paste(txt); };
  term.onData((d) => { if (tab.state === 'connected') api.ssh.write(sid, d); else if (d === '\r' && tab.state === 'closed') connect(tab); });
  term.onResize(({ cols, rows }) => api.ssh.resize(sid, cols, rows));
  term.onSelectionChange(() => { const s = term.getSelection(); if (s && settings.copyOnSelect) api.clip.write(s); });
  $('.term', view).addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const sel = term.getSelection();
    showMenu(e.clientX, e.clientY, [
      { icon: 'copy', label: t('copy'), hint: 'Ctrl+Shift+C', disabled: !sel, run: () => { api.clip.write(sel); toast(t('copied')); } },
      { icon: 'clipboard', label: t('paste'), hint: 'Ctrl+Shift+V', run: paste },
      { icon: 'select', label: t('selectAll'), run: () => term.selectAll() },
      '-',
      { icon: 'search', label: t('find'), hint: 'Ctrl+F', run: () => openFind(tab) },
      { icon: 'eraser', label: t('clear'), run: () => term.clear() },
    ]);
  });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') { const s = term.getSelection(); if (s) api.clip.write(s); return false; }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') { paste(); return false; }
    if (e.ctrlKey && !e.shiftKey && e.code === 'KeyF') { openFind(tab); return false; }
    if (e.ctrlKey && (e.code === 'KeyK' || e.code === 'Tab' || e.code === 'Equal' || e.code === 'Minus' || e.code === 'Digit0')) return false;
    if (e.ctrlKey && e.shiftKey && (e.code === 'KeyW' || e.code === 'KeyT' || e.code === 'KeyD')) return false;
    return true;
  });
  tab.ro = new ResizeObserver(() => fit(tab));
  tab.ro.observe($('.term', view));

  view.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]'); const act = btn?.dataset.act;
    if (act === 'reconnect') reconnect(tab);
    if (act === 'sftp') toggleSftp(tab);
    if (act === 'find') openFind(tab);
    if (act === 'snips') toggleSnipPop(tab);
    if (act === 'split') { const rc = btn.getBoundingClientRect(); splitMenu(tab, rc.left, rc.bottom + 4); }
    if (act === 'close') closeTab(tab.sid);
    const sp = e.target.closest('.sp-item');
    if (sp) { $('.snip-pop', view).classList.add('hidden'); runSnippet(tab, snippets.find((x) => x.id === sp.dataset.sid), !e.shiftKey); }
    if (!e.target.closest('.snip-pop') && act !== 'snips') $('.snip-pop', view).classList.add('hidden');
  });
  view.addEventListener('mousedown', () => focusPane(sid), true);
  term.textarea?.addEventListener('focus', () => focusPane(sid));
  bindFind(tab);
  bindSftp(tab);

  if (splitFrom && tabs.has(splitFrom) && paneList(splitFrom).length < 4) splitWith(splitFrom, sid); else switchTab(sid);
  connect(tab);
}

function toggleSnipPop(tab) {
  const pop = $('.snip-pop', tab.view);
  if (!pop.classList.contains('hidden')) return pop.classList.add('hidden');
  pop.innerHTML = snippets.length
    ? snippets.map((s) => `<button class="sp-item" data-sid="${s.id}">${icon('play')}<div><b>${esc(s.name)}</b><small class="mono">${esc(s.command.split('\n')[0])}</small></div></button>`).join('')
    : `<div class="sp-empty">${t('noSnipHere')}</div>`;
  pop.classList.remove('hidden');
}

function reconnect(tab) {
  if (tab.state === 'connecting') return;
  if (tab.state === 'connected') api.ssh.close(tab.sid);
  tab.state = 'closed';
  setTimeout(() => connect(tab), 150);
}

// ResizeObserver can fire many times per frame while dragging; fit at most once per frame
function fit(tab, now = false) {
  if (!tab.view.classList.contains('active')) return;
  if (now) { cancelAnimationFrame(tab.fitRaf); tab.fitRaf = 0; try { tab.fitAddon.fit(); } catch {} return; }
  if (tab.fitRaf) return;
  tab.fitRaf = requestAnimationFrame(() => {
    tab.fitRaf = 0;
    if (tabs.has(tab.sid) && tab.view.classList.contains('active')) { try { tab.fitAddon.fit(); } catch {} }
  });
}

function updateStatus(tab) {
  const label = { connecting: t('connecting'), connected: t('connected'), closed: t('disconnected') }[tab.state];
  const st = $('.status', tab.view);
  st.textContent = label; st.dataset.state = tab.state;
  $('.st', tab.tabEl).dataset.state = tab.state;
  renderLive();
}

const alive = (tab) => tabs.get(tab.sid) === tab;
async function connect(tab, attempt = 0) {
  const h = tab.hostId ? hosts.find((x) => x.id === tab.hostId) : null;
  let password = tab.password;
  const needPwd = tab.quick || (h && h.authType === 'password' && !h.hasPassword);
  if (needPwd && password == null) {
    tab.state = 'connecting'; updateStatus(tab);
    password = await ask(t('askPwd', tab.label), { type: 'password' });
    if (!alive(tab)) return;
    if (password == null) { tab.state = 'closed'; updateStatus(tab); tab.term.write(`\x1b[90m${t('pressEnter')}\x1b[0m\r\n`); return; }
  }
  tab.state = 'connecting'; updateStatus(tab);
  fit(tab, true);
  tab.term.write(`\x1b[90m${t('connecting')} ${tab.label} …\x1b[0m\r\n`);
  try {
    await api.ssh.connect({ sid: tab.sid, hostId: tab.hostId, quick: tab.quick, password, passphrase: tab.passphrase, cols: tab.term.cols, rows: tab.term.rows, lang: settings.lang });
    if (!alive(tab)) { api.ssh.close(tab.sid); return; } // tab was closed while connecting
    tab.password = password;
    tab.state = 'connected'; updateStatus(tab);
    tab.term.focus();
    if (h) h.lastUsed = Date.now();
    renderHosts();
    if (!$('.sftp', tab.view).classList.contains('hidden')) sftpLoad(tab);
  } catch (err) {
    if (!alive(tab)) return;
    tab.state = 'closed'; updateStatus(tab);
    tab.term.write(`\x1b[31m✕ ${cleanErr(err)}\x1b[0m\r\n`);
    // wrong / missing password or key passphrase: ask again right away instead of making the user edit the host
    const code = errCode(err);
    if (code && attempt < 3) {
      const v = await ask(t(code === 'E_AUTH' ? 'askPwdAgain' : 'askPassphrase', tab.label), { type: 'password' });
      if (!alive(tab)) return;
      if (v != null) {
        if (code === 'E_AUTH') tab.password = v; else tab.passphrase = v;
        return connect(tab, attempt + 1);
      }
    }
    tab.password = null; tab.passphrase = null;
    tab.term.write(`\x1b[90m${t('pressEnter')}\x1b[0m\r\n`);
  }
}
const errCode = (err) => (String(err?.message || err).match(/\b(E_AUTH|E_PASSPHRASE)\|/) || [])[1] || '';
function cleanErr(err) { return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^E_[A-Z]+\|/, ''); }

api.ssh.onData((sid, d) => { const tab = tabs.get(sid); if (tab) tab.term.write(d); });
api.ssh.onError((sid, m) => { const tab = tabs.get(sid); if (tab) tab.term.write(`\r\n\x1b[31m${m}\x1b[0m\r\n`); });
api.ssh.onClosed((sid) => {
  const tab = tabs.get(sid); if (!tab || tab.state !== 'connected') return;
  tab.state = 'closed'; updateStatus(tab); renderHosts();
  tab.term.write(`\r\n\x1b[33m${t('disconnected')}\x1b[0m · \x1b[90m${t('pressEnter')}\x1b[0m\r\n`);
});

// ---------- find ----------
const FIND_OPTS = { decorations: { matchOverviewRuler: '#8f9bff', activeMatchColorOverviewRuler: '#ffb547', matchBackground: '#5a5f8a', activeMatchBackground: '#b07a1e' } };
function openFind(tab) {
  const bar = $('.findbar', tab.view); bar.classList.remove('hidden');
  const inp = $('input', bar); inp.focus(); inp.select();
}
function bindFind(tab) {
  const bar = $('.findbar', tab.view), inp = $('input', bar);
  const close = () => { bar.classList.add('hidden'); tab.search.clearDecorations(); tab.term.focus(); };
  tab.search.onDidChangeResults?.(({ resultIndex, resultCount }) => {
    $('.fcount', bar).textContent = inp.value ? (resultCount ? `${resultIndex + 1}/${resultCount}` : '0/0') : '';
  });
  inp.addEventListener('input', () => tab.search.findNext(inp.value, { ...FIND_OPTS, incremental: true }));
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Enter') e.shiftKey ? tab.search.findPrevious(inp.value, FIND_OPTS) : tab.search.findNext(inp.value, FIND_OPTS);
  });
  bar.addEventListener('click', (e) => {
    const f = e.target.closest('[data-f]')?.dataset.f;
    if (f === 'next') tab.search.findNext(inp.value, FIND_OPTS);
    if (f === 'prev') tab.search.findPrevious(inp.value, FIND_OPTS);
    if (f === 'close') close();
  });
}

// ---------- SFTP ----------
function toggleSftp(tab) {
  const pane = $('.sftp', tab.view);
  pane.classList.toggle('hidden');
  $('[data-act="sftp"]', tab.view).classList.toggle('on', !pane.classList.contains('hidden'));
  setTimeout(() => fit(tab), 0);
  if (!pane.classList.contains('hidden') && tab.state === 'connected' && !tab.cwd) sftpLoad(tab);
}
async function sftpLoad(tab, dir) {
  try {
    if (!dir) dir = tab.cwd || await api.sftp.home(tab.sid);
    const r = await api.sftp.list(tab.sid, dir);
    tab.cwd = r.path; tab.files = r.items;
    $('.path', tab.view).value = r.path;
    renderFiles(tab);
  } catch (err) { toast(t('failed', cleanErr(err)), true); }
}
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s * 1000), now = new Date(), p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() === now.getFullYear() ? `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const fullPath = (tab, name) => (tab.cwd.endsWith('/') ? tab.cwd : tab.cwd + '/') + name;
function renderFiles(tab) {
  if (!tab.files) return;
  const list = tab.files.filter((f) => f.name !== '.' && f.name !== '..' && (tab.showHidden || !f.name.startsWith('.')));
  $('.files', tab.view).innerHTML = list.length ? list.map((f) => `
    <div class="file ${f.isDir ? 'dir' : ''}" data-i="${tab.files.indexOf(f)}">
      <span class="fi">${icon(f.isDir ? 'folder' : f.isLink ? 'link' : 'file')}</span>
      <span class="fn" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="fd">${fmtDate(f.mtime)}</span>
      <span class="fs">${f.isDir ? '' : fmtSize(f.size)}</span>
    </div>`).join('') : `<div class="dir-empty">${t('emptyDir')}</div>`;
  $('.fcnt', tab.view).textContent = t('files', list.length);
}
async function fileAction(tab, act, f) {
  try {
    if (act === 'open') { if (f.isDir || f.isLink) return sftpLoad(tab, fullPath(tab, f.name)); return fileAction(tab, 'download', f); }
    if (act === 'download') { const p = await api.sftp.download(tab.sid, tab.cwd, f.name, f.isDir); hideProg(tab); if (p) toast(t('downloaded', p)); }
    if (act === 'rename') { const n = await ask(t('newName'), { value: f.name }); if (n && n !== f.name) { await api.sftp.rename(tab.sid, tab.cwd, f.name, n); sftpLoad(tab); } }
    if (act === 'delete') { if (await confirmBox(t('confirmDel', f.name))) { await api.sftp.remove(tab.sid, tab.cwd, f.name, f.isDir); sftpLoad(tab); } }
    if (act === 'copyPath') { api.clip.write(fullPath(tab, f.name)); toast(t('copied')); }
    if (act === 'cd') { const p = f ? fullPath(tab, f.name) : tab.cwd; api.ssh.write(tab.sid, `cd '${p.replace(/'/g, `'\\''`)}'\r`); tab.term.focus(); }
  } catch (err) { hideProg(tab); toast(t('failed', cleanErr(err)), true); }
}
function bindSftp(tab) {
  const v = tab.view, pane = $('.sftp', v);
  const up = () => { const p = tab.cwd.replace(/\/+$/, ''); sftpLoad(tab, p.slice(0, p.lastIndexOf('/')) || '/'); };
  pane.addEventListener('click', async (e) => {
    const s = e.target.closest('[data-s]')?.dataset.s;
    if (s === 'up') up();
    if (s === 'refresh') sftpLoad(tab);
    if (s === 'hidden') { tab.showHidden = !tab.showHidden; e.target.closest('[data-s]').classList.toggle('on', tab.showHidden); renderFiles(tab); }
    if (s === 'upload' || s === 'uploadDir') {
      try { const n = await api.sftp.upload(tab.sid, tab.cwd, null, s === 'uploadDir'); if (n) { toast(t('uploadedN', n)); sftpLoad(tab); } }
      catch (err) { toast(t('failed', cleanErr(err)), true); sftpLoad(tab); } finally { hideProg(tab); }
    }
    if (s === 'mkdir') { const n = await ask(t('newFolderName')); if (n) { try { await api.sftp.mkdir(tab.sid, tab.cwd, n); sftpLoad(tab); } catch (err) { toast(t('failed', cleanErr(err)), true); } } }
    const row = e.target.closest('.file');
    $$('.file.sel', pane).forEach((x) => x.classList.remove('sel'));
    if (row) row.classList.add('sel');
  });
  pane.addEventListener('dblclick', (e) => { const row = e.target.closest('.file'); if (row) fileAction(tab, 'open', tab.files[row.dataset.i]); });
  pane.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.file'); e.preventDefault();
    if (!row) return showMenu(e.clientX, e.clientY, [
      { icon: 'upload', label: t('upload'), run: () => $('[data-s="upload"]', pane).click() },
      { icon: 'folderUp', label: t('uploadFolder'), run: () => $('[data-s="uploadDir"]', pane).click() },
      { icon: 'folderPlus', label: t('mkdir'), run: () => $('[data-s="mkdir"]', pane).click() },
      { icon: 'terminal', label: t('cdHere'), run: () => fileAction(tab, 'cd', null) },
      { icon: 'refresh', label: t('refresh'), run: () => sftpLoad(tab) },
    ]);
    $$('.file.sel', pane).forEach((x) => x.classList.remove('sel')); row.classList.add('sel');
    const f = tab.files[row.dataset.i];
    showMenu(e.clientX, e.clientY, [
      ...(f.isDir ? [{ icon: 'folder', label: t('open'), run: () => fileAction(tab, 'open', f) },
        { icon: 'terminal', label: t('cdHere'), run: () => fileAction(tab, 'cd', f) },
        { icon: 'download', label: t('download'), run: () => fileAction(tab, 'download', f) }]
        : [{ icon: 'download', label: t('download'), run: () => fileAction(tab, 'download', f) }]),
      { icon: 'edit', label: t('rename'), run: () => fileAction(tab, 'rename', f) },
      { icon: 'copy', label: t('copyPath'), run: () => fileAction(tab, 'copyPath', f) },
      '-',
      { icon: 'trash', label: t('delete'), danger: true, run: () => fileAction(tab, 'delete', f) },
    ]);
  });
  $('.path', v).addEventListener('keydown', (e) => { if (e.key === 'Enter') sftpLoad(tab, e.target.value.trim() || '/'); });
  pane.addEventListener('dragover', (e) => { e.preventDefault(); pane.classList.add('drag'); });
  pane.addEventListener('dragleave', (e) => { if (!pane.contains(e.relatedTarget)) pane.classList.remove('drag'); });
  pane.addEventListener('drop', async (e) => {
    e.preventDefault(); pane.classList.remove('drag');
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (!paths.length || tab.state !== 'connected') return;
    try { const n = await api.sftp.upload(tab.sid, tab.cwd, paths); toast(t('uploadedN', n)); sftpLoad(tab); }
    catch (err) { toast(t('failed', cleanErr(err)), true); sftpLoad(tab); } finally { hideProg(tab); }
  });
}
function hideProg(tab) { $('.prog', tab.view).classList.add('hidden'); }
api.sftp.onProgress((sid, name, done, total) => {
  const tab = tabs.get(sid); if (!tab) return;
  const el = $('.prog', tab.view); el.classList.remove('hidden');
  const pct = total ? Math.floor((done / total) * 100) : 0;
  $('.prog-bar', el).style.width = pct + '%';
  $('span', el).textContent = `${name} · ${pct}%`;
});

// ---------- port forwarding ----------
const fwdTypeIc = { local: 'arrowRight', remote: 'arrowLeft', dynamic: 'globe' };
function fwdDesc(f) {
  const bind = `${f.bindHost}:${f.bindPort}`;
  if (f.type === 'dynamic') return `${t('socks')} ${bind}`;
  return `${bind} → ${f.destHost}:${f.destPort}`;
}
function renderForwards() {
  const el = $('#fwdContent');
  if (!forwards.length) {
    el.innerHTML = `<div class="empty"><div class="empty-ic">${icon('forward')}</div><h3>${t('fwdEmpty')}</h3><p>${t('fwdEmptySub')}</p>
      <button class="btn dark" data-fwd="new">${icon('plus')}<span>${t('newFwd')}</span></button></div>`;
  } else {
    el.innerHTML = `<div class="flist">${forwards.map((f) => {
      const h = hosts.find((x) => x.id === f.hostId);
      const st = fwdState.get(f.id) || 'stopped';
      return `<div class="fcard" data-fid="${f.id}" data-state="${st}">
        <div class="ftype t-${f.type}">${icon(fwdTypeIc[f.type])}</div>
        <div class="hc-text"><div class="hc-name">${esc(f.name || fwdDesc(f))}</div>
          <div class="hc-addr">${esc(fwdDesc(f))}</div>
          <div class="chips"><span class="chip">${t({ local: 'tLocal', remote: 'tRemote', dynamic: 'tDynamic' }[f.type])}</span>${h ? `<span class="chip">${icon('server')}${esc(t('via', h.name))}</span>` : ''}</div></div>
        <span class="fstate">${t({ running: 'fwdRunning', starting: 'fwdStarting', stopped: 'fwdStopped', error: 'fwdStopped' }[st])}</span>
        <label class="switch" data-act="toggle"><input type="checkbox" ${st === 'running' || st === 'starting' ? 'checked' : ''} ${st === 'starting' ? 'disabled' : ''}><i></i></label>
        <button class="ib hc-edit" data-act="edit" title="${t('edit')}">${icon('edit')}</button>
      </div>`;
    }).join('')}</div>`;
  }
  renderLive();
}
async function toggleFwd(f) {
  const st = fwdState.get(f.id);
  if (st === 'running') { await api.fwd.stop(f.id); return; }
  fwdState.set(f.id, 'starting'); renderForwards();
  try { await api.fwd.start(f.id, settings.lang); fwdState.set(f.id, 'running'); toast(t('fwdStarted', fwdDesc(f))); }
  catch (err) { fwdState.set(f.id, 'stopped'); toast(t('failed', cleanErr(err)), true); }
  renderForwards();
}
api.fwd.onStatus((id, s, m) => {
  if (s === 'error') { toast(t('failed', m), true); return; }
  fwdState.set(id, s); renderForwards();
});
$('#btnNewFwd').onclick = () => openFwdEditor(null);
$('#fwdContent').addEventListener('click', (e) => {
  if (e.target.closest('[data-fwd="new"]')) return openFwdEditor(null);
  const c = e.target.closest('.fcard'); if (!c) return;
  const f = forwards.find((x) => x.id === c.dataset.fid);
  if (e.target.closest('[data-act="toggle"]')) { e.preventDefault(); if (e.target.tagName === 'I' || e.target.tagName === 'INPUT') toggleFwd(f); return; }
  openFwdEditor(f);
});
$('#fwdContent').addEventListener('contextmenu', (e) => {
  const c = e.target.closest('.fcard'); if (!c) return;
  e.preventDefault();
  const f = forwards.find((x) => x.id === c.dataset.fid);
  const on = fwdState.get(f.id) === 'running';
  showMenu(e.clientX, e.clientY, [
    { icon: on ? 'x' : 'play', label: on ? t('fStop') : t('fStart'), run: () => toggleFwd(f) },
    { icon: 'edit', label: t('edit'), run: () => openFwdEditor(f) },
    '-',
    { icon: 'trash', label: t('delete'), danger: true, run: () => deleteFwd(f) },
  ]);
});
async function deleteFwd(f) {
  if (await confirmBox(t('confirmDelFwd', f.name || fwdDesc(f)))) { await api.fwd.remove(f.id); fwdState.delete(f.id); closeDrawers(); loadForwards(); }
}
const fform = $('#fwdForm'), ff = fform.elements;
let startAfterSave = false;
function setFwdTypeUI() {
  const ty = ff.type.value;
  $('#fwdHelp').textContent = t({ local: 'helpLocal', remote: 'helpRemote', dynamic: 'helpDynamic' }[ty]);
  $('.dest', fform).classList.toggle('hidden', ty === 'dynamic');
  ff.destPort.required = ty !== 'dynamic';
  $('#bindLabel').textContent = t(ty === 'remote' ? 'bindRemote' : 'bindLocal');
  $('#destLabel').textContent = t(ty === 'remote' ? 'destLocal' : 'destRemote');
  ff.bindPort.placeholder = ty === 'dynamic' ? '1080' : '8080';
}
function openFwdEditor(f) {
  if (!hosts.length) return toast(t('fwdNoHost'), true);
  fform.reset();
  $('#fwdTitle').textContent = f ? t('editFwd') : t('addFwd');
  $('#fwdHostSelect').innerHTML = hosts.map((x) => `<option value="${x.id}">${esc(x.name)} · ${esc(hostAddr(x))}</option>`).join('');
  ff.id.value = f?.id || ''; ff.name.value = f?.name || ''; ff.type.value = f?.type || 'local';
  ff.hostId.value = f?.hostId || hosts[0].id;
  ff.bindHost.value = f?.bindHost || '127.0.0.1'; ff.bindPort.value = f?.bindPort || '';
  ff.destHost.value = f?.destHost || '127.0.0.1'; ff.destPort.value = f?.destPort || '';
  $('#fwdDel').classList.toggle('hidden', !f);
  setFwdTypeUI();
  openDrawer('#fwdDrawer');
  setTimeout(() => ff.name.focus(), 180);
}
fform.addEventListener('change', (e) => { if (e.target.name === 'type') setFwdTypeUI(); });
$('#fwdDel').onclick = () => { const f = forwards.find((x) => x.id === ff.id.value); if (f) deleteFwd(f); };
$('#fwdSaveStart').onclick = () => { startAfterSave = true; fform.requestSubmit(); };
fform.addEventListener('submit', async (e) => {
  e.preventDefault();
  const go = startAfterSave; startAfterSave = false;
  const wasOn = fwdState.get(ff.id.value) === 'running';
  if (wasOn) await api.fwd.stop(ff.id.value);
  const saved = await api.fwd.save(Object.fromEntries(new FormData(fform).entries()));
  closeDrawers();
  await loadForwards();
  if (go || wasOn) toggleFwd(saved); else toast(t('saved'));
});

// ---------- command palette ----------
let palItems = [], palSel = 0;
function openPalette() {
  hideMenu(); closeDrawers();
  $('#palette').classList.remove('hidden');
  const inp = $('#palInput'); inp.value = ''; renderPalette(); inp.focus();
}
const closePalette = () => $('#palette').classList.add('hidden');
function renderPalette() {
  const q = $('#palInput').value.trim().toLowerCase();
  const m = q.match(/^(?:ssh\s+)?([^@\s]+)@([^:\s]+)(?::(\d+))?$/);
  const items = [];
  if (m) items.push({ g: 'grpActions', icon: 'terminal', label: t('connectTo', q), run: () => openSession(null, { username: m[1], host: m[2], port: Number(m[3]) || 22 }) });
  const hit = (s) => !q || s.toLowerCase().includes(q);
  hosts.filter((h) => hit([h.name, h.host, h.username, h.group].join(' '))).slice(0, 8)
    .forEach((h) => items.push({ g: 'grpHosts', icon: 'server', label: h.name, sub: hostAddr(h), run: () => openSession(h.id) }));
  const tab = tabs.get(activeTab);
  snippets.filter((s) => hit(s.name + ' ' + s.command)).slice(0, 6)
    .forEach((s) => items.push({ g: 'grpSnippets', icon: 'zap', label: s.name, sub: s.command.split('\n')[0], run: () => tab ? runSnippet(tab, s) : openSnipEditor(s) }));
  [
    { icon: 'plus', label: t('newHost'), run: () => { setNav('hosts'); openHostEditor(null); } },
    { icon: 'plus', label: t('newSnippet'), run: () => { setNav('snippets'); openSnipEditor(null); } },
    { icon: 'download', label: t('importSsh'), run: () => { setNav('hosts'); importSshConfig(false); } },
    { icon: 'forward', label: t('addFwd'), run: () => { setNav('forwards'); openFwdEditor(null); } },
    { icon: 'sun', label: t('cmdToggleTheme'), run: () => { settings.theme = isDark() ? 'light' : 'dark'; saveSettings(); applySettings(); syncSettingsUI(); } },
    { icon: 'sliders', label: t('settings'), run: () => setNav('settings') },
  ].filter((a) => hit(a.label)).forEach((a) => items.push({ g: 'grpActions', ...a }));
  palItems = items; palSel = 0;
  let last = '';
  $('#palList').innerHTML = items.map((it, i) => {
    const head = it.g !== last ? `<div class="pal-g">${t(it.g)}</div>` : ''; last = it.g;
    return `${head}<button class="pal-item" data-i="${i}">${icon(it.icon)}<span class="pl">${esc(it.label)}</span>${it.sub ? `<span class="ps mono">${esc(it.sub)}</span>` : ''}</button>`;
  }).join('') || `<div class="pal-none">${t('noResults')}</div>`;
  markPal();
}
function markPal() {
  $$('.pal-item').forEach((b) => b.classList.toggle('on', +b.dataset.i === palSel));
  $('.pal-item.on')?.scrollIntoView({ block: 'nearest' });
}
function runPal(i) { const it = palItems[i]; if (!it) return; closePalette(); it.run(); }
$('#palInput').addEventListener('input', renderPalette);
$('#palInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palItems.length - 1, palSel + 1); markPal(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(0, palSel - 1); markPal(); }
  if (e.key === 'Enter') { e.preventDefault(); runPal(palSel); }
});
$('#palList').addEventListener('click', (e) => { const b = e.target.closest('.pal-item'); if (b) runPal(+b.dataset.i); });
$('#palList').addEventListener('mousemove', (e) => { const b = e.target.closest('.pal-item'); if (b && +b.dataset.i !== palSel) { palSel = +b.dataset.i; markPal(); } });
$('#palette').addEventListener('mousedown', (e) => { if (e.target.id === 'palette') closePalette(); });

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.shiftKey && e.code === 'KeyK') { e.preventDefault(); return $('#palette').classList.contains('hidden') ? openPalette() : closePalette(); }
  if (e.key === 'Escape' && !$('#palette').classList.contains('hidden')) return closePalette();
  if (e.key === 'Escape') {
    hideMenu();
    if ($('#prompt')._cancel) $('#prompt')._cancel(); else closeDrawers();
    $$('.snip-pop').forEach((p) => p.classList.add('hidden'));
  }
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    const ids = ['home', ...tabs.keys()];
    switchTab(ids[(ids.indexOf(activeTab) + (e.shiftKey ? ids.length - 1 : 1)) % ids.length]);
  }
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyW' && activeTab !== 'home') { e.preventDefault(); closeTab(activeTab); }
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyD' && tabs.has(activeTab)) { e.preventDefault(); const tb = tabs.get(activeTab); if (paneList(activeTab).length < 4) openSession(tb.hostId, tb.quick, tb.sid); else toast(t('maxPanes'), true); }
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyT') { e.preventDefault(); setNav('hosts'); }
  if (e.ctrlKey && !e.shiftKey && (e.code === 'Equal' || e.code === 'Minus' || e.code === 'Digit0')) {
    e.preventDefault();
    settings.fontSize = e.code === 'Digit0' ? 14 : Math.min(24, Math.max(10, settings.fontSize + (e.code === 'Minus' ? -1 : 1)));
    applySettings(); saveSettings();
  }
});

// ---------- init ----------
(async function init() {
  settings = { ...DEFAULTS, ...(await api.settings.get()) };
  if (!['system', 'dark', 'light'].includes(settings.theme)) settings.theme = 'system';
  if (!settings.lang) settings.lang = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  applySettings();
  await Promise.all([loadHosts(), loadSnippets(), loadForwards()]);
  refreshTexts();
  $('#omni').focus();
})();
