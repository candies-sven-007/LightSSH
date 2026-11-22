// LightSSH - main process
const { app, BrowserWindow, ipcMain, dialog, safeStorage, Menu, shell, nativeTheme } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
  writeJSON('hosts.json', loadHosts().filter((h) => h.id !== id));
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

ipcMain.handle('ssh:connect', async (_e, { sid, hostId, quick, password, cols, rows, lang }) => {
  let h;
  if (quick) h = { host: quick.host, port: quick.port || 22, username: quick.username, authType: 'password' };
  else h = loadHosts().find((x) => x.id === hostId);
  if (!h) throw new Error('Host not found');

  const cfg = {
    host: h.host,
    port: Number(h.port) || 22,
    username: h.username,
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    tryKeyboard: true,
    hostVerifier: (key, cb) => { verifyHost(`[${h.host}]:${h.port || 22}`, key, lang).then(cb); },
  };
  const pwd = password || dec(h.password || '');
  if (h.authType === 'key') {
    if (!h.keyPath) throw new Error('No private key file');
    cfg.privateKey = fs.readFileSync(h.keyPath);
    const pp = dec(h.passphrase || '');
    if (pp) cfg.passphrase = pp;
    if (pwd) cfg.password = pwd;
  } else {
    cfg.password = pwd;
  }

  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => pwd)));
    client.on('ready', () => {
      client.shell({ term: 'xterm-256color', cols: cols || 80, rows: rows || 24 }, (err, stream) => {
        if (err) { settled = true; client.end(); return reject(err); }
        sessions.set(sid, { client, stream, sftp: null });
        stream.on('data', (d) => send('ssh:data', sid, d));
        stream.stderr.on('data', (d) => send('ssh:data', sid, d));
        stream.on('close', () => { client.end(); });
        settled = true;
        if (!quick) touchHost(hostId);
        resolve(true);
      });
    });
    client.on('error', (err) => {
      if (!settled) { settled = true; reject(err); }
      else send('ssh:error', sid, err.message);
    });
    client.on('close', () => { sessions.delete(sid); send('ssh:closed', sid); });
    try { client.connect(cfg); } catch (err) { settled = true; reject(err); }
  });
});

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
// Windows 11 22H2+ (build 22621) supports native acrylic; older systems get a CSS fallback
function nativeGlass() {
  if (process.platform !== 'win32') return false;
  const build = Number(os.release().split('.')[2] || 0);
  return build >= 22621;
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  const glass = nativeGlass();
  win = new BrowserWindow({
    width: 1200, height: 760, minWidth: 820, minHeight: 500,
    backgroundColor: glass ? '#00000000' : '#101218',
    ...(glass ? { backgroundMaterial: 'acrylic' } : {}),
    title: 'LightSSH',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#dfe3ea', height: 42 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { glass: glass ? 'native' : 'css' } });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

Menu.setApplicationMenu(null);
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { for (const s of sessions.values()) s.client.end(); app.quit(); });
