// 문헌 등록·편집 모달, 온라인 검색, 목차 편집기
'use strict';

import { $, $$, esc, uid, modal, toast, ICON, initials, mountImageFallbacks } from './util.js';
import { allTags, parseTOC, normalizeChapter, chapterPages } from './store.js';
import { rowsFromPages, rowsToText, summarize } from './toc-ocr.js';

const api = window.codex;

// ═══════════════════════════════════════════════════════════════════════════
// 태그 입력 위젯
// ═══════════════════════════════════════════════════════════════════════════
function mountTagInput(root, initial = []) {
  let tags = [...initial];
  const suggestions = allTags().map(([t]) => t).filter(t => !tags.includes(t)).slice(0, 12);

  root.innerHTML = `
    <div class="tag-input" data-box>
      <input type="text" placeholder="태그 입력 후 Enter" data-inp />
    </div>
    ${suggestions.length ? `<div class="tag-suggest">${suggestions.map(t =>
      `<button type="button" class="s" data-sug="${esc(t)}">+ ${esc(t)}</button>`).join('')}</div>` : ''}`;

  const box = $('[data-box]', root);
  const inp = $('[data-inp]', root);

  function render() {
    $$('.tag-pill', box).forEach(e => e.remove());
    tags.forEach(t => {
      const pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.innerHTML = `${esc(t)}<b data-x>×</b>`;
      pill.querySelector('[data-x]').onclick = () => { tags = tags.filter(x => x !== t); render(); };
      box.insertBefore(pill, inp);
    });
  }
  function add(v) {
    const t = String(v || '').trim().replace(/^#/, '');
    if (!t || tags.includes(t)) return;
    tags.push(t); render();
  }
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(inp.value); inp.value = ''; }
    else if (e.key === 'Backspace' && !inp.value && tags.length) { tags.pop(); render(); }
  });
  inp.addEventListener('blur', () => { if (inp.value.trim()) { add(inp.value); inp.value = ''; } });
  box.addEventListener('click', e => { if (e.target === box) inp.focus(); });
  $$('[data-sug]', root).forEach(b => b.onclick = () => { add(b.dataset.sug); b.remove(); });

  render();
  return { get: () => [...tags], add };
}

