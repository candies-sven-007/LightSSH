const { contextBridge, ipcRenderer, webUtils, clipboard } = require('electron');

contextBridge.exposeInMainWorld('api', {
  hosts: {
    list: () => ipcRenderer.invoke('hosts:list'),
    save: (h) => ipcRenderer.invoke('hosts:save', h),
    remove: (id) => ipcRenderer.invoke('hosts:delete', id),
  },
  setTheme: (dark) => ipcRenderer.invoke('win:theme', dark),
  snippets: {
    list: () => ipcRenderer.invoke('snippets:list'),
    save: (s) => ipcRenderer.invoke('snippets:save', s),
    remove: (id) => ipcRenderer.invoke('snippets:delete', id),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (s) => ipcRenderer.invoke('settings:set', s),
  },
  pickKey: () => ipcRenderer.invoke('dialog:pickKey'),
  clip: { read: () => clipboard.readText(), write: (t) => clipboard.writeText(t) },
  pathForFile: (f) => webUtils.getPathForFile(f),
  ssh: {
    connect: (o) => ipcRenderer.invoke('ssh:connect', o),
    write: (sid, d) => ipcRenderer.send('ssh:write', sid, d),
    resize: (sid, c, r) => ipcRenderer.send('ssh:resize', sid, c, r),
    close: (sid) => ipcRenderer.send('ssh:close', sid),
    onData: (cb) => ipcRenderer.on('ssh:data', (_e, sid, d) => cb(sid, d)),
    onClosed: (cb) => ipcRenderer.on('ssh:closed', (_e, sid) => cb(sid)),
    onError: (cb) => ipcRenderer.on('ssh:error', (_e, sid, m) => cb(sid, m)),
  },
  sftp: {
    home: (sid) => ipcRenderer.invoke('sftp:home', sid),
    list: (sid, dir) => ipcRenderer.invoke('sftp:list', sid, dir),
    download: (sid, dir, name) => ipcRenderer.invoke('sftp:download', sid, dir, name),
    upload: (sid, dir, paths) => ipcRenderer.invoke('sftp:upload', sid, dir, paths),
    mkdir: (sid, dir, name) => ipcRenderer.invoke('sftp:mkdir', sid, dir, name),
    rename: (sid, dir, a, b) => ipcRenderer.invoke('sftp:rename', sid, dir, a, b),
    remove: (sid, dir, name, isDir) => ipcRenderer.invoke('sftp:delete', sid, dir, name, isDir),
    onProgress: (cb) => ipcRenderer.on('sftp:progress', (_e, sid, n, d, t) => cb(sid, n, d, t)),
  },
});
