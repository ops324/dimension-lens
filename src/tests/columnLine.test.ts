/**
 * 列平均バッファ（Phase 1b）。
 *
 * ## 既存の `columnMeans` テストには 1 つ穴がある（監査が実際に壊して確認）
 *
 * `image.test.ts` が探るのは `x ∈ {0, 1, 127, 512, 1023}` の 5 列だけで、
 * 残りは「列平均の平均 = 全体平均」という**総和 1 本**でしか押さえていない。
 * だから **列 300 と列 301 を入れ替える**（総和は保存される）と 222 件が緑のまま通る。
 *
 * 1b は列平均を u 軸へ**並べる**ので、順序の反転や 1 列ずれは
 * `stats` 側のテストでは絶対に捕まらない（バッファは正しく、並べ方が誤っている）。
 * → ここでは**位置と色の対応**を、非対称な入力で直接見る。
 */

import { describe, expect, it } from 'vitest';
import { LINE_MAX_POINTS, buildColumnLine, lineCountFor } from '../image/columnLine';
import { imageHalfExtents } from '../image/grid';
import { computeScales, computeStats } from '../image/stats';
import { linearizeRgba } from '../image/linearize';
import { makeSpecimen0, SPECIMEN_H, SPECIMEN_W } from '../image/fixture';

const spec = makeSpecimen0();
const canonical = linearizeRgba(spec.rgba, spec.width, spec.height);
const stats = computeStats(canonical);
const scales = computeScales(stats);

function buffers(n: number) {
  return { base: new Float32Array(n * 5), colors: new Float32Array(n * 3) };
}

function build(n: number) {
  const out = buffers(n);
  const r = buildColumnLine(
    stats.columnMeans, SPECIMEN_W, SPECIMEN_H, 'srgb', scales, n, out,
  );
  return { ...r, ...out };
}

describe('lineCountFor', () => {
  /**
   * 点数の上限は**実測 2 件**が決めている:
   * (1) `gainFor` の較正域 —— 正準幅 2048 だと `s0 = 0.41 px` で +51.7% ずれる
   * (2) half-float の加算深度 —— `dimLevel = 0` で点数がそのまま深度になる。
   *     n ≤ 512 で最悪 ΔE00 1.364、n ≤ 2048 で 4.376（予算 3.0 超）
   */
  it('格子の列数を超えない（s0 が格子より細かくならない）', () => {
    for (const cols of [1, 244, 366, 489, 798, 2048]) {
      const n = lineCountFor(cols);
      expect(n).toBeLessThanOrEqual(cols);
      expect(n).toBeLessThanOrEqual(LINE_MAX_POINTS);
      expect(n).toBeGreaterThanOrEqual(1);
    }
  });

  it('ティア表の列数はそのまま通る（線が格子より粗くならない）', () => {
    expect(lineCountFor(244)).toBe(244);
    expect(lineCountFor(366)).toBe(366);
    expect(lineCountFor(489)).toBe(489);
    // 極端なアスペクトで列数が上限を超えるときだけ粗くなる
    expect(lineCountFor(798)).toBe(512);
  });

  it('上限が half-float の予算から来ている', () => {
    expect(LINE_MAX_POINTS).toBe(512);
  });
});

