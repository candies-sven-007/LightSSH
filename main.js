// LightSSH - main process
const { app, BrowserWindow, ipcMain, dialog, safeStorage, Menu, shell, nativeTheme, screen, clipboard } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const { Client, utils } = require('ssh2');

let win;
const sessions = new Map(); // id -> { client, stream, sftp }

const dataDir = () => app.getPath('userData');
const file = (n) => path.join(dataDir(), n);

function readJSON(name, def) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return def; }
}
// write to a temp file and rename, so a crash mid-write never leaves a truncated file behind
function writeJSON(name, obj) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = file(name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file(name));
}
const expandHome = (p) => (p && /^~(?=$|[\\/])/.test(p) ? path.join(os.homedir(), p.slice(1)) : p || '');

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

// ---- import from OpenSSH config ----
// Parses Host blocks the way ssh does: for each concrete alias, walk every matching block in order, first value wins.
function parseSshConfig(text) {
  const blocks = []; let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^(\S+?)\s*(?:=\s*|\s+)(.+)$/); if (!m) continue;
    const key = m[1].toLowerCase(); const val = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') { cur = { patterns: val.split(/\s+/), opts: {} }; blocks.push(cur); continue; }
    if (key === 'match') { cur = null; continue; } // Match blocks are not supported; skip their options
    if (!cur) { cur = { patterns: ['*'], opts: {} }; blocks.push(cur); }
    if (!(key in cur.opts)) cur.opts[key] = val;
  }
  const glob = (p, s) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i').test(s);
  const matches = (pats, s) => !pats.some((p) => p.startsWith('!') && glob(p.slice(1), s)) && pats.some((p) => !p.startsWith('!') && glob(p, s));
  const aliases = [...new Set(blocks.flatMap((b) => b.patterns.filter((p) => !/[*?!]/.test(p))))];
  return aliases.map((alias) => {
    const o = {};
    for (const b of blocks) if (matches(b.patterns, alias)) for (const [k, v] of Object.entries(b.opts)) if (!(k in o)) o[k] = v;
    return { alias, ...o };
  });
}

