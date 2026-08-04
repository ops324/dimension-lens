/**
 * 色相不変性 —— **この作品の看板の主張を真にする唯一のテスト。**
 *
 * 主張: 平面 (3,4) の回転は OKLab の色相回転そのものである。
 *   A1  彩度 √(a²+b²) が不変
 *   A2  色相角がちょうど θ 進む
 *   A3  他ブロック(u, v, L)へ漏れない
 *   A4  **軸ごとスケールにすると A1 が破れる**
 *
 * A4 は省略できない。SPEC §0.1 項目 6 が記録しているとおり、この主張の**偽の版**が
 * 生き延びたのは、誰もテストを落としてみなかったからである。
 * 通る場合だけを確かめるテストは、歯があることを証明しない。
 *
 * 測るのは**正規化空間ではなく OKLab 空間**。正規化空間では A1/A2 は
 * 直交ペアの平面回転にすぎず恒真になる。`s_a === s_b` であることが、
 * その性質を OKLab へ運ぶ ── そこが主張の中身。
 */

import { describe, expect, it } from 'vitest';
import { composeRotN, applyMatrixBatch } from '../math/rotationN';
import { wrapPi } from '../math/angle';
import { makeSpecimen0 } from '../image/fixture';
import { linearizeRgba } from '../image/linearize';
import { computeScales, computeStats } from '../image/stats';
import { lift } from '../image/lift';
import { fitGrid } from '../image/grid';

const N = 5;

/** 実際のパイプラインから base を作る —— 手書き配列ではなく `lift()` の出力を試す */
function pipelineBase(): { base: Float64Array; count: number; sC: number } {
  const spec = makeSpecimen0();
  const canonical = linearizeRgba(spec.rgba, spec.width, spec.height);
  const stats = computeStats(canonical);
  const scales = computeScales(stats);
  const grid = fitGrid(spec.width, spec.height, 4000);
  const count = grid.cols * grid.rows;
  const out = { base: new Float32Array(count * N), colors: new Float32Array(count * 3) };
  lift(canonical, grid, scales, out);
  return { base: Float64Array.from(out.base), count, sC: scales.sC };
}

describe('色相不変性(平面 (3,4))', () => {
  const { base, count, sC } = pipelineBase();

  it('sC は退化していない(標本にはちゃんと色がある)', () => {
    expect(sC).toBeGreaterThan(0.01);
    expect(sC).toBeLessThan(0.4);
  });

  for (const theta of [0.1, 0.7, Math.PI / 3, 2.0, Math.PI, -1.3]) {
    it(`θ=${theta.toFixed(4)}: 彩度不変 かつ 色相がちょうど θ 進む`, () => {
      const m = composeRotN([{ i: 3, j: 4, angle: theta }], N, new Float64Array(N * N));
      const rotated = new Float64Array(base.length);
      applyMatrixBatch(base, rotated, N, count, m);

      let checked = 0;
      for (let v = 0; v < count; v++) {
        const o = v * N;
        // **OKLab へ戻してから測る** —— 主張は OKLab で立っている
        const a0 = base[o + 3] * sC;
        const b0 = base[o + 4] * sC;
        const a1 = rotated[o + 3] * sC;
        const b1 = rotated[o + 4] * sC;
        const r0 = Math.hypot(a0, b0);
        if (r0 <= 1e-6) continue;
        checked++;

        // A1 彩度不変
        expect(Math.abs(Math.hypot(a1, b1) - r0)).toBeLessThan(1e-12 * Math.max(1, r0));
        // A2 色相角がちょうど θ 進む
        const dh = wrapPi(Math.atan2(b1, a1) - Math.atan2(b0, a0) - theta);
        expect(Math.abs(dh)).toBeLessThan(1e-12);
        // A3 他ブロックへ漏れない
        expect(Math.abs(rotated[o] - base[o])).toBeLessThan(1e-15);
        expect(Math.abs(rotated[o + 1] - base[o + 1])).toBeLessThan(1e-15);
        expect(Math.abs(rotated[o + 2] - base[o + 2])).toBeLessThan(1e-15);
      }
      expect(checked).toBeGreaterThan(100);
    });
  }

  it('A4 —— 軸ごとスケールにすると彩度不変が**破れる**（テストに歯があることの証明）', () => {
    // s_a = sC, s_b = 1.7·sC という軸ごと正規化を再現する。
    // 正規化空間での R(θ) は OKLab では D⁻¹RD に共役され、s_a ≠ s_b なら SO(2) の元でない。
    const SKEW = 1.7;
    const theta = 0.7;
    const m = composeRotN([{ i: 3, j: 4, angle: theta }], N, new Float64Array(N * N));

    const skewed = new Float64Array(base.length);
    for (let v = 0; v < count; v++) {
      const o = v * N;
      skewed[o] = base[o];
      skewed[o + 1] = base[o + 1];
      skewed[o + 2] = base[o + 2];
      skewed[o + 3] = base[o + 3];
      skewed[o + 4] = base[o + 4] / SKEW; // b 軸だけ違うスケール
    }
    const rotated = new Float64Array(base.length);
    applyMatrixBatch(skewed, rotated, N, count, m);

    let worst = 0;
    for (let v = 0; v < count; v++) {
      const o = v * N;
      const a0 = skewed[o + 3] * sC;
      const b0 = skewed[o + 4] * (SKEW * sC);
      const a1 = rotated[o + 3] * sC;
      const b1 = rotated[o + 4] * (SKEW * sC);
      const r0 = Math.hypot(a0, b0);
      if (r0 <= 1e-6) continue;
      worst = Math.max(worst, Math.abs(Math.hypot(a1, b1) - r0) / r0);
    }
    expect(worst).toBeGreaterThan(1e-3);
  });
});
