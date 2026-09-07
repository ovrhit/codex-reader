// 화면 구성 · 라우팅
'use strict';

import { $, $$, esc, fmtDate, daysBetween, toast, confirmDialog, ensureDefs, coverHTML, mountImageFallbacks, ICON } from './util.js';
import {
  state, loadDB, save, flush, resolveCovers, getWork, addWork, deleteWork,
  progressOf, syncStatus, setStatus, toggleChapter, allTags, visibleWorks, computeStats,
  chapterPages, normalizeWork
} from './store.js';
import { openWorkForm, openTocEditor, promptText } from './modals.js';

const api = window.codex;
const content = $('#content');

// ═══════════════════════════════════════════════════════════════════════════
// 부트스트랩
// ═══════════════════════════════════════════════════════════════════════════
init();

async function init() {
  ensureDefs();
  wireChrome();
  try {
    await loadDB();
  } catch (e) {
    toast('데이터를 불러오지 못했습니다: ' + e.message, 'err');
  }
  render();
}

function wireChrome() {
  $('#btn-min').onclick = () => api.window.minimize();
  $('#btn-max').onclick = () => api.window.toggleMaximize();
  $('#btn-close').onclick = async () => { await flush(); api.window.close(); };
  $('#btn-add').onclick = createEntry;

  $$('.nav-item').forEach(b => b.onclick = () => go(b.dataset.view));

  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); createEntry(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault(); go('library'); setTimeout(() => $('[data-search]')?.focus(), 40);
    }
    if (e.key === 'Escape' && !typing && !$('#modal-root .overlay') && state.ui.detailId) {
      state.ui.detailId = null; render();
    }
  });

  window.addEventListener('beforeunload', () => { api.db.flush(); });
}

function go(view) {
  state.ui.view = view;
  state.ui.detailId = null;
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  render();
}

function openDetail(id) {
  state.ui.detailId = id;
  render();
  content.scrollTop = 0;
}

async function createEntry() {
  const data = await openWorkForm({ mode: 'create' });
  if (!data) return;
  const w = addWork(data);
  await resolveCovers();
  toast(`"${w.title.slice(0, 28)}" 등록 완료`, 'ok');
  state.ui.view = 'library';
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === 'library'));
  openDetail(w.id);
}

// ═══════════════════════════════════════════════════════════════════════════
// 렌더 분기
// ═══════════════════════════════════════════════════════════════════════════
function render() {
  if (state.ui.detailId) {
    const w = getWork(state.ui.detailId);
    if (!w) { state.ui.detailId = null; return render(); }
    renderDetail(w);
  } else if (state.ui.view === 'stats') renderStats();
  else if (state.ui.view === 'settings') renderSettings();
  else renderLibrary();

  updateNavRing();
  mountImageFallbacks(content);
}

function updateNavRing() {
  const s = computeStats();
  const C = 2 * Math.PI * 18;
  const fg = $('#nav-stat .r-fg');
  if (fg) {
    fg.style.strokeDasharray = C;
    fg.style.strokeDashoffset = C * (1 - s.overall / 100);
  }
  $('#nav-stat-pct').textContent = s.overall + '%';
}

