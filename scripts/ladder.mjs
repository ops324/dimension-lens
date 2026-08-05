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
 * **ただし Phase 2a では CI にまだ載せていない（水準 C）。**
 * `channel: 'chrome'` が GitHub の runner に在るかを、ここから確かめる手段が無い ──
 * 確かめずに `deploy.yml` へ足せば、それは §0.1 の規律 2
 * 「ツールのバージョンを書く前に API を叩く」を破ることになる。
 * 載せるのは、runner で `--structural` が通ることを 1 度実測した PR である。
 * それまでは**ローカルのリリースゲート**で、PR に数値を貼る運用が hard gate を担う。
 *
 * 使い方:
 *   npm run ladder              フル（実 GPU・予算判定あり）
 *   npm run ladder -- --structural   構造回帰のみ（CI 用）
 *   npm run ladder -- --json    JSON も出す
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
  s0: 2.247830687830687,
  gain: 0.4530724335144705,
  cameraDistance: 1.9635938049105979,
  cascadeDist: 3.38382867097012,
  gridW: 378,
  gridH: 236,
  meanHex: '#8d8d8e',
  fillX: 0.86,
};

const args = process.argv.slice(2);
const STRUCTURAL = args.includes('--structural');
const AS_JSON = args.includes('--json');

const rows = [];
let failures = 0;

function record(id, what, budget, measured, ok, note = '') {
  rows.push({ id, what, budget, measured, ok, note });
  if (!ok) failures++;
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
      () => document.documentElement.dataset.lensRender === 'ok',
      null,
      { timeout: 30_000 },
    );

    const gl = await page.evaluate(() => window.__LENS__.glInfo());
    const traces = await page.evaluate(() => ({ ...document.documentElement.dataset }));

    // ---- 測定 viewport を固定する（これが無いと以降のどの数値も §7.7 と比較できない）
    const buffer = await page.evaluate(
      ([w, h]) => window.__LENS__.setViewport(w, h),
      [MEASURE_CSS.w, MEASURE_CSS.h],
    );

    record(
      'ENV',
      'drawingBuffer',
      `${MEASURE_BUFFER.width}×${MEASURE_BUFFER.height}`,
      `${buffer.width}×${buffer.height}`,
      buffer.width === MEASURE_BUFFER.width && buffer.height === MEASURE_BUFFER.height,
    );
    record('ENV', '読み戻しの自己検査', 'ok', traces.lensCapture ?? '(なし)',
      traces.lensCapture === 'ok');
    record('ENV', 'HDR 読み戻しの自己検査', 'ok', traces.lensCaptureHdr ?? '(なし)',
      traces.lensCaptureHdr === 'ok');
    record('ENV', '取り込み', 'ok', traces.lensIngest ?? '(なし)', traces.lensIngest === 'ok');
    record('ENV', '描画', 'ok', traces.lensRender ?? '(なし)', traces.lensRender === 'ok');

    // ---- アンカー（CPU で決まる。ラスタライザに依らないので CI でも権威がある）
    const anchors = await page.evaluate(() => {
      const L = window.__LENS__;
      L.setDimLevel(2);
      L.freezeRotation(true);
      L.resetRotation();
      L.setBloom(false);
      L.setGrade(false);
      L.setCompress(false);
      L.renderOnce(2);
      const s = L.sceneStats();
      const st = L.stats();
      return {
        s0: s.s0, gain: s.gain, cameraDistance: s.cameraDistance, cascadeDist: s.cascadeDist,
        gridW: s.gridW, gridH: s.gridH, fillX: s.fill.x, meanHex: st.meanHex,
        sampleWeight: s.sampleWeight, additionDepth: s.additionDepth, spritePx: s.spritePx,
      };
    });
    for (const k of ['s0', 'gain', 'cameraDistance', 'cascadeDist', 'gridW', 'gridH', 'fillX']) {
      record('ENV', `アンカー ${k}`, String(ANCHORS[k]), String(anchors[k]),
        Object.is(anchors[k], ANCHORS[k]), 'Object.is');
    }
    record('ENV', 'アンカー meanHex', ANCHORS.meanHex, anchors.meanHex,
      anchors.meanHex === ANCHORS.meanHex);
    record('G7', 'sampleWeight (d=2)', '厳密に 1', String(anchors.sampleWeight),
      Object.is(anchors.sampleWeight, 1), 'Object.is');

    if (!STRUCTURAL) {
      await measureLadder(page);
      await measureZeroPhase(context);
    }

    record('ENV', 'コンソールエラー', '0', String(consoleErrors.length),
      consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

    report(gl, buffer);
  } finally {
    await browser?.close();
    dev.kill('SIGTERM');
    await sleep(200);
  }
  process.exit(failures > 0 ? 1 : 0);
}

