// LightSSH - main process
const { app, BrowserWindow, ipcMain, dialog, safeStorage, Menu, shell, nativeTheme } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const { Client } = require('ssh2');

let win;
const sessions = new Map(); // id -> { client, stream, sftp }

const dataDir = () => app.getPath('userData');
const file = (n) => path.join(dataDir(), n);

function readJSON(name, def) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return def; }
}
function writeJSON(name, obj) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(file(name), JSON.stringify(obj, null, 2), 'utf8');
}

// ---- secret helpers (Windows DPAPI via safeStorage) ----
function enc(s) {
  if (!s) return '';
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(s).toString('base64');
  return 'b64:' + Buffer.from(s, 'utf8').toString('base64');
}
function dec(s) {
  if (!s) return '';
  try {
    if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
    if (s.startsWith('b64:')) return Buffer.from(s.slice(4), 'base64').toString('utf8');
  } catch { return ''; }
  return s;
}

// ---- hosts ----
function loadHosts() { return readJSON('hosts.json', []); }
function publicHost(h) {
  const { password, passphrase, ...rest } = h;
  return { ...rest, hasPassword: !!password, hasPassphrase: !!passphrase };
}

ipcMain.handle('hosts:list', () => loadHosts().map(publicHost));

ipcMain.handle('hosts:save', (_e, h) => {
  const hosts = loadHosts();
  const idx = hosts.findIndex((x) => x.id === h.id);
  const old = idx >= 0 ? hosts[idx] : (h.copyFrom ? { ...(hosts.find((x) => x.id === h.copyFrom) || {}), lastUsed: 0 } : {});
  const rec = {
    id: h.id || crypto.randomUUID(),
    name: (h.name || '').trim() || `${h.username}@${h.host}`,
    group: (h.group || '').trim(),
    host: (h.host || '').trim(),
    port: Number(h.port) || 22,
    username: (h.username || '').trim(),
    authType: h.authType === 'key' ? 'key' : 'password',
    keyPath: h.keyPath || '',
    jumpHostId: h.jumpHostId && h.jumpHostId !== h.id ? h.jumpHostId : '',
    // empty field in form = keep old secret; explicit clear flag removes it
    lastUsed: old.lastUsed || 0,
    password: h.clearPassword ? '' : (h.password ? enc(h.password) : old.password || ''),
    passphrase: h.clearPassphrase ? '' : (h.passphrase ? enc(h.passphrase) : old.passphrase || ''),
  };
  if (idx >= 0) hosts[idx] = rec; else hosts.push(rec);
  writeJSON('hosts.json', hosts);
  return publicHost(rec);
});

ipcMain.handle('hosts:delete', (_e, id) => {
  writeJSON('hosts.json', loadHosts().filter((h) => h.id !== id).map((h) => (h.jumpHostId === id ? { ...h, jumpHostId: '' } : h)));
  return true;
});

// ---- snippets ----
ipcMain.handle('snippets:list', () => readJSON('snippets.json', []));
ipcMain.handle('snippets:save', (_e, sn) => {
  const list = readJSON('snippets.json', []);
  const rec = { id: sn.id || crypto.randomUUID(), name: (sn.name || '').trim() || sn.command.split('\n')[0].slice(0, 40), command: sn.command || '' };
  const i = list.findIndex((x) => x.id === rec.id);
  if (i >= 0) list[i] = rec; else list.push(rec);
  writeJSON('snippets.json', list);
  return rec;
});
ipcMain.handle('snippets:delete', (_e, id) => { writeJSON('snippets.json', readJSON('snippets.json', []).filter((x) => x.id !== id)); return true; });

function touchHost(id) {
  if (!id) return;
  const hosts = loadHosts();
  const h = hosts.find((x) => x.id === id);
  if (h) { h.lastUsed = Date.now(); writeJSON('hosts.json', hosts); }
}

// ---- settings ----
ipcMain.handle('settings:get', () => readJSON('settings.json', {}));
ipcMain.handle('settings:set', (_e, s) => { writeJSON('settings.json', s); return true; });

ipcMain.handle('dialog:pickKey', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Private key',
    defaultPath: path.join(app.getPath('home'), '.ssh'),
    properties: ['openFile', 'showHiddenFiles'],
  });
  return r.canceled ? '' : r.filePaths[0];
});

