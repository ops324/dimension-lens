#!/usr/bin/env node
/**
 * 忠実性ラダーの自動実行（`npm run ladder`・Phase 2a）。
 *
 * ## なぜこれが Phase 2 の**最初**の成果物なのか
 *
 * SPEC §7.9 は「この仕組みが見張らないもの」として、ブラウザの読み戻しに依存する主張
 * （G0〜G11 のほとんど、とくに**予算を外している G9**）には自動ゲートが無いと書いている。
 * その正直さは正しいが、**帰結は正直ではなかった** ── G9 は 1b で「予算内 1.5244」と
 * 記録され、1c で「再現しない 4.3228」と分かるまで、2 フェーズのあいだ誰も見ていなかった。
 * `npm test` も `npm run teeth` も、その 2 フェーズずっと緑だった。
 *
 * そして §0.1 の規律 8 は「**『測れない』と書く前に、測る手段が無いことを確かめる**」と言う。
 * 確かめた結果:
 *
 *   - `/Applications/Google Chrome.app` は在る（150.0.7871.188）
 *   - `playwright-core` はシステムの Chrome を `channel: 'chrome'` で駆動でき、
 *     ブラウザのダウンロードを 1 バイトも要求しない
 *   - headless の Chrome で WebGL2 は**実 GPU（ANGLE Metal）**で動き、読み戻しも通る
 *   - `rAF` は headless で 1 回も発火しないが、`__LENS__.renderOnce()` が
 *     Phase 0 から在る（§7.2 が別の理由で作った口が、ここで効いている）
 *
 * → 「自動化は別の仕事」は**限界ではなく、やっていなかっただけ**だった。
 *
 * ## この道具自身に歯を付ける（`--teeth`）
 *
 * **最初の版で、G9 の行に `ok` として `true` をベタ書きしていた。**
 * あのままなら永久に ✅ を報告し続けた ── つまり **G9 を腐らせたのと同じ失敗モードが、
 * それを見張る道具の中で再演されかけた**。手で気づいたから直せたが、
 * 「手で気づく」は §7.9 が仕組みへ置き換えたはずのものである。
 *
 * → `npm run ladder -- --teeth` は、**わざと絵か採点を壊してラダーが赤くなるか**を試す。
 * 壊し方はソースではなく `__LENS__` 越しの注入なので、作業ツリーに触らない
 * （`scripts/teeth.mjs` が `src/` を書き換えるのと役割を分ける）。
 *
 * ## ラスタライザの素性を必ず併記する
 *
 * 監査サブエージェントが、同じページ・同じ手順で `dimLevel = 0` の峰を
 * **133** と **129** の 2 通り測った。前者は playwright 同梱 Chromium の
 * **SwiftShader**（ソフトウェア）、後者はシステム Chrome の **ANGLE Metal**。
 * `data-lens-render` は `"ok"`、コンソールエラー 0、アンカーは厳密一致 ──
 * **どこにも「別のラスタライザだ」とは出ていなかった。**
 * だからこのスクリプトは、すべての数値の隣に UNMASKED_RENDERER を出す。
 *
 * ## CI では ΔE00 の権威にしない
 *
 * GitHub の runner に GPU は無く、測ることになるのは SwiftShader である。
 * そこで通る予算はシステム Chrome では落ちうるし、その逆もある ──
 * つまり CI に置いた ΔE00 ゲートは「緑だが中身が無い」の典型になる。
 * → `--structural` では**構造回帰だけ**を見る（起動・自己検査・コンソール 0・
 * CPU で決まるアンカーの厳密一致）。ΔE00 の判定はローカルの実 GPU でのみ行う。
 *
 * **`--structural` は CI に載せた。** 阻んでいた不確定要素は事実で消えている ──
 * runner イメージ（ubuntu-24.04）に Google Chrome 150.0.7871.128 が在る（`gh api` で確認）。
 * ローカルで SwiftShader を強制して先に確かめてもある（`--use-angle=swiftshader` で
 * 痕跡 5 つとも ok・アンカー厳密一致・コンソール 0）。
 *
 * **そして CI の初回実行が、こちらの想定を 1 つ壊した** ── runner は 4 コアなので
 * `bootTier()` が **BALANCED** を返し、格子が 251×157 になる。
 * 「アンカーは CPU で決まるからラスタライザに依らない」は真だが、
 * **機体に依らないとは言っていなかった**。→ ティアが違う行は `➖`（採点しない）。
 *
 * 使い方:
 *   npm run ladder                   フル（実 GPU・予算判定あり）
 *   npm run ladder -- --teeth        **ラダー自身の歯**（故障を注入して赤くなるか）
 *   npm run ladder -- --structural   構造回帰のみ（CI に載っている）
 *   npm run ladder -- --json         JSON も出す
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const PORT = 5188;
const URL = `http://localhost:${PORT}/`;
/** §7.7 のアンカーはこの drawingBuffer でしか再現しない */
const MEASURE_CSS = { w: 494, h: 389 };
const MEASURE_BUFFER = { width: 988, height: 778 };

/**
 * `anchors.test.ts` が node で厳密に固定している値。**ここに写しを置く理由**:
 * ブラウザ側が同じ数を出すことを確かめるのがこの表の役目で、
 * ブラウザから読んだ値を自分自身と比べても何も分からない（§7.7 の `fillRatios` の教訓）。
 */
const ANCHORS = {
  /**
   * **この表は HIGH ティアの表である**（Phase 2a で判明）。
   *
   * `bootTier()` は `hardwareConcurrency` / `deviceMemory` / DPR を読むので、
   * **ティアは機体で変わる** ── GitHub の runner（4 コア）は **BALANCED** で起動し、
   * 格子は 251×157、`s0` は 3.3851792828685254 になる。
   * 「アンカーは CPU で決まるからラスタライザに依らない」は真だが、
   * **機体に依らないとは言っていなかった**。1 機体でしか測っていなかったので気づかなかった。
   *
   * → ティアが違うときは**採点しない**（`null`）。緑にも赤にもせず、
   * 「採点しなかった」と出す ── 飛ばした行を通過と読ませない。
   * どのティアでも採点できるようにするには `__LENS__` にティアを固定する口が要る（Phase 2c）。
   */
  tier: 'HIGH',
  s0: 2.247830687830687,
  gain: 0.4530724335144705,
  cameraDistance: 1.9635938049105979,
  cascadeDist: 3.38382867097012,
  gridW: 378,
  gridH: 236,
  meanHex: '#8d8d8e',
  fillX: 0.86,
};

