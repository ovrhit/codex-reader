'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// 옵시디언 볼트 연동
//
// 볼트는 그냥 마크다운 파일 폴더라서 직접 읽고 쓸 수 있다. 다만 이건 사용자의
// 개인 지식 저장소이므로 두 가지를 못 박아 둔다.
//   1. 쓰기는 사용자가 지정한 하위 폴더 안에서만 한다. 그 밖은 읽기만.
//   2. 덮어쓰지 않는다. 같은 이름이 있으면 번호를 붙여 새로 만든다.
// ─────────────────────────────────────────────────────────────────────────────

const { app, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'codex-data', 'obsidian.json');
const DEFAULT_SUBFOLDER = 'CODEX';

// ─── 설정 ───────────────────────────────────────────────────────────────────
function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8'));
    return {
      vaultPath: c.vaultPath || '',
      subfolder: c.subfolder || DEFAULT_SUBFOLDER
    };
  } catch {
    return { vaultPath: '', subfolder: DEFAULT_SUBFOLDER };
  }
}

function writeConfig(c) {
  const dir = path.dirname(CONFIG_FILE());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(c, null, 2), 'utf8');
}

/** 옵시디언이 기록해 둔 볼트 목록을 읽는다. 설치돼 있지 않으면 빈 배열. */
function detectVaults() {
  try {
    const p = path.join(app.getPath('appData'), 'obsidian', 'obsidian.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Object.values(j.vaults || {})
      .filter(v => v?.path && fs.existsSync(v.path))
      .map(v => ({ path: v.path, name: path.basename(v.path), open: !!v.open }));
  } catch {
    return [];
  }
}

function status() {
  const c = readConfig();
  const vaults = detectVaults();
  const linked = !!c.vaultPath && fs.existsSync(c.vaultPath);
  let writable = false;
  if (linked) {
    try {
      const probe = path.join(c.vaultPath, '.codex-write-probe');
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      writable = true;
    } catch { writable = false; }
  }
  return {
    vaultPath: c.vaultPath,
    vaultName: c.vaultPath ? path.basename(c.vaultPath) : '',
    subfolder: c.subfolder,
    linked,
    writable,
    detected: vaults
  };
}

function setConfig({ vaultPath, subfolder }) {
  const c = readConfig();
  if (vaultPath !== undefined) c.vaultPath = vaultPath || '';
  if (subfolder !== undefined) {
    // 하위 폴더는 볼트 안의 상대 경로여야 한다. 위로 올라가는 건 막는다.
    const s = String(subfolder || '').replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '');
    if (s.split('/').some(seg => seg === '..' || seg === '.')) {
      throw new Error('하위 폴더 경로에 .. 는 쓸 수 없습니다.');
    }
    c.subfolder = s || DEFAULT_SUBFOLDER;
  }
  writeConfig(c);
  return status();
}

async function pickVault() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '옵시디언 볼트 폴더 선택',
    properties: ['openDirectory']
  });
  if (canceled || !filePaths[0]) return status();
  const p = filePaths[0];
  if (!fs.existsSync(path.join(p, '.obsidian'))) {
    // 강제하지는 않되 알려 준다 — 새 볼트일 수도 있으니.
    // (렌더러에서 경고를 띄우도록 플래그만 넘긴다)
    const s = setConfig({ vaultPath: p });
    return { ...s, warnNotAVault: true };
  }
  return setConfig({ vaultPath: p });
}

// ─── 경로 안전장치 ──────────────────────────────────────────────────────────
function vaultRoot() {
  const c = readConfig();
  if (!c.vaultPath) throw new Error('볼트가 연결되지 않았습니다. 설정에서 먼저 지정하세요.');
  if (!fs.existsSync(c.vaultPath)) throw new Error('볼트 폴더를 찾을 수 없습니다: ' + c.vaultPath);
  return c.vaultPath;
}

/** 볼트 안의 상대 경로를 절대 경로로 바꾸되, 볼트 밖으로 나가면 거부한다. */
function resolveInVault(rel, { mustBeInSubfolder = false } = {}) {
  const root = vaultRoot();
  const c = readConfig();
  const abs = path.resolve(root, rel);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw new Error('볼트 밖의 경로에는 접근하지 않습니다.');
  }
  if (mustBeInSubfolder) {
    const base = path.resolve(root, c.subfolder);
    const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
    if (!abs.startsWith(baseWithSep)) {
      throw new Error(`쓰기는 "${c.subfolder}" 폴더 안에서만 합니다.`);
    }
  }
  return abs;
}

const toVaultRel = (abs) => path.relative(vaultRoot(), abs).split(path.sep).join('/');

// ─── 노트 목록 / 읽기 ───────────────────────────────────────────────────────
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules']);

async function listNotes({ query = '', limit = 300 } = {}) {
  const root = vaultRoot();
  const q = String(query).trim().toLowerCase();
  const out = [];

  async function walk(dir) {
    if (out.length >= limit) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name));
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        const abs = path.join(dir, e.name);
        const rel = toVaultRel(abs);
        if (!q || rel.toLowerCase().includes(q)) {
          out.push({ rel, name: e.name.replace(/\.md$/i, '') });
        }
      }
    }
  }
  await walk(root);
  out.sort((a, b) => a.rel.localeCompare(b.rel, 'ko'));
  return out;
}

