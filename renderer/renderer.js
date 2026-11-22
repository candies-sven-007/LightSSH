/* LightSSH renderer */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DEFAULTS = { lang: '', fontSize: 14, fontFamily: 'Cascadia Mono', glass: 42, cursorStyle: 'block', copyOnSelect: true };
let settings = { ...DEFAULTS };
let hosts = [];
let snippets = [];
let nav = 'hosts';
const tabs = new Map();
let activeTab = 'home';

document.body.classList.add('glass-' + (new URLSearchParams(location.search).get('glass') || 'css'));
hydrateIcons();

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
  $('#search').placeholder = t(nav === 'hosts' ? 'searchHosts' : 'searchSnippets');
  $('#btnAddLabel').textContent = t(nav === 'hosts' ? 'newHost' : 'newSnippet');
  renderSide(); renderHome();
  for (const tab of tabs.values()) { updateStatus(tab); if (tab.files) renderFiles(tab); }
}

// ---------- settings ----------
function applySettings() {
  document.documentElement.style.setProperty('--tint', (settings.glass / 100).toFixed(2));
  for (const tab of tabs.values()) {
    Object.assign(tab.term.options, { fontSize: settings.fontSize, fontFamily: termFont(), cursorStyle: settings.cursorStyle });
    fit(tab);
  }
}
const termFont = () => `"${settings.fontFamily}", "Cascadia Mono", Consolas, "Sarasa Mono SC", "Microsoft YaHei", monospace`;
const saveSettings = () => api.settings.set(settings);

function openSettings() {
  $$('#setLang button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.lang));
  $$('#setCursor button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.cursorStyle));
  $('#setGlass').value = settings.glass; $('#setGlassV').textContent = settings.glass + '%';
  $('#setFont').value = settings.fontSize; $('#setFontV').textContent = settings.fontSize;
  $('#setFamily').value = settings.fontFamily;
  $('#setCopySel').checked = settings.copyOnSelect;
  showModal('#setModal');
}
$('#btnSettings').onclick = openSettings;
$('#setLang').onclick = (e) => { const v = e.target.dataset.v; if (!v) return; settings.lang = v; saveSettings(); openSettings(); refreshTexts(); };
$('#setCursor').onclick = (e) => { const v = e.target.dataset.v; if (!v) return; settings.cursorStyle = v; saveSettings(); applySettings(); openSettings(); };
$('#setGlass').oninput = (e) => { settings.glass = +e.target.value; $('#setGlassV').textContent = settings.glass + '%'; applySettings(); };
$('#setFont').oninput = (e) => { settings.fontSize = +e.target.value; $('#setFontV').textContent = settings.fontSize; applySettings(); };
$('#setGlass').onchange = $('#setFont').onchange = saveSettings;
$('#setFamily').onchange = (e) => { settings.fontFamily = e.target.value; applySettings(); saveSettings(); };
$('#setCopySel').onchange = (e) => { settings.copyOnSelect = e.target.checked; saveSettings(); };

// ---------- modals / toast / prompt ----------
function showModal(sel) { $(sel).classList.remove('hidden'); }
function hideModals() { $$('.modal').forEach((m) => { if (m.id !== 'prompt') m.classList.add('hidden'); }); }
document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) e.target.closest('.modal').classList.add('hidden'); });
$$('.modal').forEach((m) => m.addEventListener('mousedown', (e) => { if (e.target === m && m.id !== 'prompt') m.classList.add('hidden'); }));