/**
 * **注入する故障の一覧 —— ラダーの台帳。**
 *
 * `scripts/teeth.mjs` の台帳が `src/` の行を壊すのに対し、こちらは
 * **絵と採点者を実行時に壊す**。どちらも主張は同じ ──
 * 「守っているはずのものを壊したら、本当に赤くなるか」。
 *
 * `expect` は「少なくともこの ID の行が落ちること」。`npm run teeth` の hard gate が
 * 「少なくとも 1 件」なのに対し、ここは **どの行が気づくべきか**まで書く ──
 * 行数が少ないので特定でき、特定できるなら特定したほうが強い。
 */
const FAULTS = [
  { key: 'bloom', name: 'bloom を入れたまま測る（後処理オフが前提の行）', expect: ['G2a', 'G3'] },
  /**
   * **grade は領域平均では捕まらない。** これは最初 `['G2a','G3','G4']` と書いて外し、
   * 機構に戻して直した ── grain は 1 画素あたり ±`GRADE_GRAIN`/2 = ±0.0075 の**零平均**で、
   * 領域を平均した瞬間に消える。ビネットは `smoothstep(0.55, 1.15, rr)` なので
   * 図の中央（rr が小さい）では厳密に 0、色収差は平坦部で差を生まない。
   * つまり**加算的な画素ごとの摂動を捕まえられるのは、予算が「厳密 0」の行だけ**である。
   * → G0（背景）。1 点しかない G9 も平均が効かないので落ちる。
   */
  { key: 'grade', name: 'grade を入れたまま測る', expect: ['G0'] },
  { key: 'viewport', name: '測定 viewport を 400×315 にする（アンカーが動く）', expect: ['ENV'] },
  { key: 'nophase', name: 'G9 で位相を割らない（1c までの読み方）', expect: ['G9'] },
  { key: 'wrongdim', name: 'G9 を d=0.5 で測る（別の状態を平均色として採点）', expect: ['G9'] },
  { key: 'flattarget', name: '目標を定数グレー 128 に取り違える', expect: ['G3', 'G4'] },
  { key: 'nocollapse', name: '`setPath` を効かなくする（板を 2 回測って雲と呼ぶ）', expect: ['G2c'] },
];

const args = process.argv.slice(2);
const STRUCTURAL = args.includes('--structural');
const AS_JSON = args.includes('--json');
const TEETH = args.includes('--teeth');

let rows = [];
let failures = 0;

/** `ok === null` は「採点しない」。**通過にも失敗にも数えない** */
function record(id, what, budget, measured, ok, note = '') {
  rows.push({ id, what, budget, measured, ok, note });
  if (ok === false) failures++;
}

function startDev() {
  const child = spawn(
    'npx',
    ['vite', '--port', String(PORT), '--strictPort', '--clearScreen', 'false'],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('vite が 30 秒以内に起動しなかった')), 30_000);
    const onData = (b) => {
      if (/ready in|Local:/i.test(String(b))) {
        clearTimeout(t);
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
  });
}

async function main() {
  const dev = await startDev();
  let browser;
  let exitCode = 0;
  try {
    // **システムの Chrome を使う。** 同梱 Chromium は SwiftShader に落ちることがあり、
    // そのとき数値は変わるのに、どの痕跡も「ok」のままである。
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({
      deviceScaleFactor: 2,
      viewport: { width: 640, height: 520 },
    });
    const page = await context.newPage();

    const consoleErrors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));

    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(
      () => document.documentElement.dataset.lensRender === 'ok', null, { timeout: 30_000 },
    );

    const gl = await page.evaluate(() => window.__LENS__.glInfo());

    if (TEETH) {
      exitCode = await runTeeth(page, gl);
    } else {
      const buffer = await runOnce(page, context, {}, consoleErrors);
      report(gl, buffer);
      exitCode = failures > 0 ? 1 : 0;
    }
  } finally {
    await browser?.close();
    dev.kill('SIGTERM');
    await sleep(200);
  }
  process.exit(exitCode);
}