// ═══════════════════════════════════════════════════════════════════════════
// 문헌 등록 / 편집 폼
// ═══════════════════════════════════════════════════════════════════════════
export function openWorkForm({ mode = 'create', work = null } = {}) {
  return new Promise(resolve => {
    const isEdit = mode === 'edit';
    let type = work?.type || 'paper';
    // 편집 중에 새로 만든 표지 파일 — 취소하면 지운다.
    let cover = work?.cover ? { file: work.cover.file, url: work._coverUrl } : null;
    const originalCoverFile = work?.cover?.file || null;
    const createdFiles = [];
    let tocDraft = work ? (work.toc || []).map(c => ({ ...c })) : [];
    let lastPick = null;   // 온라인 검색에서 고른 항목 (목차 조회용)
    let settled = false;

    const m = modal({
      kicker: isEdit ? 'EDIT ENTRY' : 'NEW ENTRY',
      title: isEdit ? '문헌 편집' : '새 문헌 등록',
      wide: true,
      bodyHTML: formHTML(),
      footHTML: `
        <span class="muted" style="font-size:11.5px">모든 항목은 직접 입력할 수 있습니다. 온라인 검색은 선택 사항입니다.</span>
        <div class="right">
          <button class="btn ghost" data-cancel>취소</button>
          <button class="btn primary" data-ok>${ICON.check}${isEdit ? '저장' : '등록'}</button>
        </div>`,
      onClose: () => {
        if (settled) return;
        settled = true;
        cleanupCovers();
        resolve(null);
      }
    });

    const body = m.body;
    const tagWidget = mountTagInput($('[data-tags]', body), work?.tags || []);

    function cleanupCovers() {
      for (const f of createdFiles) if (f !== originalCoverFile) api.cover.remove(f);
    }

    function formHTML() {
      const w = work || {};
      return `
      <div class="seg-pick mb" data-typepick>
        <button type="button" data-type="paper" class="${type === 'paper' ? 'on' : ''}">
          ${ICON.paper}논문 / 아티클<small>READ · UNREAD + TAGS</small></button>
        <button type="button" data-type="book" class="${type === 'book' ? 'on' : ''}">
          ${ICON.book}책 / 단행본<small>TOC · PROGRESS · EXCERPT</small></button>
      </div>

      <div class="panel mb" data-searchpanel>
        <div class="panel-head">
          <span class="panel-title">ONLINE LOOKUP</span>
          <span class="muted" style="font-size:11px" data-srcinfo></span>
        </div>
        <div class="row">
          <div class="search-box grow">
            ${ICON.search}
            <input type="text" data-q placeholder="제목 · 저자 · DOI · ISBN 으로 검색" />
          </div>
          <button class="btn" data-dosearch>${ICON.search}검색</button>
        </div>
        <div data-results class="mt-s"></div>
      </div>

      <div class="form-grid">
        <div class="field full">
          <label>TITLE *</label>
          <input type="text" data-f="title" value="${esc(w.title || '')}" placeholder="문헌 제목" />
        </div>
        <div class="field full">
          <label>AUTHORS</label>
          <input type="text" data-f="authors" value="${esc((w.authors || []).join(', '))}" placeholder="홍길동, Jane Doe" />
        </div>
        <div class="field">
          <label>YEAR</label>
          <input type="text" data-f="year" value="${esc(w.year ?? '')}" placeholder="2024" />
        </div>
        <div class="field">
          <label data-venuelabel>${type === 'book' ? 'PUBLISHER' : 'JOURNAL / SOURCE'}</label>
          <input type="text" data-f="venue" value="${esc(w.venue || '')}" />
        </div>
        <div class="field" data-doi-field>
          <label>DOI</label>
          <input type="text" data-f="doi" value="${esc(w.doi || '')}" placeholder="10.xxxx/xxxxx" />
        </div>
        <div class="field" data-isbn-field>
          <label>ISBN</label>
          <input type="text" data-f="isbn" value="${esc(w.isbn || '')}" />
        </div>
        <div class="field" data-pages-field>
          <label>TOTAL PAGES</label>
          <input type="text" data-f="pageCount" value="${esc(w.pageCount ?? '')}" placeholder="예: 384" />
        </div>
        <div class="field">
          <label>LINK (URL)</label>
          <input type="text" data-f="url" value="${esc(w.url || '')}" placeholder="https://" />
        </div>
        <div class="field full">
          <label>TAGS</label>
          <div data-tags></div>
        </div>

        <div class="field full">
          <label>COVER IMAGE</label>
          <div class="row wrap">
            <div class="cover" data-coverpreview style="flex:0 0 52px;width:52px;height:74px">
              ${cover?.url ? `<img src="${esc(cover.url)}" alt="">` : `<span class="ph">${esc(initials(w.title || ''))}</span>`}
            </div>
            <button class="btn sm" data-coverfile>${ICON.img}파일에서 선택</button>
            <button class="btn sm" data-coverurl>${ICON.link}이미지 주소로 추가</button>
            <button class="btn sm ghost" data-coverclear>제거</button>
          </div>
        </div>

        <div class="field full" data-tocblock style="${type === 'book' ? '' : 'display:none'}">
          <label>TABLE OF CONTENTS</label>
          <div class="row wrap mb">
            <button class="btn sm" data-tocpaste>${ICON.list}목차 붙여넣기 / 편집</button>
            <button class="btn sm" data-tocweb disabled>${ICON.search}온라인 목차 가져오기</button>
            <span class="muted" style="font-size:11.5px" data-toccount>등록된 장 0개</span>
          </div>
          <div class="hint">목차가 없어도 등록됩니다. 나중에 상세 화면에서 언제든 추가·수정할 수 있습니다.</div>
        </div>

        <div class="field full">
          <label>NOTES</label>
          <textarea data-f="notes" placeholder="읽으면서 남길 메모">${esc(w.notes || '')}</textarea>
        </div>
      </div>`;
    }

    // ── 타입 전환 ──────────────────────────────────────────────────────────
    function applyType() {
      $$('[data-typepick] button', body).forEach(b => b.classList.toggle('on', b.dataset.type === type));
      $('[data-venuelabel]', body).textContent = type === 'book' ? 'PUBLISHER' : 'JOURNAL / SOURCE';
      $('[data-doi-field]', body).style.display = type === 'paper' ? '' : 'none';
      $('[data-isbn-field]', body).style.display = type === 'book' ? '' : 'none';
      $('[data-pages-field]', body).style.display = type === 'book' ? '' : 'none';
      $('[data-tocblock]', body).style.display = type === 'book' ? '' : 'none';
      $('[data-q]', body).placeholder = type === 'book'
        ? '책 제목 · 저자 · ISBN 으로 검색' : '논문 제목 · 저자 · DOI 로 검색';
      $('[data-srcinfo]', body).textContent = type === 'book'
        ? 'Open Library · Google Books' : 'Crossref';
      $('[data-results]', body).innerHTML = '';
    }
    $$('[data-typepick] button', body).forEach(b => b.onclick = () => {
      if (isEdit && work.type !== b.dataset.type && (work.toc || []).length) {
        toast('목차가 있는 책은 종류를 바꿀 수 없습니다.', 'err'); return;
      }
      type = b.dataset.type; applyType(); updateTocCount();
    });
    applyType();

    // ── 표지 ───────────────────────────────────────────────────────────────
    function paintCover() {
      const box = $('[data-coverpreview]', body);
      box.innerHTML = cover?.url
        ? `<img src="${esc(cover.url)}" alt="">`
        : `<span class="ph">${esc(initials($('[data-f="title"]', body).value))}</span>`;
    }
    $('[data-coverfile]', body).onclick = async () => {
      try {
        const r = await api.cover.pickFile();
        if (r) { cover = r; createdFiles.push(r.file); paintCover(); }
      } catch (e) { toast('이미지를 불러오지 못했습니다: ' + e.message, 'err'); }
    };
    $('[data-coverurl]', body).onclick = async () => {
      const url = await promptText({ title: '이미지 주소', label: 'COVER IMAGE URL', placeholder: 'https://...' });
      if (!url) return;
      try {
        const r = await api.cover.download(url);
        cover = r; createdFiles.push(r.file); paintCover();
        toast('표지를 저장했습니다.', 'ok');
      } catch (e) { toast('표지를 받지 못했습니다: ' + e.message, 'err'); }
    };
    $('[data-coverclear]', body).onclick = () => { cover = null; paintCover(); };
    $('[data-f="title"]', body).addEventListener('input', () => { if (!cover) paintCover(); });

    // ── 목차 ───────────────────────────────────────────────────────────────
    function updateTocCount() {
      const el = $('[data-toccount]', body);
      const pages = tocDraft.reduce((s, c) => s + chapterPages(c), 0);
      el.textContent = `등록된 장 ${tocDraft.length}개` + (pages ? ` · ${pages}쪽` : '');
    }
    $('[data-tocpaste]', body).onclick = async () => {
      const res = await openTocEditor(tocDraft);
      if (res) { tocDraft = res; updateTocCount(); }
    };
    const tocWebBtn = $('[data-tocweb]', body);
    tocWebBtn.onclick = async () => {
      if (!lastPick) return;
      tocWebBtn.disabled = true;
      tocWebBtn.innerHTML = `<span class="spinner"></span>조회 중`;
      try {
        const r = await api.search.toc({ editions: lastPick.editions || [], isbn: lastPick.isbn || '' });
        if (!r) { toast('이 책의 온라인 목차를 찾지 못했습니다. 직접 입력해 주세요.'); }
        else {
          const rows = r.rows.map(x => normalizeChapter({
            id: uid(),
            title: x.title,
            level: x.level || 0,
            from: x.page || null
          }));
          for (let i = 0; i < rows.length; i++) {
            if (rows[i].from != null && rows[i].to == null) {
              const nx = rows.slice(i + 1).find(c => c.from != null);
              if (nx && nx.from > rows[i].from) rows[i].to = nx.from - 1;
            }
          }
          const ok = await openTocEditor(rows, `${r.source} 에서 ${rows.length}개 항목을 가져왔습니다. 확인 후 저장하세요.`);
          if (ok) { tocDraft = ok; updateTocCount(); toast('목차를 가져왔습니다.', 'ok'); }
        }
      } catch (e) {
        toast('목차 조회 실패: ' + e.message, 'err');
      } finally {
        tocWebBtn.disabled = false;
        tocWebBtn.innerHTML = `${ICON.search}온라인 목차 가져오기`;
      }
    };
    updateTocCount();

    // ── 온라인 검색 ────────────────────────────────────────────────────────
    const resultsEl = $('[data-results]', body);
    const qInput = $('[data-q]', body);

    async function doSearch() {
      const q = qInput.value.trim();
      if (!q) { qInput.focus(); return; }
      resultsEl.innerHTML = `<div class="loading"><span class="spinner"></span>검색 중…</div>`;
      try {
        const list = type === 'book' ? await api.search.books(q) : await api.search.papers(q);
        if (!list.length) {
          resultsEl.innerHTML = `<div class="notice">검색 결과가 없습니다. 아래 항목을 직접 입력해 주세요.</div>`;
          return;
        }
        resultsEl.innerHTML = `<div class="result-list scroll" style="max-height:280px;overflow-y:auto">
          ${list.map((r, i) => resultHTML(r, i)).join('')}</div>`;
        mountImageFallbacks(resultsEl);
        $$('[data-ri]', resultsEl).forEach(el => el.onclick = () => {
          $$('[data-ri]', resultsEl).forEach(x => x.classList.remove('on'));
          el.classList.add('on');
          fillFrom(list[+el.dataset.ri]);
        });
      } catch (e) {
        resultsEl.innerHTML = `<div class="notice err">검색에 실패했습니다 (${esc(e.message)}).<br>인터넷 연결과 무관하게, 아래 항목을 직접 입력하면 그대로 등록됩니다.</div>`;
      }
    }
    $('[data-dosearch]', body).onclick = doSearch;
    qInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

    function resultHTML(r, i) {
      const srcCls = r.source === 'Crossref' ? 'cross' : r.source === 'Open Library' ? 'ol' : 'gb';
      return `<div class="result" data-ri="${i}">
        <div class="rc">${r.coverUrl ? `<img src="${esc(r.coverUrl)}" alt="" data-fallback="${esc(initials(r.title))}">` : `<span>${esc(initials(r.title))}</span>`}</div>
        <div class="ri">
          <div class="rt">${esc(r.title)}</div>
          <div class="ra">${esc((r.authors || []).slice(0, 4).join(', ')) || '저자 미상'}</div>
          <div class="rm">
            <span class="src ${srcCls}">${esc(r.source)}</span>
            ${r.year ? `<span>${esc(r.year)}</span>` : ''}
            ${r.venue ? `<span>· ${esc(r.venue)}</span>` : ''}
            ${r.pageCount ? `<span>· ${esc(r.pageCount)}쪽</span>` : ''}
            ${r.doi ? `<span>· ${esc(r.doi)}</span>` : ''}
          </div>
        </div>
      </div>`;
    }

    async function fillFrom(r) {
      lastPick = r;
      const set = (k, v) => { const el = $(`[data-f="${k}"]`, body); if (el && v != null && v !== '') el.value = v; };
      set('title', r.title);
      set('authors', (r.authors || []).join(', '));
      set('year', r.year ?? '');
      set('venue', r.venue || '');
      set('doi', r.doi || '');
      set('isbn', r.isbn || '');
      set('url', r.url || '');
      set('pageCount', r.pageCount ?? '');
      (r.tags || []).slice(0, 3).forEach(t => tagWidget.add(t));
      tocWebBtn.disabled = !(type === 'book' && ((r.editions || []).length || r.isbn));

      if (r.coverUrl && !cover) {
        try {
          const c = await api.cover.download(r.coverUrl);
          cover = c; createdFiles.push(c.file); paintCover();
        } catch { /* 표지는 없어도 그만 */ }
      }
      paintCover();
      toast('검색 결과를 불러왔습니다. 필요하면 직접 수정하세요.', 'ok');
    }

    // ── 저장 ───────────────────────────────────────────────────────────────
    $('[data-cancel]', m.root).onclick = () => m.close();
    $('[data-ok]', m.root).onclick = () => {
      const get = k => ($(`[data-f="${k}"]`, body)?.value || '').trim();
      const title = get('title');
      if (!title) { toast('제목은 반드시 입력해야 합니다.', 'err'); $('[data-f="title"]', body).focus(); return; }

      const yearRaw = get('year').match(/\d{3,4}/);
      const data = {
        type,
        title,
        authors: get('authors').split(/[,;]/).map(s => s.trim()).filter(Boolean),
        year: yearRaw ? parseInt(yearRaw[0], 10) : null,
        venue: get('venue'),
        doi: type === 'paper' ? get('doi').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') : '',
        isbn: type === 'book' ? get('isbn') : '',
        url: get('url'),
        pageCount: type === 'book' ? (parseInt(get('pageCount').replace(/[^\d]/g, ''), 10) || null) : null,
        tags: tagWidget.get(),
        notes: get('notes'),
        cover: cover ? { file: cover.file } : null,
        toc: type === 'book' ? tocDraft : [],
        source: lastPick ? lastPick.source : (work?.source || 'MANUAL ENTRY')
      };
      // 새로 만든 표지 중 실제로 쓰지 않는 것만 정리
      for (const f of createdFiles) if (f !== cover?.file && f !== originalCoverFile) api.cover.remove(f);
      if (originalCoverFile && cover?.file !== originalCoverFile) api.cover.remove(originalCoverFile);

      settled = true;
      m.close();
      resolve(data);
    };

    setTimeout(() => $('[data-f="title"]', body)?.focus(), 60);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 목차 편집기 — 텍스트로 붙여넣고 미리보기로 확인
// ═══════════════════════════════════════════════════════════════════════════
export function openTocEditor(current = [], note = '') {
  return new Promise(resolve => {
    let settled = false;
    const initialText = serializeTOC(current);
    let parsed = current.map(c => ({ ...c }));

    const m = modal({
      kicker: 'TABLE OF CONTENTS',
      title: '목차 편집',
      wide: true,
      bodyHTML: `
        ${note ? `<div class="notice mb">${esc(note)}</div>` : ''}
        <div class="notice mb">
          한 줄에 한 장씩 입력합니다. 쪽 범위는 <b class="mono">Chapter | 12-40</b> 또는 <b class="mono">Chapter ..... 12</b> 형태로 쓸 수 있고,
          줄 앞에 <b>공백 2칸</b>을 넣으면 하위 절이 됩니다. 쪽 범위를 모두 넣으면 진척도가 <b>쪽 수 기준</b>으로 계산됩니다.
        </div>
        <div class="panel mb" data-ocrpanel hidden>
          <div class="panel-head">
            <span class="panel-title">IMAGE OCR</span>
            <span class="muted" style="font-size:11px">Windows 내장 엔진 · 오프라인</span>
          </div>
          <div class="row wrap">
            <button class="btn sm primary" data-aipick hidden>${ICON.spark}AI로 읽기</button>
            <button class="btn sm" data-ocrpick>${ICON.img}Windows OCR 로 읽기</button>
            <select class="sel" data-ocrlang></select>
            <label class="row gap-s" style="font-size:11.5px;color:var(--txt-2);cursor:pointer">
              <input type="checkbox" data-ocrappend checked style="width:auto;accent-color:var(--cy)" />
              기존 목차 뒤에 붙이기
            </label>
            <span class="muted grow" style="font-size:11.5px;text-align:right" data-ocrstatus></span>
          </div>
          <div class="hint mt-s" data-ocrhint>
            책의 목차 페이지를 찍은 사진이나 스캔본을 넣으면 목차 초안을 만들어 줍니다.
            여러 장을 한 번에 고를 수 있고, 고른 순서대로 이어 붙입니다.
            <b>어느 쪽이든 결과는 완벽하지 않으니 아래 미리보기로 꼭 확인하세요.</b>
          </div>
        </div>

        <div class="two-col" style="grid-template-columns:1fr 1fr">
          <div class="field">
            <label>TOC TEXT</label>
            <textarea class="mono" data-toctext style="min-height:330px" placeholder="Chapter 1. Introduction | 1-24&#10;  1.1 Background | 1-10&#10;  1.2 Prior work | 11-24&#10;Chapter 2. Theory | 25-70">${esc(initialText)}</textarea>
          </div>
          <div class="field">
            <label>PREVIEW <span data-cnt class="muted"></span></label>
            <div class="panel scroll" data-preview style="min-height:330px;max-height:330px;overflow-y:auto;padding:10px"></div>
          </div>
        </div>`,
      footHTML: `
        <button class="btn ghost danger sm" data-clear>${ICON.trash}전체 비우기</button>
        <div class="right">
          <button class="btn ghost" data-cancel>취소</button>
          <button class="btn primary" data-ok>${ICON.check}목차 저장</button>
        </div>`,
      onClose: () => { if (!settled) { settled = true; resolve(null); } }
    });

    const ta = $('[data-toctext]', m.body);
    const pv = $('[data-preview]', m.body);
    const cnt = $('[data-cnt]', m.body);

    function refresh() {
      const rows = parseTOC(ta.value);
      // 기존 읽음 상태를 제목이 같으면 유지한다.
      const prev = new Map(current.map(c => [c.title.trim(), c]));
      parsed = rows.map(r => {
        const old = prev.get(r.title.trim());
        return old ? { ...r, id: old.id, read: old.read, readAt: old.readAt, scope: old.scope } : r;
      });
      const pages = parsed.reduce((s, c) => s + chapterPages(c), 0);
      cnt.textContent = `— ${parsed.length}개 항목${pages ? ` · ${pages}쪽` : ''}`;
      pv.innerHTML = parsed.length
        ? parsed.map(c => `<div class="toc-item lvl${c.level}" style="cursor:default;padding:6px 8px">
             <span class="toc-title">${esc(c.title)}</span>
             ${c.from != null ? `<span class="toc-pages">${c.from}${c.to != null && c.to !== c.from ? '–' + c.to : ''}</span>` : ''}
           </div>`).join('')
        : `<div class="muted" style="font-size:12px;padding:8px">아직 항목이 없습니다.</div>`;
    }
    ta.addEventListener('input', refresh);
    refresh();

    mountOcr(m, ta, refresh);

    $('[data-clear]', m.root).onclick = () => { ta.value = ''; refresh(); };
    $('[data-cancel]', m.root).onclick = () => m.close();
    $('[data-ok]', m.root).onclick = () => { settled = true; m.close(); resolve(parsed); };
    setTimeout(() => ta.focus(), 60);
  });
}

// ─── 목차 편집기의 이미지 OCR ───────────────────────────────────────────────
// OCR 을 쓸 수 없는 환경(언어 팩 없음 등)에서는 패널을 아예 띄우지 않는다.
// 수동 입력 경로는 그대로 남아 있으므로 기능이 없어도 목차 등록에는 지장이 없다.
async function mountOcr(m, ta, refresh) {
  const panel = $('[data-ocrpanel]', m.body);
  if (!panel) return;

  const status = $('[data-ocrstatus]', panel);
  const appendBox = $('[data-ocrappend]', panel);

  /** 인식 결과(행 배열)를 텍스트 칸에 반영한다. 두 경로가 공유한다. */
  function applyRows(rows, label) {
    if (!rows.length) {
      status.textContent = '항목을 찾지 못했습니다';
      toast('목차로 볼 만한 내용을 찾지 못했습니다. 더 밝고 큰 사진으로 다시 시도해 보세요.', 'err');
      return false;
    }
    const text = rowsToText(rows);
    const keep = appendBox.checked && ta.value.trim();
    ta.value = keep ? (ta.value.replace(/\s+$/, '') + '\n' + text) : text;
    refresh();
    const s = summarize(rows);
    status.textContent = `${label} · ${s.total}개 항목 · 쪽번호 ${s.withPage}개`;
    return s;
  }

  // ── AI 경로 ───────────────────────────────────────────────────────────────
  const aiBtn = $('[data-aipick]', panel);
  let aiCfg = null;
  try { aiCfg = await api.ai.getConfig(); } catch { /* noop */ }
  if (aiCfg?.hasKey) {
    aiBtn.hidden = false;
    aiBtn.title = `${aiCfg.providers?.[aiCfg.provider]?.label || aiCfg.provider} · ${aiCfg.model}`;
    aiBtn.onclick = async () => {
      let files = [];
      try { files = await api.ocr.pickImages(); } catch (e) { toast('이미지를 열지 못했습니다: ' + e.message, 'err'); return; }
      if (!files.length) return;

      aiBtn.disabled = true;
      const all = [];
      const failed = [];
      for (let i = 0; i < files.length; i++) {
        status.innerHTML = `<span class="spinner" style="display:inline-block;vertical-align:-3px"></span> AI ${i + 1}/${files.length} — ${esc(files[i].name)} 읽는 중…`;
        try {
          const r = await api.ai.extractTOC(files[i].path);
          all.push(...r.entries.map(e => ({ title: e.title, level: e.level, page: e.from == null ? '' : String(e.from), to: e.to })));
        } catch (e) {
          failed.push(`${files[i].name}: ${e.message}`);
        }
      }
      aiBtn.disabled = false;

      if (!all.length) {
        status.textContent = 'AI 인식 실패';
        toast('AI 인식에 실패했습니다. ' + (failed[0] || ''), 'err');
        return;
      }
      // AI 는 끝쪽까지 주는 경우가 있어 그대로 살린다.
      const rows = all.map(r => ({
        title: r.title, level: r.level,
        page: r.to != null && r.page ? `${r.page}-${r.to}` : r.page
      }));
      const s = applyRows(rows, `AI(${aiCfg.model})`);
      if (s) {
        toast(`AI 가 목차 ${s.total}개 항목을 읽었습니다. 미리보기에서 확인하세요.`, 'ok');
      }
      if (failed.length) toast(`${failed.length}장 실패: ${failed[0]}`, 'err');
    };
  }

  // ── Windows OCR 경로 ──────────────────────────────────────────────────────
  let langs = [];
  try { langs = await api.ocr.languages(); } catch { langs = []; }
  if (!langs.length) {
    // OCR 을 못 쓰더라도 AI 키가 있으면 패널은 띄운다.
    $('[data-ocrpick]', panel).hidden = true;
    $('[data-ocrlang]', panel).hidden = true;
    if (aiCfg?.hasKey) panel.hidden = false;
    return;
  }

  const sel = $('[data-ocrlang]', panel);
  const preferred = ['ko', 'en-US', 'ja'];
  langs.sort((a, b) => {
    const ia = preferred.findIndex(p => a.tag.startsWith(p));
    const ib = preferred.findIndex(p => b.tag.startsWith(p));
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  sel.innerHTML = langs.map(l => `<option value="${esc(l.tag)}">${esc(l.name)}</option>`).join('');
  panel.hidden = false;

  const btn = $('[data-ocrpick]', panel);

  btn.onclick = async () => {
    let files = [];
    try { files = await api.ocr.pickImages(); } catch (e) { toast('이미지를 열지 못했습니다: ' + e.message, 'err'); return; }
    if (!files.length) return;

    btn.disabled = true;
    const lang = sel.value;
    const pages = [];
    const failed = [];

    for (let i = 0; i < files.length; i++) {
      status.innerHTML = `<span class="spinner" style="display:inline-block;vertical-align:-3px"></span> ${i + 1}/${files.length} — ${esc(files[i].name)} 인식 중…`;
      try {
        pages.push(await api.ocr.recognize(files[i].path, lang));
      } catch (e) {
        failed.push(`${files[i].name}: ${e.message}`);
      }
    }
    btn.disabled = false;

    if (!pages.length) {
      status.textContent = '인식 실패';
      toast('이미지를 인식하지 못했습니다. ' + (failed[0] || ''), 'err');
      return;
    }

    const rows = rowsFromPages(pages);
    const upscaled = pages.filter(p => p.scaled > 1.05).length;
    const s = applyRows(rows, 'Windows OCR');
    if (s) {
      toast(
        `목차 ${s.total}개 항목을 읽었습니다` +
        (s.withoutPage ? ` (쪽번호 ${s.withoutPage}개 누락)` : '') +
        (upscaled ? ` · 사진 ${upscaled}장은 자동 확대함` : '') +
        '. 미리보기에서 확인하세요.',
        'ok'
      );
    }
    if (failed.length) toast(`${failed.length}장은 실패했습니다: ${failed[0]}`, 'err');
  };
}

export function serializeTOC(toc) {
  return (toc || []).map(c => {
    const indent = '  '.repeat(c.level || 0);
    let pages = '';
    if (c.from != null) pages = ` | ${c.from}${c.to != null && c.to !== c.from ? '-' + c.to : ''}`;
    return indent + c.title + pages;
  }).join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 간단 텍스트 입력 프롬프트
// ═══════════════════════════════════════════════════════════════════════════
// label 은 mono 서브 글꼴이라 영어만 넣는다. 한국어 설명은 hint(본문 글꼴)로.
export function promptText({ title = '입력', label = '', hint = '', placeholder = '', value = '', multiline = false }) {
  return new Promise(resolve => {
    let settled = false;
    const m = modal({
      kicker: 'INPUT', title,
      bodyHTML: `<div class="field">
          ${label ? `<label>${esc(label)}</label>` : ''}
          ${multiline
            ? `<textarea data-v placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
            : `<input type="text" data-v value="${esc(value)}" placeholder="${esc(placeholder)}" />`}
          ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
        </div>`,
      footHTML: `<div class="right">
          <button class="btn ghost" data-cancel>취소</button>
          <button class="btn primary" data-ok>확인</button>
        </div>`,
      onClose: () => { if (!settled) { settled = true; resolve(null); } }
    });
    const inp = $('[data-v]', m.body);
    const ok = () => { settled = true; const v = inp.value.trim(); m.close(); resolve(v || null); };
    $('[data-ok]', m.root).onclick = ok;
    $('[data-cancel]', m.root).onclick = () => m.close();
    if (!multiline) inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
    setTimeout(() => inp.focus(), 60);
  });
}
