// VENDORED_FROM: ops324/dimension@8cd37d8ffe74017acd18c1907195e36a20d9ec19 src/math/ease.ts
// STATUS: VERBATIM
//
// 逆流の向きは一方向に固定する ── このファイルにバグを見つけたら、まず dimension 側で
// 直して PR にし、その SHA を上の VENDORED_FROM に反映してからコピーし直す。
// LENS 側で直接直すと、どちらが真かの議論が始まる。

/**
 * イージング/補間ユーティリティ。純関数のみ。
 */

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export const clamp = (x: number, min: number, max: number): number =>
  x < min ? min : x > max ? max : x;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 0..1 にクランプした 3t²−2t³ */
export const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/**
 * フレームレート非依存の指数平滑化。
 * `rate` が大きいほど速く target へ収束する(rate≈6 で体感 0.5 秒弱)。
 * dt を半分にして 2 回呼んでも 1 回呼びと同じ結果になる(指数則)。
 */
export const expSmooth = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

/** 0→1→0→1… の三角波(周期 2) */
export const pingpong = (t: number): number => 1 - Math.abs(1 - (((t % 2) + 2) % 2));