/** 연결된 노트의 앞부분을 미리보기로 준다. 없으면 exists:false. */
async function readNote(rel) {
  const abs = resolveInVault(rel);
  try {
    const txt = await fsp.readFile(abs, 'utf8');
    const body = txt.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');   // 프론트매터 제거
    const st = await fsp.stat(abs);
    return {
      exists: true, rel,
      preview: body.split(/\r?\n/).filter(l => l.trim()).slice(0, 6).join('\n').slice(0, 500),
      bytes: st.size,
      modifiedAt: st.mtime.toISOString()
    };
  } catch {
    return { exists: false, rel };
  }
}

// ─── 노트 만들기 ────────────────────────────────────────────────────────────
// Windows 금지 문자에 더해 옵시디언 링크에서 말썽인 문자까지 걸러낸다.
const BAD_CHARS = /[\\/:*?"<>|#^[\]]/g;

// Windows 가 장치 이름으로 예약해 둔 것들 — 파일명으로 쓰면 생성이 실패한다.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function safeName(s, fallback = 'untitled') {
  let out = String(s || '').replace(BAD_CHARS, ' ');
  // 제목에 "../" 가 섞여 들어와도 경로로 읽히지 않게 점 연속을 없앤다.
  out = out.replace(/\.{2,}/g, ' ');
  // 제어 문자도 제거
  out = out.replace(/[\u0000-\u001f\u007f]/g, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  out = out.replace(/^[.\s]+|[.\s]+$/g, '').trim();
  if (out.length > 80) out = out.slice(0, 80).trim();
  if (!out) return fallback;
  if (RESERVED.test(out)) out = out + '_';
  return out;
}

function frontmatter(obj) {
  const esc = v => `"${String(v).replace(/"/g, '\\"')}"`;
  const lines = ['---'];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      lines.push(`${k}: [${v.map(esc).join(', ')}]`);
    } else if (typeof v === 'number') {
      lines.push(`${k}: ${v}`);
    } else {
      lines.push(`${k}: ${esc(v)}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

/**
 * 장 하나에 대한 노트를 만든다. 이미 있으면 덮어쓰지 않고 " 2", " 3" 을 붙인다.
 * @returns {{rel:string, created:boolean}}
 */
async function createChapterNote({ work, chapter }) {
  const c = readConfig();
  const root = vaultRoot();

  const bookDir = safeName(work?.title, 'book');
  const noteName = safeName(chapter?.title, 'chapter');
  const dirAbs = resolveInVault(path.join(c.subfolder, bookDir), { mustBeInSubfolder: true });
  await fsp.mkdir(dirAbs, { recursive: true });

  let abs = path.join(dirAbs, `${noteName}.md`);
  let n = 2;
  while (fs.existsSync(abs)) {
    abs = path.join(dirAbs, `${noteName} ${n}.md`);
    n++;
    if (n > 999) throw new Error('같은 이름의 노트가 너무 많습니다.');
  }
  resolveInVault(path.relative(root, abs), { mustBeInSubfolder: true });   // 최종 확인

  const pages = (chapter?.from != null && chapter?.to != null) ? `${chapter.from}-${chapter.to}`
              : (chapter?.from != null ? String(chapter.from) : '');

  const fm = frontmatter({
    book: work?.title || '',
    authors: (work?.authors || []).join(', '),
    year: work?.year ?? '',
    chapter: chapter?.title || '',
    pages,
    source: 'CODEX',
    created: new Date().toISOString().slice(0, 10),
    tags: ['codex', ...(work?.tags || [])]
  });

  const meta = [work?.authors?.length ? work.authors.join(', ') : null, work?.year || null,
                pages ? `pp. ${pages}` : null].filter(Boolean).join(' · ');

  const body = `${fm}# ${chapter?.title || ''}\n\n`
    + `> [!info] ${work?.title || ''}${meta ? `\n> ${meta}` : ''}\n\n`
    + `## 요약\n\n\n## 메모\n\n\n## 인용\n\n`;

  await fsp.writeFile(abs, body, 'utf8');
  return { rel: toVaultRel(abs), created: true };
}

// ─── 열기 ───────────────────────────────────────────────────────────────────
/** obsidian://open 으로 해당 노트를 띄운다. 볼트 이름과 파일 경로 모두 인코딩. */
async function openNote(rel) {
  const root = vaultRoot();
  resolveInVault(rel);                       // 볼트 밖이면 여기서 막힌다
  const vault = path.basename(root);
  const url = `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(rel.replace(/\.md$/i, ''))}`;
  await shell.openExternal(url);
  return true;
}

module.exports = {
  status, setConfig, pickVault, detectVaults,
  listNotes, readNote, createChapterNote, openNote,
  DEFAULT_SUBFOLDER
};
