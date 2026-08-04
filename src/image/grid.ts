/**
 * 格子の寸法と、画像の世界座標での半径。
 *
 * `imageHalfExtents` は**この作品で唯一の**アスペクト比の源である ── 板のクアッド、
 * 点群の座標、カメラのフィット、この 3 つが同じ 1 つの関数から出ることが要件。
 * 親 SPEC の portraitDolly に付いていた「この式は 1 箇所にしか存在してはならない」を継ぐ。
 */

export interface GridSpec {
  readonly cols: number;
  readonly rows: number;
}

/**
 * 画像の世界座標での半径。長辺を 1 に正規化する **1 つのスカラー** `1/max(W,H)` を掛けるだけ ──
 * だからアスペクト比は厳密に保存される(SPEC §2.1 の空間ブロック等方正規化)。
 */
export function imageHalfExtents(w: number, h: number): { aX: number; aY: number } {
  const m = Math.max(w, h);
  return { aX: w / m, aY: h / m };
}

/**
 * 点数予算からアスペクトを保った格子を決める。
 *
 * 予算は**必ず下回る**(SPEC のティア表と bench の点数を一致させるため ──
 * Phase 0 の 1.29 ms/frame は特定の点数についての A 水準の主張なので、ずらさない)。
 */
export function fitGrid(w: number, h: number, budget: number): GridSpec {
  if (!(w > 0) || !(h > 0) || !(budget >= 1)) return { cols: 1, rows: 1 };
  const aspect = w / h;
  // cols·rows ≤ budget かつ cols/rows ≈ aspect
  let cols = Math.max(1, Math.floor(Math.sqrt(budget * aspect)));
  let rows = Math.max(1, Math.floor(budget / cols));
  // floor の組み合わせで予算を超えることはないが、アスペクト誤差を詰める
  let best = { cols, rows, err: Number.POSITIVE_INFINITY };
  for (let c = Math.max(1, cols - 3); c <= cols + 3; c++) {
    const r = Math.floor(budget / c);
    if (r < 1) continue;
    if (c * r > budget) continue;
    const err = Math.abs(c / r - aspect) / aspect;
    // 同じ誤差なら点数の多い方(予算を使い切る方)を採る
    if (err < best.err - 1e-12 || (Math.abs(err - best.err) <= 1e-12 && c * r > best.cols * best.rows)) {
      best = { cols: c, rows: r, err };
    }
  }
  cols = best.cols;
  rows = best.rows;
  return { cols, rows };
}

/** SPEC §4.3 のティア点数。bench が測ったのと同じ数でなければならない */
export const TIER_BUDGET = {
  BALANCED: 244 * 162, // 39,528
  HIGH: 366 * 244, // 89,304
  ULTRA: 489 * 326, // 159,414
} as const;

export type TierName = keyof typeof TIER_BUDGET;

/** 正準バッファの長辺上限。列平均バッファ(Phase 1b)の点数上限でもある */
export const MAX_CANONICAL_EDGE = 2048;
