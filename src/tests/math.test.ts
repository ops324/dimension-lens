/**
 * 移植した数学コアの回帰ロック。
 *
 * このファイルは ops324/dimension@8cd37d8 の src/tests/math.test.ts から
 * **ease / rotation / projection の describe ブロックをそのまま**持ってきたもの
 * (hopf / polytopes / ステレオ投影は LENS に存在しないので落としてある)。
 *
 * rotation.ts を VERBATIM に保っている限り、これは無料の回帰ロックとして機能する ──
 * 親で実測済み(A 水準)の正しさを、こちらでも同じテストで確かめられる。
 * rotation.ts に 1 行でも足した瞬間にその継承は切れる。だから足さない。
 */

import { describe, expect, it } from 'vitest';
import { clamp01, expSmooth, lerp, pingpong, smoothstep } from '../math/ease';
import { rotateBatch, type PlaneRotation } from '../math/rotation';
import { projectOrtho, projectPerspective } from '../math/projection';

/** 決定的な擬似乱数(テストの再現性のため Math.random は使わない) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function norm(arr: Float64Array, n: number, v: number): number {
  let sum = 0;
  for (let k = 0; k < n; k++) sum += arr[v * n + k] ** 2;
  return Math.sqrt(sum);
}

describe('ease', () => {
  it('clamp01 は範囲外を丸める', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.25)).toBe(0.25);
    expect(clamp01(1.5)).toBe(1);
  });

  it('lerp / smoothstep の端点と中点', () => {
    expect(lerp(2, 6, 0.5)).toBe(4);
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 12);
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(2)).toBe(1);
  });

  it('expSmooth は dt 分割に対して不変(フレームレート非依存)', () => {
    const oneStep = expSmooth(0, 10, 6, 1 / 30);
    const half = expSmooth(0, 10, 6, 1 / 60);
    const twoStep = expSmooth(half, 10, 6, 1 / 60);
    expect(twoStep).toBeCloseTo(oneStep, 12);
  });

  it('pingpong は 0→1→0 を往復し負の入力でも周期的', () => {
    expect(pingpong(0)).toBe(0);
    expect(pingpong(1)).toBe(1);
    expect(pingpong(1.5)).toBeCloseTo(0.5, 12);
    expect(pingpong(2)).toBe(0);
    expect(pingpong(-0.5)).toBeCloseTo(0.5, 12);
  });
});

describe('rotation', () => {
  const rand = mulberry32(42);
  const n = 7;
  const count = 50;
  const src = new Float64Array(n * count);
  for (let k = 0; k < src.length; k++) src[k] = rand() * 2 - 1;
  const rots: PlaneRotation[] = [
    { i: 0, j: 3, angle: 0.7 },
    { i: 1, j: 5, angle: -1.3 },
    { i: 2, j: 6, angle: 2.9 },
  ];

  it('ノルムを保存する(1e-12)', () => {
    const dst = new Float64Array(src.length);
    rotateBatch(src, dst, n, count, rots);
    for (let v = 0; v < count; v++) {
      expect(norm(dst, n, v)).toBeCloseTo(norm(src, n, v), 12);
    }
  });

  it('逆順の逆回転で恒等になる', () => {
    const dst = new Float64Array(src.length);
    rotateBatch(src, dst, n, count, rots);
    const inverse = [...rots].reverse().map((r) => ({ ...r, angle: -r.angle }));
    rotateBatch(dst, dst, n, count, inverse); // src === dst の in-place も同時に検証
    for (let k = 0; k < src.length; k++) {
      expect(dst[k]).toBeCloseTo(src[k], 12);
    }
  });

  it('回転平面の外の座標には触れない', () => {
    const dst = new Float64Array(src.length);
    rotateBatch(src, dst, n, count, [{ i: 0, j: 1, angle: 1.1 }]);
    for (let v = 0; v < count; v++) {
      for (let k = 2; k < n; k++) {
        expect(dst[v * n + k]).toBe(src[v * n + k]);
      }
    }
  });
});

describe('projection', () => {
  it('直交投影は先頭 3 座標を取り出す', () => {
    const src = new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5]);
    const out = new Float32Array(3);
    projectOrtho(src, 5, 1, out);
    expect([...out]).toEqual([Math.fround(0.1), Math.fround(0.2), Math.fround(0.3)]);
  });

  it('透視カスケード n=4 の手計算値', () => {
    // f = 2.4/(2.4−0.4) = 1.2
    const src = new Float64Array([0.5, -0.3, 0.2, 0.4]);
    const out = new Float32Array(3);
    projectPerspective(src, 4, 1, 2.4, out);
    expect(out[0]).toBeCloseTo(0.6, 6);
    expect(out[1]).toBeCloseTo(-0.36, 6);
    expect(out[2]).toBeCloseTo(0.24, 6);
  });

  it('透視カスケード n=5 の手計算値(2 段)', () => {
    // d=4: f = 3/(3−0.5) = 1.2 → (0.12, 0.24, 0.36, 0.48)
    // d=3: f = 3/(3−0.48)     → (0.1428571, 0.2857143, 0.4285714)
    const src = new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5]);
    const out = new Float32Array(3);
    projectPerspective(src, 5, 1, 3, out);
    expect(out[0]).toBeCloseTo(0.12 * (3 / 2.52), 6);
    expect(out[1]).toBeCloseTo(0.24 * (3 / 2.52), 6);
    expect(out[2]).toBeCloseTo(0.36 * (3 / 2.52), 6);
  });

  it('n=3 では恒等(コピー)になる', () => {
    const src = new Float64Array([0.3, -0.7, 0.2]);
    const out = new Float32Array(3);
    projectPerspective(src, 3, 1, 2.4, out);
    expect(out[0]).toBeCloseTo(0.3, 6);
    expect(out[1]).toBeCloseTo(-0.7, 6);
    expect(out[2]).toBeCloseTo(0.2, 6);
  });
});
