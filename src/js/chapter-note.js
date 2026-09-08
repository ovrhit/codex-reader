// 장별 메모 + 옵시디언 노트 연결
'use strict';

import { $, $$, esc, modal, toast, ICON, cleanErr } from './util.js';

const api = window.codex;

/**
 * 한 장(chapter)의 메모와 옵시디언 노트 연결을 다루는 모달.
 * 저장은 호출한 쪽이 한다 — onSave 로 바뀐 값을 돌려준다.
 */
export function openChapterNote({ work, chapter, onSave }) {
  return new Promise(resolve => {
    let noteLink = chapter.noteLink || '';
    let settled = false;

    const pages = (chapter.from != null && chapter.to != null) ? `${chapter.from}–${chapter.to}`
                : (chapter.from != null ? `p.${chapter.from}` : '');

    const m = modal({
      kicker: 'CHAPTER NOTE',
      title: chapter.title || '(제목 없음)',
      wide: true,
      bodyHTML: `
        <div class="row mono muted mb" style="font-size:11.5px">
          <span>${esc(work.title)}</span>
          ${pages ? `<span class="sep">·</span><span>${esc(pages)}</span>` : ''}
        </div>

        <div class="field mb">
          <label>NOTE</label>
          <textarea data-note style="min-height:150px" placeholder="이 장에 대한 메모">${esc(chapter.note || '')}</textarea>
          <div class="hint">앱 안에만 저장되는 메모입니다. 아래에서 옵시디언 노트와 따로 연결할 수 있습니다.</div>
        </div>

        <div class="panel" data-obs>
          <div class="panel-head">
            <span class="panel-title">OBSIDIAN</span>
            <span class="muted" style="font-size:11px" data-obsinfo></span>
          </div>
          <div data-obsbody></div>
        </div>`,
      footHTML: `
        <div class="right">
          <button class="btn ghost" data-cancel>취소</button>
          <button class="btn primary" data-ok>${ICON.check}저장</button>
        </div>`,
      onClose: () => { if (!settled) { settled = true; resolve(null); } }
    });

    const noteTa = $('[data-note]', m.body);
    const obsBody = $('[data-obsbody]', m.body);
    const obsInfo = $('[data-obsinfo]', m.body);

    // ── 옵시디언 영역 ────────────────────────────────────────────────────────
    async function paintObsidian() {
      let st;
      try { st = await api.obsidian.status(); }
      catch (e) { obsBody.innerHTML = `<div class="notice err">볼트 상태를 확인하지 못했습니다: ${esc(cleanErr(e))}</div>`; return; }

      obsInfo.textContent = st.linked ? `${st.vaultName} / ${st.subfolder}` : '';

      if (!st.linked) {
        obsBody.innerHTML = `<div class="notice">
          옵시디언 볼트가 연결되지 않았습니다. <b>설정 → OBSIDIAN</b> 에서 볼트를 지정하면
          이 장의 노트를 볼트에 만들거나 기존 노트와 연결할 수 있습니다.
        </div>`;
        return;
      }

      if (!noteLink) {
        obsBody.innerHTML = `
          <div class="row wrap">
            <button class="btn sm primary" data-create>${ICON.plus}이 장의 노트 만들기</button>
            <button class="btn sm" data-link>${ICON.link}기존 노트 연결</button>
          </div>
          <div class="hint mt-s">
            새로 만들면 <b>${esc(st.subfolder)}/${esc(work.title.slice(0, 30))}/</b> 아래에
            책·장·쪽 정보가 담긴 프론트매터와 함께 생성됩니다.
          </div>`;
        $('[data-create]', obsBody).onclick = doCreate;
        $('[data-link]', obsBody).onclick = doPick;
        return;
      }

      // 연결돼 있으면 미리보기까지 보여 준다
      let info = { exists: false };
      try { info = await api.obsidian.readNote(noteLink); } catch { /* noop */ }

      obsBody.innerHTML = `
        <div class="row wrap mb">
          <span class="badge ${info.exists ? 'read' : ''}" style="max-width:none">${info.exists ? 'LINKED' : 'MISSING'}</span>
          <span class="mono sel-text" style="font-size:11.5px;color:var(--txt-2)">${esc(noteLink)}</span>
        </div>
        ${info.exists
          ? `<div class="panel scroll" style="max-height:170px;overflow:auto;padding:11px;background:rgba(255,255,255,.02)">
               <div class="sel-text" style="font-size:12.5px;line-height:1.65;white-space:pre-wrap;color:var(--txt-2)">${esc(info.preview) || '<span class="muted">(내용 없음)</span>'}</div>
             </div>`
          : `<div class="notice warn">볼트에서 이 파일을 찾을 수 없습니다. 옵시디언에서 옮기거나 이름을 바꿨을 수 있습니다.</div>`}
        <div class="row wrap mt">
          <button class="btn sm" data-open ${info.exists ? '' : 'disabled'}>${ICON.link}옵시디언에서 열기</button>
          <button class="btn sm ghost" data-relink>${ICON.edit}다른 노트로 변경</button>
          <button class="btn sm ghost danger" data-unlink>연결 해제</button>
        </div>`;

      $('[data-open]', obsBody).onclick = async () => {
        try { await api.obsidian.openNote(noteLink); }
        catch (e) { toast('열지 못했습니다: ' + cleanErr(e), 'err'); }
      };
      $('[data-relink]', obsBody).onclick = doPick;
      $('[data-unlink]', obsBody).onclick = () => { noteLink = ''; paintObsidian(); };
    }

    async function doCreate(ev) {
      const b = ev.currentTarget;
      b.disabled = true;
      try {
        const r = await api.obsidian.createNote({
          work: { title: work.title, authors: work.authors, year: work.year, tags: work.tags },
          chapter: { title: chapter.title, from: chapter.from, to: chapter.to }
        });
        noteLink = r.rel;
        toast('노트를 만들었습니다: ' + r.rel, 'ok');
        await paintObsidian();
      } catch (e) {
        toast('노트를 만들지 못했습니다: ' + cleanErr(e), 'err');
        b.disabled = false;
      }
    }

    async function doPick() {
      const picked = await pickNote(chapter.title);
      if (picked) { noteLink = picked; await paintObsidian(); }
    }

    paintObsidian();

    $('[data-cancel]', m.root).onclick = () => m.close();
    $('[data-ok]', m.root).onclick = () => {
      settled = true;
      const result = { note: noteTa.value.trim(), noteLink };
      m.close();
      if (onSave) onSave(result);
      resolve(result);
    };
    setTimeout(() => noteTa.focus(), 60);
  });
}

