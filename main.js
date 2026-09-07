'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

const IS_DEV = process.argv.includes('--dev');

// userData 경로가 %APPDATA%\CODEX 가 되도록 — getPath 보다 먼저 호출해야 한다.
app.setName('CODEX');

// ─── 저장소 경로 ────────────────────────────────────────────────────────────
// 모든 데이터는 이 PC 안에만 존재합니다. 외부 서버로 전송하지 않습니다.
const DATA_DIR = path.join(app.getPath('userData'), 'codex-data');
const DATA_FILE = path.join(DATA_DIR, 'library.json');
const COVER_DIR = path.join(DATA_DIR, 'covers');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

function ensureDirs() {
  for (const d of [DATA_DIR, COVER_DIR, BACKUP_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

const EMPTY_DB = { version: 1, works: [], settings: { accent: 'cyan' }, updatedAt: null };

function readDB() {
  ensureDirs();
  if (!fs.existsSync(DATA_FILE)) return structuredClone(EMPTY_DB);
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const db = JSON.parse(raw);
    if (!db || typeof db !== 'object' || !Array.isArray(db.works)) return structuredClone(EMPTY_DB);
    db.settings = Object.assign({}, EMPTY_DB.settings, db.settings || {});
    return db;
  } catch (err) {
    // 손상된 파일은 덮어쓰지 않고 따로 보관한다.
    const broken = path.join(BACKUP_DIR, `corrupt-${Date.now()}.json`);
    try { fs.copyFileSync(DATA_FILE, broken); } catch { /* noop */ }
    return structuredClone(EMPTY_DB);
  }
}

let saveTimer = null;
let pendingDB = null;

function writeDBSync(db) {
  ensureDirs();
  db.updatedAt = new Date().toISOString();
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
  return db.updatedAt;
}

// 하루 한 번 자동 백업 (최근 20개 유지)
function rollingBackup() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const target = path.join(BACKUP_DIR, `library-${stamp}.json`);
    if (fs.existsSync(target)) return;
    fs.copyFileSync(DATA_FILE, target);
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('library-')).sort();
    while (files.length > 20) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch { /* 백업 실패가 앱을 막지 않도록 */ }
}

// ─── 창 ─────────────────────────────────────────────────────────────────────
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 1040,
    minHeight: 660,
    show: false,
    frame: false,
    backgroundColor: '#05070d',
    title: 'CODEX',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());
  if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });

  const push = () => win.webContents.send('window:state', {
    maximized: win.isMaximized(), fullscreen: win.isFullScreen()
  });
  win.on('maximize', push);
  win.on('unmaximize', push);
  win.on('enter-full-screen', push);
  win.on('leave-full-screen', push);

  // 외부 링크는 기본 브라우저로.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });

  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  ensureDirs();
  rollingBackup();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (pendingDB) { try { writeDBSync(pendingDB); } catch { /* noop */ } pendingDB = null; }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (saveTimer) clearTimeout(saveTimer);
  if (pendingDB) { try { writeDBSync(pendingDB); } catch { /* noop */ } pendingDB = null; }
});

// ─── IPC: 창 제어 ───────────────────────────────────────────────────────────
ipcMain.handle('window:minimize', () => win && win.minimize());
ipcMain.handle('window:toggleMaximize', () => {
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
  return win.isMaximized();
});
ipcMain.handle('window:close', () => win && win.close());

// ─── IPC: 데이터 ────────────────────────────────────────────────────────────
ipcMain.handle('db:load', () => ({ db: readDB(), paths: { data: DATA_DIR, file: DATA_FILE, covers: COVER_DIR } }));

ipcMain.handle('db:save', (_e, db) => {
  pendingDB = db;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { writeDBSync(pendingDB); } catch (err) { console.error('save failed', err); }
    pendingDB = null;
    saveTimer = null;
  }, 250);
  return true;
});

ipcMain.handle('db:flush', () => {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (pendingDB) { const t = writeDBSync(pendingDB); pendingDB = null; return t; }
  return null;
});