let toastTimer;
function toast(msg, err) {
  const el = $('#toast');
  el.textContent = msg; el.className = err ? 'err' : '';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

function ask(title, { value = '', type = 'text', confirmOnly = false, danger = false } = {}) {
  return new Promise((resolve) => {
    const m = $('#prompt'), inp = $('#promptInput'), ok = $('#promptOk');
    $('#promptTitle').textContent = title;
    inp.classList.toggle('hidden', confirmOnly);
    inp.type = type; inp.value = value;
    ok.textContent = danger ? t('delete') : t('ok');
    ok.className = 'btn ' + (danger ? 'danger solid' : 'primary');
    m.classList.remove('hidden');
    setTimeout(() => { if (confirmOnly) ok.focus(); else { inp.focus(); inp.select(); } }, 0);
    const done = (v) => { m.classList.add('hidden'); $('#promptForm').onsubmit = null; $('#promptCancel').onclick = null; resolve(v); };
    $('#promptForm').onsubmit = (e) => { e.preventDefault(); done(confirmOnly ? true : inp.value); };
    $('#promptCancel').onclick = () => done(confirmOnly ? false : null);
    m._cancel = () => done(confirmOnly ? false : null);
  });
}
const confirmBox = (msg) => ask(msg, { confirmOnly: true, danger: true });

// ---------- context menu ----------
function showMenu(x, y, items) {
  const el = $('#ctx');
  el.innerHTML = items.map((it, i) => it === '-' ? '<div class="sep"></div>'
    : `<button data-i="${i}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>${icon(it.icon)}<span>${esc(it.label)}</span>${it.hint ? `<kbd>${it.hint}</kbd>` : ''}</button>`).join('');
  el.classList.remove('hidden');
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
  el.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
  el.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; hideMenu(); items[b.dataset.i].run(); };
}
function hideMenu() { $('#ctx').classList.add('hidden'); }
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctx')) hideMenu(); });
window.addEventListener('blur', hideMenu);

// ---------- data ----------
async function loadHosts() { hosts = await api.hosts.list(); renderSide(); renderHome(); }
async function loadSnippets() { snippets = await api.snippets.list(); renderSide(); }

const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const avatar = (h) => `<div class="av" style="--h:${hue(h.name + h.host)}">${esc((h.name || '?').trim().slice(0, 1).toUpperCase())}</div>`;
const groupBy = (list) => {
  const g = {}; list.forEach((h) => { (g[h.group || ''] ||= []).push(h); });
  return Object.keys(g).sort((a, b) => (a === '') - (b === '') || a.localeCompare(b)).map((k) => [k, g[k]]);
};
const activeHostIds = () => new Set([...tabs.values()].filter((x) => x.state === 'connected').map((x) => x.hostId));

// ---------- sidebar ----------
$$('.nav button').forEach((b) => b.onclick = () => {
  nav = b.dataset.nav;
  $$('.nav button').forEach((x) => x.classList.toggle('on', x === b));
  $('#search').value = '';
  refreshTexts();
});
$('#search').addEventListener('input', () => { renderSide(); renderHome(); });
$('#btnAdd').onclick = () => (nav === 'hosts' ? openHostEditor(null) : openSnipEditor(null));

function renderSide() {
  const q = $('#search').value.trim().toLowerCase();
  const el = $('#sideList');
  if (nav === 'hosts') {
    const live = activeHostIds();
    const list = hosts.filter((h) => !q || [h.name, h.host, h.username, h.group].join(' ').toLowerCase().includes(q));
    const groups = groupBy(list);
    el.innerHTML = groups.map(([g, hs]) => `
      ${groups.length > 1 || g ? `<div class="group">${esc(g || t('ungrouped'))}</div>` : ''}
      ${hs.map((h) => `
        <div class="item ${live.has(h.id) ? 'live' : ''}" data-id="${h.id}" title="${esc(h.username)}@${esc(h.host)}:${h.port}">
          ${avatar(h)}<div class="it-text"><b>${esc(h.name)}</b><small>${esc(h.username)}@${esc(h.host)}</small></div>
          <button class="ib" data-act="edit" title="${t('edit')}">${icon('edit')}</button>
        </div>`).join('')}`).join('') || `<div class="side-empty">${t('emptySub')}</div>`;
  } else {
    const list = snippets.filter((s) => !q || (s.name + ' ' + s.command).toLowerCase().includes(q));
    el.innerHTML = list.map((s) => `
      <div class="item snip" data-sid="${s.id}" title="${esc(s.command)}">
        <div class="sn-ic">${icon('play')}</div>
        <div class="it-text"><b>${esc(s.name)}</b><small class="mono">${esc(s.command.split('\n')[0])}</small></div>
        <button class="ib" data-act="edit" title="${t('edit')}">${icon('edit')}</button>
      </div>`).join('') || `<div class="side-empty">${t('emptySnip')}</div>`;
  }
}

