// 데이터 모델 · 저장 · 파생 계산(진척도/통계)
'use strict';

import { uid, daysBetween } from './util.js';

const api = window.codex;

export const state = {
  db: { version: 1, works: [], settings: {} },
  paths: {},
  ui: {
    view: 'library',
    detailId: null,
    query: '',
    type: 'all',       // all | paper | book
    status: 'all',     // all | unread | reading | read
    tag: null,
    sort: 'added-desc'
  }
};

// ─── 로드 / 저장 ────────────────────────────────────────────────────────────
export async function loadDB() {
  const { db, paths } = await api.db.load();
  state.db = db;
  state.paths = paths;
  state.db.works = db.works.map(normalizeWork);
  await resolveCovers();
  return state.db;
}

export function save() {
  // 화면 전용 필드(_coverUrl)는 저장하지 않는다.
  const clean = {
    ...state.db,
    works: state.db.works.map(w => {
      const { _coverUrl, ...rest } = w;
      return rest;
    })
  };
  return api.db.save(clean);
}

export function flush() { return api.db.flush(); }

export async function resolveCovers() {
  await Promise.all(state.db.works.map(async w => {
    w._coverUrl = w.cover?.file ? await api.cover.resolve(w.cover.file) : null;
  }));
}

// ─── 정규화 ────────────────────────────────────────────────────────────────
export function normalizeWork(w) {
  const o = {
    id: w.id || uid(),
    type: w.type === 'book' ? 'book' : 'paper',
    title: w.title || '(제목 없음)',
    authors: Array.isArray(w.authors) ? w.authors : (w.authors ? String(w.authors).split(/[,;]/).map(s => s.trim()).filter(Boolean) : []),
    year: w.year ?? null,
    venue: w.venue || '',
    doi: w.doi || '',
    isbn: w.isbn || '',
    url: w.url || '',
    pageCount: w.pageCount ?? null,
    cover: w.cover && w.cover.file ? { file: w.cover.file } : null,
    tags: Array.isArray(w.tags) ? w.tags.filter(Boolean) : [],
    status: ['unread', 'reading', 'read'].includes(w.status) ? w.status : 'unread',
    rating: Number(w.rating) || 0,
    notes: w.notes || '',
    addedAt: w.addedAt || new Date().toISOString(),
    startedAt: w.startedAt || null,
    finishedAt: w.finishedAt || null,
    source: w.source || 'MANUAL ENTRY',
    // 책 전용
    toc: Array.isArray(w.toc) ? w.toc.map(normalizeChapter) : [],
    excerptMode: !!w.excerptMode,
    excerptNote: w.excerptNote || '',
    manualProgress: Math.max(0, Math.min(100, Number(w.manualProgress) || 0)),
    _coverUrl: w._coverUrl || null
  };
  if (o.type === 'paper') { o.toc = []; o.excerptMode = false; }
  return o;
}

export function normalizeChapter(c) {
  const from = numOrNull(c.from);
  const to = numOrNull(c.to);
  return {
    id: c.id || uid(),
    title: c.title || '',
    level: Math.max(0, Math.min(2, Number(c.level) || 0)),
    from, to,
    read: !!c.read,
    readAt: c.readAt || null,
    scope: c.scope !== false   // 기본은 '범위에 포함'
  };
}

function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

// ─── CRUD ──────────────────────────────────────────────────────────────────
export function getWork(id) { return state.db.works.find(w => w.id === id) || null; }

export function addWork(data) {
  const w = normalizeWork({ ...data, id: uid(), addedAt: new Date().toISOString() });
  syncStatus(w, { silent: true });
  state.db.works.unshift(w);
  save();
  return w;
}

export function updateWork(id, patch) {
  const w = getWork(id);
  if (!w) return null;
  Object.assign(w, patch);
  save();
  return w;
}

