'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// AI 비전 모델로 목차 이미지 읽기
//
// Windows 내장 OCR 은 글자를 "읽기만" 하므로 점선 리더·계층·기울기를 사람이 다시
// 짜맞춰야 하고, 쪽번호를 통째로 놓치는 일이 잦다. 비전 모델은 목차라는 맥락을
// 이해한 채로 구조화된 결과를 바로 내놓는다.
//
// 다만 이건 책 페이지 이미지를 외부로 보낸다. 그래서 완전한 선택 기능이고,
// 사용자가 자기 API 키를 직접 넣어야만 켜진다. 키는 OS 암호화(DPAPI)로 저장하며
// 서재 백업 파일에는 절대 들어가지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

const { app, nativeImage, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

// 비전 모델은 이보다 큰 이미지를 어차피 내부에서 줄인다. 토큰과 전송량만 낭비된다.
const MAX_EDGE = 2000;
const JPEG_QUALITY = 88;

// ─── provider 정의 ──────────────────────────────────────────────────────────
const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    note: '무료 티어 있음 · 이미지 입력 포함 (분당 10~15회 / 하루 1500회)',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'AI Studio 에서 카드 등록 없이 발급받을 수 있습니다.',
    defaultModel: 'gemini-3.8-flash',
    models: ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'],
    free: true
  },
  claude: {
    label: 'Anthropic Claude',
    note: '유료 (종량제) · 정확도가 가장 높은 편',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: '',
    defaultModel: 'claude-opus-5',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    free: false
  },
  openai: {
    label: 'OpenAI 호환 (xAI Grok · OpenAI · OpenRouter 등)',
    note: '유료 · Base URL 을 직접 지정합니다',
    keyUrl: '',
    keyHint: '예: https://api.x.ai/v1 · https://api.openai.com/v1 · https://openrouter.ai/api/v1',
    defaultModel: '',
    models: [],
    needsBaseUrl: true,
    free: false
  }
};

// ─── 설정 저장 (키는 OS 암호화) ─────────────────────────────────────────────
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'codex-data', 'ai-config.json');

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE(), 'utf8');
    const c = JSON.parse(raw);
    return {
      provider: c.provider || 'gemini',
      model: c.model || '',
      baseUrl: c.baseUrl || '',
      keyEnc: c.keyEnc || '',
      encrypted: !!c.encrypted
    };
  } catch {
    return { provider: 'gemini', model: '', baseUrl: '', keyEnc: '', encrypted: false };
  }
}

function decryptKey(c) {
  if (!c.keyEnc) return '';
  if (!c.encrypted) return c.keyEnc;             // 암호화를 못 쓰는 환경에서 저장된 값
  try { return safeStorage.decryptString(Buffer.from(c.keyEnc, 'base64')); }
  catch { return ''; }
}

/** 화면에 돌려줄 때는 키 자체를 절대 보내지 않는다. 설정 여부와 꼬리 4자리만. */
function publicConfig() {
  const c = readConfig();
  const key = decryptKey(c);
  return {
    provider: c.provider,
    model: c.model || PROVIDERS[c.provider]?.defaultModel || '',
    baseUrl: c.baseUrl,
    hasKey: !!key,
    keyTail: key ? key.slice(-4) : '',
    encrypted: c.encrypted,
    providers: PROVIDERS
  };
}

function saveConfig({ provider, model, baseUrl, apiKey }) {
  const cur = readConfig();
  const next = {
    provider: provider || cur.provider,
    model: model !== undefined ? model : cur.model,
    baseUrl: baseUrl !== undefined ? baseUrl : cur.baseUrl,
    keyEnc: cur.keyEnc,
    encrypted: cur.encrypted
  };

  // apiKey 가 undefined 면 기존 키 유지, 빈 문자열이면 삭제
  if (apiKey !== undefined) {
    if (!apiKey) { next.keyEnc = ''; next.encrypted = false; }
    else if (safeStorage.isEncryptionAvailable()) {
      next.keyEnc = safeStorage.encryptString(apiKey).toString('base64');
      next.encrypted = true;
    } else {
      next.keyEnc = apiKey;
      next.encrypted = false;
    }
  }

  const dir = path.dirname(CONFIG_FILE());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(next, null, 2), 'utf8');
  return publicConfig();
}