$('#sideList').addEventListener('click', (e) => {
  const it = e.target.closest('.item'); if (!it) return;
  const editing = e.target.closest('[data-act="edit"]');
  if (it.dataset.id) { const h = hosts.find((x) => x.id === it.dataset.id); return editing ? openHostEditor(h) : openSession(h.id); }
  const s = snippets.find((x) => x.id === it.dataset.sid);
  if (editing) return openSnipEditor(s);
  runSnippet(s);
});
$('#sideList').addEventListener('contextmenu', (e) => {
  const it = e.target.closest('.item'); if (!it) return;
  e.preventDefault();
  if (it.dataset.id) hostMenu(e.clientX, e.clientY, hosts.find((x) => x.id === it.dataset.id));
  else {
    const s = snippets.find((x) => x.id === it.dataset.sid);
    showMenu(e.clientX, e.clientY, [
      { icon: 'play', label: t('run'), run: () => runSnippet(s) },
      { icon: 'clipboard', label: t('paste'), run: () => runSnippet(s, false) },
      { icon: 'edit', label: t('edit'), run: () => openSnipEditor(s) },
      '-',
      { icon: 'trash', label: t('delete'), danger: true, run: async () => { if (await confirmBox(t('confirmDelSnip', s.name))) { await api.snippets.remove(s.id); loadSnippets(); } } },
    ]);
  }
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
  if (await confirmBox(t('confirmDelHost', h.name))) { await api.hosts.remove(h.id); hideModals(); loadHosts(); }
}

function runSnippet(s, run = true) {
  const tab = tabs.get(activeTab);
  if (!tab || tab.state !== 'connected') return toast(t('noSession'), true);
  api.ssh.write(tab.sid, s.command.replace(/\r?\n/g, '\r') + (run ? '\r' : ''));
  tab.term.focus();
}

// ---------- home ----------
function renderHome() {
  const q = $('#search').value.trim().toLowerCase();
  const list = hosts.filter((h) => !q || [h.name, h.host, h.username, h.group].join(' ').toLowerCase().includes(q));
  const el = $('#homeContent');
  if (!hosts.length) {
    el.innerHTML = `<div class="empty"><div class="empty-ic">${icon('server')}</div><h3>${t('emptyTip')}</h3><p>${t('emptySub')}</p>
      <button class="btn primary" data-home="new">${icon('plus')}<span>${t('newHost')}</span></button></div>`;
    return;
  }
  const card = (h) => `
    <div class="hcard" data-id="${h.id}">
      ${avatar(h)}
      <div class="hc-body"><b>${esc(h.name)}</b><small>${esc(h.username)}@${esc(h.host)}${h.port != 22 ? ':' + h.port : ''}</small></div>
      <span class="hc-auth" title="${h.authType === 'key' ? t('authKey') : t('authPwd')}">${icon(h.authType === 'key' ? 'key' : 'lock')}</span>
      <button class="ib hc-edit" data-act="edit" title="${t('edit')}">${icon('edit')}</button>
    </div>`;
  const recent = !q ? hosts.filter((h) => h.lastUsed).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 4) : [];
  el.innerHTML = `
    <div class="sec-head"><h2>${t('hosts')}</h2><span class="count">${list.length}</span><span class="grow"></span>
      <button class="btn primary sm" data-home="new">${icon('plus')}<span>${t('newHost')}</span></button></div>
    ${recent.length ? `<div class="sec-title">${icon('clock')}${t('recent')}</div><div class="hgrid">${recent.map(card).join('')}</div>` : ''}
    ${groupBy(list).map(([g, hs]) => `<div class="sec-title">${icon('folder')}${esc(g || (recent.length ? t('allHosts') : t('ungrouped')))}</div><div class="hgrid">${hs.map(card).join('')}</div>`).join('')}`;
}
$('#homeContent').addEventListener('click', (e) => {
  if (e.target.closest('[data-home="new"]')) return openHostEditor(null);
  const c = e.target.closest('.hcard'); if (!c) return;
  const h = hosts.find((x) => x.id === c.dataset.id);
  if (e.target.closest('[data-act="edit"]')) openHostEditor(h); else openSession(h.id);
});
$('#homeContent').addEventListener('contextmenu', (e) => {
  const c = e.target.closest('.hcard'); if (!c) return;
  e.preventDefault(); hostMenu(e.clientX, e.clientY, hosts.find((x) => x.id === c.dataset.id));
});

