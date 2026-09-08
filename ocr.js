'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// 목차 이미지 OCR — Windows 내장 엔진(Windows.Media.Ocr) 사용
//
// 추가 설치물이 전혀 없다. Windows 10/11 에 들어 있는 OCR 엔진을 powershell.exe
// 를 통해 호출한다. 스크립트는 파일로 두지 않고 -EncodedCommand 로 넘기는데,
// 패키징하면 소스가 app.asar 안으로 들어가 외부 프로그램이 읽을 수 없기 때문이다.
// ─────────────────────────────────────────────────────────────────────────────

const { app, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

// OCR 엔진이 받는 최대 변 길이. 업스케일이 이걸 넘지 않게 한다.
const MAX_DIM = 10000;
// 이보다 가로가 좁으면 확대한다. 해상도가 인식률에 가장 크게 작용한다.
// 실측(한글 목차 13항목): 1000px 원본 쪽번호 9/13 → 2000px 11/13 → 2500px 12/13.
// 2500px 을 넘으면 더 좋아지지 않고 처리 시간만 는다.
const TARGET_WIDTH = 2600;
const MAX_SCALE = 3;

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * PowerShell 스크립트를 실행하고, 스크립트가 $Out 에 쓴 JSON 을 읽어 돌려준다.
 * stdout 은 콘솔 코드페이지를 타서 한글이 깨지므로 쓰지 않는다.
 */
function runPS(lines, outFile, timeout = 60000) {
  const script = lines.join('\n');
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err) => {
        // PowerShell 은 진행률 스트림을 stderr 로 흘리므로 stderr 자체는 실패 신호가 아니다.
        // 성공 여부는 출력 파일이 생겼는지로 판단한다.
        let raw = null;
        try { raw = fs.readFileSync(outFile, 'utf8'); } catch { /* 아래에서 처리 */ }
        if (!raw) {
          return reject(new Error(err ? `OCR 실행 실패: ${err.message}` : 'OCR 이 결과를 내지 못했습니다.'));
        }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('OCR 결과를 해석하지 못했습니다: ' + e.message)); }
      }
    );
  });
}

const PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  // 진행률 스트림을 끄지 않으면 stderr 가 CLIXML 로 지저분해진다.
  "$ProgressPreference = 'SilentlyContinue'",
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null',
  '$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {',
  "  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and",
  // 아래 줄에 백틱이 있어 템플릿 리터럴 대신 배열로 스크립트를 만든다.
  "  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'",
  '})[0]',
  'function Await($op, $type) {',
  '  $m = $asTaskGeneric.MakeGenericMethod($type)',
  '  $t = $m.Invoke($null, @($op))',
  '  $t.Wait(-1) | Out-Null',
  '  $t.Result',
  '}',
  '[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null'
];

const WRITE_OUT = (outFile) => [
  '$json = $payload | ConvertTo-Json -Depth 6 -Compress',
  `[System.IO.File]::WriteAllText(${psQuote(outFile)}, $json, (New-Object System.Text.UTF8Encoding $false))`
];

function tmpPath(ext) {
  return path.join(app.getPath('temp'), `codex-ocr-${crypto.randomUUID()}${ext}`);
}

// ─── 사용 가능한 인식 언어 ───────────────────────────────────────────────────
let langCache = null;

async function availableLanguages() {
  if (langCache) return langCache;
  const out = tmpPath('.json');
  try {
    const data = await runPS([
      ...PRELUDE,
      '$langs = @()',
      'foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {',
      '  $langs += [pscustomobject]@{ tag = $l.LanguageTag; name = $l.DisplayName }',
      '}',
      '$payload = [pscustomobject]@{ languages = $langs }',
      ...WRITE_OUT(out)
    ], out, 30000);
    langCache = data.languages || [];
    return langCache;
  } finally {
    fsp.unlink(out).catch(() => {});
  }
}

// ─── 이미지 한 장 인식 ───────────────────────────────────────────────────────
/**
 * 필요하면 확대한 뒤 OCR 한다.
 * 저해상도 사진에서 쪽번호가 통째로 누락되는 일이 잦은데, 확대만으로 많이 회복된다.
 */
async function recognizeFile(imgPath, lang) {
  let target = imgPath;
  let tmpImg = null;
  let scaled = 1;

  try {
    const img = nativeImage.createFromPath(imgPath);
    if (img.isEmpty()) {
      throw new Error('이미지를 읽지 못했습니다. PNG · JPG · BMP · WEBP 만 지원합니다. (HEIC 는 지원하지 않습니다)');
    }
    const { width, height } = img.getSize();

    if (width > 0 && width < TARGET_WIDTH) {
      let s = Math.min(MAX_SCALE, TARGET_WIDTH / width);
      s = Math.min(s, MAX_DIM / Math.max(width, height));
      if (s > 1.05) {
        const resized = img.resize({
          width: Math.round(width * s),
          height: Math.round(height * s),
          quality: 'best'
        });
        tmpImg = tmpPath('.png');
        await fsp.writeFile(tmpImg, resized.toPNG());
        target = tmpImg;
        scaled = s;
      }
    } else if (Math.max(width, height) > MAX_DIM) {
      const s = MAX_DIM / Math.max(width, height);
      const resized = img.resize({
        width: Math.round(width * s), height: Math.round(height * s), quality: 'best'
      });
      tmpImg = tmpPath('.png');
      await fsp.writeFile(tmpImg, resized.toPNG());
      target = tmpImg;
      scaled = s;
    }

    const out = tmpPath('.json');
    try {
      const data = await runPS([
        ...PRELUDE,
        `$Path = ${psQuote(target)}`,
        `$Lang = ${psQuote(lang)}`,
        '$file    = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])',
        '$stream  = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
        '$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
        '$bitmap  = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
        '$engine  = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $Lang))',
        'if ($null -eq $engine) { throw "OCR language not available: $Lang" }',
        '$result  = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
        '$lines = @()',
        'foreach ($line in $result.Lines) {',
        '  $words = @()',
        '  foreach ($w in $line.Words) {',
        '    $words += [pscustomobject]@{',
        '      t = $w.Text; x = [int]$w.BoundingRect.X; y = [int]$w.BoundingRect.Y',
        '      w = [int]$w.BoundingRect.Width; h = [int]$w.BoundingRect.Height',
        '    }',
        '  }',
        '  $lines += [pscustomobject]@{ text = $line.Text; words = $words }',
        '}',
        '$payload = [pscustomobject]@{',
        '  imageWidth = [int]$decoder.PixelWidth; imageHeight = [int]$decoder.PixelHeight',
        '  textAngle = $result.TextAngle; lines = $lines',
        '}',
        ...WRITE_OUT(out)
      ], out, 120000);

      return {
        file: path.basename(imgPath),
        imageWidth: data.imageWidth,
        imageHeight: data.imageHeight,
        textAngle: data.textAngle,
        scaled: Math.round(scaled * 100) / 100,
        lines: (data.lines || []).map(l => ({
          text: l.text || '',
          // PowerShell 은 항목이 하나뿐인 배열을 객체로 직렬화한다.
          words: l.words == null ? [] : (Array.isArray(l.words) ? l.words : [l.words])
        }))
      };
    } finally {
      fsp.unlink(out).catch(() => {});
    }
  } finally {
    if (tmpImg) fsp.unlink(tmpImg).catch(() => {});
  }
}

module.exports = { availableLanguages, recognizeFile };
