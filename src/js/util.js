// 공용 유틸 — DOM 헬퍼, 토스트, 모달
'use strict';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
}

/** 태그 리터럴로 안전하게 HTML을 만든다. ${} 값은 자동 이스케이프, ${raw(x)}는 그대로. */
const RAW = Symbol('raw');
export const raw = (s) => ({ [RAW]: String(s ?? '') });
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v && typeof v === 'object' && RAW in v) out += v[RAW];
    else if (Array.isArray(v)) out += v.map(x => (x && typeof x === 'object' && RAW in x) ? x[RAW] : esc(x)).join('');
    else out += esc(v);
  }
  return out;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

export function daysBetween(a, b) {
  if (!a || !b) return null;
  const d = (new Date(b) - new Date(a)) / 86400000;
  return isNaN(d) ? null : Math.max(0, Math.round(d));
}

/**
 * IPC 를 건너온 오류는 Electron 이 앞에 껍데기를 씌운다.
 *   "Error invoking remote method 'ai:extractTOC': Error: 진짜 메시지"
 * 사용자에게는 진짜 메시지만 보여 준다.
 */
export function cleanErr(e) {
  let m = (e && e.message) || String(e || '');
  m = m.replace(/^Error invoking remote method '[^']*':\s*/, '');
  m = m.replace(/^(?:Uncaught\s+)?(?:\w*Error):\s*/, '');
  return m.trim() || '알 수 없는 오류';
}

export function initials(title) {
  const t = String(title || '').trim();
  if (!t) return '·';
  const w = t.split(/\s+/).filter(Boolean);
  if (/[가-힣]/.test(t)) return t.slice(0, 2);
  return (w.length > 1 ? w[0][0] + w[1][0] : t.slice(0, 2)).toUpperCase();
}

// ─── 토스트 ────────────────────────────────────────────────────────────────
export function toast(msg, kind = '') {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `<span>${esc(msg)}</span>`;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, kind === 'err' ? 4200 : 2600);
}

// ─── 모달 ──────────────────────────────────────────────────────────────────
let openModals = 0;

/**
 * 모달을 연다.
 * @returns {{root:HTMLElement, close:Function, body:HTMLElement, foot:HTMLElement}}
 */
export function modal({ kicker = '', title = '', bodyHTML = '', footHTML = '', wide = false, onClose = null }) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div>
          ${kicker ? `<div class="k">${esc(kicker)}</div>` : ''}
          <h2>${esc(title)}</h2>
        </div>
        <button class="x-btn" data-close aria-label="닫기">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="modal-body">${bodyHTML}</div>
      ${footHTML ? `<div class="modal-foot">${footHTML}</div>` : ''}
    </div>`;

  document.getElementById('modal-root').appendChild(overlay);
  openModals++;

  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    openModals--;
    overlay.style.animation = 'fade .15s ease reverse';
    setTimeout(() => overlay.remove(), 140);
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose(result);
  };

  const onKey = (e) => {
    if (e.key === 'Escape' && openModals && overlay.parentNode) {
      // 가장 위 모달만 닫는다
      const all = $$('#modal-root .overlay');
      if (all[all.length - 1] === overlay) { e.stopPropagation(); close(null); }
    }
  };
  document.addEventListener('keydown', onKey);

  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
  overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => close(null)));

  return {
    root: overlay,
    el: $('.modal', overlay),
    body: $('.modal-body', overlay),
    foot: $('.modal-foot', overlay),
    close
  };
}

export function confirmDialog({ title = '확인', message = '', okText = '확인', danger = false }) {
  return new Promise(resolve => {
    let done = false;
    const m = modal({
      kicker: 'CONFIRM', title,
      bodyHTML: `<div class="notice${danger ? ' warn' : ''}">${esc(message)}</div>`,
      footHTML: `<div class="right">
          <button class="btn ghost" data-no>취소</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(okText)}</button>
        </div>`,
      onClose: () => { if (!done) resolve(false); }
    });
    $('[data-no]', m.root).onclick = () => { done = true; m.close(); resolve(false); };
    $('[data-yes]', m.root).onclick = () => { done = true; m.close(); resolve(true); };
  });
}

/** SVG 그라디언트 정의 (링 stroke 용). 문서에 한 번만 삽입. */
export function ensureDefs() {
  if ($('#codex-defs')) return;
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.id = 'codex-defs';
  s.setAttribute('width', '0'); s.setAttribute('height', '0');
  s.style.position = 'absolute';
  s.innerHTML = `<defs>
    <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#37e8ff"/><stop offset="100%" stop-color="#9d6bff"/>
    </linearGradient>
  </defs>`;
  document.body.appendChild(s);
}

/** 표지 이미지 태그 (없으면 이니셜 자리표시자) */
export function coverHTML(work, cls = 'cover') {
  const url = work._coverUrl;
  const t = work.type === 'paper' ? ' paper' : '';
  // CSP 때문에 인라인 onerror 를 쓸 수 없어, 이미지 실패는 mountImageFallbacks() 가 처리한다.
  if (url) return `<div class="${cls}${t}"><img src="${esc(url)}" alt="" loading="lazy" data-fallback="${esc(initials(work.title))}"></div>`;
  return `<div class="${cls}${t}"><span class="ph">${esc(initials(work.title))}</span></div>`;
}

/** 깨진 이미지를 이니셜 자리표시자로 바꾼다. 렌더 직후 한 번 호출. */
export function mountImageFallbacks(root = document) {
  $$('img[data-fallback]', root).forEach(img => {
    if (img.dataset.wired) return;
    img.dataset.wired = '1';
    const swap = () => {
      const span = document.createElement('span');
      span.className = 'ph';
      span.textContent = img.dataset.fallback || '·';
      img.replaceWith(span);
    };
    img.addEventListener('error', swap);
    if (img.complete && img.naturalWidth === 0) swap();
  });
}

export const ICON = {
  check: '<svg viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L21 21"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 13a4 4 0 0 0 6 .5l2-2a4 4 0 0 0-6-6l-1 1"/><path d="M14 11a4 4 0 0 0-6-.5l-2 2a4 4 0 0 0 6 6l1-1"/></svg>',
  img: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 16l-5-5-9 8"/></svg>',
  target: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5"/></svg>',
  paper: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h7M8 14h8v7H8z"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 4v13M6 12l6 6 6-6M4 21h16"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 20V7M6 12l6-6 6 6M4 3h16"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>',
  key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M17 6l2.5 2.5M14 9l2 2"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M5 4h11l3 3v13H5z"/><path d="M8.5 10h7M8.5 14h5"/></svg>',
  vault: '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/><path d="M12 4v16M4 12h8"/><circle cx="16" cy="12" r="2"/></svg>'
};
