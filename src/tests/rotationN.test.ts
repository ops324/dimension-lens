/**
 * 融合カーネルの等価性と、透視カスケードの真の不変条件。
 *
 * ここにある「等価性」テストが、**ストリーミングパスを 3 本削る自信の唯一の根拠**である。
 * composeRotN の左乗算/右乗算を取り違えると、順序が逆の行列ができて
 * しかも見た目には動いてしまう ── それを捕まえられるのはこのテストだけ。
 */

import { describe, expect, it } from 'vitest';
import { rotateBatch, type PlaneRotation } from '../math/rotation';
import { projectPerspective } from '../math/projection';
import {
  applyMatrixBatch,
  cascadeSafety,
  composeRotN,
  foldExtent,
  liftProject,
  liftProject5,
} from '../math/rotationN';
import { clamp01 } from '../math/ease';
import { mulberry32 } from './math.test';

const DIST = 2.4;

/** 単位球内に一様に散る n 次元点群(‖x‖ ≤ 1 を構成的に満たす) */
function randomBall(rand: () => number, n: number, count: number): Float64Array {
  const out = new Float64Array(n * count);
  for (let v = 0; v < count; v++) {
    const o = v * n;
    let norm2 = 0;
    for (let k = 0; k < n; k++) {
      // Box-Muller で正規分布 → 方向が一様になる
      const u = Math.max(rand(), 1e-12);
      const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
      out[o + k] = g;
      norm2 += g * g;
    }
    const r = Math.cbrt(rand()) / Math.sqrt(norm2);
    for (let k = 0; k < n; k++) out[o + k] *= r;
  }
  return out;
}

function extentOf(dimLevel: number, n: number): Float64Array {
  const e = new Float64Array(n);
  for (let k = 0; k < n; k++) e[k] = clamp01(dimLevel - k);
  return e;
}

describe('composeRotN', () => {
  it('rotateBatch と同じ写像になる(n=3..8, 1e-12)', () => {
    const rand = mulberry32(7);
    for (let n = 3; n <= 8; n++) {
      const count = 40;
      const src = randomBall(rand, n, count);
      const rots: PlaneRotation[] = [
        { i: 0, j: 2, angle: 0.61 },
        { i: 1, j: n - 1, angle: -1.42 },
        { i: 2, j: n - 2, angle: 2.07 },
        { i: 0, j: 1, angle: 0.33 },
      ];

      const viaBatch = new Float64Array(src.length);
      rotateBatch(src, viaBatch, n, count, rots);

      const m = composeRotN(rots, n, new Float64Array(n * n));
      const viaMatrix = new Float64Array(src.length);
      applyMatrixBatch(src, viaMatrix, n, count, m);

      for (let k = 0; k < src.length; k++) {
        expect(viaMatrix[k]).toBeCloseTo(viaBatch[k], 12);
      }
    }
  });

  it('回転列が空なら単位行列', () => {
    const m = composeRotN([], 5, new Float64Array(25));
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        expect(m[r * 5 + c]).toBe(r === c ? 1 : 0);
      }
    }
  });

  it('直交行列である(MᵀM = I, 1e-12)', () => {
    const n = 5;
    const m = composeRotN(
      [
        { i: 0, j: 3, angle: 1.1 },
        { i: 2, j: 4, angle: -0.7 },
      ],
      n,
      new Float64Array(n * n),
    );
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        let dot = 0;
        for (let k = 0; k < n; k++) dot += m[k * n + a] * m[k * n + b];
        expect(dot).toBeCloseTo(a === b ? 1 : 0, 12);
      }
    }
  });
});

describe('foldExtent', () => {
  it('R·E は「先に縮めてから回す」と一致する(1e-12)', () => {
    const rand = mulberry32(11);
    const n = 5;
    const count = 30;
    const src = randomBall(rand, n, count);
    const rots: PlaneRotation[] = [
      { i: 0, j: 2, angle: 0.9 },
      { i: 3, j: 4, angle: -1.6 },
    ];
    const e = extentOf(3.4, n);

    // 参照: 先に extent を掛けてから rotateBatch
    const scaled = new Float64Array(src.length);
    for (let v = 0; v < count; v++) {
      for (let k = 0; k < n; k++) scaled[v * n + k] = src[v * n + k] * e[k];
    }
    const reference = new Float64Array(src.length);
    rotateBatch(scaled, reference, n, count, rots);

    // 融合: R·E を 1 枚の行列に畳む
    const m = foldExtent(composeRotN(rots, n, new Float64Array(n * n)), n, e);
    const fused = new Float64Array(src.length);
    applyMatrixBatch(src, fused, n, count, m);

    for (let k = 0; k < src.length; k++) {
      expect(fused[k]).toBeCloseTo(reference[k], 12);
    }
  });
});