ipcMain.handle('hosts:importSshConfig', async (_e, pick) => {
  let cfgPath = path.join(os.homedir(), '.ssh', 'config');
  if (pick || !fs.existsSync(cfgPath)) {
    const r = await dialog.showOpenDialog(win, { defaultPath: path.join(os.homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'] });
    if (r.canceled) return null;
    cfgPath = r.filePaths[0];
  }
  const entries = parseSshConfig(fs.readFileSync(cfgPath, 'utf8'));
  const hosts = loadHosts();
  const user = (() => { try { return os.userInfo().username; } catch { return 'root'; } })();
  const byAlias = new Map();
  let added = 0, skipped = 0;
  for (const e of entries) {
    const rec = {
      id: crypto.randomUUID(), name: e.alias, group: 'SSH config',
      host: e.hostname ? e.hostname.replace(/%h/g, e.alias) : e.alias, port: Number(e.port) || 22, username: e.user || user,
      authType: e.identityfile ? 'key' : 'password', keyPath: e.identityfile ? expandHome(e.identityfile.replace(/%d/g, '~')) : '',
      jumpHostId: '', lastUsed: 0, password: '', passphrase: '', _jump: e.proxyjump && e.proxyjump.toLowerCase() !== 'none' ? e.proxyjump : '',
    };
    const dup = hosts.find((h) => h.host === rec.host && Number(h.port) === rec.port && h.username === rec.username);
    if (dup) { skipped++; byAlias.set(e.alias, dup); continue; }
    hosts.push(rec); byAlias.set(e.alias, rec); added++;
  }
  // ProxyJump: point at the hop nearest to the target, matched by alias or by user@host:port
  for (const h of hosts) {
    if (!h._jump) continue;
    const hop = h._jump.split(',').pop().trim();
    const m = hop.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
    const j = byAlias.get(hop) || (m && hosts.find((x) => x !== h && (x.name === m[2] || x.host === m[2]) && (!m[1] || x.username === m[1]) && (!m[3] || Number(x.port) === Number(m[3]))));
    if (j && j.id !== h.id) h.jumpHostId = j.id;
    delete h._jump;
  }
  writeJSON('hosts.json', hosts);
  return { added, skipped, file: cfgPath };
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

// ---- clipboard & native input editing ----
// Electron 45+ exposes clipboard in main process (Promise-based) rather than preload/renderer.
ipcMain.handle('clip:read', async () => (await clipboard.readText()) || '');
ipcMain.handle('clip:write', async (_e, text) => { await clipboard.writeText(String(text ?? '')); return true; });
ipcMain.handle('edit:cmd', (_e, cmd) => {
  if (!win || win.isDestroyed()) return false;
  if (['cut', 'copy', 'paste', 'selectAll'].includes(cmd)) { win.webContents[cmd](); return true; }
  return false;
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

// Errors that the renderer can recover from by asking the user again carry a tag: "E_AUTH|msg" / "E_PASSPHRASE|msg".
const tagged = (tag, msg) => new Error(`${tag}|${msg}`);

// Open an authenticated client to host h, going through its jump host chain when it has one.
// password / passphrase override the saved ones for the target host only (not for jump hosts).
async function openClient(h, { password, passphrase, lang, chain = [] } = {}) {
  const top = !chain.length;
  const pwd = password || dec(h.password || '');
  let privateKey = null, pp = '';
  if (h.authType === 'key') {
    if (!h.keyPath) throw new Error(ZH(lang) ? '没有选择私钥文件' : 'No private key file');
    try { privateKey = fs.readFileSync(expandHome(h.keyPath)); } catch (e) { throw new Error((ZH(lang) ? '无法读取私钥：' : 'Cannot read private key: ') + e.message); }
    pp = passphrase || dec(h.passphrase || '');
    const parsed = utils.parseKey(privateKey, pp || undefined);
    if (parsed instanceof Error) {
      const msg = (ZH(lang) ? '私钥无法解析：' : 'Cannot parse private key: ') + parsed.message;
      if (top && /passphrase|decrypt|encrypted/i.test(parsed.message)) throw tagged('E_PASSPHRASE', msg);
      throw new Error(msg);
    }
  }

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
  const cfg = {
    host: h.host, port: Number(h.port) || 22, username: h.username,
    readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 4, tryKeyboard: true,
    hostVerifier: (key, cb) => { verifyHost(`[${h.host}]:${h.port || 22}`, key, lang).then(cb); },
  };
  if (sock) cfg.sock = sock;
  if (privateKey) {
    cfg.privateKey = privateKey;
    if (pp) cfg.passphrase = pp;
    if (pwd) cfg.password = pwd;
  } else cfg.password = pwd;

  const client = new Client();
  client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => pwd)));
  await new Promise((resolve, reject) => {
    let done = false;
    const fail = (err) => {
      if (done) return; done = true; jumps.forEach((c) => c.end());
      if (top && err.level === 'client-authentication') {
        const who = h.name || `${h.username}@${h.host}`;
        return reject(tagged('E_AUTH', ZH(lang) ? `认证失败（${who}）` : `Authentication failed (${who})`));
      }
      reject(err);
    };
    client.once('ready', () => { done = true; resolve(); });
    client.on('error', fail);
    try { client.connect(cfg); } catch (err) { fail(err); }
  });
  client.on('close', () => jumps.forEach((c) => c.end()));
  return { client, jumps };
}

// Batch terminal output: one IPC message per session every few ms instead of one per TCP chunk.
const outBuf = new Map(); // sid -> Buffer[]
let outTimer = null;
function flushOut() {
  outTimer = null;
  for (const [sid, chunks] of outBuf) send('ssh:data', sid, chunks.length === 1 ? chunks[0] : Buffer.concat(chunks));
  outBuf.clear();
}
function queueOut(sid, d) {
  const q = outBuf.get(sid);
  if (q) q.push(d); else outBuf.set(sid, [d]);
  if (!outTimer) outTimer = setTimeout(flushOut, 4);
}

function endSession(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  sessions.delete(sid); // remove first so its close event is not reported as a fresh disconnect
  try { s.client.end(); } catch {}
}

ipcMain.handle('ssh:connect', async (_e, { sid, hostId, quick, password, passphrase, cols, rows, lang }) => {
  let h;
  if (quick) h = { host: quick.host, port: quick.port || 22, username: quick.username, authType: 'password' };
  else h = loadHosts().find((x) => x.id === hostId);
  if (!h) throw new Error('Host not found');
  endSession(sid);
  const { client } = await openClient(h, { password, passphrase, lang });
  return new Promise((resolve, reject) => {
    client.shell({ term: 'xterm-256color', cols: cols || 80, rows: rows || 24 }, (err, stream) => {
      if (err) { client.end(); return reject(err); }
      const mine = () => sessions.get(sid)?.client === client;
      sessions.set(sid, { client, stream, sftp: null });
      stream.on('data', (d) => queueOut(sid, d));
      stream.stderr.on('data', (d) => queueOut(sid, d));
      stream.on('close', () => client.end());
      client.on('error', (e) => { if (mine()) send('ssh:error', sid, e.message); });
      client.on('close', () => {
        if (!mine()) return;
        sessions.delete(sid);
        if (outBuf.has(sid)) flushOut();
        send('ssh:closed', sid);
      });
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
    if (!g.subarray(2, 2 + g[1]).includes(0)) return sock.end(Buffer.from([5, 0xff])); // client must offer "no auth"
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

// progress at most ~10 times a second per transfer, plus the final 100%
function progress(sid, name) {
  let last = 0;
  return (done, _c, total) => {
    const now = Date.now();
    if (done < total && now - last < 100) return;
    last = now;
    send('sftp:progress', sid, name, done, total);
  };
}
const isDirMode = (mode) => (mode & 0o170000) === 0o040000;
const mkdirQuiet = (f, pth) => p((cb) => f.mkdir(pth, cb)).catch(async (e) => {
  const st = await p((cb) => f.stat(pth, cb)).catch(() => null);
  if (!st || !isDirMode(st.mode)) throw e; // only "already exists as a directory" is fine
});

async function getTree(f, sid, remote, local) {
  fs.mkdirSync(local, { recursive: true });
  let n = 0;
  for (const it of await p((cb) => f.readdir(remote, cb))) {
    const r = rjoin(remote, it.filename), l = path.join(local, it.filename.replace(/[<>:"/\\|?*]/g, '_'));
    if (isDirMode(it.attrs.mode)) n += await getTree(f, sid, r, l);
    else if ((it.attrs.mode & 0o170000) === 0o100000) { await p((cb) => f.fastGet(r, l, { step: progress(sid, it.filename) }, cb)); n++; }
  }
  return n;
}
async function putTree(f, sid, local, remote) {
  if (!fs.statSync(local).isDirectory()) {
    await p((cb) => f.fastPut(local, remote, { step: progress(sid, path.basename(local)) }, cb));
    return 1;
  }
  await mkdirQuiet(f, remote);
  let n = 0;
  for (const ent of fs.readdirSync(local, { withFileTypes: true })) {
    if (ent.isDirectory() || ent.isFile()) n += await putTree(f, sid, path.join(local, ent.name), rjoin(remote, ent.name));
  }
  return n;
}

ipcMain.handle('sftp:download', async (_e, sid, dir, name, isDir) => {
  const f = await getSftp(sid);
  if (isDir) {
    const r = await dialog.showOpenDialog(win, { defaultPath: app.getPath('downloads'), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return false;
    const dest = path.join(r.filePaths[0], name);
    await getTree(f, sid, rjoin(dir, name), dest);
    return dest;
  }
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), name) });
  if (r.canceled) return false;
  await p((cb) => f.fastGet(rjoin(dir, name), r.filePath, { step: progress(sid, name) }, cb));
  return r.filePath;
});

ipcMain.handle('sftp:upload', async (_e, sid, dir, localPaths, folder) => {
  const f = await getSftp(sid);
  let files = localPaths;
  if (!files || !files.length) {
    const r = await dialog.showOpenDialog(win, { properties: folder ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'] });
    if (r.canceled) return 0;
    files = r.filePaths;
  }
  let n = 0;
  for (const lp of files) n += await putTree(f, sid, lp, rjoin(dir, path.basename(lp)));
  return n;
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
// Warm parchment / olive-umber shell; Windows caption buttons match the top rail.
const chromeColors = (dark) => ({ color: dark ? '#141412' : '#ede9df', symbolColor: dark ? '#aba79d' : '#57554f', height: 44 });
ipcMain.handle('win:theme', (_e, dark) => {
  try { win.setTitleBarOverlay(chromeColors(dark)); } catch {}
});

function loadBounds() {
  const b = readJSON('window.json', null);
  if (!b || !(b.width > 0 && b.height > 0)) return null;
  // only restore a position that is still on a connected display
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) => b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 8 && b.y < a.y + a.height - 40);
  return onScreen ? b : { width: b.width, height: b.height, maximized: b.maximized };
}

function createWindow() {
  const b = loadBounds();
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: b?.width || 1260, height: b?.height || 800, ...(b?.x != null && b?.y != null ? { x: b.x, y: b.y } : {}),
    minWidth: 860, minHeight: 540,
    backgroundColor: dark ? '#141412' : '#ede9df',
    title: 'LightSSH',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: chromeColors(dark),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  if (b?.maximized) win.maximize();
  win.on('close', () => {
    try { writeJSON('window.json', { ...win.getNormalBounds(), maximized: win.isMaximized() }); } catch {}
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // never let a stray file drop or link replace the app page
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

Menu.setApplicationMenu(null);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(createWindow);
}
app.on('window-all-closed', () => { for (const s of sessions.values()) s.client.end(); for (const r of running.values()) r.client.end(); app.quit(); });
