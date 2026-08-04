/**
 * 取り込みの CPU 予算。**Node で測る。**
 *
 * ブラウザ側の ms をここへ持ってこないこと ── 検証に使うブラウザペインは
 * 同じ機体の Node に対してメインスレッドで 3.6〜4.1 倍、**worker 内では 23〜28 倍**遅い
 * (実測: 1e8 回の整数加算が Node 98.3ms / ペインのメイン 400.1ms / ペインの worker 2400ms、
 * 暖機しても改善しない)。取り込みは worker で走るので、あの環境の数字を予算として
 * 引用すると丸ごと嘘になる。
 *
 * ここで測るのは「worker が何を肩代わりしているか」である。SPEC §4.3 と同じく
 * `mean` がそのまま 1 回あたりの ms。
 */

import { bench, describe } from 'vitest';
import { linearizeRgba } from '../image/linearize';
import { computeScales, computeStats } from '../image/stats';
import { lift } from '../image/lift';
import { fitGrid, TIER_BUDGET } from '../image/grid';

/** 正準バッファの代表寸法(長辺 2048)。3:2 と 4:3 と正方形(最悪) */
const SHAPES = [
  { name: '2048x1365 (3:2)', w: 2048, h: 1365 },
  { name: '2048x1536 (4:3)', w: 2048, h: 1536 },
  { name: '2048x2048 (1:1・最悪)', w: 2048, h: 2048 },
] as const;

/** 決定的な合成 RGBA8。乱数を使わない(SPEC の決定性の規律) */
function syntheticRgba(w: number, h: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0, o = 0; y < h; y++) {
    for (let x = 0; x < w; x++, o += 4) {
      rgba[o] = (x * 7 + y * 3) & 255;
      rgba[o + 1] = (x * 3 + y * 11) & 255;
      rgba[o + 2] = (x ^ y) & 255;
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

for (const shape of SHAPES) {
  describe(`取り込み ${shape.name}`, () => {
    const rgba = syntheticRgba(shape.w, shape.h);
    const canonical = linearizeRgba(rgba, shape.w, shape.h);
    const stats = computeStats(canonical);
    const scales = computeScales(stats);
    const grid = fitGrid(shape.w, shape.h, TIER_BUDGET.ULTRA);
    const count = grid.cols * grid.rows;
    const buffers = {
      base: new Float32Array(count * 5),
      colors: new Float32Array(count * 3),
    };

    bench('linearizeRgba (RGBA8 → 正準リニア)', () => {
      linearizeRgba(rgba, shape.w, shape.h);
    });

    bench('computeStats (平均・列平均・OKLab 統計・退化判定)', () => {
      computeStats(canonical);
    });

    bench('lift → ULTRA 格子', () => {
      lift(canonical, grid, scales, buffers);
    });
  });
}
