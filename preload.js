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
  ocr: {
    languages: () => ipcRenderer.invoke('ocr:languages'),
    pickImages: () => ipcRenderer.invoke('ocr:pickImages'),
    recognize: (path, lang) => ipcRenderer.invoke('ocr:recognize', { path, lang })
  },
  ai: {
    // 키 자체는 절대 렌더러로 돌아오지 않는다 (설정 여부와 꼬리 4자리만).
    getConfig: () => ipcRenderer.invoke('ai:getConfig'),
    setConfig: (cfg) => ipcRenderer.invoke('ai:setConfig', cfg),
    test: () => ipcRenderer.invoke('ai:test'),
    extractTOC: (path) => ipcRenderer.invoke('ai:extractTOC', path),
    // 한도 초과로 재시도를 기다리는 중이라는 알림
    onProgress: (cb) => {
      const h = (_e, info) => cb(info);
      ipcRenderer.on('ai:progress', h);
      return () => ipcRenderer.removeListener('ai:progress', h);
    }
  },
  obsidian: {
    status: () => ipcRenderer.invoke('obs:status'),
    setConfig: (cfg) => ipcRenderer.invoke('obs:setConfig', cfg),
    pickVault: () => ipcRenderer.invoke('obs:pickVault'),
    listNotes: (opts) => ipcRenderer.invoke('obs:listNotes', opts),
    readNote: (rel) => ipcRenderer.invoke('obs:readNote', rel),
    createNote: (payload) => ipcRenderer.invoke('obs:createNote', payload),
    openNote: (rel) => ipcRenderer.invoke('obs:openNote', rel)
  },
  shell: {
    openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
    openExternal: (u) => ipcRenderer.invoke('shell:openExternal', u)
  }
});