$('#quick').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const v = e.target.value.trim(); if (!v) return;
  const m = v.match(/^(?:ssh\s+)?(?:-p\s*(\d+)\s+)?([^@\s]+)@([^:\s]+)(?::(\d+))?(?:\s+-p\s*(\d+))?$/);
  if (!m) return toast(t('badQuick'), true);
  openSession(null, { username: m[2], host: m[3], port: Number(m[4] || m[1] || m[5]) || 22 });
  e.target.value = '';
});

// ---------- host editor ----------
const form = $('#hostForm'), fe = form.elements;
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
  $('#groupList').innerHTML = [...new Set(hosts.map((x) => x.group).filter(Boolean))].map((g) => `<option value="${esc(g)}">`).join('');
  $('#btnDel').classList.toggle('hidden', !h || duplicate);
  $('#btnDup').classList.toggle('hidden', !h || duplicate);
  setAuthUI();
  showModal('#hostModal');
  setTimeout(() => (h ? fe.name : fe.host).focus(), 0);
}
form.addEventListener('change', (e) => { if (e.target.name === 'authType') setAuthUI(); });
$('#btnPickKey').onclick = async () => { const p = await api.pickKey(); if (p) fe.keyPath.value = p; };
$('#btnDel').onclick = () => { const h = hosts.find((x) => x.id === fe.id.value); if (h) deleteHost(h); };
$('#btnDup').onclick = () => { const h = hosts.find((x) => x.id === fe.id.value); if (h) openHostEditor(h, true); };
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  await api.hosts.save(Object.fromEntries(new FormData(form).entries()));
  $('#hostModal').classList.add('hidden');
  toast(t('saved'));
  loadHosts();
});

// ---------- snippet editor ----------
const sform = $('#snipForm'), se = sform.elements;
function openSnipEditor(s) {
  sform.reset();
  $('#snipTitle').textContent = s ? t('editSnippet') : t('addSnippet');
  se.id.value = s?.id || ''; se.name.value = s?.name || ''; se.command.value = s?.command || '';
  $('#snipDel').classList.toggle('hidden', !s);
  showModal('#snipModal');
  setTimeout(() => (s ? se.name : se.command).focus(), 0);
}
$('#snipDel').onclick = async () => {
  const s = snippets.find((x) => x.id === se.id.value);
  if (s && await confirmBox(t('confirmDelSnip', s.name))) { await api.snippets.remove(s.id); $('#snipModal').classList.add('hidden'); loadSnippets(); }
};
sform.addEventListener('submit', async (e) => {
  e.preventDefault();
  await api.snippets.save(Object.fromEntries(new FormData(sform).entries()));
  $('#snipModal').classList.add('hidden');
  loadSnippets();
});