/** 볼트의 노트를 검색해 고르는 작은 모달. 상대 경로를 돌려준다. */
function pickNote(initialQuery = '') {
  return new Promise(resolve => {
    let settled = false;
    const m = modal({
      kicker: 'OBSIDIAN', title: '노트 연결',
      bodyHTML: `
        <div class="search-box mb">
          ${ICON.search}
          <input type="text" data-q placeholder="노트 이름 · 폴더로 검색" value="${esc(initialQuery)}" />
        </div>
        <div data-list class="result-list scroll" style="max-height:340px;overflow-y:auto"></div>`,
      footHTML: `<div class="right"><button class="btn ghost" data-cancel>취소</button></div>`,
      onClose: () => { if (!settled) { settled = true; resolve(null); } }
    });

    const q = $('[data-q]', m.body);
    const listEl = $('[data-list]', m.body);
    let timer = null;

    async function refresh() {
      listEl.innerHTML = `<div class="loading"><span class="spinner"></span>불러오는 중…</div>`;
      try {
        const notes = await api.obsidian.listNotes({ query: q.value.trim(), limit: 300 });
        if (!notes.length) {
          listEl.innerHTML = `<div class="notice">일치하는 노트가 없습니다.</div>`;
          return;
        }
        listEl.innerHTML = notes.map((n, i) => `
          <div class="result" data-i="${i}" style="align-items:center">
            <div class="ri">
              <div class="rt">${esc(n.name)}</div>
              <div class="rm mono">${esc(n.rel)}</div>
            </div>
          </div>`).join('');
        $$('[data-i]', listEl).forEach(el => el.onclick = () => {
          settled = true;
          const rel = notes[+el.dataset.i].rel;
          m.close();
          resolve(rel);
        });
      } catch (e) {
        listEl.innerHTML = `<div class="notice err">${esc(cleanErr(e))}</div>`;
      }
    }

    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 200); });
    $('[data-cancel]', m.root).onclick = () => m.close();
    refresh();
    setTimeout(() => q.focus(), 60);
  });
}