/** 1 回ぶんの測定と採点。`fault` を渡すと絵か採点者が壊れる */
async function runOnce(page, context, fault, consoleErrors) {
  const traces = await page.evaluate(() => ({ ...document.documentElement.dataset }));
  const buffer = await page.evaluate(
    ([w, h, f]) => window.__LENS__.setViewport(f.viewport ? 400 : w, f.viewport ? 315 : h),
    [MEASURE_CSS.w, MEASURE_CSS.h, fault],
  );

  record('ENV', 'drawingBuffer', `${MEASURE_BUFFER.width}×${MEASURE_BUFFER.height}`,
    `${buffer.width}×${buffer.height}`,
    buffer.width === MEASURE_BUFFER.width && buffer.height === MEASURE_BUFFER.height);
  record('ENV', '読み戻しの自己検査', 'ok', traces.lensCapture ?? '(なし)',
    traces.lensCapture === 'ok');
  record('ENV', 'HDR 読み戻しの自己検査', 'ok', traces.lensCaptureHdr ?? '(なし)',
    traces.lensCaptureHdr === 'ok');
  record('ENV', '取り込み', 'ok', traces.lensIngest ?? '(なし)', traces.lensIngest === 'ok');
  record('ENV', '描画', 'ok', traces.lensRender ?? '(なし)', traces.lensRender === 'ok');

  const anchors = await page.evaluate(() => {
    const L = window.__LENS__;
    L.setDimLevel(2); L.freezeRotation(true); L.resetRotation();
    L.setBloom(false); L.setGrade(false); L.setCompress(false);
    L.renderOnce(2);
    const s = L.sceneStats(); const st = L.stats();
    return {
      s0: s.s0, gain: s.gain, cameraDistance: s.cameraDistance, cascadeDist: s.cascadeDist,
      gridW: s.gridW, gridH: s.gridH, fillX: s.fill.x, meanHex: st.meanHex,
      sampleWeight: s.sampleWeight, tier: st.tier,
    };
  });
  // ティアに依らない行と、格子（＝ティア）で決まる行を分ける
  const tierMatch = anchors.tier === ANCHORS.tier;
  record('ENV', 'ティア', `${ANCHORS.tier}（アンカー表のティア）`,
    `${anchors.tier}（格子 ${anchors.gridW}×${anchors.gridH}）`, tierMatch ? true : null,
    tierMatch ? '' : 'ティアが違うので、格子に依存する行は採点しない');
  for (const k of ['cameraDistance', 'fillX']) {
    record('ENV', `アンカー ${k}（ティアに依らない）`, String(ANCHORS[k]), String(anchors[k]),
      Object.is(anchors[k], ANCHORS[k]), 'Object.is');
  }
  for (const k of ['s0', 'gain', 'cascadeDist', 'gridW', 'gridH']) {
    record('ENV', `アンカー ${k}（ティア依存）`, String(ANCHORS[k]), String(anchors[k]),
      tierMatch ? Object.is(anchors[k], ANCHORS[k]) : null, tierMatch ? 'Object.is' : '');
  }
  record('ENV', 'アンカー meanHex', ANCHORS.meanHex, anchors.meanHex,
    anchors.meanHex === ANCHORS.meanHex);
  // **ティアに依らず厳密 1 でなければならない**（Phase 2a で構造にした）。
  // CI が BALANCED で 0.9999999999999996 を出したのが、この行が在る理由である。
  record('G7', 'sampleWeight (d=2)', '厳密に 1（全ティア）', String(anchors.sampleWeight),
    Object.is(anchors.sampleWeight, 1), 'Object.is');

  if (!STRUCTURAL) {
    const raw = await page.evaluate(measureInPage, fault);
    score(raw, fault);
    ladderRaw = raw;
    if (!fault.quick) await measureZeroPhase(context);
  }

  if (consoleErrors) {
    record('ENV', 'コンソールエラー', '0', String(consoleErrors.length),
      consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  }
  return buffer;
}

/**
 * **ラダー自身の歯。** 故障を 1 つずつ注入して、赤くなるかを確かめる。
 *
 * hard gate は 2 つ:
 *   1. **素の状態で全行が緑**（そうでなければ以降の赤は故障のせいだと言えない）
 *   2. **各故障で、期待した ID の行が実際に落ちる**
 *
 * 2 が「1 件でも落ちる」ではなく「**その ID が**落ちる」なのは、行数が少なくて
 * 特定できるからである。特定できるなら特定したほうが強い ── そうしないと
 * 「たまたま別の行が落ちていた」を成功と読む余地が残る。
 */
async function runTeeth(page, gl) {
  const log = [];
  console.log('');
  console.log('  ラダーの歯の確認');
  console.log(`  ラスタライザ : ${gl.renderer}`);
  console.log('');

  rows = []; failures = 0;
  await runOnce(page, null, { quick: true }, null);
  const baseOk = failures === 0;
  console.log(`  素の状態: ${baseOk ? '緑 ✅' : `赤 ❌（${failures} 行）`}`);
  if (!baseOk) {
    for (const r of rows.filter((x) => !x.ok)) console.log(`    ❌ ${r.id} ${r.what} → ${r.measured}`);
    console.log('\n  素の状態が緑でないので、故障注入の結果は解釈できない。');
    return 1;
  }
  console.log('');

  let bitten = 0;
  for (const f of FAULTS) {
    rows = []; failures = 0;
    await runOnce(page, null, { [f.key]: true, quick: true }, null);
    const failedIds = new Set(rows.filter((r) => !r.ok).map((r) => r.id));
    const hit = f.expect.filter((id) => failedIds.has(id));
    const ok = hit.length > 0;
    if (ok) bitten++;
    log.push({ ...f, ok, failedIds: [...failedIds] });
    console.log(`  ${ok ? '✅' : '❌'} ${f.name}`);
    console.log(`     期待 ${f.expect.join('/')} → 落ちた行 ${[...failedIds].join('/') || '（無し）'}`);
  }

  // 後片付け: viewport を測定用へ戻す（次に走らせる人のため）
  await page.evaluate(([w, h]) => window.__LENS__.setViewport(w, h), [MEASURE_CSS.w, MEASURE_CSS.h]);

  console.log('');
  console.log(`  合計 ${FAULTS.length} / 噛んだ ${bitten} / **抜けた ${FAULTS.length - bitten}**`);
  if (bitten < FAULTS.length) {
    console.log('');
    console.log('  抜けた歯がある。**ラダーがその故障を見ていない** ──');
    console.log('  G9 を 2 フェーズ腐らせたのと同じ形が、見張る道具の中に在る。');
  }
  if (AS_JSON) console.log('\nJSON\n' + JSON.stringify({ gl, log }, null, 2));
  return bitten === FAULTS.length ? 0 : 1;
}

/** ページ内で走る測定本体。**`fault` はここで絵と採点者に効く** */
async function measureInPage(fault) {
  const L = window.__LENS__;
  const { deltaE2000Linear } = await import('/src/color/deltaE.ts');
  const { primariesFor, linearToOklab } = await import('/src/color/oklab.ts');
  const { srgbToLinear, linearToCode } = await import('/src/color/srgb.ts');
  const { spritePhaseFactor, centreFragmentOffset } = await import('/src/image/spriteGain.ts');
  const { makeSpecimen0, REGIONS, RAMP_CODES } = await import('/src/image/fixture.ts');
  const P = primariesFor('srgb');
  const dE = (a, b) => deltaE2000Linear(P, a, b);
  const lin = (v) => srgbToLinear(v / 255);
  const spec = makeSpecimen0();
  const W = spec.width, H = spec.height;

  const setup = (d, path) => {
    L.setBloom(!!fault.bloom); L.setGrade(!!fault.grade); L.setCompress(false);
    L.setPath(fault.nocollapse ? 'auto' : (path ?? 'auto'));
    L.setDimLevel(d); L.freezeRotation(true); L.resetRotation(); L.renderOnce(3);
  };
  /**
   * 実際の drawingBuffer。**要求値ではなく canvas から読む** ──
   * 故障 `viewport` のときは 800×630 になるので、要求値を使うと
   * 「読む座標だけ正しいつもり」になって、故障が見えなくなる。
   */
  const canvas = document.querySelector('canvas');
  const BUF = { w: canvas.width, h: canvas.height };

  const px = async (x, y, w, h) => L.readback(x, y, w, h);
  const meanOf = async (x, y, w, h) => {
    const p = await px(x, y, w, h);
    let a = 0, b = 0, c = 0;
    const n = (p.length / 4) | 0;
    for (let i = 0; i < n; i++) { a += lin(p[i * 4]); b += lin(p[i * 4 + 1]); c += lin(p[i * 4 + 2]); }
    return [a / n, b / n, c / n];
  };
  const toBuf = (ix, iy, fill) => ({
    x: (((2 * (ix / W) - 1) * fill.x + 1) / 2) * BUF.w,
    y: (((1 - 2 * (iy / H)) * fill.y + 1) / 2) * BUF.h,
  });
  /**
   * 領域の内側を平均する。`inset` は領域の何割を取るか。
   *
   * **既定の中央 30% では G3 が測れない** ── `REGIONS.markers` の 4 個
   * （(0,0)/(32,0)/(64,0)/(0,32)、各 32×32）は `REGIONS.ramp`（0,0,1024,80）の
   * **第 1 段の上に重ねて描かれている**。中央窓はそこへ食い込み、黒 0 のはずの段が
   * 108 として返る（この行を足した初回の実測）。
   * §7.7 の「標本の 1px 黒枠は背景と同色なので基準点として機能しない」と同じ型で、
   * **標本の領域設計が推定器の窓を制約している**。ランプはマーカーの下端（y = 64）より
   * 下だけを見る。
   */
  const regionMean = async (reg, fill, inset) => {
    const q = inset ?? { x0: 0.35, x1: 0.65, y0: 0.35, y1: 0.65 };
    const a = toBuf(reg.x + reg.w * q.x0, reg.y + reg.h * q.y1, fill);
    const b = toBuf(reg.x + reg.w * q.x1, reg.y + reg.h * q.y0, fill);
    const x0 = Math.round(Math.min(a.x, b.x)), y0 = Math.round(Math.min(a.y, b.y));
    return meanOf(x0, y0, Math.max(2, Math.round(Math.abs(b.x - a.x))),
      Math.max(2, Math.round(Math.abs(b.y - a.y))));
  };
  /** 標本の画素からその領域の真値を取る。**故障 `flattarget` はここを定数へ差し替える** */
  const truthAt = (ix, iy) => {
    if (fault.flattarget) return [lin(128), lin(128), lin(128)];
    const o = ((iy | 0) * W + (ix | 0)) * 4;
    return [lin(spec.rgba[o]), lin(spec.rgba[o + 1]), lin(spec.rgba[o + 2])];
  };

  const out = {};

  // ---------- G0: 板の外側は厳密に 0
  setup(2, 'plate');
  const s2 = L.sceneStats();
  const fill = s2.fill;
  const corners = [];
  for (const [x, y] of [[0, 0], [BUF.w - 1, 0], [0, BUF.h - 1], [BUF.w - 1, BUF.h - 1]]) {
    const p = await px(x, y, 1, 1);
    corners.push([p[0], p[1], p[2]]);
  }
  out.G0 = { corners, ok: corners.every((c) => c[0] === 0 && c[1] === 0 && c[2] === 0) };

  // ---------- G1: アスペクト・充填・基準点の重心
  out.G1 = { aspect: s2.gridW / s2.gridH, fill, markers: [] };
  for (const m of REGIONS.markers) {
    const c = toBuf(m.x + m.w / 2, m.y + m.h / 2, fill);
    const half = 14;
    const x0 = Math.round(c.x - half), y0 = Math.round(c.y - half);
    const p = await px(x0, y0, half * 2, half * 2);
    // 白マーカーの重心（明るさで重み付け）。窓は白領域の広がりに合わせる（§7.6 の教訓）
    let sw = 0, sx = 0, sy = 0;
    for (let j = 0; j < half * 2; j++) {
      for (let i = 0; i < half * 2; i++) {
        const w = lin(p[(j * half * 2 + i) * 4]);
        if (w < 0.5) continue; // 背景グレー(0.216)と白(1.0)の中間で切る
        sw += w; sx += w * (x0 + i + 0.5); sy += w * (y0 + j + 0.5);
      }
    }
    out.G1.markers.push(sw > 0
      ? { err: Math.hypot(sx / sw - c.x, sy / sw - c.y), weight: sw }
      : { err: Infinity, weight: 0 });
  }

  // ---------- G2a / G2b / G3 / G4
  const flat = REGIONS.flat;
  /**
   * **2 つの経路が本当に別の画素であることを確かめるための控え。**
   *
   * `setPath` が効かなくなると、板経路と雲経路の測定が**同じ絵を 2 回測る**ことになり、
   * ΔE00 はどちらも通ってしまう ── ラダー自身の歯（故障 `nocollapse`）で実際に抜けた。
   * §7.2 の「板経路と雲経路で別のゲートを持たない」は**両方を測っていること**が前提で、
   * その前提はこれまでどこでも確かめていなかった。
   */
  const pathSample = {};
  for (const path of ['plate', 'cloud']) {
    setup(2, path);
    const f2 = L.sceneStats().fill;
    pathSample[path] = await px(
      Math.round(BUF.w / 2) - 32, Math.round(BUF.h / 2) - 32, 64, 64,
    );
    const m = await regionMean(flat, f2);
    const t = truthAt(flat.x + flat.w / 2, flat.y + flat.h / 2);
    out['G2a_' + path] = { deltaE: dE(m, t), code: m.map(linearToCode) };
    if (path === 'cloud') out.G2b = { errPct: 100 * (m[1] / t[1] - 1) };

    // G3: グレーランプ 8 段（トーン応答と単調性）
    const R = REGIONS.ramp;
    /**
     * ランプの窓は**スプライトの半径から導く**（手で詰めない）。
     *
     * ランプ帯 y ∈ [0, 80] のうち、上は `REGIONS.markers` の 4 個（y ≤ 64）に潰され、
     * 下は `REGIONS.wheel`（y ≥ 80）が接している。雲経路のスプライトは
     * `discard` 半径 `S/2` device px まで光を運ぶので、**その半径ぶん両側から退かないと
     * 隣の領域の光を測ることになる** ── 実測でこれを踏み、黒の段（真値 0）が
     * **6** として返り、ΔE00 が黒付近で増幅されて 2.77 になった。
     *
     * 窓を答えが通るまで詰めるのは §7.6 の「推定器の感度が予算より大きいなら
     * それは予算ではない」を裏返しにやることなので、**半径から計算する**。
     * 計算した窓が空になったら、その経路では**測れない**と報告する（黙って通さない）。
     */
    const pxPerImage = (BUF.w * f2.x) / W;
    const radImage = L.sceneStats().spritePx / 2 / pxPerImage;
    const yLo = 64 + radImage;
    const yHi = R.y + R.h - radImage;
    const measurable = yHi - yLo > 1;
    const RAMP_INSET = {
      x0: 0.35, x1: 0.65,
      y0: (yLo - R.y) / R.h, y1: (yHi - R.y) / R.h,
    };
    const steps = [];
    for (let i = 0; i < 8; i++) {
      const reg = { x: R.x + i * 128, y: R.y, w: 128, h: R.h };
      const mm = await regionMean(reg, f2, RAMP_INSET);
      const ty = Math.round((yLo + yHi) / 2);
      steps.push({ code: RAMP_CODES[i], measured: mm, deltaE: dE(mm, truthAt(reg.x + 64, ty)) });
    }
    let monotone = true;
    for (let i = 1; i < steps.length; i++) if (!(steps[i].measured[1] > steps[i - 1].measured[1])) monotone = false;
    out['G3_' + path] = {
      worstDeltaE: Math.max(...steps.map((s) => s.deltaE)), monotone, measurable,
      window: [Math.round(yLo * 10) / 10, Math.round(yHi * 10) / 10],
      radImage: Math.round(radImage * 100) / 100,
      codes: steps.map((s) => linearToCode(s.measured[1])),
    };

    // G4: 彩度ホイール 24 パッチ
    const patchW = Math.floor(REGIONS.wheel.w / 12), patchH = Math.floor(REGIONS.wheel.h / 2);
    let worst = 0; const hueRes = [];
    const labM = new Float64Array(3), labT = new Float64Array(3);
    for (let row = 0; row < 2; row++) {
      for (let k = 0; k < 12; k++) {
        const reg = {
          x: REGIONS.wheel.x + k * patchW, y: REGIONS.wheel.y + row * patchH,
          w: patchW, h: patchH,
        };
        const mm = await regionMean(reg, f2);
        const t2 = truthAt(reg.x + (patchW >> 1), reg.y + (patchH >> 1));
        worst = Math.max(worst, dE(mm, t2));
        linearToOklab(P, mm[0], mm[1], mm[2], labM);
        linearToOklab(P, t2[0], t2[1], t2[2], labT);
        let dh = Math.atan2(labM[2], labM[1]) - Math.atan2(labT[2], labT[1]);
        while (dh > Math.PI) dh -= 2 * Math.PI;
        while (dh < -Math.PI) dh += 2 * Math.PI;
        hueRes.push((dh * 180) / Math.PI);
      }
    }
    const mean = hueRes.reduce((a, b) => a + b, 0) / hueRes.length;
    out['G4_' + path] = {
      worstDeltaE: worst, meanHueDeg: mean,
      sdHueDeg: Math.sqrt(hueRes.reduce((a, b) => a + (b - mean) ** 2, 0) / hueRes.length),
    };
  }

  {
    const a = pathSample.plate, b = pathSample.cloud;
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    out.G2c = { diffBytes: diff, totalBytes: a.length };
  }

  // ---------- G5: 板の拡大補間がリニア光か（専用プローブ）
  setup(2, 'plate');
  const t5 = L.sampleTexel(REGIONS.checker.x + 2, REGIONS.checker.y + 1);
  out.G5 = t5 ? { code: linearToCode(t5.rgb[0] / 255), raw: t5.rgb[0], glError: t5.glError } : null;

  // ---------- G6: 後処理の非混入（オフで再現・オンで差・compress は恒等）
  {
    setup(2, 'plate');
    const win = [Math.round(BUF.w / 2) - 64, Math.round(BUF.h / 2) - 64, 128, 128];
    const a = await px(...win);
    L.renderOnce(3);
    const b = await px(...win);
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;

    // compress を入れる。強度 0 なので**画素まで恒等**でなければならない
    L.setCompress(true); L.renderOnce(3);
    const c = await px(...win);
    let compressIdentical = true; let diffBytes = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== c[i]) { compressIdentical = false; diffBytes++; }
    L.setCompress(false);

    // bloom を入れる。**差が出なければ G6 の後半は何も主張していない**
    L.setBloom(true); L.renderOnce(3);
    const d2 = await px(...win);
    const meanOfBuf = (p) => {
      let r = 0, g = 0, bl = 0; const n = (p.length / 4) | 0;
      for (let i = 0; i < n; i++) { r += lin(p[i * 4]); g += lin(p[i * 4 + 1]); bl += lin(p[i * 4 + 2]); }
      return [r / n, g / n, bl / n];
    };
    const bloomDelta = dE(meanOfBuf(d2), meanOfBuf(a));
    L.setBloom(!!fault.bloom);
    out.G6 = { repeatable: same, compressIdentical, compressDiffBytes: diffBytes,
      totalBytes: a.length, bloomDelta };
  }

  // ---------- 潰しの行の**独立な採点者**（標本の画素から作り直す）
  const colMean = (() => {
    const o2 = new Float64Array(W * 3);
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let y = 0; y < H; y++) {
        const o = (y * W + x) * 4;
        r += lin(spec.rgba[o]); g += lin(spec.rgba[o + 1]); b += lin(spec.rgba[o + 2]);
      }
      o2[x * 3] = r / H; o2[x * 3 + 1] = g / H; o2[x * 3 + 2] = b / H;
    }
    return o2;
  })();
  const bandMean = (i, n) => {
    const x0 = ((i * W) / n) | 0, x1 = (((i + 1) * W) / n) | 0;
    let r = 0, g = 0, b = 0, k = 0;
    for (let x = x0; x < x1; x++) { r += colMean[x * 3]; g += colMean[x * 3 + 1]; b += colMean[x * 3 + 2]; k++; }
    return k ? [r / k, g / k, b / k] : [0, 0, 0];
  };
  const centreTarget = (n) => {
    if (fault.flattarget) return [lin(128), lin(128), lin(128)];
    if (n <= 1) {
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < W; i++) { r += colMean[i * 3]; g += colMean[i * 3 + 1]; b += colMean[i * 3 + 2]; }
      return [r / W, g / W, b / W];
    }
    const lo = Math.floor((n - 1) / 2), hi = Math.ceil((n - 1) / 2);
    const a = bandMean(lo, n), b2 = bandMean(hi, n);
    return [0, 1, 2].map((c) => (a[c] + b2[c]) / 2);
  };

  const collapse = {};
  for (const d of [1, 0.5, 0]) {
    // 故障 `wrongdim`: 平均色の行を別の状態で測る
    const dim = fault.wrongdim && d === 0 ? 0.5 : d;
    setup(dim, 'auto');
    const s = L.sceneStats();
    const off = centreFragmentOffset(BUF.w, BUF.h);
    const p = await px(Math.floor(BUF.w / 2) - 1, Math.floor(BUF.h / 2) - 1, 2, 2);
    const quad = [];
    for (let i = 0; i < 4; i++) quad.push([p[i * 4], p[i * 4 + 1], p[i * 4 + 2]]);
    const rowSpread = Math.abs((quad[0][0] + quad[1][0]) / 2 - (quad[2][0] + quad[3][0]) / 2);
    const ox = s.linePoints <= 1 ? off.x : 0;
    // 故障 `nophase`: 1c までの読み方（位相を割らない）へ戻す
    const phase = fault.nophase ? 1 : spritePhaseFactor(ox, off.y, s.spritePx);
    const meas = [0, 1, 2].map((c) => quad.reduce((a, q) => a + lin(q[c]), 0) / 4);
    const recon = meas.map((v) => v / phase);
    const target = centreTarget(d === 0 ? 1 : s.linePoints);
    collapse['d' + d] = {
      buffer: s.buffer, linePoints: s.linePoints, depth: s.additionDepth,
      spritePx: s.spritePx, rowSpread, phase,
      measuredCode: meas.map(linearToCode), reconCode: recon.map(linearToCode),
      targetCode: target.map(linearToCode), deltaE: dE(recon, target),
      levelPct: 100 * (recon[1] / target[1] - 1),
    };
  }
  out.collapse = collapse;

  // ---------- G10: 加算深度
  const depths = [];
  for (let d = 0; d <= 5; d += 0.25) { setup(d, 'auto'); depths.push([d, L.sceneStats().additionDepth]); }
  out.G10 = { max: Math.max(...depths.map((x) => x[1])) };

  // ---------- G11: 帯からのはみ出しと近平面の余裕
  if (!fault.quick) {
    L.freezeRotation(false);
    let maxFill = 0, minMargin = Infinity;
    for (let d = 0; d <= 5; d += 0.5) {
      L.setDimLevel(d); L.resetRotation();
      for (let step = 0; step < 20; step++) {
        L.renderOnce(6);
        const s = L.sceneStats();
        maxFill = Math.max(maxFill, s.fill.x, s.fill.y);
        minMargin = Math.min(minMargin, s.cameraDistance - s.spread.zHi);
      }
    }
    out.G11 = { maxFill, minMargin };
    L.freezeRotation(true);
  }

  // ---------- G1 の二面体 8 変換（**別インスタンスの絵と区別がつくか**）
  if (!fault.quick) {
    const sig = async () => {
      setup(2, 'plate');
      const f3 = L.sceneStats().fill;
      const v = [];
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          v.push(...(await regionMean(
            { x: (i * W) / 4, y: (j * H) / 4, w: W / 4, h: H / 4 }, f3,
          )).map((x) => Math.round(x * 1000)));
        }
      }
      return v;
    };
    const draw = (t) => new Promise((res) => {
      const cv = document.createElement('canvas');
      const swap = t.rot % 2 === 1;
      cv.width = swap ? H : W; cv.height = swap ? W : H;
      const g = cv.getContext('2d');
      const src = document.createElement('canvas');
      src.width = W; src.height = H;
      src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(spec.rgba), W, H), 0, 0);
      g.translate(cv.width / 2, cv.height / 2);
      g.rotate((t.rot * Math.PI) / 2);
      if (t.flip) g.scale(-1, 1);
      g.drawImage(src, -W / 2, -H / 2);
      cv.toBlob((b) => res(b), 'image/png');
    });
    const sigs = [];
    for (let rot = 0; rot < 4; rot++) {
      for (const flip of [false, true]) {
        await L.ingestBlob(await draw({ rot, flip }));
        sigs.push({ rot, flip, sig: await sig() });
      }
    }
    let distinct = 0, pairs = 0;
    for (let i = 0; i < sigs.length; i++) {
      for (let j = i + 1; j < sigs.length; j++) {
        pairs++;
        if (sigs[i].sig.some((v, k) => v !== sigs[j].sig[k])) distinct++;
      }
    }
    out.G1d = { pairs, distinct };
    // 標本 No.0 へ戻す（以降の測定のため）
    await L.ingestBlob(await draw({ rot: 0, flip: false }));
  }

  return out;
}