export function deleteWork(id) {
  const i = state.db.works.findIndex(w => w.id === id);
  if (i < 0) return false;
  const [w] = state.db.works.splice(i, 1);
  if (w.cover?.file) api.cover.remove(w.cover.file);
  save();
  return true;
}

// ─── 진척도 ────────────────────────────────────────────────────────────────
export function chapterPages(c) {
  if (c.from == null || c.to == null) return 0;
  const n = c.to - c.from + 1;
  return n > 0 ? n : 0;
}

/**
 * 책 진척도.
 * - 발췌독 모드면 scope=true 인 장만 분모에 넣는다.
 * - 범위 안 모든 장에 쪽수가 있으면 '쪽 수 가중', 아니면 '장 개수'로 계산한다.
 */
export function progressOf(w) {
  if (w.type === 'paper') {
    return { pct: w.status === 'read' ? 100 : 0, mode: 'binary', read: 0, total: 0, pages: null };
  }
  const items = w.toc || [];
  const scoped = w.excerptMode ? items.filter(c => c.scope) : items;

  if (!scoped.length) {
    return {
      pct: w.status === 'read' ? 100 : (w.manualProgress || 0),
      mode: 'manual', read: 0, total: 0, pages: null
    };
  }
  const readItems = scoped.filter(c => c.read);
  const weighted = scoped.every(c => chapterPages(c) > 0);

  let pct;
  let pages = null;
  if (weighted) {
    const total = scoped.reduce((s, c) => s + chapterPages(c), 0);
    const done = readItems.reduce((s, c) => s + chapterPages(c), 0);
    pct = total ? (done / total) * 100 : 0;
    pages = { done, total };
  } else {
    pct = (readItems.length / scoped.length) * 100;
  }
  return {
    pct: Math.round(pct * 10) / 10,
    mode: weighted ? 'pages' : 'chapters',
    read: readItems.length,
    total: scoped.length,
    pages,
    excerpt: !!w.excerptMode,
    outOfScope: items.length - scoped.length
  };
}

/** 목차 체크 상태에 맞춰 status/날짜를 자동 정리한다. */
export function syncStatus(w, { silent = false } = {}) {
  const now = new Date().toISOString();
  if (w.type === 'book' && (w.toc || []).length) {
    const p = progressOf(w);
    if (p.total > 0) {
      if (p.read === 0) w.status = w.manualProgress > 0 ? 'reading' : 'unread';
      else if (p.read >= p.total) w.status = 'read';
      else w.status = 'reading';
    }
  }
  if (w.status !== 'unread' && !w.startedAt) w.startedAt = now;
  if (w.status === 'read' && !w.finishedAt) w.finishedAt = now;
  if (w.status !== 'read') w.finishedAt = null;
  if (w.status === 'unread') { w.startedAt = null; }
  if (!silent) save();
  return w;
}

export function setStatus(w, status) {
  w.status = status;
  const now = new Date().toISOString();
  if (w.type === 'book' && (w.toc || []).length) {
    // 상태를 직접 바꾸면 목차도 함께 맞춘다.
    const scoped = w.excerptMode ? w.toc.filter(c => c.scope) : w.toc;
    if (status === 'read') scoped.forEach(c => { if (!c.read) { c.read = true; c.readAt = now; } });
    if (status === 'unread') w.toc.forEach(c => { c.read = false; c.readAt = null; });
  }
  if (status === 'unread') { w.startedAt = null; w.finishedAt = null; w.manualProgress = 0; }
  else {
    if (!w.startedAt) w.startedAt = now;
    w.finishedAt = status === 'read' ? (w.finishedAt || now) : null;
    if (status === 'read' && !(w.toc || []).length) w.manualProgress = 100;
  }
  save();
  return w;
}

export function toggleChapter(w, chapterId) {
  const c = (w.toc || []).find(x => x.id === chapterId);
  if (!c) return;
  c.read = !c.read;
  c.readAt = c.read ? new Date().toISOString() : null;
  syncStatus(w);
}

