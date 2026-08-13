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

/**
 * その `extentY` で**実際に描く格子の行数**（Phase 2c-x）。`effectiveLineCount` の y 軸版。
 *
 * ## 何を直しているのか
 *
 * 格子経路（`dimLevel > 1`）は畳みを一切通らなかった（`lensScene` は `!grid` のときしか
 * `rebuildLine` を呼ばない）。`extentY → 0⁺` では `rows` 行が画面上で重なり、
 * 加算深度が `min(cols, ⌊K/extentX⌋+1) × min(rows, ⌊K·ρ/extentY⌋+1)` の右側で
 * `rows` に張り付いて **`4 × rows`** になる（HIGH 944 / 予算は `n ≤ 512`。§4.6.1）。
 *
 * 規則は x 側と同じ ── **画面上の間隔が `s0y` を保つ行数まで減らす**:
 *
 * ```
 * 画面間隔 = extentY · s0y · rows / n   を  s0y  に等しくしたい  ⟹  n = extentY · rows
 * ```
 *
 * `extentY = 1`（`dimLevel = 2` のアンカー）では `n = rows` に**厳密に戻る**ので、
 * アンカーの絵は 1 ビットも動かない（`collapseWeight` が `x/x` になる）。
 *
 * ## `rows/2` より上では畳まない —— 畳みではなく**間引き**になるから
 *
 * 帯の境界は `lift` と同じ `floor` の厳密分割なので、`n > rows/2` になると
 * **源の行を 1 本しか含まない帯が現れる**（実測: `rows = 236` では `n = 119` から。
 * `wide` の `rows = 74` では `n = 38` から）。そこから先の「畳み」は平均ではなく
 * **どの行を捨てるかの選択**で、x 側の `effectiveLineCount` が行っている操作とは別物である。
 *
 * そして**その帯に畳む理由が無い**: `n > rows/2` ⟺ `extentY > 0.5` では
 * `⌊K·ρ/extentY⌋+1 ≤ 8` なので、畳まなくても深度は `4 × 8 = 32` で予算の内側にある。
 *
 * 実測（実 GPU・標本 No.0・HIGH・畳まない絵との差）: `d ≥ 1.55` を畳むと
 * ΔE00 が最大 **19.449**、灯った画素の **1.9%** が予算 3.0 を超える ── **利得ゼロで**。
 * 畳まなければその帯は**ビット単位で従来と同一**（実測 0.000 / 0 画素）。
 *
 * → **帯が 2 行以上を平均できるあいだだけ畳む。** 条件は `2n ≤ rows`。
 */
export function effectiveRowCount(extentY: number, rows: number): number {
  const max = Math.max(1, Math.floor(rows));
  if (!Number.isFinite(extentY) || extentY >= 1) return max;
  if (!(extentY > 0)) return 1;
  const n = Math.round(extentY * max);
  if (n < 1) return 1;
  // 帯が 1 行しか含まなくなったら畳まない（畳みではなく間引きになる）
  return 2 * n > max ? max : n;
}
