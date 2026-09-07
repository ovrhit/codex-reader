'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 렌더러에는 딱 이 함수들만 노출한다. (Node 접근 없음)
contextBridge.exposeInMainWorld('codex', {
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    onState: (cb) => ipcRenderer.on('window:state', (_e, s) => cb(s))
  },
  db: {
    load: () => ipcRenderer.invoke('db:load'),
    save: (db) => ipcRenderer.invoke('db:save', db),
    flush: () => ipcRenderer.invoke('db:flush'),
    exportTo: (db) => ipcRenderer.invoke('db:export', db),
    importFrom: () => ipcRenderer.invoke('db:import')
  },
  cover: {
    pickFile: () => ipcRenderer.invoke('cover:pickFile'),
    download: (url) => ipcRenderer.invoke('cover:download', url),
    resolve: (file) => ipcRenderer.invoke('cover:resolve', file),
    remove: (file) => ipcRenderer.invoke('cover:delete', file)
  },
  search: {
    papers: (q) => ipcRenderer.invoke('search:papers', q),
    books: (q) => ipcRenderer.invoke('search:books', q),
    toc: (payload) => ipcRenderer.invoke('search:toc', payload)
  },
  shell: {
    openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
    openExternal: (u) => ipcRenderer.invoke('shell:openExternal', u)
  }
});