/** 生の測定から行を作る。**採点はここに集約する**（`enabledPasses()` のような自己参照を作らない） */
function score(r, fault) {
  record('G0', '背景（四隅）', '厳密 0', JSON.stringify(r.G0.corners[0]), r.G0.ok);
  record('G1', 'アスペクト（格子）', '1.6017（378/236）', r.G1.aspect.toFixed(4),
    Math.abs(r.G1.aspect - 378 / 236) < 1e-9);
  record('G1', '充填（一辺に接する）', 'fill.x = 0.86', r.G1.fill.x.toFixed(4),
    Math.abs(r.G1.fill.x - 0.86) < 1e-9);
  const worstMarker = Math.max(...r.G1.markers.map((m) => m.err));
  record('G1', '基準点の重心誤差（白マーカー 5 個）', '≤ 2 device px', worstMarker.toFixed(3),
    worstMarker <= 2, r.G1.markers.map((m) => m.err.toFixed(2)).join(' / '));
  if (r.G1d) {
    record('G1', '二面体 8 変換で区別がつく', `${r.G1d.pairs}/${r.G1d.pairs} 対で相違`,
      `${r.G1d.distinct}/${r.G1d.pairs}`, r.G1d.distinct === r.G1d.pairs);
  }
  for (const path of ['plate', 'cloud']) {
    record('G2a', `平坦部（${path}）`, 'ΔE00 ≤ 2.0', r['G2a_' + path].deltaE.toFixed(4),
      r['G2a_' + path].deltaE <= 2.0);
    const g3 = r['G3_' + path];
    record('G3', `ランプ 8 段（${path}）`, 'ΔE00 ≤ 2.0',
      g3.measurable ? g3.worstDeltaE.toFixed(4) : '測れない（窓が空）',
      g3.measurable && g3.worstDeltaE <= 2.0,
      `codes ${g3.codes.join(',')} / 窓 y∈[${g3.window[0]},${g3.window[1]}] / スプライト半径 ${g3.radImage} 画像px`);
    record('G3', `ランプの単調性（${path}）`, '厳密に単調増加', String(g3.monotone), g3.monotone);
    const g4 = r['G4_' + path];
    record('G4', `ホイール 24（${path}）`, 'ΔE00 ≤ 2.0', g4.worstDeltaE.toFixed(4),
      g4.worstDeltaE <= 2.0);
    record('G4', `平均色相残差（${path}）`, '≤ 0.5°',
      `${g4.meanHueDeg.toFixed(4)}° (sd ${g4.sdHueDeg.toFixed(3)}°)`,
      Math.abs(g4.meanHueDeg) <= 0.5);
  }
  record('G2c', '板経路と雲経路が別の画素である', '> 0 バイト相違',
    `${r.G2c.diffBytes} / ${r.G2c.totalBytes} バイト`, r.G2c.diffBytes > 0,
    '同じ絵を 2 回測って 2 つのゲートと呼んでいないか');
  record('G2b', '実効ゲイン（雲）', '±2%', `${r.G2b.errPct.toFixed(3)}%`,
    Math.abs(r.G2b.errPct) <= 2);
  if (r.G5) {
    record('G5', '板の拡大補間', 'sRGB 188', String(r.G5.code),
      Math.abs(r.G5.code - 188) <= 1, `生値 ${r.G5.raw}`);
  }
  record('G6', 'オフで再現する（同じ画素）', '画素一致', String(r.G6.repeatable), r.G6.repeatable);
  record('G6', 'CompressPass の恒等性（強度 0）', `0 / ${r.G6.totalBytes} バイト相違`,
    `${r.G6.compressDiffBytes} バイト`, r.G6.compressIdentical);
  record('G6', 'オンにすると差が出る（bloom）', 'ΔE00 > 0', r.G6.bloomDelta.toFixed(4),
    r.G6.bloomDelta > 0);

  const c = r.collapse;
  const collapseRow = (id, key, label, budget) => {
    const g = c[key];
    const premise = g.rowSpread <= 1;
    record(id, `${label}: 位相モデルの前提（上下 2 行の一致）`, '≤ 1 コード',
      String(g.rowSpread), premise);
    record(id, `${label}（再構成した中心値）`, `ΔE00 ≤ ${budget}`, g.deltaE.toFixed(4),
      premise && g.deltaE <= budget,
      `生 ${g.measuredCode.join(',')} → ${g.reconCode.join(',')} / 目標 ${g.targetCode.join(',')}`
      + ` / 位相 ${g.phase.toFixed(6)} / 水準 ${g.levelPct.toFixed(2)}%`
      + ` / 深度 ${g.depth} / 点 ${g.linePoints}`);
  };
  collapseRow('G8a', 'd1', 'd=1 列平均線', 2.0);
  collapseRow('G8b', 'd0.5', 'd=0.5 線', 2.0);
  collapseRow('G9', 'd0', 'd=0 平均色', 3.0);
  record('G10', '加算深度（全 dimLevel）', 'n ≤ 512', String(r.G10.max), r.G10.max <= 512);
  if (r.G11) {
    record('G11a', '帯からのはみ出し', '≤ 1.00', r.G11.maxFill.toFixed(4), r.G11.maxFill <= 1.0);
    record('G11b', '近平面の余裕', '≥ 0.25 world', r.G11.minMargin.toFixed(4),
      r.G11.minMargin >= 0.25);
  }
  void fault;
}