// ---- known hosts ----
function verifyHost(hostKeyId, key, lang) {
  const fp = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  const known = readJSON('known_hosts.json', {});
  if (known[hostKeyId] === fp) return Promise.resolve(true);
  const zh = lang === 'zh';
  const changed = !!known[hostKeyId];
  const msg = changed
    ? (zh ? '警告：主机密钥已改变！可能存在中间人攻击。' : 'WARNING: Host key has CHANGED! Possible man-in-the-middle attack.')
    : (zh ? '首次连接此主机，请确认指纹。' : 'First connection to this host. Please verify the fingerprint.');
  return dialog.showMessageBox(win, {
    type: changed ? 'warning' : 'question',
    title: zh ? '主机验证' : 'Host verification',
    message: msg,
    detail: `${hostKeyId}\n${fp}`,
    buttons: zh ? ['信任并继续', '取消'] : ['Trust & continue', 'Cancel'],
    defaultId: changed ? 1 : 0,
    cancelId: 1,
  }).then((r) => {
    if (r.response === 0) { known[hostKeyId] = fp; writeJSON('known_hosts.json', known); return true; }
    return false;
  });
}

// ---- SSH ----
function send(ch, ...args) { if (win && !win.isDestroyed()) win.webContents.send(ch, ...args); }
const ZH = (lang) => lang === 'zh';

// Open an authenticated client to host h, going through its jump host chain when it has one.
async function openClient(h, { password, lang, chain = [] } = {}) {
  let sock = null;
  let jumps = [];
  if (h.jumpHostId) {
    if (chain.includes(h.jumpHostId) || chain.length > 4) throw new Error(ZH(lang) ? '跳板机设置成了循环' : 'Jump host chain loops');
    const jh = loadHosts().find((x) => x.id === h.jumpHostId);
    if (!jh) throw new Error(ZH(lang) ? '找不到跳板机' : 'Jump host not found');
    if (jh.authType !== 'key' && !jh.password) throw new Error(ZH(lang) ? `跳板机「${jh.name}」需要保存密码` : `Jump host "${jh.name}" needs a saved password`);
    const j = await openClient(jh, { lang, chain: [...chain, h.id || 'quick'] });
    jumps = [...j.jumps, j.client];
    try {
      sock = await new Promise((res, rej) => j.client.forwardOut('127.0.0.1', 0, h.host, Number(h.port) || 22, (e, s) => (e ? rej(e) : res(s))));
    } catch (e) { jumps.forEach((c) => c.end()); throw new Error((ZH(lang) ? '跳板机无法到达目标：' : 'Jump host cannot reach target: ') + e.message); }
  }
  const pwd = password || dec(h.password || '');
  const cfg = {
    host: h.host, port: Number(h.port) || 22, username: h.username,
    readyTimeout: 20000, keepaliveInterval: 15000, tryKeyboard: true,
    hostVerifier: (key, cb) => { verifyHost(`[${h.host}]:${h.port || 22}`, key, lang).then(cb); },
  };
  if (sock) cfg.sock = sock;
  if (h.authType === 'key') {
    if (!h.keyPath) throw new Error(ZH(lang) ? '没有选择私钥文件' : 'No private key file');
    cfg.privateKey = fs.readFileSync(h.keyPath);
    const pp = dec(h.passphrase || '');
    if (pp) cfg.passphrase = pp;
    if (pwd) cfg.password = pwd;
  } else cfg.password = pwd;

  const client = new Client();
  client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => pwd)));
  await new Promise((resolve, reject) => {
    let done = false;
    client.once('ready', () => { done = true; resolve(); });
    client.on('error', (err) => { if (!done) { done = true; jumps.forEach((c) => c.end()); reject(err); } });
    try { client.connect(cfg); } catch (err) { done = true; jumps.forEach((c) => c.end()); reject(err); }
  });
  client.on('close', () => jumps.forEach((c) => c.end()));
  return { client, jumps };
}

ipcMain.handle('ssh:connect', async (_e, { sid, hostId, quick, password, cols, rows, lang }) => {
  let h;
  if (quick) h = { host: quick.host, port: quick.port || 22, username: quick.username, authType: 'password' };
  else h = loadHosts().find((x) => x.id === hostId);
  if (!h) throw new Error('Host not found');
  const { client } = await openClient(h, { password, lang });
  return new Promise((resolve, reject) => {
    client.shell({ term: 'xterm-256color', cols: cols || 80, rows: rows || 24 }, (err, stream) => {
      if (err) { client.end(); return reject(err); }
      sessions.set(sid, { client, stream, sftp: null });
      stream.on('data', (d) => send('ssh:data', sid, d));
      stream.stderr.on('data', (d) => send('ssh:data', sid, d));
      stream.on('close', () => client.end());
      client.on('error', (e) => send('ssh:error', sid, e.message));
      client.on('close', () => { sessions.delete(sid); send('ssh:closed', sid); });
      if (!quick) touchHost(hostId);
      resolve(true);
    });
  });
});