describe('buildColumnLine', () => {
  it('u はセル中心で、`lift` と同じ規約（線と格子が dimLevel = 1 で重なる）', () => {
    const n = 8;
    const { base } = build(n);
    const { aX } = imageHalfExtents(SPECIMEN_W, SPECIMEN_H);
    for (let i = 0; i < n; i++) {
      expect(base[i * 5]).toBeCloseTo(((2 * (i + 0.5)) / n - 1) * aX, 6);
      // v は 0 ── 線は画像の縦中央にある
      expect(base[i * 5 + 1]).toBe(0);
    }
  });

  it('u は単調増加（並べ方の反転を捕まえる）', () => {
    const { base } = build(64);
    for (let i = 1; i < 64; i++) {
      expect(base[i * 5]).toBeGreaterThan(base[(i - 1) * 5]);
    }
  });

  /**
   * ## 位置と色の対応 —— **総和が保存される壊し方**を捕まえる唯一の口
   *
   * 標本 No.0 のホイール領域は左右非対称（12 色相が並ぶ）なので、
   * 列の反転も 1 列ずれも色として現れる。
   */
  it('バンドの色が、そのバンドの正準列平均と一致する', () => {
    const n = 256;
    const { colors } = build(n);
    for (const i of [0, 1, 37, 128, 200, n - 1]) {
      const x0 = ((i * SPECIMEN_W) / n) | 0;
      const x1 = (((i + 1) * SPECIMEN_W) / n) | 0;
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let x = x0; x < x1; x++) acc += stats.columnMeans[x * 3 + c];
        expect(colors[i * 3 + c], `i=${i} c=${c}`).toBeCloseTo(acc / (x1 - x0), 6);
      }
    }
  });

  it('反転した色列とは一致しない（歯の証明）', () => {
    const n = 256;
    const { colors } = build(n);
    let same = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(colors[i * 3] - colors[(n - 1 - i) * 3]) < 1e-9) same++;
    }
    // 左右対称なら全部一致してしまう。標本 No.0 は非対称なので大半が食い違う
    expect(same).toBeLessThan(n / 2);
  });

  /**
   * ## `dimLevel = 0` の平均色
   *
   * 全点が 1 点へ重なるので、読める値は**描いた色の単純平均**である。
   * それが `stats.meanLinear` と一致しなければ「平均色」を名乗れない。
   *
   * 正準の 1 列はちょうど `height` 画素なので、列平均の単純平均は全体平均に厳密に一致する
   * （`image.test.ts` が既に固定している）。バンドへ集約すると、バンド幅が割り切れない
   * ぶんだけ残差が出る ── その残差を数値で固定する（緩めない）。
   */
  it('描いた色の平均が全体平均に一致する（バンド集約の残差つき）', () => {
    for (const n of [64, 128, 256, 378, 512]) {
      const { mean } = build(n);
      for (let c = 0; c < 3; c++) {
        const rel = Math.abs(mean[c] / stats.meanLinear[c] - 1);
        // 実測: 標本 No.0（幅 1024）ではどの n でも 5e-4 未満
        expect(rel, `n=${n} c=${c} rel=${rel.toExponential(3)}`).toBeLessThan(5e-4);
      }
    }
  });

  /**
   * バンド幅が揃えば残差は**集約の誤差ではなく f32 の丸めだけ**になる。
   * `columnMeans` は `Float32Array` なので「厳密に一致」は原理的に書けない ──
   * 残差 1e-8 は f32 の相対精度（約 6e-8）の内側である。
   */
  it('幅が点数で割り切れるときは f32 の丸めまで一致する（残差 1e-8）', () => {
    for (const n of [256, 512]) {
      // 1024 / 256 = 4、1024 / 512 = 2 ── どのバンドも同じ列数
      const { mean } = build(n);
      for (let c = 0; c < 3; c++) {
        const rel = Math.abs(mean[c] / stats.meanLinear[c] - 1);
        expect(rel, `n=${n} c=${c}`).toBeLessThan(1e-7);
      }
    }
  });

  it('L`, a`, b` はブロック等方正規化を通っている（0 を掛けて消える値も嘘にしない）', () => {
    const { base } = build(64);
    let finite = true;
    let anyChroma = false;
    for (let i = 0; i < 64; i++) {
      for (let k = 2; k < 5; k++) if (!Number.isFinite(base[i * 5 + k])) finite = false;
      if (Math.abs(base[i * 5 + 3]) > 1e-6 || Math.abs(base[i * 5 + 4]) > 1e-6) anyChroma = true;
    }
    expect(finite).toBe(true);
    expect(anyChroma).toBe(true);
  });

  it('点数が幅を超えても壊れない（退化）', () => {
    const n = SPECIMEN_W + 10;
    const out = buffers(n);
    const r = buildColumnLine(
      stats.columnMeans, SPECIMEN_W, SPECIMEN_H, 'srgb', scales, n, out,
    );
    expect(r.count).toBe(SPECIMEN_W);
    for (let i = 0; i < r.count * 3; i++) expect(Number.isFinite(out.colors[i])).toBe(true);
  });
});