ipcMain.handle('db:export', async (_e, db) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '서재 내보내기',
    defaultPath: `codex-library-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { ok: false };
  await fsp.writeFile(filePath, JSON.stringify(db, null, 2), 'utf8');
  return { ok: true, path: filePath };
});

ipcMain.handle('db:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '서재 가져오기', properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePaths[0]) return { ok: false };
  const raw = await fsp.readFile(filePaths[0], 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.works)) throw new Error('올바른 CODEX 백업 파일이 아닙니다.');
  return { ok: true, db: parsed, path: filePaths[0] };
});

ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p || DATA_DIR));
ipcMain.handle('shell:openExternal', (_e, url) => {
  if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
  return false;
});

// ─── IPC: 표지 이미지 ───────────────────────────────────────────────────────
const IMG_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif' };

ipcMain.handle('cover:pickFile', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '표지 이미지 선택', properties: ['openFile'],
    filters: [{ name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] }]
  });
  if (canceled || !filePaths[0]) return null;
  ensureDirs();
  const ext = path.extname(filePaths[0]).toLowerCase() || '.png';
  const name = crypto.randomUUID() + ext;
  const dest = path.join(COVER_DIR, name);
  await fsp.copyFile(filePaths[0], dest);
  return { file: name, url: pathToFileURL(dest) };
});

ipcMain.handle('cover:download', async (_e, url) => {
  if (!/^https?:\/\//i.test(url)) throw new Error('http(s) 주소만 받을 수 있습니다.');
  ensureDirs();
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`이미지를 받지 못했습니다 (HTTP ${res.status})`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 512) throw new Error('표지 이미지가 비어 있습니다.');
  const ext = IMG_EXT[type] || path.extname(new URL(url).pathname).toLowerCase() || '.jpg';
  const name = crypto.randomUUID() + ext;
  const dest = path.join(COVER_DIR, name);
  await fsp.writeFile(dest, buf);
  return { file: name, url: pathToFileURL(dest) };
});

ipcMain.handle('cover:resolve', (_e, file) => {
  if (!file) return null;
  const p = path.join(COVER_DIR, path.basename(file));
  return fs.existsSync(p) ? pathToFileURL(p) : null;
});

ipcMain.handle('cover:delete', async (_e, file) => {
  if (!file) return false;
  const p = path.join(COVER_DIR, path.basename(file));
  try { await fsp.unlink(p); return true; } catch { return false; }
});

function pathToFileURL(p) {
  return 'file:///' + p.replace(/\\/g, '/').replace(/#/g, '%23').replace(/\?/g, '%3F');
}

// ─── IPC: 온라인 문헌 검색 (전부 선택 기능 · 실패해도 수동 입력 가능) ──────
const UA = 'CODEX-Reader/1.0 (local desktop reading tracker)';

async function getJSON(url, timeout = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

function cleanText(s) {
  if (!s) return '';
  return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// 논문 — Crossref (DOI 등록기관, 학술 문헌 커버리지가 가장 넓다)
async function searchCrossref(q) {
  const doi = q.trim().replace(/^(https?:\/\/(dx\.)?doi\.org\/)/i, '');
  const isDOI = /^10\.\d{4,9}\/\S+$/.test(doi);
  const url = isDOI
    ? `https://api.crossref.org/works/${encodeURIComponent(doi)}`
    : `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&rows=15&select=DOI,title,author,issued,container-title,page,volume,issue,publisher,type,URL,abstract,subject`;
  const data = await getJSON(url);
  const items = isDOI ? [data.message] : (data.message?.items || []);
  return items.filter(Boolean).map(it => ({
    source: 'Crossref',
    type: 'paper',
    title: cleanText((it.title || [])[0]) || '(제목 없음)',
    authors: (it.author || []).map(a => cleanText([a.given, a.family].filter(Boolean).join(' ') || a.name)).filter(Boolean),
    year: it.issued?.['date-parts']?.[0]?.[0] || null,
    venue: cleanText((it['container-title'] || [])[0]) || cleanText(it.publisher),
    doi: it.DOI || '',
    url: it.URL || (it.DOI ? `https://doi.org/${it.DOI}` : ''),
    pages: it.page || '',
    volume: [it.volume, it.issue].filter(Boolean).join('('),
    abstract: cleanText(it.abstract).slice(0, 600),
    tags: (it.subject || []).slice(0, 4),
    coverUrl: null,
    kind: it.type || ''
  }));
}

// 책 — Open Library (표지 + 판본 목차) / Google Books (표지 + 쪽수 보강)
async function searchOpenLibrary(q) {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=12&fields=key,title,author_name,first_publish_year,cover_i,number_of_pages_median,publisher,isbn,edition_key,subject`;
  const data = await getJSON(url);
  return (data.docs || []).map(d => ({
    source: 'Open Library',
    type: 'book',
    title: cleanText(d.title) || '(제목 없음)',
    authors: (d.author_name || []).map(cleanText),
    year: d.first_publish_year || null,
    venue: cleanText((d.publisher || [])[0]),
    isbn: (d.isbn || [])[0] || '',
    url: d.key ? `https://openlibrary.org${d.key}` : '',
    pageCount: d.number_of_pages_median || null,
    coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null,
    tags: (d.subject || []).slice(0, 4).map(cleanText),
    editions: (d.edition_key || []).slice(0, 6),
    olKey: d.key || ''
  }));
}

