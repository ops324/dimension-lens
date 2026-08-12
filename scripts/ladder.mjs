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
 *   npm run ladder -- --teeth --budgets  **予算そのものに歯が在るかを数える**（Phase 2c-vi）
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
 *
 * ## ティア別の表にした（Phase 2c-iii）
 *
 * 2a〜2c-ii のあいだ、この表は **HIGH の 1 枚だけ**だった。GitHub の runner は 4 コアで
 * **BALANCED** で起動するので、格子に依存する 6 行が CI で永久に `➖`（採点しない）だった。
 * SPEC はこれを「`__LENS__` にティアを固定する口が無いから」と書いていたが、**それは偽である** ──
 * 必要だったのは口ではなく**ティアごとの期待値**だった。
 *
 * BALANCED / ULTRA の値は `anchors.test.ts` と同じ式を node で回して出し、
 * **BALANCED は CI の実出力と 5 値すべてが厳密に一致することを確認してから**ここへ写した
 * （実測: `s0` 3.3851792828685254 / `gain` 0.45296699544158425 /
 * `cascadeDist` 3.3746125074981395 / 格子 251×157 —— #24 までの CI ログ）。
 * **ULTRA だけはまだどの機体でも観測されていない**（node の予測値である）。
 *
 * ## ティアに依らない量と、依る量
 *
 * `cameraDistance` / `fillX` / `meanHex` は **3 ティアで同一**である ──
 * 格子は点の間隔しか変えず、板の構図を変えないため。だから下では別扱いにする。
 *
 * ## 写しであって計算ではない
 *
 * ここで `fitGrid` や `gainFor` を import して計算してはいけない ──
 * それは作品を作品自身で採点する（`x/x`）。**手で写した数字**であることに意味がある。
 */
const TIER_ANCHORS = {
  BALANCED: {
    s0: 3.3851792828685254,
    gain: 0.45296699544158425,
    cascadeDist: 3.3746125074981395,
    gridW: 251,
    gridH: 157,
    /** CI（runner・4 コア）で実測済み */
    observed: 'CI runner',
  },
  HIGH: {
    s0: 2.247830687830687,
    gain: 0.4530724335144705,
    cascadeDist: 3.38382867097012,
    gridW: 378,
    gridH: 236,
    /** ローカル（M1 Max）で実測済み。§7.7 の表そのもの */
    observed: 'M1 Max',
  },
  ULTRA: {
    s0: 1.6825346534653463,
    gain: 0.4540684625258778,
    cascadeDist: 3.3884220034953074,
    gridW: 505,
    gridH: 315,
    /** **まだどの機体でも観測されていない**（node の予測値） */
    observed: null,
  },
};

/** ティアに依らない量。**3 ティアで同一であることを node で確認してある** */
const ANCHORS = {
  cameraDistance: 1.9635938049105979,
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
  // ---- Phase 2b で足した故障 ----
  {
    key: 'colorfield',
    name: '色場 `image+mean` を `image` に取り違える（重ね合わせを壊す）',
    expect: ['G12'],
  },
  {
    key: 'nomotion',
    name: '光過敏の配慮を効かなくする（2a まで実際にこうだった）',
    expect: ['G13'],
  },
  {
    key: 'blendorder',
    name: '加算の順序を逆に積む（順序依存を握り潰す）',
    expect: ['G14'],
  },
  {
    key: 'nowire',
    name: '`CompressPass` の配線を外す（2a まで実際にこうだった）',
    expect: ['G15'],
  },
  // ---- Phase 2c で足した故障 ----
  //
  // **2b までの読み方そのもの** ── 位相を進めずに測る。これが赤くならないなら、
  // G16 は「位相を流している」と言いながら位相 0 を測っていることになる
  // （`MEASURED_PEAK_ENVELOPE` が包絡を名乗れてしまったのと同じ形）。
  // ---- Phase 2c-iii ----
  //
  // ティア別のアンカー表を置くと、**表を選ぶのが作品側の出力**（`stats().tier`）になる。
  // `bootTier()` が壊れて別のティアを返すようになっても、ラダーがその表を選んで
  // 緑のままになりうる ── 独立監査が指摘した `x/x` の変種である。
  // `bootTier()` は構造上 ULTRA を返し得ないので、この故障はどの機体でも赤になる。
  {
    key: 'wrongtier',
    name: '検出したティアを偽る（`bootTier()` が壊れた状態）',
    expect: ['ENV'],
  },
  {
    key: 'nosweep',
    name: 'G16 で位相を進めない（2b までの読み方＝ 位相 0 で測って包絡と呼ぶ）',
    expect: ['G16'],
  },
  // ---- Phase 2c-v ----
  //
  // **予算 0.2% そのものを試す。** 既存の `colorfield` は `dev ≈ −100%` を出すので
  // 0.5% でも 0.2% でも同じように赤く、予算の数字を緩い方へ動かしても誰も気づかなかった。
  // 0.3% は 0.2%（新）と 0.5%（旧）の間なので、**予算を戻した瞬間にこの故障が素通りする**。
  {
    key: 'g12budget',
    name: '重ね合わせを 0.3% だけ壊す（予算 0.2% を 0.5% へ戻すと素通りする）',
    expect: ['G12'],
  },
];

const args = process.argv.slice(2);
const STRUCTURAL = args.includes('--structural');
const AS_JSON = args.includes('--json');
const TEETH = args.includes('--teeth');
/** 予算そのものに歯が在るかを数える（`--teeth` と併用する） */
const BUDGETS = args.includes('--budgets');

let rows = [];
let failures = 0;

const CMP = {
  le: (v, l) => v <= l, lt: (v, l) => v < l,
  ge: (v, l) => v >= l, gt: (v, l) => v > l,
};

/**
 * `ok === null` は「採点しない」。**通過にも失敗にも数えない**
 *
 * ## `gauge` —— 予算そのものを検査するための 7 番目の引数（Phase 2c-vi）
 *
 * `{ site, value, limit, dir }`。**数値の予算を持つ行にだけ**足す（真偽・厳密一致・
 * `Object.is` の 43 行は 1 文字も変わらない）。`site` は**予算リテラルの識別子**であって
 * 行の識別子ではない ── G12 の 3 行（d=3/4/5）は同じ `0.002` を共有するので同じ `site` になる。
 * **検査の単位は行ではなく予算リテラルである。**
 *
 * `gauge` が `ok` と食い違ったら**その場で落とす**。これが無いと `gauge` は
 * 「実際の判定式とずれた手書きの写し」になり、検査が自分の書いた表を読み返すだけの
 * `x/x` に堕ちる ── だから `--budgets` のときだけでなく**全モードで毎回**検査する。
 */