// ---------- tabs ----------
function switchTab(id) {
  activeTab = id;
  $$('#tabbar .tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === id));
  $$('#views .view').forEach((el) => el.classList.toggle('active', el.id === 'view-' + id));
  const tab = tabs.get(id);
  if (tab) setTimeout(() => { fit(tab); tab.term.focus(); }, 0);
  else setTimeout(() => $('#quick').focus(), 0);
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
    { icon: 'refresh', label: t('reconnect'), disabled: tab.state === 'connected', run: () => connect(tab) },
    { icon: 'copy', label: t('duplicate'), run: () => openSession(tab.hostId, tab.quick) },
    '-',
    { icon: 'x', label: t('close'), hint: 'Ctrl+Shift+W', run: () => closeTab(tab.sid) },
  ]);
});

function closeTab(sid) {
  const tab = tabs.get(sid); if (!tab) return;
  api.ssh.close(sid);
  tab.term.dispose(); tab.ro.disconnect();
  tab.tabEl.remove(); tab.view.remove();
  tabs.delete(sid);
  renderSide();
  if (activeTab === sid) { const last = [...tabs.keys()].pop(); switchTab(last || 'home'); }
}

// ---------- sessions ----------
let seq = 0;
function openSession(hostId, quick) {
  const h = hostId ? hosts.find((x) => x.id === hostId) : null;
  const label = h ? h.name : `${quick.username}@${quick.host}`;
  const sid = 's' + (++seq) + '_' + Date.now();

  const tabEl = document.createElement('div');
  tabEl.className = 'tab'; tabEl.dataset.tab = sid;
  tabEl.innerHTML = `<span class="st"></span><span class="tl">${esc(label)}</span><span class="x">${icon('x')}</span>`;
  $('#tabbar').appendChild(tabEl);
  tabEl.scrollIntoView({ inline: 'nearest' });

  const view = document.createElement('section');
  view.className = 'view session'; view.id = 'view-' + sid;
  view.innerHTML = `
    <div class="sess-body">
      <div class="term-wrap">
        <div class="term-bar">
          <span class="status"></span><span class="addr">${esc(h ? `${h.username}@${h.host}:${h.port}` : `${quick.username}@${quick.host}:${quick.port}`)}</span><span class="grow"></span>
          <button class="ib" data-act="find" title="${t('find')} (Ctrl+F)">${icon('search')}</button>
          <button class="ib" data-act="reconnect" title="${t('reconnect')}">${icon('refresh')}</button>
          <button class="ib tg" data-act="sftp" title="${t('sftp')}">${icon('folder')}</button>
        </div>
        <div class="findbar hidden">
          ${icon('search')}<input spellcheck="false"><span class="fcount"></span>
          <button class="ib" data-f="prev">${icon('chevUp')}</button><button class="ib" data-f="next">${icon('chevDown')}</button><button class="ib" data-f="close">${icon('x')}</button>
        </div>
        <div class="term"></div>
      </div>
      <div class="sftp hidden">
        <div class="sftp-bar">
          <button class="ib" data-s="up" title="${t('up')}">${icon('up')}</button>
          <input class="input path mono" spellcheck="false">
          <button class="ib" data-s="refresh" title="${t('refresh')}">${icon('refresh')}</button>
        </div>
        <div class="sftp-bar sub">
          <button class="btn sm" data-s="upload">${icon('upload')}<span>${t('upload')}</span></button>
          <button class="btn sm ghost" data-s="mkdir">${icon('folderPlus')}<span>${t('mkdir')}</span></button>
          <span class="grow"></span>
          <button class="ib tg" data-s="hidden" title="${t('hidden')}">${icon('eye')}</button>
        </div>
        <div class="files"></div>
        <div class="sftp-foot"><span class="fcnt"></span><span class="grow"></span><span>${t('dropHere')}</span></div>
        <div class="prog hidden"><div class="prog-bar"></div><span></span></div>
      </div>
    </div>`;
  $('#views').appendChild(view);

  const term = new Terminal({
    fontFamily: termFont(), fontSize: settings.fontSize, lineHeight: 1.15,
    cursorBlink: true, cursorStyle: settings.cursorStyle, cursorInactiveStyle: 'outline',
    allowProposedApi: true, allowTransparency: true, scrollback: 10000, smoothScrollDuration: 80,
    theme: {
      background: '#00000000', foreground: '#dfe3ea', cursor: '#7fe3d8', cursorAccent: '#0b0d12', selectionBackground: 'rgba(127,227,216,0.25)',
      black: '#2a2e38', red: '#f28b8b', green: '#9ad99a', yellow: '#ecc98a', blue: '#80b4f2', magenta: '#cc9cf0', cyan: '#7fe3d8', white: '#dfe3ea',
      brightBlack: '#6b7280', brightRed: '#ff9e9e', brightGreen: '#b2e8b2', brightYellow: '#f5d9a3', brightBlue: '#9cc7ff', brightMagenta: '#dcb4f7', brightCyan: '#a3f0e7', brightWhite: '#ffffff',
    },
  });
  const fitAddon = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(search);
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon.WebLinksAddon((ev, uri) => { if (ev.ctrlKey || ev.button === 0) window.open(uri); }));
  term.open($('.term', view));

  const tab = { sid, hostId, quick, label, term, fitAddon, search, view, tabEl, state: 'connecting', cwd: '', files: null, showHidden: false, password: null };
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
    if (e.ctrlKey && (e.code === 'Tab' || e.code === 'Equal' || e.code === 'Minus')) return false;
    return true;
  });
  tab.ro = new ResizeObserver(() => fit(tab));
  tab.ro.observe($('.term', view));

  view.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'reconnect' && tab.state !== 'connecting') { if (tab.state === 'connected') api.ssh.close(sid); setTimeout(() => connect(tab), 150); }
    if (act === 'sftp') toggleSftp(tab);
    if (act === 'find') openFind(tab);
  });
  bindFind(tab);
  bindSftp(tab);

  switchTab(sid);
  connect(tab);
}