async function searchGoogleBooks(q) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=12&printType=books`;
  const data = await getJSON(url);
  return (data.items || []).map(it => {
    const v = it.volumeInfo || {};
    const isbn = (v.industryIdentifiers || []).find(i => i.type === 'ISBN_13') || (v.industryIdentifiers || [])[0];
    const thumb = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || null;
    return {
      source: 'Google Books',
      type: 'book',
      title: cleanText(v.title) + (v.subtitle ? ': ' + cleanText(v.subtitle) : ''),
      authors: (v.authors || []).map(cleanText),
      year: v.publishedDate ? parseInt(String(v.publishedDate).slice(0, 4), 10) : null,
      venue: cleanText(v.publisher),
      isbn: isbn?.identifier || '',
      url: v.infoLink || v.canonicalVolumeLink || '',
      pageCount: v.pageCount || null,
      coverUrl: thumb ? thumb.replace(/^http:/, 'https:').replace(/&edge=curl/, '') : null,
      tags: (v.categories || []).slice(0, 4).map(cleanText),
      abstract: cleanText(v.description).slice(0, 600),
      editions: [],
      olKey: ''
    };
  });
}

ipcMain.handle('search:papers', async (_e, q) => {
  const out = await searchCrossref(q);
  return out;
});

ipcMain.handle('search:books', async (_e, q) => {
  const results = await Promise.allSettled([searchOpenLibrary(q), searchGoogleBooks(q)]);
  const list = [];
  for (const r of results) if (r.status === 'fulfilled') list.push(...r.value);
  if (!list.length) {
    const err = results.find(r => r.status === 'rejected');
    if (err) throw new Error(err.reason?.message || '검색에 실패했습니다.');
  }
  // 두 소스를 제목+저자 기준으로 살짝 섞어 정렬 (표지/쪽수 있는 쪽 우선)
  list.sort((a, b) => (score(b) - score(a)));
  function score(x) { return (x.coverUrl ? 2 : 0) + (x.pageCount ? 1 : 0); }
  return list;
});

// 판본 목차 조회 — Open Library 판본 레코드에 table_of_contents 가 있으면 가져온다.
ipcMain.handle('search:toc', async (_e, payload) => {
  const editions = (payload?.editions || []).slice(0, 6);
  const isbn = payload?.isbn;
  const tried = [];

  async function fromEdition(key) {
    const data = await getJSON(`https://openlibrary.org/books/${encodeURIComponent(key)}.json`);
    const toc = data?.table_of_contents;
    if (!Array.isArray(toc) || !toc.length) return null;
    // Open Library 목차는 레코드마다 필드 쓰임이 다르다.
    //  · {label:"1장", title:"서론", pagenum:"3"}  — 흔한 형태
    //  · {label:"서론", title:"vii", pagenum:""}    — 쪽 번호가 title 에 들어간 형태
    const pageLike = s => /^(\d{1,4}|[ivxlcdm]{1,7})$/i.test(s);
    const rows = toc.map(t => {
      let label = cleanText(t.label || '');
      let title = cleanText(t.title || '');
      let page = t.pagenum ? String(t.pagenum).trim() : '';

      if (!page && title && pageLike(title) && label.length > 3) { page = title; title = ''; }
      else if (!page && label && /^\d{1,4}$/.test(label) && title) { page = label; label = ''; }

      return {
        title: [label, title].filter(Boolean).join(' ').trim(),
        level: Number(t.level) || 0,
        page
      };
    }).filter(r => r.title);
    if (!rows.length) return null;
    // 레코드에 따라 최상위 레벨이 1부터 시작하기도 한다 — 0 기준으로 맞춘다.
    const minLevel = Math.min(...rows.map(r => r.level));
    for (const r of rows) r.level = Math.max(0, Math.min(2, r.level - minLevel));
    return { rows, source: `Open Library / ${key}` };
  }

  for (const key of editions) {
    tried.push(key);
    try { const r = await fromEdition(key); if (r) return r; } catch { /* 다음 판본 */ }
  }

  if (isbn) {
    try {
      const d = await getJSON(`https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`);
      if (d?.key) {
        const key = d.key.split('/').pop();
        if (!tried.includes(key)) { const r = await fromEdition(key); if (r) return r; }
      }
    } catch { /* noop */ }
  }
  return null;
});