describe('liftProject(融合カーネル)', () => {
  const rand = mulberry32(23);
  const n = 5;
  const count = 500;
  const src64 = randomBall(rand, n, count);
  const base32 = Float32Array.from(src64);
  const rots: PlaneRotation[] = [
    { i: 0, j: 2, angle: 0.77 },
    { i: 3, j: 4, angle: 1.93 },
    { i: 1, j: 3, angle: -0.41 },
  ];

  /** 素直な 3 パス実装: extent → rotateBatch → projectPerspective */
  function reference(dimLevel: number): Float32Array {
    const e = extentOf(dimLevel, n);
    const scaled = new Float64Array(src64.length);
    for (let v = 0; v < count; v++) {
      for (let k = 0; k < n; k++) scaled[v * n + k] = src64[v * n + k] * e[k];
    }
    const rotated = new Float64Array(src64.length);
    rotateBatch(scaled, rotated, n, count, rots);
    const out = new Float32Array(count * 3);
    projectPerspective(rotated, n, count, DIST, out);
    return out;
  }

  for (const dimLevel of [0, 1, 2, 2.5, 3.4, 5]) {
    it(`dimLevel=${dimLevel} で参照実装と一致する(1e-6)`, () => {
      const want = reference(dimLevel);
      const m = foldExtent(
        composeRotN(rots, n, new Float64Array(n * n)),
        n,
        extentOf(dimLevel, n),
      );

      const gotGeneric = new Float32Array(count * 3);
      liftProject(base32, count, n, m, DIST, gotGeneric);

      const got5 = new Float32Array(count * 3);
      liftProject5(base32, count, m, DIST, got5);

      for (let k = 0; k < want.length; k++) {
        expect(gotGeneric[k]).toBeCloseTo(want[k], 6);
        // 展開版と一般版は同じ順序で総和するので数値としては完全一致する。
        // ただし toBe(Object.is) は使えない ── 一般版は acc を +0 で初期化するため
        // 全項が -0 のとき +0 を返し、展開版は -0 を返す。数値としては等しく、
        // 描画にも影響しないが Object.is(-0, +0) は false になる。
        expect(got5[k] === gotGeneric[k]).toBe(true);
      }
    });
  }
});

describe('透視カスケードの不変条件', () => {
  /**
   * ‖x‖ ≤ 1 を全 extent で確かめるテストは**恒真**である ── extent は対角縮小、
   * 回転は等長なので ‖REx‖ ≤ ‖x‖ が定理として成り立つ。定理をテストしても何も証明しない。
   * 測るべきは各段の |p[d]| が dist を割っているかどうか。
   */
  it('n=5・dist=2.4 では全段が安全で、F_CLAMP は発動しない', () => {
    const rand = mulberry32(31);
    const n = 5;
    const count = 2000;
    const base = Float32Array.from(randomBall(rand, n, count));

    let worst = 0;
    for (const dimLevel of [0, 1, 2, 3, 4, 5, 2.7, 4.3]) {
      for (const angle of [0, 0.4, 1.1, 2.2, 3.0]) {
        const m = foldExtent(
          composeRotN(
            [
              { i: 0, j: 4, angle },
              { i: 1, j: 3, angle: -angle * 0.7 },
              { i: 2, j: 4, angle: angle * 1.3 },
            ],
            n,
            new Float64Array(n * n),
          ),
          n,
          extentOf(dimLevel, n),
        );
        const safety = cascadeSafety(base, count, n, m, DIST);
        expect(safety.clamped).toBe(false);
        expect(safety.maxRatio).toBeLessThan(1);
        if (safety.maxRatio > worst) worst = safety.maxRatio;
      }
    }
    // 余裕がどれだけあるかを主張として固定する(dist を詰めると静かに壊れる)
    expect(worst).toBeLessThan(0.75);
  });

  it('dist を 1.5 まで詰めると壊れる(無音で壊れることの証拠)', () => {
    const rand = mulberry32(37);
    const n = 7; // 段数を増やして累積を効かせる
    const count = 500;
    const base = Float32Array.from(randomBall(rand, n, count));
    const m = foldExtent(
      composeRotN([{ i: 0, j: 6, angle: 0.8 }], n, new Float64Array(n * n)),
      n,
      extentOf(7, n),
    );
    const safety = cascadeSafety(base, count, n, m, 1.5);
    expect(safety.maxRatio).toBeGreaterThan(1);
  });
});