function fit(tab) {
  if (!tab.view.classList.contains('active')) return;
  try { tab.fitAddon.fit(); } catch {}
}

function updateStatus(tab) {
  const label = { connecting: t('connecting'), connected: t('connected'), closed: t('disconnected') }[tab.state];
  const st = $('.status', tab.view);
  st.textContent = label; st.dataset.state = tab.state;
  $('.st', tab.tabEl).dataset.state = tab.state;
}

async function connect(tab) {
  const h = tab.hostId ? hosts.find((x) => x.id === tab.hostId) : null;
  let password = tab.password;
  const needPwd = tab.quick || (h && h.authType === 'password' && !h.hasPassword);
  if (needPwd && password == null) {
    password = await ask(t('askPwd', tab.label), { type: 'password' });
    if (password == null) { tab.state = 'closed'; updateStatus(tab); tab.term.write(`\x1b[90m${t('pressEnter')}\x1b[0m\r\n`); return; }
  }
  tab.state = 'connecting'; updateStatus(tab);
  fit(tab);
  tab.term.write(`\x1b[90m${t('connecting')} ${tab.label} …\x1b[0m\r\n`);
  try {
    await api.ssh.connect({ sid: tab.sid, hostId: tab.hostId, quick: tab.quick, password, cols: tab.term.cols, rows: tab.term.rows, lang: settings.lang });
    tab.password = password;
    tab.state = 'connected'; updateStatus(tab);
    tab.term.focus();
    renderSide();
    if (tab.hostId) { const hh = hosts.find((x) => x.id === tab.hostId); if (hh) { hh.lastUsed = Date.now(); renderHome(); } }
    if (!$('.sftp', tab.view).classList.contains('hidden')) sftpLoad(tab);
  } catch (err) {
    tab.password = null;
    tab.state = 'closed'; updateStatus(tab);
    tab.term.write(`\x1b[31m✕ ${cleanErr(err)}\x1b[0m\r\n\x1b[90m${t('pressEnter')}\x1b[0m\r\n`);
  }
}
function cleanErr(err) { return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }

