/**
 * 列平均バッファ —— `dimLevel < 1` の **LINE**（SPEC §2 の n=1）を描くための点列。**純関数。**
 *
 * ## なぜ格子を潰すだけでは駄目なのか（Phase 1b で実測）
 *
 * `extent = [1,0,0,0,0]` は v を 0 にするので、同じ列の `rows` 個の点は
 * **浮動小数点として厳密に同一の位置**へ落ちる（実測: `dimLevel ≤ 1` で
 * 先頭 4000 点の相異なる XY が 378 = `cols`）。加算合成なので、そこに出るのは
 * 列**平均**ではなく列**合計**である ── 実測で平坦場の **159.1 倍**。
 *
 * さらに悪いことに、`dimLevel = 0` では全点（HIGH で 89,208 点）が 1 点へ重なる。
 * half-float の加算はそこで天井に当たって停止し、読み戻すと **−96.4%** ──
 * つまりほぼ真っ黒になる（`halfFloat.ts`）。
 *
 * → **バッファそのものを差し替える。** これは最適化ではなく正しさの問題である。
 *
 * ## 点数を `cols` 以下に抑える理由が 2 つある（どちらも実測）
 *
 * 1. **`gainFor` の較正域。** 点数を正準幅（最大 2048）にすると
 *    `s0 = 0.41 px` まで落ち、`gainFor` が漸近値から **+51.7%** ずれる。
 *    `s0 ≤ 0.152 px` では `ksum = 0` になって **`Infinity`** が返る
 *    （`spriteGain.ts` の `MIN_CALIBRATED_S0`）。
 * 2. **half-float の加算深度。** `dimLevel = 0` では点数がそのまま加算深度になる。
 *    実測の最悪 ΔE00 は n ≤ 512 で **1.364**、n ≤ 2048 で **4.376**（予算 3.0 超）。
 *
 * `lineCount = min(cols, 512)` ならどちらも通り、しかも
 * **`s0` が格子と同じかそれ以上**になるので `gainFor` はアンカーと同じ較正域に留まる。
 *
 * ## 平均色は「線を潰したもの」であって、別のバッファではない
 *
 * `dimLevel = 0` では `extent[0] = 0` なので線の全点が原点へ重なり、
 * `sampleWeight`（`collapseWeight`）が総和を平均へ戻す。板は使わない ──
 * `plateWeight(d) = 0` は `d ≤ 1.55` で厳密に 0 で（実測）、
 * 板を復活させると「板と点群は同じ 1 つの門から出る」という 1a-iii の合成則
 * （`rotationSchedule.test.ts` が機械で見ている）を壊すことになる。
 *
 * ## 縮約は正準バッファから取る（SPEC §4.7）
 *
 * 源は `computeStats` の `columnMeans`（3 f32 × 正準幅、**リニア光**）。
 * 正準の各列はちょうど `height` 画素なので、列平均の単純平均が全体平均に厳密に一致する
 * （`image.test.ts` が既に固定している不変条件）── 格子のセル平均を平均し直すと
 * セル高が割り切れないぶんだけずれるので、そちらは使わない。
 */

import { linearToOklab, primariesFor } from '../color/oklab';
import { imageHalfExtents } from './grid';
import type { BlockScales } from './stats';

/**
 * 列平均線の最大点数。**実測 2 件がこの値を決めている**（上記）。
 * 512 点なら `dimLevel = 0` の加算深度が 512 で、最悪 ΔE00 は 1.364。
 */
export const LINE_MAX_POINTS = 512;

/** 格子の列数から線の点数を決める。`s0` が格子より細かくならないことが要件 */
export function lineCountFor(cols: number): number {
  if (!(cols >= 1)) return 1;
  return Math.min(Math.floor(cols), LINE_MAX_POINTS);
}

export interface ColumnLineBuffers {
  /** 5 f32/点: [u, 0, L', a', b'] */
  readonly base: Float32Array;
  /** 3 f32/点: **リニア光** RGB */
  readonly colors: Float32Array;
}

export interface ColumnLineResult {
  readonly count: number;
  /** 描いた点の色の**単純平均**。`dimLevel = 0` で読める値の理論値 */
  readonly mean: readonly [number, number, number];
}

/**
 * `columnMeans` を `count` 本のバンドへ集約して線の点列を作る。
 *
 * バンド境界は `lift` と同じ `floor` の厳密分割。正準の 1 列 = `height` 画素で
 * 全列等しいので、バンド内の単純平均はそのバンドの画素平均に**厳密に**一致する。
 * バンド幅そのものは割り切れないと ±1 列ずれるので、
 * 全バンドの単純平均と全体平均の差は 0 ではない ── その残差は
 * `columnLine.test.ts` が数値で固定する（緩めない）。
 */
export function buildColumnLine(
  columnMeans: Float32Array,
  width: number,
  height: number,
  gamut: 'srgb' | 'display-p3',
  scales: BlockScales,
  count: number,
  out: ColumnLineBuffers,
): ColumnLineResult {
  const n = Math.max(1, Math.min(Math.floor(count), width));
  const { aX } = imageHalfExtents(width, height);
  const p = primariesFor(gamut);
  const { lMid, sL, sC } = scales;
  const lab = new Float64Array(3);

  let mr = 0;
  let mg = 0;
  let mb = 0;

  for (let i = 0; i < n; i++) {
    const x0 = ((i * width) / n) | 0;
    const x1 = (((i + 1) * width) / n) | 0;
    let r = 0;
    let g = 0;
    let b = 0;
    let k = 0;
    for (let x = x0; x < x1; x++) {
      r += columnMeans[x * 3];
      g += columnMeans[x * 3 + 1];
      b += columnMeans[x * 3 + 2];
      k++;
    }
    if (k === 0) {
      // 退化（count > width）は lineCountFor が防ぐが、純関数としては塞いでおく
      const x = Math.min(width - 1, x0);
      r = columnMeans[x * 3];
      g = columnMeans[x * 3 + 1];
      b = columnMeans[x * 3 + 2];
      k = 1;
    }
    const inv = 1 / k;
    r *= inv;
    g *= inv;
    b *= inv;

    linearToOklab(p, r, g, b, lab);

    const o5 = i * 5;
    // u はセルの**中心**。`lift` と同じ規約（線と格子が dimLevel = 1 で重なる）
    out.base[o5] = ((2 * (i + 0.5)) / n - 1) * aX;
    // v は 0 ── 線は画像の縦中央にある。`extent[1] = 0` なので効かないが、
    // 「線がどこにあるか」を base に書いておく（0 を掛けて消える値を嘘にしない）
    out.base[o5 + 1] = 0;
    out.base[o5 + 2] = (lab[0] - lMid) / sL;
    out.base[o5 + 3] = lab[1] / sC;
    out.base[o5 + 4] = lab[2] / sC;

    const o3 = i * 3;
    out.colors[o3] = r;
    out.colors[o3 + 1] = g;
    out.colors[o3 + 2] = b;

    mr += r;
    mg += g;
    mb += b;
  }

  const invN = 1 / n;
  return { count: n, mean: [mr * invN, mg * invN, mb * invN] };
}