// ─── 태그 ──────────────────────────────────────────────────────────────────
export function allTags() {
  const m = new Map();
  for (const w of state.db.works) for (const t of w.tags) m.set(t, (m.get(t) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// ─── 필터 / 정렬 ────────────────────────────────────────────────────────────
export function visibleWorks() {
  const { query, type, status, tag, sort } = state.ui;
  const q = query.trim().toLowerCase();
  let list = state.db.works.filter(w => {
    if (type !== 'all' && w.type !== type) return false;
    if (status !== 'all' && w.status !== status) return false;
    if (tag && !w.tags.includes(tag)) return false;
    if (q) {
      const hay = [w.title, w.venue, w.doi, w.isbn, ...(w.authors || []), ...(w.tags || []), w.notes]
        .join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const cmp = {
    'added-desc': (a, b) => new Date(b.addedAt) - new Date(a.addedAt),
    'added-asc': (a, b) => new Date(a.addedAt) - new Date(b.addedAt),
    'title': (a, b) => a.title.localeCompare(b.title, 'ko'),
    'progress-desc': (a, b) => progressOf(b).pct - progressOf(a).pct,
    'progress-asc': (a, b) => progressOf(a).pct - progressOf(b).pct,
    'year-desc': (a, b) => (b.year || 0) - (a.year || 0),
    'finished-desc': (a, b) => new Date(b.finishedAt || 0) - new Date(a.finishedAt || 0),
    'rating-desc': (a, b) => (b.rating || 0) - (a.rating || 0)
  }[sort] || (() => 0);

  return list.sort(cmp);
}

// ─── 종합 통계 ──────────────────────────────────────────────────────────────
export function computeStats() {
  const works = state.db.works;
  const papers = works.filter(w => w.type === 'paper');
  const books = works.filter(w => w.type === 'book');

  const byStatus = s => works.filter(w => w.status === s).length;

  let chaptersRead = 0, chaptersTotal = 0, pagesRead = 0;
  const readDates = [];

  for (const w of books) {
    for (const c of (w.toc || [])) {
      const inScope = !w.excerptMode || c.scope;
      if (inScope) chaptersTotal++;
      if (c.read) {
        chaptersRead++;
        pagesRead += chapterPages(c);
        if (c.readAt) readDates.push(c.readAt);
      }
    }
    // 목차 없이 완독 처리한 책은 등록된 쪽수를 반영
    if (!(w.toc || []).length && w.pageCount) {
      const p = progressOf(w).pct;
      pagesRead += Math.round(w.pageCount * p / 100);
    }
  }
  for (const w of works) if (w.finishedAt) readDates.push(w.finishedAt);

  // 완독한 문헌
  const finished = works.filter(w => w.status === 'read');
  const durations = finished
    .map(w => daysBetween(w.startedAt, w.finishedAt))
    .filter(d => d !== null);
  const avgDays = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;

  // 전체 완독률 (책은 진척도 평균, 논문은 0/100)
  const pctSum = works.reduce((s, w) => s + progressOf(w).pct, 0);
  const overall = works.length ? Math.round(pctSum / works.length) : 0;

  // 최근 12개월 활동 (완독 또는 챕터 완료 기준)
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: `${d.getMonth() + 1}`, n: 0 });
  }
  const mIndex = new Map(months.map((m, i) => [m.key, i]));
  for (const iso of readDates) {
    const k = String(iso).slice(0, 7);
    if (mIndex.has(k)) months[mIndex.get(k)].n++;
  }

  // 연속 기록(streak): 활동이 있었던 날 기준
  const daySet = new Set(readDates.map(d => String(d).slice(0, 10)));
  let streak = 0;
  {
    const cur = new Date();
    // 오늘 활동이 없으면 어제부터 센다
    if (!daySet.has(iso10(cur))) cur.setDate(cur.getDate() - 1);
    while (daySet.has(iso10(cur))) { streak++; cur.setDate(cur.getDate() - 1); }
  }

  // 태그
  const tags = allTags();

  // 평점
  const rated = works.filter(w => w.rating > 0);
  const avgRating = rated.length ? (rated.reduce((s, w) => s + w.rating, 0) / rated.length) : 0;

  // 올해
  const yr = String(now.getFullYear());
  const thisYear = works.filter(w => w.finishedAt && String(w.finishedAt).startsWith(yr)).length;

  return {
    total: works.length,
    papers: papers.length,
    books: books.length,
    unread: byStatus('unread'),
    reading: byStatus('reading'),
    read: byStatus('read'),
    papersRead: papers.filter(w => w.status === 'read').length,
    booksRead: books.filter(w => w.status === 'read').length,
    chaptersRead, chaptersTotal, pagesRead,
    overall, avgDays, streak, months, tags,
    avgRating, ratedCount: rated.length,
    thisYear,
    excerptBooks: books.filter(b => b.excerptMode).length,
    activeDays: daySet.size
  };
}

function iso10(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─── 목차 텍스트 파서 ───────────────────────────────────────────────────────
/**
 * 붙여넣은 목차 텍스트를 장 배열로 바꾼다. 지원 형식:
 *   1장 서론                  → 제목만
 *   1장 서론 | 12-40          → 파이프로 쪽 범위
 *   1장 서론 .......... 12    → 점선 뒤 시작 쪽
 *   1장 서론 12               → 끝의 숫자를 시작 쪽으로
 *     1.1 배경                → 앞 공백/탭 = 하위 레벨
 * 시작 쪽만 있으면 다음 장의 시작 쪽 - 1 을 끝 쪽으로 채운다.
 */
export function parseTOC(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = (line.match(/^[\t 　]*/) || [''])[0];
    let level = Math.min(2, Math.floor(indent.replace(/\t/g, '  ').length / 2));
    let s = line.trim();

    let from = null, to = null;

    // "제목 | 12-40" 또는 "제목 | 12"
    const pipe = s.match(/^(.*?)\s*[|｜]\s*(\d+)\s*(?:[-–~〜]\s*(\d+))?\s*$/);
    if (pipe) {
      s = pipe[1].trim();
      from = parseInt(pipe[2], 10);
      to = pipe[3] ? parseInt(pipe[3], 10) : null;
    } else {
      // "제목 ......... 23" / "제목   23-45"
      // 공백 하나만으로는 자르지 않는다 ("Chapter 2" 같은 제목을 쪽수로 오인하지 않도록).
      const trail = s.match(/^(.*?)[\s.·…‥\-—_]{2,}(\d+)\s*(?:[-–~〜]\s*(\d+))?\s*$/)
                 || s.match(/^(.*?[^\d\s])\s{2,}(\d{1,4})\s*(?:[-–~〜]\s*(\d{1,4}))?\s*$/);
      if (trail && trail[1].trim()) {
        s = trail[1].replace(/[\s.·…‥\-—_]+$/, '').trim();
        from = parseInt(trail[2], 10);
        to = trail[3] ? parseInt(trail[3], 10) : null;
      }
    }

    // "1.2.3 제목" 처럼 번호 깊이로 레벨 보정 (들여쓰기가 없을 때만)
    if (!indent.trim().length && indent.length === 0) {
      const num = s.match(/^(\d+(?:\.\d+)+)\s/);
      if (num) level = Math.min(2, num[1].split('.').length - 1);
    }
    if (!s) continue;
    out.push({ id: uid(), title: s, level, from, to, read: false, readAt: null, scope: true });
  }

  // 끝 쪽 자동 보완
  for (let i = 0; i < out.length; i++) {
    if (out[i].from != null && out[i].to == null) {
      const next = out.slice(i + 1).find(c => c.from != null);
      if (next && next.from > out[i].from) out[i].to = next.from - 1;
    }
  }
  return out;
}