/** 読み戻しに依存する行（§7.6 の「毎フェーズ要るのは G0/G2/G4/G5 と G8〜G11」） */
async function measureLadder(page) {
  const r = await page.evaluate(async () => {
    const L = window.__LENS__;
    const { deltaE2000Linear } = await import('/src/color/deltaE.ts');
    const { primariesFor } = await import('/src/color/oklab.ts');
    const { srgbToLinear, linearToCode } = await import('/src/color/srgb.ts');
    const { spritePhaseFactor, centreFragmentOffset } = await import('/src/image/spriteGain.ts');
    const P = primariesFor('srgb');
    const dE = (a, b) => deltaE2000Linear(P, a, b);
    const lin = (v) => srgbToLinear(v / 255);
    const B = { w: 988, h: 778 };

    const setup = (d, path) => {
      L.setBloom(false); L.setGrade(false); L.setCompress(false);
      L.setPath(path ?? 'auto');
      L.setDimLevel(d);
      L.freezeRotation(true);
      L.resetRotation();
      L.renderOnce(3);
    };
    const px = async (x, y, w, h) => L.readback(x, y, w, h);
    const meanOf = async (x, y, w, h) => {
      const p = await px(x, y, w, h);
      let a = 0, b = 0, c = 0;
      const n = (p.length / 4) | 0;
      for (let i = 0; i < n; i++) { a += lin(p[i * 4]); b += lin(p[i * 4 + 1]); c += lin(p[i * 4 + 2]); }
      return [a / n, b / n, c / n];
    };
    /** 画像画素 → drawingBuffer 座標（原点左下）。板は帯に fill 比で収まっている */
    const toBuf = (ix, iy, fill, W, H) => {
      const ndcX = (2 * (ix / W) - 1) * fill.x;
      const ndcY = (1 - 2 * (iy / H)) * fill.y;
      return { x: ((ndcX + 1) / 2) * B.w, y: ((ndcY + 1) / 2) * B.h };
    };

    const out = {};

    // ---------- G0: 板の外側は厳密に 0
    setup(2, 'plate');
    const corners = [];
    for (const [x, y] of [[0, 0], [B.w - 1, 0], [0, B.h - 1], [B.w - 1, B.h - 1]]) {
      const p = await px(x, y, 1, 1);
      corners.push([p[0], p[1], p[2]]);
    }
    out.G0 = { corners, ok: corners.every((c) => c[0] === 0 && c[1] === 0 && c[2] === 0) };

    // ---------- G2a / G4: 板経路と雲経路
    const s2 = L.sceneStats();
    const fill = s2.fill;
    const W = 1024, H = 640;
    const flat = { x: 384, y: 256, w: 256, h: 256 };
    const target128 = [lin(128), lin(128), lin(128)];

    const regionMean = async (reg) => {
      const a = toBuf(reg.x + reg.w * 0.35, reg.y + reg.h * 0.65, fill, W, H);
      const b = toBuf(reg.x + reg.w * 0.65, reg.y + reg.h * 0.35, fill, W, H);
      const x0 = Math.round(Math.min(a.x, b.x)), y0 = Math.round(Math.min(a.y, b.y));
      const w = Math.max(2, Math.round(Math.abs(b.x - a.x)));
      const h = Math.max(2, Math.round(Math.abs(b.y - a.y)));
      return meanOf(x0, y0, w, h);
    };

    for (const path of ['plate', 'cloud']) {
      setup(2, path);
      const m = await regionMean(flat);
      out['G2a_' + path] = { deltaE: dE(m, target128), measured: m.map(linearToCode) };
      if (path === 'cloud') {
        // G2b: 実効ゲイン = 読めた値 / 意図した値 − 1
        out.G2b = { errPct: 100 * (m[1] / target128[1] - 1) };
      }
      // G4: ホイール 24 パッチ
      const patchW = Math.floor(1024 / 12), patchH = Math.floor(160 / 2);
      let worst = 0; const hueRes = [];
      const { linearToOklab } = await import('/src/color/oklab.ts');
      const labM = new Float64Array(3), labT = new Float64Array(3);
      const { makeSpecimen0, REGIONS } = await import('/src/image/fixture.ts');
      const spec = makeSpecimen0();
      for (let row = 0; row < 2; row++) {
        for (let k = 0; k < 12; k++) {
          const reg = {
            x: REGIONS.wheel.x + k * patchW, y: REGIONS.wheel.y + row * patchH,
            w: patchW, h: patchH,
          };
          const m2 = await regionMean(reg);
          const cx = reg.x + (patchW >> 1), cy = reg.y + (patchH >> 1);
          const o = (cy * W + cx) * 4;
          const t = [lin(spec.rgba[o]), lin(spec.rgba[o + 1]), lin(spec.rgba[o + 2])];
          const d = dE(m2, t);
          if (d > worst) worst = d;
          linearToOklab(P, m2[0], m2[1], m2[2], labM);
          linearToOklab(P, t[0], t[1], t[2], labT);
          let dh = Math.atan2(labM[2], labM[1]) - Math.atan2(labT[2], labT[1]);
          while (dh > Math.PI) dh -= 2 * Math.PI;
          while (dh < -Math.PI) dh += 2 * Math.PI;
          hueRes.push((dh * 180) / Math.PI);
        }
      }
      const mean = hueRes.reduce((a, b) => a + b, 0) / hueRes.length;
      const sd = Math.sqrt(hueRes.reduce((a, b) => a + (b - mean) ** 2, 0) / hueRes.length);
      out['G4_' + path] = { worstDeltaE: worst, meanHueDeg: mean, sdHueDeg: sd };
    }

    // ---------- G5: 板の拡大補間がリニア光か（専用プローブ）
    setup(2, 'plate');
    const t5 = L.sampleTexel(REGIONS_CHECKER_X(), 249);
    out.G5 = t5 ? { code: linearToCode(t5.rgb[0] / 255), raw: t5.rgb[0], glError: t5.glError } : null;
    function REGIONS_CHECKER_X() { return 10; }

    /**
     * ---------- 潰しの行の**独立な採点者**
     *
     * SPEC §7.1 の「参照実装は独立に書く」── `buildColumnLine` の戻り値を
     * 採点に使うと、実装を写した数と実装を比べることになる（`reconstructMean` 病）。
     * ここでは標本の画素から**この場で**リニア列平均を作り直し、`n` 本のバンドへ畳む。
     * 使うのは `srgbToLinear` だけで、これは `color.test.ts` が区分関数として固定している。
     */
    const { makeSpecimen0: mk0 } = await import('/src/image/fixture.ts');
    const spec0 = mk0();
    const colMean = (() => {
      const W0 = spec0.width, H0 = spec0.height;
      const out2 = new Float64Array(W0 * 3);
      for (let x = 0; x < W0; x++) {
        let r = 0, g = 0, b = 0;
        for (let y = 0; y < H0; y++) {
          const o = (y * W0 + x) * 4;
          r += srgbToLinear(spec0.rgba[o] / 255);
          g += srgbToLinear(spec0.rgba[o + 1] / 255);
          b += srgbToLinear(spec0.rgba[o + 2] / 255);
        }
        out2[x * 3] = r / H0; out2[x * 3 + 1] = g / H0; out2[x * 3 + 2] = b / H0;
      }
      return out2;
    })();
    /** `n` 本のバンドの平均（`buildColumnLine` と同じ floor 分割を、独立に書き直す） */
    const bandMean = (i, n) => {
      const W0 = spec0.width;
      const x0 = ((i * W0) / n) | 0, x1 = (((i + 1) * W0) / n) | 0;
      let r = 0, g = 0, b = 0, k = 0;
      for (let x = x0; x < x1; x++) {
        r += colMean[x * 3]; g += colMean[x * 3 + 1]; b += colMean[x * 3 + 2]; k++;
      }
      return k ? [r / k, g / k, b / k] : [0, 0, 0];
    };
    /** 図の中心が読むべき値。`n` が偶数なら中心は 2 バンドのちょうど境目にある */
    const centreTarget = (n) => {
      if (n <= 1) {
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < spec0.width; i++) {
          r += colMean[i * 3]; g += colMean[i * 3 + 1]; b += colMean[i * 3 + 2];
        }
        return [r / spec0.width, g / spec0.width, b / spec0.width];
      }
      const lo = Math.floor((n - 1) / 2), hi = Math.ceil((n - 1) / 2);
      const a = bandMean(lo, n), b2 = bandMean(hi, n);
      return [0, 1, 2].map((c) => (a[c] + b2[c]) / 2);
    };

    // ---------- G8 / G9: 潰しの行（**位相を明示して再構成する**）
    const collapse = {};
    for (const d of [1, 0.5, 0]) {
      setup(d, 'auto');
      const s = L.sceneStats();
      const off = centreFragmentOffset(B.w, B.h);
      // 図の中心は NDC 原点 → (W/2, H/2)。その周りの 2×2 を読む
      const cx = B.w / 2, cy = B.h / 2;
      const p = await px(Math.floor(cx) - 1, Math.floor(cy) - 1, 2, 2);
      const quad = [];
      for (let i = 0; i < 4; i++) quad.push([p[i * 4], p[i * 4 + 1], p[i * 4 + 2]]);
      /**
       * **位相モデルの前提を、割る前に測る。**
       *
       * y は必ず潰れているので、上下 2 行は同じ減衰を受ける ── 一致しなければ
       * 「図が 1 本/1 個のスプライトである」という前提が崩れており、
       * そのときは再構成してはいけない（モデルで割った数を A として書くと、
       * それは §0.1 規律 4 の「測っていない数を測った数の書式で書く」になる）。
       */
      const rowLo = (quad[0][0] + quad[1][0]) / 2;
      const rowHi = (quad[2][0] + quad[3][0]) / 2;
      const rowSpread = Math.abs(rowHi - rowLo);
      // 縦だけ潰れる d=1 では x 方向は格子なので位相は x に掛からない
      const ox = s.linePoints <= 1 ? off.x : 0;
      const phase = spritePhaseFactor(ox, off.y, s.spritePx);
      const meas = [0, 1, 2].map((c) => quad.reduce((a, q) => a + lin(q[c]), 0) / 4);
      const recon = meas.map((v) => v / phase);
      const target = centreTarget(s.linePoints);
      collapse['d' + d] = {
        buffer: s.buffer, linePoints: s.linePoints, depth: s.additionDepth,
        sampleWeight: s.sampleWeight, spritePx: s.spritePx,
        plateau: quad.map((q) => q[0]), rowSpread,
        phase, measuredCode: meas.map(linearToCode), reconCode: recon.map(linearToCode),
        targetCode: target.map(linearToCode), deltaE: dE(recon, target),
        levelPct: 100 * (recon[1] / target[1] - 1),
      };
    }
    out.collapse = collapse;

    // ---------- G10: 加算深度
    const depths = [];
    for (let d = 0; d <= 5; d += 0.25) { setup(d, 'auto'); depths.push([d, L.sceneStats().additionDepth]); }
    out.G10 = { max: Math.max(...depths.map((x) => x[1])), depths };

    // ---------- G11: 帯からのはみ出しと近平面の余裕
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

    return out;
  });

  const meanTarget = 0; // 参照は下で JS 側から

  record('G0', '背景（四隅）', '厳密 0', JSON.stringify(r.G0.corners[0]), r.G0.ok);
  for (const path of ['plate', 'cloud']) {
    const g = r['G2a_' + path];
    record('G2a', `平坦部（${path}）`, 'ΔE00 ≤ 2.0', g.deltaE.toFixed(4), g.deltaE <= 2.0);
    const h = r['G4_' + path];
    record('G4', `ホイール 24（${path}）`, 'ΔE00 ≤ 2.0', h.worstDeltaE.toFixed(4),
      h.worstDeltaE <= 2.0);
    record('G4', `平均色相残差（${path}）`, '≤ 0.5°', `${h.meanHueDeg.toFixed(4)}° (sd ${h.sdHueDeg.toFixed(3)}°)`,
      Math.abs(h.meanHueDeg) <= 0.5);
  }
  record('G2b', '実効ゲイン（雲）', '±2%', `${r.G2b.errPct.toFixed(3)}%`,
    Math.abs(r.G2b.errPct) <= 2);
  if (r.G5) {
    record('G5', '板の拡大補間', 'sRGB 188', String(r.G5.code),
      Math.abs(r.G5.code - 188) <= 1, `生値 ${r.G5.raw}`);
  }

  const c = r.collapse;
  const collapseRow = (id, key, label, budget) => {
    const g = c[key];
    // 前提（上下 2 行が一致）が崩れていたら、再構成そのものを認めない
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
  record('G11a', '帯からのはみ出し', '≤ 1.00', r.G11.maxFill.toFixed(4), r.G11.maxFill <= 1.0);
  record('G11b', '近平面の余裕', '≥ 0.25 world', r.G11.minMargin.toFixed(4),
    r.G11.minMargin >= 0.25);

  ladderRaw = r;
  void meanTarget;
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
 *
 * この構成では峰は 2×2 ではなく**単一画素**になるはずで、その生の値が
 * そのまま平均色でなければならない。割り算は 1 回も出てこない。
 */
async function measureZeroPhase(context) {
  const page = await context.newPage();
  try {
    // deviceScaleFactor は context 単位なので、CDP で this page だけ上書きする
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
      // 中心の画素（奇数寸法なら floor(W/2) がその画素）と、その周りの 3×3
      const cx = Math.floor(buf.width / 2), cy = Math.floor(buf.height / 2);
      const p = await L.readback(cx - 1, cy - 1, 3, 3);
      const at = (i, j) => [p[((j * 3 + i) * 4)], p[(j * 3 + i) * 4 + 1], p[(j * 3 + i) * 4 + 2]];
      const centre = at(1, 1);
      let uniqueMax = true;
      for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 3; i++) {
          if ((i !== 1 || j !== 1) && at(i, j)[0] >= centre[0]) uniqueMax = false;
        }
      }
      // 目標は標本の**全画素**のリニア平均（この場で独立に作る）
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
        buffer: buf, offset: off, spritePx: s.spritePx, s0: s.s0,
        linePoints: s.linePoints, depth: s.additionDepth, calibrated: s.calibrated,
        centre, uniqueMax, field: [at(0, 1)[0], at(1, 1)[0], at(2, 1)[0]],
        measCode: meas.map(linearToCode), targetCode: target.map(linearToCode),
        deltaE: deltaE2000Linear(P, meas, target),
        levelPct: 100 * (meas[1] / target[1] - 1),
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
  const width = [6, 34, 26, 40];
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
  console.log('  ' + '-'.repeat(112));
  for (const r of rows) {
    console.log(line(r.id, r.what, String(r.budget), `${r.measured}${r.note ? `  [${r.note}]` : ''}`,
      r.ok ? '  ✅' : '  ❌'));
  }
  console.log('');
  console.log(`  ${rows.length} 行 / 通過 ${rows.length - failures} / 失敗 ${failures}`);
  if (AS_JSON) console.log('\nJSON\n' + JSON.stringify({ gl, buffer, rows, raw: ladderRaw, zeroPhase: zeroPhaseRaw }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