// ═══════════════════════════════════════════════════════════════════════════
// 서재
// ═══════════════════════════════════════════════════════════════════════════
function renderLibrary() {
  const works = state.db.works;
  const list = visibleWorks();
  const tags = allTags();
  const u = state.ui;

  const cnt = (fn) => works.filter(fn).length;

  content.innerHTML = `
  <div class="view">
    <div class="page-head">
      <div>
        <div class="page-kicker">LIBRARY</div>
        <h1 class="page-title">나의 <span class="accent">서재</span></h1>
        <div class="page-sub">문헌 ${works.length}건 · 읽는 중 ${cnt(w => w.status === 'reading')} · 완독 ${cnt(w => w.status === 'read')}</div>
      </div>
      <button class="btn primary" data-new>${ICON.plus}새 문헌 등록</button>
    </div>

    <div class="toolbar">
      <div class="search-box">
        ${ICON.search}
        <input type="text" data-search placeholder="제목 · 저자 · 태그 · DOI 검색  (Ctrl+F)" value="${esc(u.query)}" />
      </div>
      <div class="chips">
        <button class="chip ${u.type === 'all' ? 'on' : ''}" data-type="all">전체<span class="cnt">${works.length}</span></button>
        <button class="chip ${u.type === 'paper' ? 'on' : ''}" data-type="paper">논문<span class="cnt">${cnt(w => w.type === 'paper')}</span></button>
        <button class="chip ${u.type === 'book' ? 'on' : ''}" data-type="book">책<span class="cnt">${cnt(w => w.type === 'book')}</span></button>
      </div>
      <div class="chips">
        <button class="chip ${u.status === 'all' ? 'on' : ''}" data-status="all">상태 전체</button>
        <button class="chip ${u.status === 'unread' ? 'on' : ''}" data-status="unread">안 읽음<span class="cnt">${cnt(w => w.status === 'unread')}</span></button>
        <button class="chip ${u.status === 'reading' ? 'on' : ''}" data-status="reading">읽는 중<span class="cnt">${cnt(w => w.status === 'reading')}</span></button>
        <button class="chip ${u.status === 'read' ? 'on' : ''}" data-status="read">읽음<span class="cnt">${cnt(w => w.status === 'read')}</span></button>
      </div>
      <select class="sel" data-tag>
        <option value="">태그 전체</option>
        ${tags.map(([t, n]) => `<option value="${esc(t)}" ${u.tag === t ? 'selected' : ''}>${esc(t)} (${n})</option>`).join('')}
      </select>
      <select class="sel" data-sort>
        ${[['added-desc', '최근 등록순'], ['added-asc', '오래된 등록순'], ['title', '제목순'],
           ['progress-desc', '진척도 높은순'], ['progress-asc', '진척도 낮은순'],
           ['year-desc', '연도순'], ['finished-desc', '최근 완독순'], ['rating-desc', '평점순']]
          .map(([v, l]) => `<option value="${v}" ${u.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>

    ${list.length ? `<div class="grid">${list.map(cardHTML).join('')}</div>` : emptyHTML(works.length)}
  </div>`;

  // 이벤트
  $('[data-new]').onclick = createEntry;
  const si = $('[data-search]');
  si.oninput = debounce(() => { state.ui.query = si.value; renderLibraryKeepFocus(); }, 180);
  $$('[data-type]').forEach(b => b.onclick = () => { state.ui.type = b.dataset.type; renderLibrary(); });
  $$('[data-status]').forEach(b => b.onclick = () => { state.ui.status = b.dataset.status; renderLibrary(); });
  $('[data-tag]').onchange = e => { state.ui.tag = e.target.value || null; renderLibrary(); };
  $('[data-sort]').onchange = e => { state.ui.sort = e.target.value; renderLibrary(); };
  $$('[data-open]').forEach(c => c.onclick = () => openDetail(c.dataset.open));
  mountImageFallbacks(content);
}

function renderLibraryKeepFocus() {
  const pos = $('[data-search]')?.selectionStart;
  renderLibrary();
  const si = $('[data-search]');
  if (si) { si.focus(); if (pos != null) si.setSelectionRange(pos, pos); }
}

function cardHTML(w) {
  const p = progressOf(w);
  const done = p.pct >= 100;
  return `
  <div class="card" data-open="${w.id}">
    <div class="card-top">
      ${coverHTML(w)}
      <div class="card-meta">
        <div class="card-type">
          <span class="dot ${w.status}"></span>
          ${w.type === 'book' ? 'BOOK' : 'PAPER'}
          ${w.year ? ` · ${esc(w.year)}` : ''}
          ${w.excerptMode ? ' <span class="badge excerpt">EXCERPT</span>' : ''}
        </div>
        <div class="card-title">${esc(w.title)}</div>
        <div class="card-authors">${esc((w.authors || []).join(', ')) || '&nbsp;'}</div>
        ${w.venue ? `<div class="card-venue">${esc(w.venue)}</div>` : ''}
      </div>
    </div>

    ${w.type === 'book' ? `
      <div>
        <div class="bar-row">
          <span>${p.mode === 'manual' ? 'MANUAL' : `${p.read}/${p.total} CH`}${p.pages ? ` · ${p.pages.done}/${p.pages.total} P` : ''}</span>
          <b>${Math.round(p.pct)}%</b>
        </div>
        <div class="bar${done ? ' done' : ''}"><i style="width:${Math.min(100, p.pct)}%"></i></div>
      </div>`
    : `<div class="row gap-s">
        <span class="badge ${w.status === 'read' ? 'read' : ''}">${w.status === 'read' ? 'READ' : w.status === 'reading' ? 'READING' : 'UNREAD'}</span>
        ${w.rating ? `<span class="badge">★ ${w.rating}</span>` : ''}
      </div>`}

    ${w.tags.length ? `<div class="tag-row">${w.tags.slice(0, 4).map(t => `<span class="tag sm">${esc(t)}</span>`).join('')}${w.tags.length > 4 ? `<span class="tag sm">+${w.tags.length - 4}</span>` : ''}</div>` : ''}
  </div>`;
}

function emptyHTML(totalWorks) {
  return totalWorks === 0
    ? `<div class="empty">
        <h3>아직 등록된 문헌이 없습니다</h3>
        <p>왼쪽 아래 <b>등록</b> 버튼(또는 Ctrl+N)으로 첫 문헌을 추가해 보세요.<br>
        온라인 검색으로 불러오거나, 인터넷 없이 직접 입력해도 됩니다.</p>
      </div>`
    : `<div class="empty">
        <h3>조건에 맞는 문헌이 없습니다</h3>
        <p>검색어나 필터를 바꿔 보세요.</p>
      </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 상세
// ═══════════════════════════════════════════════════════════════════════════
function renderDetail(w) {
  const p = progressOf(w);
  const C = 2 * Math.PI * 50;
  const isBook = w.type === 'book';

  content.innerHTML = `
  <div class="view">
    <div class="row mb">
      <button class="btn ghost sm" data-back>${ICON.back}서재로</button>
      <div class="grow"></div>
      <button class="btn sm" data-edit>${ICON.edit}편집</button>
      <button class="btn sm danger" data-del>${ICON.trash}삭제</button>
    </div>

    <div class="detail-head">
      <div>
        ${coverHTML(w, 'detail-cover')}
        <div class="cover-actions">
          <button class="btn sm ghost" data-coverfile title="파일에서 표지 지정">${ICON.img}</button>
          <button class="btn sm ghost" data-coverurl title="이미지 주소로 표지 지정">${ICON.link}</button>
          ${w.cover ? `<button class="btn sm ghost" data-coverclear title="표지 제거">${ICON.trash}</button>` : ''}
        </div>
      </div>

      <div class="detail-info">
        <div class="page-kicker">${isBook ? 'MONOGRAPH' : 'PAPER'} · ${esc(!w.source || w.source === '수동 입력' ? 'MANUAL ENTRY' : w.source)}</div>
        <h1 class="detail-title sel-text">${esc(w.title)}</h1>
        <div class="detail-line sel-text">
          ${(w.authors || []).length ? esc(w.authors.join(', ')) : '<span class="muted">저자 미상</span>'}
          ${w.year ? `<span class="sep">·</span>${esc(w.year)}` : ''}
          ${w.venue ? `<span class="sep">·</span>${esc(w.venue)}` : ''}
        </div>
        <div class="detail-line mono muted sel-text" style="font-size:11.5px">
          ${w.doi ? `DOI ${esc(w.doi)}` : ''}
          ${w.isbn ? `ISBN ${esc(w.isbn)}` : ''}
          ${w.pageCount ? `${w.doi || w.isbn ? '<span class="sep">·</span>' : ''}${esc(w.pageCount)} P` : ''}
          ${w.url ? `<span class="sep">·</span><a class="link" data-url>OPEN SOURCE</a>` : ''}
        </div>

        <div class="row wrap mt">
          <div class="status-seg">
            ${[['unread', '안 읽음'], ['reading', '읽는 중'], ['read', '읽음']].map(([s, l]) =>
              `<button data-s="${s}" class="${w.status === s ? 'on' : ''}">${l}</button>`).join('')}
          </div>
          <div class="stars" data-stars>
            ${[1, 2, 3, 4, 5].map(i => `<svg class="star ${i <= w.rating ? 'on' : ''}" data-star="${i}" viewBox="0 0 24 24">
              <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8z"/></svg>`).join('')}
          </div>
          <div class="grow"></div>
          <div class="muted mono" style="font-size:11px">
            ADDED ${fmtDate(w.addedAt)}${w.finishedAt ? ` · DONE ${fmtDate(w.finishedAt)}` : ''}
            ${w.startedAt && w.finishedAt ? ` · ${daysBetween(w.startedAt, w.finishedAt)} DAYS` : ''}
          </div>
        </div>

        <div class="mt">
          <div class="panel-title mb" style="margin-bottom:7px">TAGS</div>
          <div class="row wrap gap-s">
            ${w.tags.map(t => `<span class="tag" data-tagx="${esc(t)}" title="클릭하면 이 태그로 서재 필터">${esc(t)}</span>`).join('')}
            <button class="btn sm ghost" data-addtag>${ICON.plus}태그</button>
          </div>
        </div>
      </div>

      ${isBook ? `
      <div class="ring">
        <svg viewBox="0 0 116 116">
          <circle class="r-bg" cx="58" cy="58" r="50"></circle>
          <circle class="r-fg" cx="58" cy="58" r="50"
            style="stroke-dasharray:${C};stroke-dashoffset:${C * (1 - Math.min(100, p.pct) / 100)}"></circle>
        </svg>
        <div class="txt"><b>${Math.round(p.pct)}<small style="font-size:14px">%</small></b><span>${p.excerpt ? 'EXCERPT' : 'PROGRESS'}</span></div>
      </div>` : ''}
    </div>

    ${isBook ? bookBodyHTML(w, p) : ''}

    <div class="panel mt">
      <div class="panel-head"><span class="panel-title">NOTES</span><span class="muted" style="font-size:11px">자동 저장</span></div>
      <div class="field">
        <textarea data-notes placeholder="이 문헌에 대한 메모를 남겨 두세요.">${esc(w.notes || '')}</textarea>
      </div>
    </div>
  </div>`;

  wireDetail(w);
}

function bookBodyHTML(w, p) {
  const toc = w.toc || [];
  const inScope = c => !w.excerptMode || c.scope;

  return `
  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">TABLE OF CONTENTS ${toc.length ? `(${toc.length})` : ''}</span>
      <div class="row gap-s">
        <button class="btn sm ghost" data-tocedit>${ICON.edit}목차 편집</button>
        ${toc.length ? `<button class="btn sm ghost" data-allread>${ICON.check}범위 전체 읽음</button>
        <button class="btn sm ghost" data-allunread>전체 해제</button>` : ''}
      </div>
    </div>

    <div class="excerpt-bar ${w.excerptMode ? '' : 'off'}">
      <div class="switch ${w.excerptMode ? 'on' : ''}" data-excerpt role="switch" aria-checked="${w.excerptMode}"></div>
      <div>
        <div class="t">발췌독 모드</div>
        <div class="d">${w.excerptMode
          ? `읽을 범위로 지정한 <b>${toc.filter(c => c.scope).length}개 장</b>만 진척도에 반영합니다. 각 줄의 <span class="mono">◎</span> 아이콘으로 범위를 조정하세요.`
          : '켜면 책의 일부만 진척도 계산에 넣을 수 있습니다. (예: 3~5장만 읽는 경우)'}</div>
      </div>
      ${w.excerptMode ? `<button class="btn sm ghost" data-scopeall>전체 포함</button>
        <button class="btn sm ghost" data-scopenone>전체 제외</button>
        <button class="btn sm ghost" data-scopenote>${ICON.edit}범위 메모</button>` : ''}
    </div>

    ${w.excerptMode && w.excerptNote ? `<div class="notice warn mb">발췌 범위: ${esc(w.excerptNote)}</div>` : ''}

    ${toc.length ? `
      <div class="toc-list">
        ${toc.map((c, i) => `
          <div class="toc-item lvl${c.level} ${c.read ? 'done' : ''} ${inScope(c) ? '' : 'out'}" data-ch="${c.id}">
            <div class="tick">${ICON.check}</div>
            <span class="toc-num">${String(i + 1).padStart(2, '0')}</span>
            <span class="toc-title">${esc(c.title)}</span>
            ${chapterPages(c) ? `<span class="toc-pages">${c.from}–${c.to} · ${chapterPages(c)}p</span>`
              : c.from != null ? `<span class="toc-pages">p.${c.from}</span>` : ''}
            ${w.excerptMode ? `<button class="toc-scope ${c.scope ? 'on' : ''}" data-scope="${c.id}" title="진척도 범위 포함/제외">${ICON.target}</button>` : ''}
          </div>`).join('')}
      </div>
      <div class="divider"></div>
      <div class="row mono muted" style="font-size:11.5px">
        <span>${p.mode === 'pages' ? 'PAGE-WEIGHTED' : 'CHAPTER-COUNT'}</span>
        <span class="sep">·</span>
        <span>CHAPTERS ${p.read} / ${p.total}</span>
        ${p.pages ? `<span class="sep">·</span><span>PAGES ${p.pages.done} / ${p.pages.total}</span>` : ''}
        ${p.outOfScope ? `<span class="sep">·</span><span>${p.outOfScope} OUT OF SCOPE</span>` : ''}
      </div>`
    : `
      <div class="empty" style="padding:28px">
        <h3>목차가 아직 없습니다</h3>
        <p>목차를 등록하면 장별 체크와 진척도가 활성화됩니다.<br>목차 없이도 아래 슬라이더로 진행률을 직접 기록할 수 있습니다.</p>
      </div>
      <div class="field mt">
        <label>MANUAL PROGRESS — ${w.manualProgress || 0}%</label>
        <input type="range" min="0" max="100" step="5" value="${w.manualProgress || 0}" data-manual style="width:100%" />
      </div>`}
  </div>`;
}

function wireDetail(w) {
  $('[data-back]').onclick = () => { state.ui.detailId = null; render(); };

  $('[data-edit]').onclick = async () => {
    const data = await openWorkForm({ mode: 'edit', work: w });
    if (!data) return;
    Object.assign(w, normalizeWork({ ...w, ...data, id: w.id, addedAt: w.addedAt }));
    syncStatus(w);
    await resolveCovers();
    toast('저장했습니다.', 'ok');
    render();
  };

  $('[data-del]').onclick = async () => {
    const ok = await confirmDialog({
      title: '문헌 삭제', danger: true, okText: '삭제',
      message: `"${w.title}" 을(를) 서재에서 완전히 삭제합니다. 되돌릴 수 없습니다.`
    });
    if (!ok) return;
    deleteWork(w.id);
    state.ui.detailId = null;
    toast('삭제했습니다.');
    render();
  };

  const urlEl = $('[data-url]');
  if (urlEl) urlEl.onclick = () => api.shell.openExternal(w.url);

  // 상태
  $$('[data-s]').forEach(b => b.onclick = () => { setStatus(w, b.dataset.s); render(); });

  // 평점
  $$('[data-star]').forEach(s => s.onclick = () => {
    const v = +s.dataset.star;
    w.rating = (w.rating === v) ? 0 : v;
    save(); render();
  });

  // 태그
  $$('[data-tagx]').forEach(t => t.onclick = () => {
    state.ui.tag = t.dataset.tagx;
    state.ui.detailId = null;
    go('library');
  });
  $('[data-addtag]').onclick = async () => {
    const v = await promptText({ title: '태그 추가', label: 'TAGS', hint: '쉼표로 여러 개를 한 번에 넣을 수 있습니다.', placeholder: '예: 방법론, 필독' });
    if (!v) return;
    for (const t of v.split(/[,;]/).map(s => s.trim().replace(/^#/, '')).filter(Boolean)) {
      if (!w.tags.includes(t)) w.tags.push(t);
    }
    save(); render();
  };

  // 표지
  $('[data-coverfile]').onclick = async () => {
    try {
      const r = await api.cover.pickFile();
      if (!r) return;
      if (w.cover?.file) api.cover.remove(w.cover.file);
      w.cover = { file: r.file }; w._coverUrl = r.url; save(); render();
    } catch (e) { toast('실패: ' + e.message, 'err'); }
  };
  $('[data-coverurl]').onclick = async () => {
    const url = await promptText({ title: '표지 이미지 주소', label: 'IMAGE URL', placeholder: 'https://...' });
    if (!url) return;
    try {
      const r = await api.cover.download(url);
      if (w.cover?.file) api.cover.remove(w.cover.file);
      w.cover = { file: r.file }; w._coverUrl = r.url; save(); render();
      toast('표지를 저장했습니다.', 'ok');
    } catch (e) { toast('표지를 받지 못했습니다: ' + e.message, 'err'); }
  };
  const cc = $('[data-coverclear]');
  if (cc) cc.onclick = () => {
    if (w.cover?.file) api.cover.remove(w.cover.file);
    w.cover = null; w._coverUrl = null; save(); render();
  };

  // 메모 (자동 저장)
  const notes = $('[data-notes]');
  if (notes) {
    const persist = debounce(() => { w.notes = notes.value; save(); }, 500);
    notes.oninput = persist;
    notes.onblur = () => { w.notes = notes.value; save(); };
  }

  if (w.type !== 'book') return;

  // 목차 체크
  $$('[data-ch]').forEach(row => row.onclick = e => {
    if (e.target.closest('[data-scope]')) return;
    toggleChapter(w, row.dataset.ch);
    render();
  });

  // 발췌 범위 토글
  $$('[data-scope]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const c = w.toc.find(x => x.id === b.dataset.scope);
    if (!c) return;
    c.scope = !c.scope;
    syncStatus(w);
    render();
  });

  const ex = $('[data-excerpt]');
  if (ex) ex.onclick = () => {
    w.excerptMode = !w.excerptMode;
    if (w.excerptMode && w.toc.every(c => c.scope)) {
      // 처음 켤 때는 안내만; 범위는 사용자가 고른다.
      toast('발췌독 모드입니다. ◎ 아이콘으로 진척도에 넣을 장을 고르세요.');
    }
    syncStatus(w);
    render();
  };

  const sa = $('[data-scopeall]'); if (sa) sa.onclick = () => { w.toc.forEach(c => c.scope = true); syncStatus(w); render(); };
  const sn = $('[data-scopenone]'); if (sn) sn.onclick = () => { w.toc.forEach(c => c.scope = false); syncStatus(w); render(); };
  const snote = $('[data-scopenote]');
  if (snote) snote.onclick = async () => {
    const v = await promptText({ title: '발췌 범위 메모', label: 'EXCERPT RANGE', hint: '어디를 왜 읽는지 적어 두면 나중에 알아보기 좋습니다.', value: w.excerptNote || '', placeholder: '예: 3~5장, 세미나 발제 범위' });
    w.excerptNote = v || ''; save(); render();
  };

  const ar = $('[data-allread]');
  if (ar) ar.onclick = () => {
    const now = new Date().toISOString();
    (w.excerptMode ? w.toc.filter(c => c.scope) : w.toc).forEach(c => { if (!c.read) { c.read = true; c.readAt = now; } });
    syncStatus(w); render();
  };
  const au = $('[data-allunread]');
  if (au) au.onclick = () => { w.toc.forEach(c => { c.read = false; c.readAt = null; }); syncStatus(w); render(); };

  $('[data-tocedit]').onclick = async () => {
    const rows = await openTocEditor(w.toc || []);
    if (!rows) return;
    w.toc = rows;
    syncStatus(w);
    toast(`목차 ${rows.length}개 항목을 저장했습니다.`, 'ok');
    render();
  };

  const manual = $('[data-manual]');
  if (manual) {
    manual.oninput = () => {
      w.manualProgress = +manual.value;
      manual.previousElementSibling.textContent = `MANUAL PROGRESS — ${w.manualProgress}%`;
    };
    manual.onchange = () => {
      w.status = w.manualProgress >= 100 ? 'read' : w.manualProgress > 0 ? 'reading' : 'unread';
      syncStatus(w);
      render();
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 통계
// ═══════════════════════════════════════════════════════════════════════════
function renderStats() {
  const s = computeStats();
  const maxMonth = Math.max(1, ...s.months.map(m => m.n));
  const maxTag = Math.max(1, ...s.tags.map(([, n]) => n));

  const statusRows = [
    ['읽음', s.read, 'linear-gradient(120deg,#6fffb0,#37e8ff)'],
    ['읽는 중', s.reading, 'linear-gradient(120deg,#ffc55c,#ff5cc8)'],
    ['안 읽음', s.unread, 'rgba(255,255,255,.18)']
  ];

  content.innerHTML = `
  <div class="view">
    <div class="page-head">
      <div>
        <div class="page-kicker">STATISTICS</div>
        <h1 class="page-title">종합 <span class="accent">스탯</span></h1>
        <div class="page-sub">지금까지 읽은 기록을 한눈에</div>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-k">TOTAL WORKS</div>
        <div class="stat-v">${s.total}</div>
        <div class="stat-d">논문 ${s.papers} · 책 ${s.books}</div>
      </div>
      <div class="stat-card c2">
        <div class="stat-k">COMPLETED</div>
        <div class="stat-v">${s.read}</div>
        <div class="stat-d">논문 ${s.papersRead} · 책 ${s.booksRead} · 올해 ${s.thisYear}건</div>
      </div>
      <div class="stat-card c3">
        <div class="stat-k">OVERALL PROGRESS</div>
        <div class="stat-v">${s.overall}<small>%</small></div>
        <div class="stat-d">전체 문헌 평균 진척도</div>
      </div>
      <div class="stat-card c4">
        <div class="stat-k">CHAPTERS READ</div>
        <div class="stat-v">${s.chaptersRead}<small>CH</small></div>
        <div class="stat-d">범위 내 총 ${s.chaptersTotal}장</div>
      </div>
      <div class="stat-card">
        <div class="stat-k">PAGES READ</div>
        <div class="stat-v">${s.pagesRead.toLocaleString()}<small>P</small></div>
        <div class="stat-d">쪽 수가 등록된 장 기준</div>
      </div>
      <div class="stat-card c2">
        <div class="stat-k">STREAK</div>
        <div class="stat-v">${s.streak}<small>DAYS</small></div>
        <div class="stat-d">연속 기록 · 활동일 ${s.activeDays}일</div>
      </div>
      <div class="stat-card c3">
        <div class="stat-k">AVG. DURATION</div>
        <div class="stat-v">${s.avgDays == null ? '—' : s.avgDays}<small>${s.avgDays == null ? '' : 'DAYS'}</small></div>
        <div class="stat-d">시작부터 완독까지 평균</div>
      </div>
      <div class="stat-card c4">
        <div class="stat-k">AVG. RATING</div>
        <div class="stat-v">${s.avgRating ? s.avgRating.toFixed(1) : '—'}<small>${s.avgRating ? '/5' : ''}</small></div>
        <div class="stat-d">평가한 문헌 ${s.ratedCount}건</div>
      </div>
    </div>

    <div class="two-col">
      <div class="panel">
        <div class="panel-head"><span class="panel-title">MONTHLY ACTIVITY</span>
          <span class="muted" style="font-size:11px">완독·장 완료 횟수</span></div>
        <div class="months">
          ${s.months.map(m => `
            <div class="month">
              <div class="n">${m.n || ''}</div>
              <div class="col ${m.n ? '' : 'zero'}" style="height:${m.n ? Math.max(6, (m.n / maxMonth) * 100) : 3}%"></div>
              <div class="m">${m.label}</div>
            </div>`).join('')}
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><span class="panel-title">STATUS BREAKDOWN</span></div>
        <div class="hbars">
          ${statusRows.map(([l, n, g]) => `
            <div class="hbar-row">
              <span class="hbar-lbl">${l}</span>
              <div class="bar"><i style="width:${s.total ? (n / s.total) * 100 : 0}%;background:${g};box-shadow:none"></i></div>
              <span class="hbar-val">${n}</span>
            </div>`).join('')}
        </div>
        <div class="divider"></div>
        <div class="hbars">
          <div class="hbar-row">
            <span class="hbar-lbl">논문</span>
            <div class="bar"><i style="width:${s.total ? (s.papers / s.total) * 100 : 0}%"></i></div>
            <span class="hbar-val">${s.papers}</span>
          </div>
          <div class="hbar-row">
            <span class="hbar-lbl">책</span>
            <div class="bar"><i style="width:${s.total ? (s.books / s.total) * 100 : 0}%;background:linear-gradient(120deg,#9d6bff,#ff5cc8)"></i></div>
            <span class="hbar-val">${s.books}</span>
          </div>
          <div class="hbar-row">
            <span class="hbar-lbl">발췌독 중인 책</span>
            <div class="bar"><i style="width:${s.books ? (s.excerptBooks / s.books) * 100 : 0}%;background:linear-gradient(120deg,#ffc55c,#ff5cc8)"></i></div>
            <span class="hbar-val">${s.excerptBooks}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="panel mt">
      <div class="panel-head"><span class="panel-title">TAGS</span>
        <span class="muted" style="font-size:11px">${s.tags.length}개 태그</span></div>
      ${s.tags.length ? `<div class="hbars">
        ${s.tags.slice(0, 12).map(([t, n]) => `
          <div class="hbar-row">
            <span class="hbar-lbl" title="${esc(t)}">${esc(t)}</span>
            <div class="bar"><i style="width:${(n / maxTag) * 100}%;background:linear-gradient(120deg,#9d6bff,#37e8ff)"></i></div>
            <span class="hbar-val">${n}</span>
          </div>`).join('')}
      </div>` : `<div class="muted" style="font-size:12.5px">아직 태그가 없습니다. 문헌 상세 화면에서 태그를 붙여 보세요.</div>`}
    </div>
  </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 설정
// ═══════════════════════════════════════════════════════════════════════════
function renderSettings() {
  content.innerHTML = `
  <div class="view">
    <div class="page-head">
      <div>
        <div class="page-kicker">SETTINGS</div>
        <h1 class="page-title">설정 · <span class="accent">데이터</span></h1>
        <div class="page-sub">모든 기록은 이 PC 안에만 저장됩니다.</div>
      </div>
    </div>

    <div class="panel mb">
      <div class="panel-head"><span class="panel-title">STORAGE</span></div>
      <div class="field">
        <label>DATA FOLDER</label>
        <input type="text" value="${esc(state.paths.data || '')}" readonly />
        <div class="hint">library.json(기록) · covers(표지 이미지) · backups(하루 1회 자동 백업, 최근 20개)</div>
      </div>
      <div class="row mt">
        <button class="btn sm" data-openfolder>${ICON.folder}폴더 열기</button>
        <button class="btn sm" data-export>${ICON.down}백업 내보내기</button>
        <button class="btn sm" data-import>${ICON.up}백업 가져오기</button>
      </div>
    </div>

    <div class="panel mb">
      <div class="panel-head"><span class="panel-title">ONLINE LOOKUP</span></div>
      <div class="notice">
        등록 시 온라인 검색은 <b>선택 기능</b>입니다. 인터넷이 없어도 모든 정보를 직접 입력해 등록·관리할 수 있습니다.<br><br>
        · <b>논문</b> — Crossref (DOI 등록기관, 학술 문헌 메타데이터)<br>
        · <b>책</b> — Open Library (표지·판본 목차), Google Books (표지·쪽수)<br><br>
        검색어와 표지 이미지 요청 외에 어떤 개인 정보도 외부로 보내지 않습니다.
      </div>
    </div>

    <div class="panel mb">
      <div class="panel-head"><span class="panel-title">SHORTCUTS</span></div>
      <div class="hbars">
        ${[['Ctrl + N', '새 문헌 등록'], ['Ctrl + F', '서재 검색'], ['Esc', '상세/모달 닫기']]
          .map(([k, v]) => `<div class="row"><span class="badge mono" style="min-width:88px;text-align:center">${k}</span>
            <span class="muted" style="font-size:12.5px">${v}</span></div>`).join('')}
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><span class="panel-title">DANGER ZONE</span></div>
      <div class="row wrap">
        <button class="btn sm danger" data-wipe>${ICON.trash}서재 전체 비우기</button>
        <span class="muted" style="font-size:11.5px">먼저 백업을 내보내는 것을 권합니다.</span>
      </div>
    </div>
  </div>`;

  $('[data-openfolder]').onclick = () => api.shell.openPath(state.paths.data);

  $('[data-export]').onclick = async () => {
    await flush();
    try {
      const clean = { ...state.db, works: state.db.works.map(({ _coverUrl, ...r }) => r) };
      const r = await api.db.exportTo(clean);
      if (r.ok) toast('백업을 저장했습니다.', 'ok');
    } catch (e) { toast('내보내기 실패: ' + e.message, 'err'); }
  };

  $('[data-import]').onclick = async () => {
    try {
      const r = await api.db.importFrom();
      if (!r.ok) return;
      const ok = await confirmDialog({
        title: '백업 가져오기', danger: true, okText: '덮어쓰기',
        message: `현재 서재(${state.db.works.length}건)를 백업 파일(${r.db.works.length}건)로 완전히 교체합니다.`
      });
      if (!ok) return;
      state.db = r.db;
      state.db.works = state.db.works.map(normalizeWork);
      await save(); await flush(); await resolveCovers();
      toast('가져오기 완료.', 'ok');
      go('library');
    } catch (e) { toast('가져오기 실패: ' + e.message, 'err'); }
  };

  $('[data-wipe]').onclick = async () => {
    const ok = await confirmDialog({
      title: '서재 전체 비우기', danger: true, okText: '전부 삭제',
      message: `문헌 ${state.db.works.length}건과 표지 이미지가 모두 삭제됩니다. 되돌릴 수 없습니다.`
    });
    if (!ok) return;
    for (const w of state.db.works) if (w.cover?.file) api.cover.remove(w.cover.file);
    state.db.works = [];
    await save(); await flush();
    toast('서재를 비웠습니다.');
    go('library');
  };
}

// ═══════════════════════════════════════════════════════════════════════════
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