// ---- port forwarding ----
const running = new Map(); // ruleId -> { client, server, sockets }
const loadFwd = () => readJSON('forwards.json', []);
const fwdState = (id, state, msg = '') => send('fwd:status', id, state, msg);
ipcMain.handle('fwd:list', () => loadFwd().map((r) => ({ ...r, state: running.has(r.id) ? 'running' : 'stopped' })));
ipcMain.handle('fwd:save', (_e, r) => {
  const list = loadFwd();
  const type = ['local', 'remote', 'dynamic'].includes(r.type) ? r.type : 'local';
  const rec = {
    id: r.id || crypto.randomUUID(), type, hostId: r.hostId || '',
    name: (r.name || '').trim(),
    bindHost: (r.bindHost || '').trim() || '127.0.0.1', bindPort: Number(r.bindPort) || 0,
    destHost: type === 'dynamic' ? '' : (r.destHost || '').trim() || '127.0.0.1', destPort: type === 'dynamic' ? 0 : Number(r.destPort) || 0,
  };
  const i = list.findIndex((x) => x.id === rec.id);
  if (i >= 0) list[i] = rec; else list.push(rec);
  writeJSON('forwards.json', list);
  return rec;
});
ipcMain.handle('fwd:delete', (_e, id) => { stopFwd(id); writeJSON('forwards.json', loadFwd().filter((x) => x.id !== id)); return true; });

function pipeBoth(a, b) {
  a.on('error', () => b.destroy?.() || b.end?.());
  b.on('error', () => a.destroy?.() || a.end?.());
  a.pipe(b).pipe(a);
}
// minimal SOCKS5 (no auth, CONNECT) for dynamic forwarding
function socks5(sock, open) {
  const fail = (code) => sock.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
  sock.on('error', () => {});
  sock.once('data', (g) => {
    if (g[0] !== 5) return sock.destroy();
    sock.write(Buffer.from([5, 0]));
    sock.once('data', (r) => {
      if (r[0] !== 5 || r[1] !== 1) return fail(7);
      let host, off;
      if (r[3] === 1) { host = [...r.subarray(4, 8)].join('.'); off = 8; }
      else if (r[3] === 3) { const l = r[4]; host = r.subarray(5, 5 + l).toString(); off = 5 + l; }
      else if (r[3] === 4) { host = r.subarray(4, 20).toString('hex').match(/.{4}/g).join(':'); off = 20; }
      else return fail(8);
      const port = r.readUInt16BE(off);
      const rest = r.subarray(off + 2);
      open(host, port, (err, stream) => {
        if (err) return fail(5);
        sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (rest.length) stream.write(rest);
        pipeBoth(sock, stream);
      });
    });
  });
}
const listen = (server, port, host) => new Promise((res, rej) => { server.once('error', rej); server.listen(port, host, () => { server.off('error', rej); res(); }); });

ipcMain.handle('fwd:start', async (_e, id, lang) => {
  if (running.has(id)) return true;
  const r = loadFwd().find((x) => x.id === id);
  if (!r) throw new Error('Rule not found');
  const h = loadHosts().find((x) => x.id === r.hostId);
  if (!h) throw new Error(ZH(lang) ? '规则对应的主机不存在' : 'Host for this rule not found');
  if (h.authType !== 'key' && !h.password) throw new Error(ZH(lang) ? `主机「${h.name}」需要先保存密码` : `Host "${h.name}" needs a saved password`);
  fwdState(id, 'starting');
  const { client } = await openClient(h, { lang });
  const rec = { client, server: null, sockets: new Set() };
  running.set(id, rec);
  client.on('error', (e) => fwdState(id, 'error', e.message));
  client.on('close', () => { try { rec.server?.close(); } catch {} rec.sockets.forEach((s) => s.destroy()); running.delete(id); fwdState(id, 'stopped'); });
  try {
    if (r.type === 'remote') {
      await new Promise((res, rej) => client.forwardIn(r.bindHost, r.bindPort, (e) => (e ? rej(e) : res())));
      client.on('tcp connection', (_info, accept) => {
        const ch = accept();
        const s = net.connect(r.destPort, r.destHost);
        rec.sockets.add(s); s.on('close', () => rec.sockets.delete(s));
        pipeBoth(ch, s);
      });
    } else {
      const server = net.createServer((sock) => {
        rec.sockets.add(sock); sock.on('close', () => rec.sockets.delete(sock));
        const open = (host, port, cb) => client.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, host, port, cb);
        if (r.type === 'dynamic') return socks5(sock, open);
        open(r.destHost, r.destPort, (err, stream) => { if (err) return sock.destroy(); pipeBoth(sock, stream); });
      });
      rec.server = server;
      await listen(server, r.bindPort, r.bindHost);
    }
  } catch (e) {
    client.end();
    throw new Error(e.code === 'EADDRINUSE' ? (ZH(lang) ? `端口 ${r.bindPort} 已被占用` : `Port ${r.bindPort} is already in use`) : e.message);
  }
  fwdState(id, 'running');
  return true;
});
function stopFwd(id) { const rec = running.get(id); if (rec) rec.client.end(); }
ipcMain.handle('fwd:stop', (_e, id) => { stopFwd(id); return true; });