/**
 * **モデルを通さずに G9 を測る**（G9z）。
 *
 * G8/G9 の再構成は `spritePhaseFactor` で割る ── つまり**採点者がモデルを含んでいる**。
 * この作品の失敗史（`reconstructMean` / `fillRatios`）はどれもその形なので、
 * モデルの要らない構成を 1 つ作って同じ主張を確かめる。
 *
 * 位相は `|中心 − 最近傍フラグメント中心|` で決まり、中心は drawingBuffer の
 * ちょうど真ん中にある。**寸法が奇数なら中心は画素中心そのもの**で、位相は厳密に 1 になる。
 * DPR 2 では `2 × 整数` が必ず偶数なので作れないが、**DPR 1.5 なら作れる**:
 * `1.5 × 494 = 741`、`1.5 × 390 = 585` ── どちらも奇数。
 */
async function measureZeroPhase(context) {
  const page = await context.newPage();
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 640, height: 520, deviceScaleFactor: 1.5, mobile: false,
    });
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(
      () => document.documentElement.dataset.lensRender === 'ok', null, { timeout: 30_000 },
    );
    const r = await page.evaluate(async () => {
      const L = window.__LENS__;
      const { deltaE2000Linear } = await import('/src/color/deltaE.ts');
      const { primariesFor } = await import('/src/color/oklab.ts');
      const { srgbToLinear, linearToCode } = await import('/src/color/srgb.ts');
      const { centreFragmentOffset } = await import('/src/image/spriteGain.ts');
      const { makeSpecimen0 } = await import('/src/image/fixture.ts');
      const P = primariesFor('srgb');
      const buf = L.setViewport(494, 390);
      L.setBloom(false); L.setGrade(false); L.setCompress(false);
      L.setDimLevel(0); L.freezeRotation(true); L.resetRotation(); L.renderOnce(3);
      const s = L.sceneStats();
      const off = centreFragmentOffset(buf.width, buf.height);
      const cx = Math.floor(buf.width / 2), cy = Math.floor(buf.height / 2);
      const p = await L.readback(cx - 1, cy - 1, 3, 3);
      const at = (i, j) => [p[(j * 3 + i) * 4], p[(j * 3 + i) * 4 + 1], p[(j * 3 + i) * 4 + 2]];
      const centre = at(1, 1);
      let uniqueMax = true;
      for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 3; i++) {
          if ((i !== 1 || j !== 1) && at(i, j)[0] >= centre[0]) uniqueMax = false;
        }
      }
      const spec = makeSpecimen0();
      let r0 = 0, g0 = 0, b0 = 0;
      const n = spec.width * spec.height;
      for (let k = 0; k < n; k++) {
        r0 += srgbToLinear(spec.rgba[k * 4] / 255);
        g0 += srgbToLinear(spec.rgba[k * 4 + 1] / 255);
        b0 += srgbToLinear(spec.rgba[k * 4 + 2] / 255);
      }
      const target = [r0 / n, g0 / n, b0 / n];
      const meas = centre.map((v) => srgbToLinear(v / 255));
      return {
        buffer: buf, offset: off, spritePx: s.spritePx, depth: s.additionDepth,
        uniqueMax, measCode: meas.map(linearToCode), targetCode: target.map(linearToCode),
        deltaE: deltaE2000Linear(P, meas, target), levelPct: 100 * (meas[1] / target[1] - 1),
      };
    });
    const odd = r.buffer.width % 2 === 1 && r.buffer.height % 2 === 1;
    record('G9z', '位相ゼロの構成（drawingBuffer が奇数×奇数）', '両方奇数',
      `${r.buffer.width}×${r.buffer.height}`, odd);
    record('G9z', '位相オフセット', '厳密 0', `x ${r.offset.x} / y ${r.offset.y}`,
      r.offset.x === 0 && r.offset.y === 0);
    record('G9z', '峰が単一画素（2×2 の平坦部でない）', 'true', String(r.uniqueMax), r.uniqueMax);
    record('G9z', 'd=0 平均色（**モデルを通さない生値**）', 'ΔE00 ≤ 3.0', r.deltaE.toFixed(4),
      odd && r.deltaE <= 3.0,
      `生 ${r.measCode.join(',')} / 目標 ${r.targetCode.join(',')}`
      + ` / 水準 ${r.levelPct.toFixed(2)}% / S ${r.spritePx.toFixed(3)} / 深度 ${r.depth}`);
    zeroPhaseRaw = r;
  } finally {
    await page.close();
  }
}