function record(id, what, budget, measured, ok, note = '', gauge = null) {
  if (gauge && ok !== null) {
    const derived = CMP[gauge.dir](gauge.value, gauge.limit);
    if (derived !== ok) {
      throw new Error(
        `gauge が ok と一致しない: ${id} / ${what} / site=${gauge.site}`
        + ` value=${gauge.value} ${gauge.dir} limit=${gauge.limit} → ${derived}、ok=${ok}`,
      );
    }
  }
  rows.push({ id, what, budget, measured, ok, note, gauge });
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
      exitCode = await runTeeth(page, context, gl);
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
  // Phase 2b: 加算合成の器具（`1 + 0.5 + 0.25 === 1.75` が厳密に返るか）。
  // これが通らないうちは G14 のどの残差の話も「器具が壊れている」と区別がつかない
  record('ENV', '加算合成の器具の自己検査', 'ok', traces.lensBlend ?? '(なし)',
    traces.lensBlend === 'ok');
  record('ENV', '取り込み', 'ok', traces.lensIngest ?? '(なし)', traces.lensIngest === 'ok');
  record('ENV', '描画', 'ok', traces.lensRender ?? '(なし)', traces.lensRender === 'ok');

  const anchors = await page.evaluate((f) => {
    const L = window.__LENS__;
    L.setDimLevel(2); L.freezeRotation(true); L.resetRotation();
    L.setBloom(false); L.setGrade(false); L.setCompress(false);
    L.renderOnce(2);
    const s = L.sceneStats(); const st = L.stats();
    return {
      s0: s.s0, gain: s.gain, cameraDistance: s.cameraDistance, cascadeDist: s.cascadeDist,
      gridW: s.gridW, gridH: s.gridH, fillX: s.fill.x, meanHex: st.meanHex,
      sampleWeight: s.sampleWeight,
      // 故障 `wrongtier`: 検出したティアを偽る。`bootTier()` が壊れた状態の模擬で、
      // **ティア別の表が「答案を選ぶ主体」を採点していない**なら、これは緑のまま通る
      tier: f.wrongtier ? 'ULTRA' : st.tier,
      // `bootTier()` の**入力**をそのまま持ち帰る（Phase 2c-iii）。
      // これが無いと、ティア別の表は「答案を選ぶ主体が採点対象」になる ── 監査の指摘。
      cores: navigator.hardwareConcurrency ?? 0,
      memory: navigator.deviceMemory ?? 0,
      dpr: window.devicePixelRatio || 1,
    };
  }, fault);
  // ティアに依らない行と、格子（＝ティア）で決まる行を分ける。
  // **表はティアごとに在る**（Phase 2c-iii）ので、どのティアで起動しても採点できる ──
  // 知らないティア名のときだけ `null`（採点しない）へ落ちる。
  /**
   * **`bootTier()` そのものを採点する**（Phase 2c-iii）。
   *
   * ティア別の表を置くと、表を選ぶのが `stats().tier` ＝ 作品側の出力になる。
   * つまり `bootTier()` が壊れて常に BALANCED を返すようになっても、
   * ラダーは BALANCED の表を選んで緑のままになる ── **答案を選ぶ主体が採点対象**という
   * `x/x` の変種で、独立監査がこれを指摘した。
   *
   * → 規則を**ここへ手で写し**、`bootTier()` の入力（コア数・メモリ・DPR）から
   * 期待ティアを独立に出して突き合わせる。`quality.ts` を import してはいけない ──
   * それをやると本当に `x/x` になる。
   */
  const expectTier = (() => {
    const { cores, memory, dpr } = anchors;
    if (cores >= 8 && memory >= 8 && dpr <= 2) return 'HIGH';
    return 'BALANCED';
  })();
  record('ENV', '`bootTier()` が入力どおりのティアを返す', expectTier, anchors.tier,
    anchors.tier === expectTier,
    `コア ${anchors.cores} / メモリ ${anchors.memory} / DPR ${anchors.dpr}`);

  const expected = TIER_ANCHORS[anchors.tier];
  record('ENV', 'ティア', '表に在るティア', `${anchors.tier}（格子 ${anchors.gridW}×${anchors.gridH}）`,
    expected ? true : null,
    expected
      ? (expected.observed ? `期待値の出どころ: ${expected.observed}` : '**未観測のティア** —— この実行が初回の実測になる')
      : '表に無いティアなので採点しない');
  for (const k of ['cameraDistance', 'fillX']) {
    record('ENV', `アンカー ${k}（ティアに依らない）`, String(ANCHORS[k]), String(anchors[k]),
      Object.is(anchors[k], ANCHORS[k]), 'Object.is');
  }
  for (const k of ['s0', 'gain', 'cascadeDist', 'gridW', 'gridH']) {
    record('ENV', `アンカー ${k}（ティア依存・${anchors.tier}）`,
      expected ? String(expected[k]) : '(表に無い)', String(anchors[k]),
      expected ? Object.is(anchors[k], expected[k]) : null, expected ? 'Object.is' : '');
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
async function runTeeth(page, context, gl) {
  const log = [];
  console.log('');
  console.log('  ラダーの歯の確認');
  console.log(`  ラスタライザ : ${gl.renderer}`);
  console.log('');

  rows = []; failures = 0;
  // `--budgets` のときだけ素の状態を**非 quick** で回す ── 分母（全 `site`）を正直に数えるため。
  // 故障側を非 quick で回すのは費用が見合わない（G16 の掃引だけで故障あたり 60 秒級）ので、
  // 生成されない行は「検査外」として**明示して数に入れる**（分母を縮めて点を良く見せない）。
  await runOnce(page, BUDGETS ? context : null, BUDGETS ? {} : { quick: true }, null);
  const baseRows = rows.map((r) => ({ id: r.id, ok: r.ok, gauge: r.gauge }));
  const baseOk = failures === 0;
  console.log(`  素の状態: ${baseOk ? '緑 ✅' : `赤 ❌（${failures} 行）`}`);
  if (!baseOk) {
    for (const r of rows.filter((x) => !x.ok)) console.log(`    ❌ ${r.id} ${r.what} → ${r.measured}`);
    console.log('\n  素の状態が緑でないので、故障注入の結果は解釈できない。');
    return 1;
  }
  console.log('');

  let bitten = 0;
  /** `--budgets` 用。**捨てていた行をそのまま持つだけ**なので、追加の測定は 1 回も要らない */
  const faultRuns = [];
  for (const f of FAULTS) {
    rows = []; failures = 0;
    await runOnce(page, null, { [f.key]: true, quick: true }, null);
    const failedIds = new Set(rows.filter((r) => !r.ok).map((r) => r.id));
    const hit = f.expect.filter((id) => failedIds.has(id));
    const ok = hit.length > 0;
    if (ok) bitten++;
    log.push({ ...f, ok, failedIds: [...failedIds] });
    faultRuns.push({
      fault: f,
      failedIds,
      rows: rows.map((r) => ({ id: r.id, ok: r.ok, gauge: r.gauge })),
    });
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
  let budgetsOk = true;
  if (BUDGETS) budgetsOk = reportBudgets(baseRows, faultRuns);

  if (AS_JSON) console.log('\nJSON\n' + JSON.stringify({ gl, log }, null, 2));
  return bitten === FAULTS.length && budgetsOk ? 0 : 1;
}

/**
 * **予算そのものに歯が在るかを数える**（`--teeth --budgets`・Phase 2c-vi）。
 *
 * ## なぜ要るのか
 *
 * 2c-v で、G12 の予算 0.2% には歯が 1 本も無かったことが分かった ── 既存の故障 `colorfield` は
 * `dev ≈ −100%` を出すので **0.5% でも 0.2% でも同じように赤く**、その数字を 0% から 100% まで
 * どこへ動かしても全テストが緑だった。1 本だけ塞いだが、**残りが何本あるかは誰も数えていなかった。**
 *
 * `scripts/teeth.mjs` の台帳は `src/` しか書き換えないので、`scripts/` に在る予算リテラルは
 * **構造的にあちらでは守れない**。ここが唯一の場所である。
 *
 * ## 判定
 *
 * 予算 `site`（上限 `L`）に歯が在るのは、次を満たす故障が在るときに限る:
 *
 *   1. その故障のもとで `site` の行が落ちる
 *   2. **その id で落ちたのがその行だけ**である ── `expect` は `id` 単位なので、
 *      同じ id の別の行が同時に落ちると、`L` を動かしても gate は色を変えない
 *   3. 比 `m`（`le`/`lt` なら `value/L`、`ge`/`gt` なら `L/value`）が `1 < m ≤ K` に入る ──
 *      **桁で外す故障は予算を検証していない**（`colorfield` の m ≈ 500 はここで落ちる）
 *
 * ## この検査が言えないこと（正直に）
 *
 * 「`L` を動かすと色が変わるか」しか見ない。**`L` が機構から導かれた数か、
 * 今日の床のまわりに引いた柵か**は判定できない（G12 の 0.2% は後者だと `score()` 自身が書いている）。
 * そこは人が書くしかない。
 */
const BUDGET_NEAR_K = 3;
/** **減ったら赤**。増えたらここを上げてから通す（`teeth.mjs` の `observed` と同じ規律） */
const EXPECTED_TOOTHED_BUDGETS = 6;
/**
 * **分母のラチェット**（Phase 2c-viii）。
 *
 * 2c-vi は分子（`toothed`）だけを見ていた。**そこに穴が在る** ── `sites` は
 * `gauge` を持つ行からしか作られないので、**歯の無い 13 site の `gauge` を消すと
 * `6 / 19` が `6 / 6` になり、判定は `true` のまま通る。**
 * 独立監査が実物の `reportBudgets` を切り出して実演し、こちらでも実機で 19 を確認した
 * （ANGLE Metal・988×778・`--teeth --budgets`）。
 *
 * **指標が証拠を消すほど良くなるのは、指標の側の欠陥である。**
 * `gauge` を外すのは「その数字はもう予算ではない」という主張なので、
 * 減らすならこの数も同じ PR で下げること ── 差分に出る。
 */
const EXPECTED_BUDGET_SITES = 19;

function reportBudgets(baseRows, faultRuns) {
  const sites = new Map();
  for (const r of baseRows) {
    if (!r.gauge) continue;
    if (!sites.has(r.gauge.site)) sites.set(r.gauge.site, { ...r.gauge, best: null, blocked: [] });
  }
  for (const run of faultRuns) {
    // その走行で id ごとに何行落ちたか（条件 2 のため）
    const failedPerId = new Map();
    for (const r of run.rows) {
      if (r.ok === false) failedPerId.set(r.id, (failedPerId.get(r.id) ?? 0) + 1);
    }
    for (const r of run.rows) {
      if (!r.gauge || r.ok !== false) continue;
      const s = sites.get(r.gauge.site);
      if (!s) continue;
      const { value, limit, dir } = r.gauge;
      const m = dir === 'le' || dir === 'lt'
        ? (limit > 0 ? value / limit : Infinity)
        : (value > 0 ? limit / value : Infinity);
      const alone = (failedPerId.get(r.id) ?? 0) === 1;
      const cand = { fault: run.fault.key, value, m, alone };
      if (!alone) { s.blocked.push(cand); continue; }
      if (m > 1 && m <= BUDGET_NEAR_K && (!s.best || m < s.best.m)) s.best = cand;
      else if (!s.best) s.blocked.push(cand);
    }
  }

  console.log('');
  console.log(`  予算の歯（--budgets・K = ${BUDGET_NEAR_K}）`);
  console.log('');
  console.log('  site               上限        最も近い故障   その値      比      判定');
  console.log('  ' + '-'.repeat(78));
  let toothed = 0;
  const rowsOut = [...sites.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [site, s] of rowsOut) {
    let verdict;
    if (s.best) { toothed++; verdict = s.best.m < 1.1 ? '歯が在る ⚠ 余裕僅少' : '歯が在る'; }
    else if (s.blocked.length) {
      const b = s.blocked.reduce((x, y) => (x.m < y.m ? x : y));
      verdict = !b.alone ? '**歯が無い**（同 id の別行と同時に落ちる）' : '**歯が無い**（桁で外す）';
    } else verdict = '**歯が無い**（覆う故障が無い）';
    const b = s.best ?? (s.blocked.length ? s.blocked.reduce((x, y) => (x.m < y.m ? x : y)) : null);
    console.log(
      `  ${site.padEnd(18)} ${String(s.limit).padEnd(11)} ${(b?.fault ?? '（無し）').padEnd(14)}`
      + ` ${(b ? b.value.toPrecision(5) : '—').padEnd(11)} ${(b ? b.m.toFixed(2) : '—').padEnd(7)} ${verdict}`,
    );
  }
  console.log('  ' + '-'.repeat(78));
  console.log(`  歯の在る予算 ${toothed} / ${sites.size}。**歯の無い予算 ${sites.size - toothed}。**`);
  const enough = toothed >= EXPECTED_TOOTHED_BUDGETS;
  // **分母も見る**（2c-viii）── 見ないと、歯の無い site の `gauge` を消すだけで
  // 「6 / 19」が「6 / 6」になり、証拠を消した側が緑になる。
  const denomOk = sites.size >= EXPECTED_BUDGET_SITES;
  const ok = enough && denomOk;
  if (!enough) {
    console.log('');
    console.log(`  ❌ 歯の在る予算が ${EXPECTED_TOOTHED_BUDGETS} を下回った。`);
    console.log('  予算に歯が無いということは、**その数字を緩い方へ動かしても誰も気づかない**ということである。');
  }
  if (!denomOk) {
    console.log('');
    console.log(`  ❌ 予算の site が ${sites.size} しかない（${EXPECTED_BUDGET_SITES} あったはず）。`);
    console.log('  `gauge` を外すと分母が縮み、**歯の無い予算を消すほど比が良くなる。**');
    console.log('  正当に減らしたのなら、この PR の中で EXPECTED_BUDGET_SITES も下げること。');
  }
  console.log('');
  console.log('  **この検査の外に在る行**: `--teeth` は `quick: true` で回すので、');
  console.log('  G1d / G11a / G11b / G9z / G12 の d=4,5 / コンソールエラーは故障側で生成されない。');
  console.log('  そこに在る予算は、故障を足さないかぎり永久に検査外である。');
  return ok;
}

/** ページ内で走る測定本体。**`fault` はここで絵と採点者に効く** */
async function measureInPage(fault) {
  const L = window.__LENS__;
  const { deltaE2000Linear } = await import('/src/color/deltaE.ts');
  const { primariesFor, linearToOklab } = await import('/src/color/oklab.ts');
  const { srgbToLinear, linearToCode } = await import('/src/color/srgb.ts');
  const { spritePhaseFactor, centreFragmentOffset } = await import('/src/image/spriteGain.ts');
  const { makeSpecimen0, REGIONS, RAMP_CODES } = await import('/src/image/fixture.ts');
  const { blendCases, classifyBlend, OBSERVED_BLEND_MODEL, BLEND_MODELS } =
    await import('/src/image/blendModel.ts');
  const { compressStrengthFor } = await import('/src/core/compress.ts');
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
      buffer: s.buffer, linePoints: s.linePoints, depth: s.modelledAdditionDepth,
      spritePx: s.spritePx, rowSpread, phase,
      measuredCode: meas.map(linearToCode), reconCode: recon.map(linearToCode),
      targetCode: target.map(linearToCode), deltaE: dE(recon, target),
      levelPct: 100 * (recon[1] / target[1] - 1),
    };
  }
  out.collapse = collapse;

  // ---------- G10: 加算深度（**掃引をやめた**・Phase 2c-v）
  //
  // 2a〜2c-iv はここを `for (let d = 0; d <= 5; d += 0.25)` で掃いて最大 **64** を得ていた。
  // だが深度は閉形式で、`extentY → 0⁺` で `ny` が `rows` に張り付く:
  //
  //     depth = min(cols, ⌊K_SPRITE/extentX⌋+1) × min(rows, ⌊K_SPRITE/extentY⌋+1)
  //
  // つまり **到達しうる最大は `4 × rows`**（`⌊3.85⌋+1 = 4` はティア不変）で、
  // HIGH 944 / BALANCED 628 / ULTRA 1260。**0.25 刻みはその帯を 1 点も採らない** ──
  // `n ≤ 512` が緑だったのは掃引の粗さのおかげである。
  //
  // **刻みを細かくするのは直し方として誤り**（§0.1 規律 9「窓は機構から導く」）。
  // 帯の幅は ULTRA で 0.01222 しかないので、0.01 刻みでも踏み損ねる。
  // → **折れ点を列挙する。** 折れ点は `extentY = K_SPRITE/m`（m = 1…rows）に全部ある。
  {
    const probe = [];
    const s2 = (() => { setup(2, 'auto'); return L.sceneStats(); })();
    const rows = s2.gridH;
    // 折れ点そのものと、その両側（`extentY = d − 1`）
    const eps = [];
    for (let m = 1; m <= rows; m++) {
      const e = 3.85 / m;
      if (e > 0 && e <= 1) { eps.push(e * 0.999999, e, e * 1.000001); }
    }
    eps.push(1e-7, 1e-4, 1e-3, 1);
    for (const e of eps) {
      setup(1 + e, 'auto');
      probe.push([1 + e, L.sceneStats().modelledAdditionDepth]);
    }
    // 掃引で見える範囲も併記する（0.25 刻みが何を見ていたか）
    const coarse = [];
    for (let d = 0; d <= 5; d += 0.25) { setup(d, 'auto'); coarse.push(L.sceneStats().modelledAdditionDepth); }
    let max = 0, at = 0;
    for (const [d, n] of probe) if (n > max) { max = n; at = d; }
    out.G10 = {
      max, at, rows, closedForm: 4 * rows,
      coarseMax: Math.max(...coarse),
      breakpoints: eps.length,
    };
  }

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

  // ---------- G12: `d ≥ 3` の色（**この帯域を採点する行は 2a まで 1 本も無かった**）
  //
  // 格子経路は 1 フラグメントに 16〜64 個のスプライトが重なる。§4.6 の残差機構が
  // そこにも残っているかを問いたいが、**別の画像を入れると `base`（位置）も変わる**
  // ── L 軸が座標そのものだからで、それでは幾何と色の効果が分離できない。
  //
  // → 位置を 1 ビットも動かさず、色場だけを `image` / `mean` / `image+mean` へ差し替え、
  // 全面の積分光量が `I(A+B) = I(A) + I(B)` を満たすかを見る。
  // **幾何のモデルを 1 つも要求しない**（失敗史はすべて「採点者がモデルを含んでいた」型）。
  //
  // **この行が見ないもの（書いておく）**: 一様な**乗法的**な欠損は重ね合わせに現れない。
  // fp16 の切り捨て（G14 が同定した機構）はほぼ乗法的なので、ここはほぼ 0 を出す ──
  // 捕まえられるのは飽和・非正規数の潰れ・クリップのような**非線形**な機構である。
  // それらこそ §4.6 が `d = 0` で恐れたものなので、この行の意味はそこにある。
  {
    const integrate = async () => {
      L.renderOnce(3);
      const p = await L.readbackHDR(0, 0, BUF.w, BUF.h);
      let s = 0;
      for (let i = 0; i < p.length; i += 4) s += p[i] + p[i + 1] + p[i + 2];
      return s;
    };
    out.G12 = [];
    for (const d of fault.quick ? [3] : [3, 4, 5]) {
      L.setBloom(!!fault.bloom); L.setGrade(!!fault.grade); L.setCompress(false);
      L.setPath('cloud'); L.setDimLevel(d); L.freezeRotation(true); L.resetRotation();
      L.setColorField('image');
      const Ia = await integrate();
      L.setColorField('mean');
      const Ib = await integrate();
      // 故障 `colorfield`: 和の場を作らず片方だけを測る
      L.setColorField(fault.colorfield ? 'image' : 'image+mean');
      const IabRaw = await integrate();
      /**
       * 故障 `g12budget`: 重ね合わせを **0.3% だけ**壊す。
       *
       * **予算そのものを試す唯一の歯である。** `colorfield` は `dev ≈ −100%` を出すので
       * 0.5% でも 0.2% でも同じように赤く、**この数字を緩い方へ動かしても誰も気づかない**
       * （§0.1 規律 7 が名指しで警告している形）。`scripts/teeth.mjs` の台帳は `src/` しか
       * 書き換えないので、あちらでは構造的にこの歯を作れない。
       *
       * 0.3% を選んだのは 0.2%（新）と 0.5%（旧）の間だからで、**予算を 0.5% へ戻した瞬間に
       * この故障が素通りする**。代償は隠さない ── これは機構ではなく**数字そのもの**を試す歯である。
       */
      const Iab = fault.g12budget ? IabRaw * 1.003 : IabRaw;
      L.setColorField('image');
      const s = L.sceneStats();
      out.G12.push({
        d, Ia, Ib, Iab, dev: (Iab - (Ia + Ib)) / Iab,
        depth: s.modelledAdditionDepth, points: s.pointCount, extent: [...s.extent],
      });
    }
    L.setPath('auto');
  }

  // ---------- G13: 光過敏の配慮（**両側から見る**）
  //
  // 2a までこの配慮は 1 画素も変えていなかった（`postfx.ts` が既定オフの `gradePass` の
  // `uTime` を握るだけで、回転そのものには門が無かった）。**未計測ではなく偽**だったので、
  // 「オンで止まる」だけでなく「**オフで動く**」も要る ──
  // 前者だけなら「常に止まっている実装」でも緑になる。
  {
    const win = [Math.round(BUF.w / 2) - 32, Math.round(BUF.h / 2) - 32, 64, 64];
    const same = (a, b) => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };
    const run = async (reduced) => {
      L.setBloom(false); L.setGrade(false); L.setCompress(false);
      L.setPath('auto'); L.setDimLevel(3);
      L.freezeRotation(false); L.resetRotation();
      // 故障 `nomotion`: 配慮が届かない（2a までの状態）
      L.setReducedMotion(fault.nomotion ? false : reduced);
      L.renderOnce(1);
      const a = await L.readback(...win);
      L.renderOnce(60);
      const b = await L.readback(...win);
      return { applied: L.reducedMotion(), identical: same(a, b) };
    };
    const on = await run(true);
    const off = await run(false);
    L.setReducedMotion(false); L.freezeRotation(true);
    out.G13 = { on, off };
  }

  // ---------- G14: 加算合成の機構（**作品を通さない器具**）
  //
  // §4.6 訂正 4 の宿題。監査の fp16 逐次丸めシミュレーション（1% 未満）と
  // 実測（−5.2% / −6.0%）が矛盾したままだったので、規定した値を GPU の
  // ブレンドユニットへ直接積んで、どのモデルと一致するかを投票させる。
  {
    out.G14 = [];
    for (const c of blendCases()) {
      const values = fault.blendorder
        ? Array.from(c.values).reverse()   // 順序依存を握り潰す故障
        : Array.from(c.values);
      const m = L.blendProbe(values);
      // **判定は宣言された並びに対して行う** ── 故障で並べ替えても採点者は動かさない
      const v = classifyBlend(c.key, c.values, m.rgb[0]);
      out.G14.push({
        key: c.key, count: m.count, glError: m.glError,
        rgb: m.rgb, channelsEqual: m.rgb[0] === m.rgb[1] && m.rgb[1] === m.rgb[2],
        predicted: v.predicted, matches: v.matches,
      });
    }
    out.observedModel = OBSERVED_BLEND_MODEL;
    out.modelKeys = BLEND_MODELS.map((m) => m.key);
  }

  // ---------- G15: `CompressPass` の配線（**2a まで誰も呼んでいなかった**）
  //
  // `setCompressStrength` を呼ぶ者がどこにも無く、出荷経路ではパスが `enabled = false`
  // のままだった ── 「1.0 を超えた加算を圧縮する」は書いてあるだけで動いていなかった。
  // 証拠は**画素**で取る（`enabledPasses()` は自分の書いたフラグを読み返すだけなので
  // 採点者にしない・監査 F.1）。
  {
    const diffBytes = (a, b) => {
      let n = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
      return n;
    };
    const frameAt = async (d, wired) => {
      L.setBloom(false); L.setGrade(false);
      L.setPath('auto'); L.setDimLevel(d); L.freezeRotation(true); L.resetRotation();
      // 故障 `nowire`: 出荷時の配線へ戻さない（＝ 常に圧縮オフ）
      L.setCompress(wired && !fault.nowire ? null : false);
      L.renderOnce(3);
      /**
       * **全面を読む。** 初版は中央 128×128 を読んで「門が開いても絵が変わらない」を得た ──
       * 圧縮はニー 0.8 の上でしか働かず、図の中央にはその明るさの画素が 1 つも無いためである。
       * 窓を答えが通るまで動かすのは §7.6 の禁じ手なので、**機構に合う窓（＝ 全面）**にする。
       */
      const px8 = await L.readback(0, 0, BUF.w, BUF.h);
      const hdr = await L.readbackHDR(0, 0, BUF.w, BUF.h);
      let peak = 0;
      for (let i = 0; i < hdr.length; i += 4) {
        if (hdr[i] > peak) peak = hdr[i];
        if (hdr[i + 1] > peak) peak = hdr[i + 1];
        if (hdr[i + 2] > peak) peak = hdr[i + 2];
      }
      return { px8, peak };
    };
    const anchorWired = await frameAt(2, true);
    const anchorOff = await frameAt(2, false);
    const openWired = await frameAt(3, true);
    const openOff = await frameAt(3, false);
    L.setCompress(false);
    out.G15phaseZero = true;
    out.G15 = {
      anchorDiffBytes: diffBytes(anchorWired.px8, anchorOff.px8),
      openDiffBytes: diffBytes(openWired.px8, openOff.px8),
      totalBytes: openWired.px8.length,
      peakWired: openWired.peak,
      peakOff: openOff.peak,
      strengthAtAnchor: compressStrengthFor(2),
      strengthAtOpen: compressStrengthFor(3),
    };
  }

  // ---------- G16: **位相を流して測る**（Phase 2c）
  //
  // 2b までの HDR 測定（G12 / G15）は、どちらも必ず `freezeRotation(true)` +
  // `resetRotation()` ＝ **位相 0** で測っていた。位相を流して掃く測定は repo に
  // 1 行も無く、その結果 `MEASURED_PEAK_ENVELOPE = 2.01758` は「包絡」を名乗りながら
  // 位相 0 近傍の値でしかなかった。実際に流すと生の峰は 2 桁上がる
  // （実測: d=3 で 101.0、d=4.25 で 266.75 —— 記録値の 50 倍 / 132 倍）。
  //
  // 機構は `core/fit.ts` の `framingHold` である ── カメラ距離は最も広がる位相に
  // 必要な値で固定されるのに、図は狭い位相で画面のごく一部へ前縮みする
  // （実測 `fill.x` 0.86 → 0.0303）。同じ総光量が少ない画素へ集まるので峰が跳ねる。
  //
  // **この行が守るのは「位相 0 で測って包絡と呼ばない」ことである。**
  // 故障 `nosweep` は位相を進めない ── そのとき生の峰は記録値を下回るので赤くなる。
  {
    /**
     * 掃引の寸法。**ラダーはローカルの門なので秒を払ってよい**が、青天井にはしない。
     * `d = 4.25` は 2b が包絡を記録した点そのもの（＝ 最も「上限」と信じられていた点）。
     * 30 秒ぶんで実測の生の峰は 30 を超える（記録値 2.01758 の 15 倍）ので、
     * 「記録値は包絡ではない」を示すには十分である。
     */
    const SWEEP_DIM = 4.25;
    const SWEEP_CHUNK_FRAMES = 300;
    const SWEEP_CHUNKS = 6;
    const { MEASURED_PEAK_ENVELOPE } = await import('/src/core/compress.ts');
    const sweep = async (d, wired) => {
      L.setBloom(false); L.setGrade(false); L.setPath('auto');
      L.setDimLevel(d);
      L.freezeRotation(false); L.resetRotation();
      L.setCompress(wired ? null : false);
      let peak = 0;
      for (let c = 0; c < SWEEP_CHUNKS; c++) {
        // 故障 `nosweep`: 位相を進めない（2b までの読み方＝ 位相 0 で測る）
        if (!fault.nosweep) {
          let left = SWEEP_CHUNK_FRAMES;
          while (left > 0) { const n = Math.min(600, left); L.renderOnce(n); left -= n; }
        } else {
          L.renderOnce(1);
        }
        const hdr = await L.readbackHDR(0, 0, BUF.w, BUF.h);
        for (let i = 0; i < hdr.length; i += 4) {
          const m = Math.max(hdr[i], hdr[i + 1], hdr[i + 2]);
          if (m > peak) peak = m;
        }
      }
      return peak;
    };
    const rawPeak = await sweep(SWEEP_DIM, false);
    const wiredPeak = await sweep(SWEEP_DIM, true);
    L.setCompress(false);
    const s = L.sceneStats();
    out.G16 = {
      d: SWEEP_DIM,
      gatedSeconds: (SWEEP_CHUNKS * SWEEP_CHUNK_FRAMES) / 60,
      rawPeak,
      wiredPeak,
      fillX: s.fill.x,
      cameraDistance: s.cameraDistance,
      strength: compressStrengthFor(SWEEP_DIM),
      recordedEnvelope: MEASURED_PEAK_ENVELOPE,
    };
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
    worstMarker <= 2, r.G1.markers.map((m) => m.err.toFixed(2)).join(' / '),
    { site: 'G1/marker', value: worstMarker, limit: 2, dir: 'le' });
  if (r.G1d) {
    record('G1', '二面体 8 変換で区別がつく', `${r.G1d.pairs}/${r.G1d.pairs} 対で相違`,
      `${r.G1d.distinct}/${r.G1d.pairs}`, r.G1d.distinct === r.G1d.pairs);
  }
  for (const path of ['plate', 'cloud']) {
    record('G2a', `平坦部（${path}）`, 'ΔE00 ≤ 2.0', r['G2a_' + path].deltaE.toFixed(4),
      r['G2a_' + path].deltaE <= 2.0, '',
      { site: 'G2a/deltaE', value: r['G2a_' + path].deltaE, limit: 2.0, dir: 'le' });
    const g3 = r['G3_' + path];
    record('G3', `ランプ 8 段（${path}）`, 'ΔE00 ≤ 2.0',
      g3.measurable ? g3.worstDeltaE.toFixed(4) : '測れない（窓が空）',
      g3.measurable && g3.worstDeltaE <= 2.0,
      `codes ${g3.codes.join(',')} / 窓 y∈[${g3.window[0]},${g3.window[1]}] / スプライト半径 ${g3.radImage} 画像px`,
      g3.measurable ? { site: 'G3/deltaE', value: g3.worstDeltaE, limit: 2.0, dir: 'le' } : null);
    record('G3', `ランプの単調性（${path}）`, '厳密に単調増加', String(g3.monotone), g3.monotone);
    const g4 = r['G4_' + path];
    record('G4', `ホイール 24（${path}）`, 'ΔE00 ≤ 2.0', g4.worstDeltaE.toFixed(4),
      g4.worstDeltaE <= 2.0, '',
      { site: 'G4/wheelDeltaE', value: g4.worstDeltaE, limit: 2.0, dir: 'le' });
    record('G4', `平均色相残差（${path}）`, '≤ 0.5°',
      `${g4.meanHueDeg.toFixed(4)}° (sd ${g4.sdHueDeg.toFixed(3)}°)`,
      Math.abs(g4.meanHueDeg) <= 0.5, '',
      { site: 'G4/hueDeg', value: Math.abs(g4.meanHueDeg), limit: 0.5, dir: 'le' });
  }
  record('G2c', '板経路と雲経路が別の画素である', '> 0 バイト相違',
    `${r.G2c.diffBytes} / ${r.G2c.totalBytes} バイト`, r.G2c.diffBytes > 0,
    '同じ絵を 2 回測って 2 つのゲートと呼んでいないか');
  record('G2b', '実効ゲイン（雲）', '±2%', `${r.G2b.errPct.toFixed(3)}%`,
    Math.abs(r.G2b.errPct) <= 2, '',
    { site: 'G2b/errPct', value: Math.abs(r.G2b.errPct), limit: 2, dir: 'le' });
  if (r.G5) {
    record('G5', '板の拡大補間', 'sRGB 188', String(r.G5.code),
      Math.abs(r.G5.code - 188) <= 1, `生値 ${r.G5.raw}`,
      { site: 'G5/code', value: Math.abs(r.G5.code - 188), limit: 1, dir: 'le' });
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
      String(g.rowSpread), premise, '',
      { site: 'G8G9/rowSpread', value: g.rowSpread, limit: 1, dir: 'le' });
    record(id, `${label}（再構成した中心値）`, `ΔE00 ≤ ${budget}`, g.deltaE.toFixed(4),
      premise && g.deltaE <= budget,
      `生 ${g.measuredCode.join(',')} → ${g.reconCode.join(',')} / 目標 ${g.targetCode.join(',')}`
      + ` / 位相 ${g.phase.toFixed(6)} / 水準 ${g.levelPct.toFixed(2)}%`
      + ` / 深度 ${g.depth} / 点 ${g.linePoints}`,
      // **前提が偽のときは予算の話にならない**ので gauge を出さない
      premise ? { site: `${id}/deltaE`, value: g.deltaE, limit: budget, dir: 'le' } : null);
  };
  collapseRow('G8a', 'd1', 'd=1 列平均線', 2.0);
  collapseRow('G8b', 'd0.5', 'd=0.5 線', 2.0);
  collapseRow('G9', 'd0', 'd=0 平均色', 3.0);
  /**
   * **G10 は 2 行になった**（Phase 2c-v）。
   *
   * 1 行目は「モデルが閉形式どおりか」＝ **掃引が折れ点を捕まえているか**の確認で、
   * これは通る。2 行目が本体 ── **`n ≤ 512` は実際に破れている。**
   *
   * 破れを「予算を上げて」隠すことも（§0.1 規律 7・緩い方へ外す）、
   * 「0.25 刻みの 21 点」へ主張を狭めることも（§7.9.2・見ていないものを合格に見せる）しない。
   * **未修正のまま、値を固定して記録する** ── 2c-iii がティアの `dpr`/`samples` 未配線を
   * そう扱ったのと同じ形である。畳み込みで直すのは次フェーズ（§4.6）。
   */
  record('G10', '深度の掃引が折れ点を捕まえている', `閉形式 4×${r.G10.rows} = ${r.G10.closedForm}`,
    String(r.G10.max), r.G10.max === r.G10.closedForm,
    `折れ点 ${r.G10.breakpoints} 点を列挙 / 最大は d=${r.G10.at.toFixed(7)}`
    + ` / **0.25 刻みの掃引が見ていたのは ${r.G10.coarseMax}** —— 2c-iv までの G10 はこれで緑だった`);
  /**
   * **既知の欠陥の固定。** 予算ではなく**記録値との一致**を見る ── 直ったら赤くなるし、
   * 悪化しても赤くなる。どちらも「知らないうちに動いた」を防ぐ。
   */
  const G10_RECORDED = { 236: 944, 157: 628, 315: 1260 };
  const expected = G10_RECORDED[r.G10.rows];
  record('G10', '**`n ≤ 512` は破れている（既知・未修正）**',
    expected === undefined ? '(この格子の記録が無い)' : `記録値 ${expected}（> 512）`,
    String(r.G10.max),
    expected === undefined ? null : r.G10.max === expected,
    `帯は d ∈ (1, 1.0301]、うち d ∈ (1, 1.0164] は ${expected} で一定。`
    + ` §4.6 の ΔE00 表では深度 512 で 2.439 / 1024 で 5.476（予算 3.0）なので、この帯は予算の外。`
    + ` **出荷経路からは到達不能**（\`setDimLevel\` は DEV フックからしか呼ばれない）。`);

  // ---- Phase 2b（予算は 2c-v で 0.5% → 0.2% に引き直した）----
  //
  // **予算 0.2% は機構から導いた数ではない。今日の床のまわりに引いた経験的な柵である。**
  // §0.1 規律 4 に従い、機構の側と柵の側を分けて書く。
  //
  // ## 機構が言えること（代数と `blendModel` の実行）
  //
  // G14 が同定した fp16 の 0 方向切り捨て（RTZ）の 1 段あたりの相対欠損は、仮数が 10 bit なので
  // 上限 **`2⁻¹⁰` = 0.0977%**（`2⁻¹¹` は**最近接**の unit roundoff で RTZ には使えない ──
  // 実測の 1 段最悪は 0.0974% で `2⁻¹¹` = 0.0488% を超える）。項が非負なら部分和は単調なので
  // `E ≤ n·ulp(T)`、`Δ = E(A) + E(B) − E(A+B)` で 3 項とも同符号（≥ 0）だから
  //
  //     |Δ| / T(A+B) ≤ n · ulp(T)/T ≤ n · 2⁻¹⁰          （深度 16 で 1.5625%）
  //
  // **「その 2 倍」ではない。** `E(A)+E(B)` が最大になる側と `E(A+B)` が最大になる側は
  // 同時に起きない。2b はここに「`16·2⁻¹¹ ≈ 0.78%` の 2 倍で上限 3.1%」と書いていたが、
  // **上限に `2⁻¹¹` を使ったのと 2 倍を二重に掛けたのと、誤りが 2 つあって打ち消し合っていた**
  // （どちらの読み方でも 1.5625% になる ── 算術としては偶然）。
  // なお採点している `dev` の分母は `T` ではなく `I(A+B) = S(A+B)` なので、
  // 実際の上界は `n·2⁻¹⁰ / (1 − n·2⁻¹⁰)`（深度 16 で 1.5873%）である。
  //
  // ## その 1.5625% は予算に使えない
  //
  // 全フラグメントの切り捨てが敵対的に揃った場合の値で、`blendModel` で構成すると深度 16 で
  // 実際に **1.44%（上界の 93%）** に届く ── 上界が緩いのではなく、**そこに置くと何も落とせない**。
  // 無作為な入力では上界の 3〜23% にしか届かない。
  //
  // ## だから 0.2% は柵である（根拠は実測だけ）
  //
  //   - 標本 No.0・2c-iv 時点: d=3 **0.0141%** / d=4 **0.0138%** / d=5 **0.0130%**
  //   - 同じ機体・同じ標本の 2b 時点: 0.0211% / 0.0202% / 0.0184%
  //     ── **コード状態だけで 1.5 倍動いた。床は機体定数ではない**
  //   - 標本を替えた実測（深度 16 のまま）: 一様グレー **0.0000%**、市松 0/255 **−0.0527%**、
  //     暗い画像 0.0003%、飽和した色ノイズ −0.0018%、明暗の勾配 0.0059%
  //
  // 柵は観測された最大 0.0527% の **3.8 倍**の位置にある。**余裕は大きくない。**
  // しかも欠損は零平均の雑音ではなく値の決定的な関数なので、**フラグメント数では均されない**
  // （同じフラグメントを 1 万個並べても `dev` は 1 個のときと 1 ビットも変わらない）。
  // → 未知の標本でここが赤くなったら、欠陥の証拠ではなく**柵を引き直す合図**でありうる。
  //
  // **両側で見る。** 切り捨ては片側にしか外れないが、`Δ` は差なので符号は片側ではない ──
  // 代数でも上下ともに `n·2⁻¹⁰` まで構成でき（実測 +1.4423% / −1.4580%）、
  // 実測でも標本によって符号が反転している。
  //
  // ## この行が見ないもの（2b の記述を訂正した）
  //
  // 2b は「一様な**乗法的**な欠損は現れない。切り捨てはほぼ乗法的なのでここはほぼ 0 を出す」と
  // 書いていた。前半は正しいが、**後半は確かめていない一般化だった**。厳密に言えるのは
  // **`B = A` なら `Δ = 0`** だけで、これは RTZ が 2 冪倍と可換（`S(2a) = 2S(a)`）だからである。
  // **`B = 2A` では既に成り立たない**（`1 + 2` は 2 冪ではない。実測最大 2.39%）。
  // → 捕まえられるのは飽和・非正規数の潰れ・クリップのような**非線形**な機構であり、
  //   構造的に捕まえられないのは **image と mean が一致する画素**（一様グレー）だけである。
  //   実測の「一様グレー 0.0000%」はまさにこの退化で、機構について何も言っていない。
  for (const g of r.G12 ?? []) {
    record('G12', `d=${g.d} 積分光量の重ね合わせ（幾何固定・色場だけ差し替え）`, '|ずれ| ≤ 0.2%',
      `${(g.dev * 100).toFixed(4)}%`, Math.abs(g.dev) <= 0.002,
      `I(A) ${g.Ia.toExponential(4)} / I(B) ${g.Ib.toExponential(4)}`
      + ` / I(A+B) ${g.Iab.toExponential(4)} / 深度 ${g.depth} / 点 ${g.points}`
      + ` / extent ${g.extent.join(',')}`,
      { site: 'G12/dev', value: Math.abs(g.dev), limit: 0.002, dir: 'le' });
  }
  if (r.G13) {
    record('G13', '光過敏の配慮: オンで画素が動かない', '60 フレームで画素一致',
      String(r.G13.on.identical), r.G13.on.identical && r.G13.on.applied === true,
      `配慮の適用 ${r.G13.on.applied}`);
    // **こちら側が本体。** 2a までの実装は「オンで動かない」を満たしていた
    //（配慮に関係なく、何もしていなかったので）
    record('G13', '光過敏の配慮: **オフでは動く**', '60 フレームで画素が変わる',
      String(!r.G13.off.identical), !r.G13.off.identical && r.G13.off.applied === false,
      '両側を見ないと「常に止まっている実装」でも緑になる');
  }
  if (r.G14) {
    /**
     * **採点は「投票」である。** 1 ケースで 1 つに絞れることは要求しない ──
     * `selftest-exact` は 4 モデルとも 1.75 だし、`f16-vs-f32` は 3 モデルが一致する。
     * **設計上そうなっている**（どのケースがどの組を分けるかは `blendCases()` に書いてある）。
     *
     * 各ケースに要求するのは「**観測されたモデルが候補に残っていること**」だけで、
     * 「1 つに絞れたか」は**全ケースの積集合**に対して 1 行だけ問う。
     * 初版はケースごとに `matches.length === 1` を要求して 2 行落とした ──
     * 器具ではなく**採点者が間違っていた**。
     */
    for (const g of r.G14) {
      const ok = g.glError === 0 && g.channelsEqual && g.matches.includes(r.observedModel);
      record('G14', `加算合成 ${g.key}（K=${g.count}）`,
        `${r.observedModel} が候補に残る`,
        g.matches.length ? g.matches.join('+') : '**どのモデルとも一致しない**', ok,
        `実測 ${g.rgb[0].toPrecision(9)}`
        + ` / ${r.modelKeys.map((k) => `${k} ${g.predicted[k].toPrecision(6)}`).join(' / ')}`);
    }
    // **全ケースを通過したモデルはただ 1 つ**でなければならない（＝ 機構が同定できた）
    let survivors = r.modelKeys.slice();
    for (const g of r.G14) survivors = survivors.filter((k) => g.matches.includes(k));
    record('G14', '**全 6 ケースを通過したモデル**', `${r.observedModel} ただ 1 つ`,
      survivors.length ? survivors.join('+') : '（無し）',
      survivors.length === 1 && survivors[0] === r.observedModel,
      '2 つ以上残るなら入力が機構を分けていない（`x/x`）。0 なら 4 つとも外している');
    // 器具そのものの健全性（3 チャンネルが独立に同じ答えを出すこと）
    const chan = r.G14.every((g) => g.channelsEqual);
    record('G14', '3 チャンネルが同じ値を返す', 'true', String(chan), chan,
      'チャンネルごとに違う丸めをする実装なら、ここが先に落ちる');
  }
  if (r.G15) {
    record('G15', 'アンカーでは配線が絵を動かさない', `0 / ${r.G15.totalBytes} バイト相違`,
      `${r.G15.anchorDiffBytes} バイト`, r.G15.anchorDiffBytes === 0,
      `強度 ${r.G15.strengthAtAnchor}（rotationGate が厳密に 0 を返す）`);
    record('G15', '**門が開くと配線が絵を動かす**', '> 0 バイト相違',
      `${r.G15.openDiffBytes} / ${r.G15.totalBytes} バイト`, r.G15.openDiffBytes > 0,
      `強度 ${r.G15.strengthAtOpen.toFixed(4)} —— これが無い状態が 2a まで続いていた`);
    // **「位相 0 で」を見出しに入れる**（Phase 2c）── 2b はこれを書かなかったので、
    // この行が「どんな位相でも 1.0 以下」を主張していると読めた。実際は位相 0 だけである。
    record('G15', '配線ありで HDR の峰が 1.0 以下（**位相 0**）', '≤ 1.0',
      r.G15.peakWired.toFixed(5),
      r.G15.peakWired <= 1.0,
      `配線なしなら ${r.G15.peakOff.toFixed(5)} —— 位相を流したときは G16 が見る`,
      { site: 'G15/peakWired', value: r.G15.peakWired, limit: 1.0, dir: 'le' });
    record('G15', '配線なしでは峰が 1.0 を超えている（圧縮する物が実在する）', '> 1.0',
      r.G15.peakOff.toFixed(5), r.G15.peakOff > 1.0,
      '超えていないなら、この配線は何も主張していない',
      { site: 'G15/peakOff', value: r.G15.peakOff, limit: 1.0, dir: 'gt' });
  }
  if (r.G16) {
    const g = r.G16;
    // 1. **記録値は包絡ではない。** 位相を流せば必ず超える ── 超えないなら掃けていない
    record('G16', `生の峰が記録値を超える（d=${g.d}・位相 ${g.gatedSeconds}s を流す）`,
      `> ${g.recordedEnvelope}`, g.rawPeak.toFixed(5),
      g.rawPeak > g.recordedEnvelope,
      `記録値の ${(g.rawPeak / g.recordedEnvelope).toFixed(1)} 倍`
        + ` / fill.x ${g.fillX.toFixed(4)} / カメラ距離 ${g.cameraDistance.toFixed(3)}`,
      { site: 'G16/rawPeak', value: g.rawPeak, limit: g.recordedEnvelope, dir: 'gt' });
    // 2. **本命。** 圧縮は上限 `knee + 1/s = 1` の全単射なので、峰がいくつでもクリップしない。
    //    2b の設計（有限の設計峰）ではここが 1.026 になり落ちる
    record('G16', '**配線ありで峰が 1.0 未満（位相を流しても）**', '< 1.0',
      g.wiredPeak.toFixed(5), g.wiredPeak < 1.0,
      `強度 ${g.strength.toFixed(4)} / 生の峰 ${g.rawPeak.toFixed(2)} —— `
        + '有限の設計峰から逆算する設計では上限が 1.026 になり、ここが落ちる',
      { site: 'G16/wiredPeak', value: g.wiredPeak, limit: 1.0, dir: 'lt' });
  }
  if (r.G11) {
    record('G11a', '帯からのはみ出し', '≤ 1.00', r.G11.maxFill.toFixed(4), r.G11.maxFill <= 1.0,
      '', { site: 'G11a/maxFill', value: r.G11.maxFill, limit: 1.0, dir: 'le' });
    record('G11b', '近平面の余裕', '≥ 0.25 world', r.G11.minMargin.toFixed(4),
      r.G11.minMargin >= 0.25, '',
      { site: 'G11b/minMargin', value: r.G11.minMargin, limit: 0.25, dir: 'ge' });
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
        buffer: buf, offset: off, spritePx: s.spritePx, depth: s.modelledAdditionDepth,
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
      + ` / 水準 ${r.levelPct.toFixed(2)}% / S ${r.spritePx.toFixed(3)} / 深度 ${r.depth}`,
      odd ? { site: 'G9z/deltaE', value: r.deltaE, limit: 3.0, dir: 'le' } : null);
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