// ─── 이미지 준비 ────────────────────────────────────────────────────────────
async function imageToBase64(imgPath) {
  const img = nativeImage.createFromPath(imgPath);
  if (img.isEmpty()) {
    throw new Error('이미지를 읽지 못했습니다. PNG · JPG · BMP · WEBP 만 지원합니다.');
  }
  const { width, height } = img.getSize();
  let out = img;
  if (Math.max(width, height) > MAX_EDGE) {
    const s = MAX_EDGE / Math.max(width, height);
    out = img.resize({ width: Math.round(width * s), height: Math.round(height * s), quality: 'best' });
  }
  return { data: out.toJPEG(JPEG_QUALITY).toString('base64'), mime: 'image/jpeg' };
}

// ─── 프롬프트 / 스키마 ──────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You extract a book's table of contents from a photograph or scan of its contents page.

Rules:
- Return every entry in the order printed on the page, top to bottom.
- "title" is the entry text WITHOUT the dot leader and WITHOUT the trailing page number. Keep the chapter numbering that is part of the title (e.g. "1장 서론", "1.1 문제 제기", "Chapter 3. Method").
- "level" is the outline depth: 0 for top-level parts/chapters, 1 for sections, 2 for sub-sections. Infer it from indentation and from numbering depth.
- "from" is the printed starting page number as an integer. If the page number is a roman numeral (front matter) or is not printed, use null.
- "to" is the printed ending page number if the page shows a range (e.g. "12-40"); otherwise null. Do not guess it.
- Do NOT include the heading of the contents page itself ("차례", "목차", "Contents", "Table of Contents").
- Do NOT invent entries or page numbers. If a page number is unreadable, use null.
- Preserve the original language and spelling exactly. Do not translate.`;

const USER_PROMPT = 'Extract the table of contents from this page image. Return JSON only.';

const TOC_SCHEMA = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Entry text without dot leader or page number' },
          level: { type: 'integer', description: 'Outline depth: 0, 1, or 2' },
          from: { type: ['integer', 'null'], description: 'Printed starting page, or null' },
          to: { type: ['integer', 'null'], description: 'Printed ending page, or null' }
        },
        required: ['title', 'level']
      }
    }
  },
  required: ['entries']
};

// ─── 응답에서 JSON 뽑기 ─────────────────────────────────────────────────────
/** 모델이 코드펜스나 잡담을 붙여도 견디도록 관대하게 파싱한다. */
function extractJSON(text) {
  if (!text) throw new Error('모델이 빈 응답을 돌려주었습니다.');
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { /* 아래에서 재시도 */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch { /* noop */ }
  }
  throw new Error('모델 응답에서 JSON 을 찾지 못했습니다.');
}

function normalizeEntries(parsed) {
  const list = Array.isArray(parsed?.entries) ? parsed.entries
             : Array.isArray(parsed) ? parsed : [];
  const num = v => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  };
  return list
    .map(e => ({
      title: String(e?.title ?? '').replace(/\s+/g, ' ').trim(),
      level: Math.max(0, Math.min(2, parseInt(e?.level, 10) || 0)),
      from: num(e?.from),
      to: num(e?.to)
    }))
    .filter(e => e.title);
}

async function httpJSON(url, opts, timeout = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const body = await res.text();
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(body);
        msg = j?.error?.message || j?.error?.type || j?.message || msg;
      } catch { if (body) msg += ` — ${body.slice(0, 200)}`; }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return JSON.parse(body);
  } finally { clearTimeout(t); }
}

// ─── provider 별 호출 ───────────────────────────────────────────────────────

// Gemini — Interactions API (v1beta). 구조화 출력을 스키마로 강제할 수 있다.
async function callGemini({ apiKey, model, image }) {
  const data = await httpJSON('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || PROVIDERS.gemini.defaultModel,
      input: [
        { type: 'text', text: SYSTEM_PROMPT + '\n\n' + USER_PROMPT },
        { type: 'image', data: image.data, mime_type: image.mime }
      ],
      response_format: { type: 'text', mime_type: 'application/json', schema: TOC_SCHEMA }
    })
  });

  // 응답은 steps[].content[] 구조. output_text 가 있으면 그걸 우선 쓴다.
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text;
  const texts = [];
  for (const step of (data?.steps || [])) {
    for (const c of (step?.content || [])) {
      if (c?.type === 'text' && typeof c.text === 'string') texts.push(c.text);
    }
  }
  if (!texts.length) throw new Error('Gemini 응답에서 텍스트를 찾지 못했습니다.');
  return texts.join('\n');
}

// Anthropic Claude — Messages API
async function callClaude({ apiKey, model, image }) {
  const data = await httpJSON('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: model || PROVIDERS.claude.defaultModel,
      max_tokens: 16000,
      system: SYSTEM_PROMPT + '\n\nRespond with a single JSON object of the form '
            + '{"entries":[{"title":string,"level":0|1|2,"from":number|null,"to":number|null}]}. '
            + 'Output JSON only — no prose, no code fences.',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } },
          { type: 'text', text: USER_PROMPT }
        ]
      }]
    })
  });
  const text = (data?.content || []).filter(b => b?.type === 'text').map(b => b.text).join('\n');
  if (!text) throw new Error('Claude 응답에서 텍스트를 찾지 못했습니다.');
  return text;
}

// OpenAI 호환 (xAI Grok, OpenAI, OpenRouter, Groq …)
async function callOpenAICompatible({ apiKey, model, image, baseUrl }) {
  const base = (baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('Base URL 을 입력해야 합니다. (예: https://api.x.ai/v1)');
  if (!model) throw new Error('모델 이름을 입력해야 합니다.');
  const data = await httpJSON(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + '\n\nRespond with JSON only: {"entries":[...]}' },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.data}` } },
            { type: 'text', text: USER_PROMPT }
          ]
        }
      ]
    })
  });
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('응답에서 텍스트를 찾지 못했습니다.');
  return text;
}