let ladderRaw = null;
let zeroPhaseRaw = null;

function report(gl, buffer) {
  const width = [6, 40, 26, 40];
  const line = (a, b, c, d, ok) =>
    `${ok} ${a.padEnd(width[0])} ${b.padEnd(width[1])} ${c.padEnd(width[2])} ${d}`;
  console.log('');
  console.log('  DIMENSION-LENS 忠実性ラダー');
  console.log(`  ラスタライザ : ${gl.renderer}`);
  console.log(`  ベンダ       : ${gl.vendor}`);
  console.log(`  GL           : ${gl.version} / maxSamples ${gl.maxSamples}`);
  console.log(`  drawingBuffer: ${buffer.width}×${buffer.height}`);
  console.log(`  モード       : ${STRUCTURAL ? '構造回帰のみ（ΔE00 の権威にしない）' : 'フル'}`);
  console.log('');
  console.log(line('  ', '項目', '予算', '実測', '  '));
  console.log('  ' + '-'.repeat(118));
  for (const r of rows) {
    console.log(line(r.id, r.what, String(r.budget),
      `${r.measured}${r.note ? `  [${r.note}]` : ''}`,
      r.ok === null ? '  ➖' : r.ok ? '  ✅' : '  ❌'));
  }
  const skipped = rows.filter((r) => r.ok === null).length;
  console.log('');
  console.log(`  ${rows.length} 行 / 通過 ${rows.length - failures - skipped} / 失敗 ${failures}`
    + (skipped ? ` / **採点しない ${skipped}**` : ''));
  if (skipped > 0) console.log('  （➖ は飛ばした行。**通過ではない**）');
  if (AS_JSON) {
    console.log('\nJSON\n' + JSON.stringify({ gl, buffer, rows, raw: ladderRaw, zeroPhase: zeroPhaseRaw }, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