api.ssh.onData((sid, d) => { const tab = tabs.get(sid); if (tab) tab.term.write(d); });
api.ssh.onError((sid, m) => { const tab = tabs.get(sid); if (tab) tab.term.write(`\r\n\x1b[31m${m}\x1b[0m\r\n`); });
api.ssh.onClosed((sid) => {
  const tab = tabs.get(sid); if (!tab || tab.state === 'closed') return;
  tab.state = 'closed'; updateStatus(tab); renderSide();
  tab.term.write(`\r\n\x1b[33m${t('disconnected')}\x1b[0m · \x1b[90m${t('pressEnter')}\x1b[0m\r\n`);
});

// ---------- find ----------
const FIND_OPTS = { decorations: { matchOverviewRuler: '#7fe3d8', activeMatchColorOverviewRuler: '#ffffff', matchBackground: '#2c5a55', activeMatchBackground: '#4a8f87' } };
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
    if (e.key === 'Escape') close();
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
    if (act === 'download') { const p = await api.sftp.download(tab.sid, tab.cwd, f.name); hideProg(tab); if (p) toast(t('downloaded', p)); }
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
    if (s === 'upload') { try { if (await api.sftp.upload(tab.sid, tab.cwd)) { toast(t('uploaded')); sftpLoad(tab); } } catch (err) { toast(t('failed', cleanErr(err)), true); } finally { hideProg(tab); } }
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
      { icon: 'folderPlus', label: t('mkdir'), run: () => $('[data-s="mkdir"]', pane).click() },
      { icon: 'terminal', label: t('cdHere'), run: () => fileAction(tab, 'cd', null) },
      { icon: 'refresh', label: t('refresh'), run: () => sftpLoad(tab) },
    ]);
    $$('.file.sel', pane).forEach((x) => x.classList.remove('sel')); row.classList.add('sel');
    const f = tab.files[row.dataset.i];
    showMenu(e.clientX, e.clientY, [
      ...(f.isDir ? [{ icon: 'folder', label: t('open'), run: () => fileAction(tab, 'open', f) },
        { icon: 'terminal', label: t('cdHere'), run: () => fileAction(tab, 'cd', f) }]
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
    try { await api.sftp.upload(tab.sid, tab.cwd, paths); toast(t('uploaded')); sftpLoad(tab); }
    catch (err) { toast(t('failed', cleanErr(err)), true); } finally { hideProg(tab); }
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

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideMenu();
    if (!$('#prompt').classList.contains('hidden')) $('#prompt')._cancel?.(); else hideModals();
  }
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    const ids = ['home', ...tabs.keys()];
    switchTab(ids[(ids.indexOf(activeTab) + (e.shiftKey ? ids.length - 1 : 1)) % ids.length]);
  }
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyW' && activeTab !== 'home') { e.preventDefault(); closeTab(activeTab); }
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyT') { e.preventDefault(); switchTab('home'); }
  if (e.ctrlKey && !e.shiftKey && (e.code === 'Equal' || e.code === 'Minus' || e.code === 'Digit0')) {
    e.preventDefault();
    settings.fontSize = e.code === 'Digit0' ? 14 : Math.min(24, Math.max(10, settings.fontSize + (e.code === 'Minus' ? -1 : 1)));
    applySettings(); saveSettings();
  }
});

// ---------- init ----------
(async function init() {
  settings = { ...DEFAULTS, ...(await api.settings.get()) };
  if (!settings.lang) settings.lang = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  applySettings();
  await Promise.all([loadHosts(), loadSnippets()]);
  refreshTexts();
  $('#quick').focus();
})();