ipcMain.on('ssh:write', (_e, sid, data) => { const s = sessions.get(sid); if (s) s.stream.write(data); });
ipcMain.on('ssh:resize', (_e, sid, cols, rows) => { const s = sessions.get(sid); if (s) s.stream.setWindow(rows, cols, 0, 0); });
ipcMain.on('ssh:close', (_e, sid) => { const s = sessions.get(sid); if (s) s.client.end(); });

// ---- SFTP ----
function getSftp(sid) {
  const s = sessions.get(sid);
  if (!s) return Promise.reject(new Error('Not connected'));
  if (s.sftp) return Promise.resolve(s.sftp);
  return new Promise((res, rej) => s.client.sftp((err, sftp) => {
    if (err) return rej(err);
    s.sftp = sftp; sftp.on('close', () => { s.sftp = null; }); res(sftp);
  }));
}
const p = (fn) => new Promise((res, rej) => fn((err, v) => (err ? rej(err) : res(v))));
const rjoin = (dir, name) => (dir.endsWith('/') ? dir : dir + '/') + name;

ipcMain.handle('sftp:home', async (_e, sid) => { const f = await getSftp(sid); return p((cb) => f.realpath('.', cb)); });

ipcMain.handle('sftp:list', async (_e, sid, dir) => {
  const f = await getSftp(sid);
  const real = await p((cb) => f.realpath(dir, cb));
  const list = await p((cb) => f.readdir(real, cb));
  return {
    path: real,
    items: list.map((it) => ({
      name: it.filename,
      size: it.attrs.size,
      mtime: it.attrs.mtime,
      isDir: (it.attrs.mode & 0o170000) === 0o040000,
      isLink: (it.attrs.mode & 0o170000) === 0o120000,
      mode: it.attrs.mode,
    })).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name)),
  };
});

function progress(sid, name) {
  return (done, _c, total) => send('sftp:progress', sid, name, done, total);
}

ipcMain.handle('sftp:download', async (_e, sid, dir, name) => {
  const f = await getSftp(sid);
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), name) });
  if (r.canceled) return false;
  await p((cb) => f.fastGet(rjoin(dir, name), r.filePath, { step: progress(sid, name) }, cb));
  return r.filePath;
});

ipcMain.handle('sftp:upload', async (_e, sid, dir, localPaths) => {
  const f = await getSftp(sid);
  let files = localPaths;
  if (!files || !files.length) {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return 0;
    files = r.filePaths;
  }
  for (const lp of files) {
    if (fs.statSync(lp).isDirectory()) continue;
    const name = path.basename(lp);
    await p((cb) => f.fastPut(lp, rjoin(dir, name), { step: progress(sid, name) }, cb));
  }
  return files.length;
});

ipcMain.handle('sftp:mkdir', async (_e, sid, dir, name) => { const f = await getSftp(sid); await p((cb) => f.mkdir(rjoin(dir, name), cb)); return true; });
ipcMain.handle('sftp:rename', async (_e, sid, dir, from, to) => { const f = await getSftp(sid); await p((cb) => f.rename(rjoin(dir, from), rjoin(dir, to), cb)); return true; });
ipcMain.handle('sftp:delete', async (_e, sid, dir, name, isDir) => {
  const f = await getSftp(sid);
  const full = rjoin(dir, name);
  const rm = async (pth, d) => {
    if (!d) return p((cb) => f.unlink(pth, cb));
    const items = await p((cb) => f.readdir(pth, cb));
    for (const it of items) await rm(rjoin(pth, it.filename), (it.attrs.mode & 0o170000) === 0o040000);
    return p((cb) => f.rmdir(pth, cb));
  };
  await rm(full, isDir);
  return true;
});

// ---- window ----
// The window paints its own sky backdrop (no OS acrylic); title bar buttons follow the theme.
ipcMain.handle('win:theme', (_e, dark) => {
  try { win.setTitleBarOverlay({ color: dark ? '#0d0d0e' : '#f1f0ec', symbolColor: dark ? '#a1a1a6' : '#4a4a4f', height: 44 }); } catch {}
});

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 780, minWidth: 860, minHeight: 520,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0d0e' : '#f1f0ec',
    title: 'LightSSH',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: nativeTheme.shouldUseDarkColors ? '#0d0d0e' : '#f1f0ec', symbolColor: nativeTheme.shouldUseDarkColors ? '#a1a1a6' : '#4a4a4f', height: 44 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

Menu.setApplicationMenu(null);
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { for (const s of sessions.values()) s.client.end(); for (const r of running.values()) r.client.end(); app.quit(); });