const CALLERS = { gemini: callGemini, claude: callClaude, openai: callOpenAICompatible };

// ─── 공개 API ───────────────────────────────────────────────────────────────
async function extractTOC(imgPath) {
  const c = readConfig();
  const apiKey = decryptKey(c);
  if (!apiKey) throw new Error('API 키가 설정되지 않았습니다. 설정 화면에서 먼저 등록하세요.');

  const caller = CALLERS[c.provider];
  if (!caller) throw new Error(`알 수 없는 provider: ${c.provider}`);

  const image = await imageToBase64(imgPath);
  const model = c.model || PROVIDERS[c.provider].defaultModel;
  const text = await caller({ apiKey, model, image, baseUrl: c.baseUrl });
  const entries = normalizeEntries(extractJSON(text));
  if (!entries.length) throw new Error('목차 항목을 하나도 찾지 못했습니다. 다른 사진으로 시도해 보세요.');
  return { file: path.basename(imgPath), provider: c.provider, model, entries };
}

/** 아주 작은 이미지로 왕복을 한 번 돌려 키·모델·네트워크를 점검한다. */
async function testConnection() {
  const c = readConfig();
  const apiKey = decryptKey(c);
  if (!apiKey) throw new Error('API 키가 없습니다.');
  const caller = CALLERS[c.provider];
  if (!caller) throw new Error(`알 수 없는 provider: ${c.provider}`);

  // 8x8 흰색 PNG
  const png = nativeImage.createFromBuffer(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8//8/AzGAiShVowoZGBgA' +
    'HBEBBWfHnJEAAAAASUVORK5CYII=', 'base64'));
  const image = { data: png.toJPEG(80).toString('base64'), mime: 'image/jpeg' };
  const model = c.model || PROVIDERS[c.provider].defaultModel;

  const t0 = Date.now();
  await caller({ apiKey, model, image, baseUrl: c.baseUrl });
  return { ok: true, ms: Date.now() - t0, provider: c.provider, model };
}

module.exports = { PROVIDERS, publicConfig, saveConfig, extractTOC, testConnection };
