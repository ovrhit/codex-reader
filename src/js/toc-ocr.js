// OCR 결과 → 목차 텍스트 복원
//
// Windows OCR 은 목차 페이지를 읽을 때 왼쪽 '제목' 열과 오른쪽 '쪽번호' 열을
// 서로 다른 줄로 끊어 놓는다(점선 리더가 사이를 갈라 놓기 때문). 그래서 줄 단위
// 텍스트를 그대로 쓰면 제목과 쪽번호가 따로 논다.
// 대신 단어의 바운딩 박스를 받아 y 좌표로 행을 다시 묶고, 왼쪽 x 로 들여쓰기
// 단계를, 오른쪽 끝 숫자로 쪽번호를 되살린다.
'use strict';

const PAGE_NUM = /^[0-9]{1,4}$/;
const PAGE_ROMAN = /^[ivxlcdm]{1,7}$/i;
// 목차 페이지 자체의 머리글 — 항목이 아니므로 걸러낸다.
const HEADING = /^(차\s*례|목\s*차|자\s*례|contents?|table\s+of\s+contents)$/i;

function isPageToken(t) {
  return PAGE_NUM.test(t) || PAGE_ROMAN.test(t);
}

/** 단어들을 y 중심 기준으로 같은 행끼리 묶는다. */
function clusterRows(words) {
  if (!words.length) return [];
  const heights = words.map(w => w.h).sort((a, b) => a - b);
  const medH = heights[Math.floor(heights.length / 2)] || 20;
  const tol = medH * 0.6;

  const sorted = [...words].sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
  const rows = [];
  for (const w of sorted) {
    const c = w.y + w.h / 2;
    const row = rows.find(r => Math.abs(r.c - c) <= tol);
    if (row) {
      row.words.push(w);
      row.c = (row.c * (row.words.length - 1) + c) / row.words.length;
    } else {
      rows.push({ c, words: [w] });
    }
  }
  rows.forEach(r => r.words.sort((a, b) => a.x - b.x));
  return { rows, medH };
}

/** 왼쪽 x 값들을 최대 3단계 들여쓰기로 나눈다. */
function levelOf(left, stops) {
  let i = stops.findIndex(s => Math.abs(left - s) <= s * 0.02 + 12);
  if (i < 0) i = stops.filter(s => s < left).length;
  return Math.max(0, Math.min(2, i));
}

function indentStops(lefts, medH) {
  const uniq = [...lefts].sort((a, b) => a - b);
  const stops = [];
  for (const v of uniq) {
    if (!stops.length || v - stops[stops.length - 1] > medH * 0.8) stops.push(v);
  }
  return stops.slice(0, 3);
}

/**
 * OCR 페이지 하나를 목차 행 배열로 바꾼다.
 * @param {{imageWidth:number, lines:Array}} page
 */
export function rowsFromPage(page) {
  const words = (page.lines || []).flatMap(l => l.words || []);
  if (!words.length) return [];

  const { rows, medH } = clusterRows(words);
  const W = page.imageWidth || Math.max(...words.map(w => w.x + w.w));

  const raw = rows.map(r => {
    const ws = r.words;
    const last = ws[ws.length - 1];
    // 쪽번호는 오른쪽 여백에 붙어 있어야 한다. 본문 중간의 숫자를 오인하지 않도록.
    const farRight = last.x > W * 0.68;
    const isPage = ws.length > 1 && farRight && isPageToken(last.t);

    const titleWords = isPage ? ws.slice(0, -1) : ws;
    const title = titleWords.map(w => w.t).join(' ')
      .replace(/[.·…‥\-—_]{2,}\s*$/, '')   // 점선 리더 꼬리
      .replace(/\s{2,}/g, ' ')
      .trim();

    let page_ = '';
    if (isPage) page_ = PAGE_ROMAN.test(last.t) && !PAGE_NUM.test(last.t) ? '' : last.t;

    return { left: ws[0].x, title, page: page_ };
  }).filter(r => r.title && !HEADING.test(r.title.replace(/\s+/g, ' ').trim()));

  if (!raw.length) return [];

  const stops = indentStops(raw.map(r => r.left), medH);
  raw.forEach(r => { r.level = levelOf(r.left, stops); });
  return raw;
}

/** 여러 장(목차가 2~3쪽에 걸치는 경우)을 순서대로 이어 붙인다. */
export function rowsFromPages(pages) {
  return (pages || []).flatMap(p => rowsFromPage(p));
}

/** 목차 편집기 텍스트 형식으로 직렬화 — 기존 parseTOC 가 그대로 읽는다. */
export function rowsToText(rows) {
  return (rows || [])
    .map(r => '  '.repeat(r.level || 0) + r.title + (r.page ? ` | ${r.page}` : ''))
    .join('\n');
}

/** 결과 요약 — 사용자에게 검토 필요성을 알리는 데 쓴다. */
export function summarize(rows) {
  const total = rows.length;
  const withPage = rows.filter(r => r.page).length;
  return { total, withPage, withoutPage: total - withPage };
}
