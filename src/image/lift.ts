/**
 * 正準リニアバッファ → R⁵ の base バッファ。**純関数。**
 *
 * 座標(`lift.test.ts` がここを全要素で固定する):
 * ```
 * m  = max(W,H);  aX = W/m;  aY = H/m          // 空間ブロックは 1 スカラー = アスペクト保存
 * u  =  (2(i+0.5)/cols − 1) · aX               // セルの**中心**
 * v  = −(2(j+0.5)/rows − 1) · aY               // y 反転: 画像の行 0(上端) → v > 0
 * L' =  (L − lMid) / sL
 * a' =  a / sC        b' = b / sC              // ← 中心化しない。下記。
 * ```
 *
 * **(a,b) ブロックを中心化してはならない。** 中心をずらすと `R(θ)` が無彩色軸から
 * 外れた点のまわりの回転になり、彩度が保存されず色相も一様に進まない ──
 * SPEC §2.1 が記録している「軸ごとスケール」とは**独立した第 2 の壊し方**である。
 * `(u,v)` を画像中心に、`L` を lMid に中心化するのは無害 ── そちらのブロックについては
 * 回転の主張をしていないから。
 */

import { linearToOklab, primariesFor } from '../color/oklab';
import { imageHalfExtents, type GridSpec } from './grid';
import type { BlockScales, Canonical } from './stats';

export interface LiftBuffers {
  /** 5 f32/点: [u, v, L', a', b'] */
  readonly base: Float32Array;
  /** 3 f32/点: **リニア光** RGB */
  readonly colors: Float32Array;
}

export interface LiftResult {
  readonly count: number;
  /**
   * 全点の ‖x‖ の最大値(全 extent = 1 のとき)。
   *
   * 透視カスケードの真の前提条件は「どの段でも |p[d]| < dist」で、n=5 では
   * **dist > 2·maxNorm** に帰着する(SPEC §4.8)。sC は p95 なので上位 5% の画素は
   * a', b' が 1 を超え、maxNorm は 1 を超えうる ── だから測って返し、
   * 呼び出し側が `safeDist` で dist を決める。
   */
  readonly maxNorm: number;
}

/**
 * 箱平均をリニア光で取り、セル単位で OKLab に変換して base へ書く。
 *
 * 境界は `floor` で**厳密に分割**する(どの画素もちょうど 1 つのセルに属する)。
 * 分割であることから `Σ cellMean·cellPx / totalPx === globalMean` が厳密に成り立ち、
 * `stats.test.ts` がこれを不変条件として見張る ── 境界の off-by-one が即座に落ちる。
 *
 * OKLab は**セルごとに 1 回**。画素ごとに Lab を作らないので中間バッファは発生しない。
 */
export function lift(
  src: Canonical,
  grid: GridSpec,
  scales: BlockScales,
  out: LiftBuffers,
): LiftResult {
  const { linear, width: W, height: H, gamut } = src;
  const { cols, rows } = grid;
  const p = primariesFor(gamut);
  const { aX, aY } = imageHalfExtents(W, H);
  const { lMid, sL, sC } = scales;

  const count = cols * rows;
  const lab = new Float64Array(3);
  let maxNorm2 = 0;

  for (let j = 0; j < rows; j++) {
    const y0 = ((j * H) / rows) | 0;
    const y1 = (((j + 1) * H) / rows) | 0;
    const v = -(((2 * (j + 0.5)) / rows - 1) * aY);
    for (let i = 0; i < cols; i++) {
      const x0 = ((i * W) / cols) | 0;
      const x1 = (((i + 1) * W) / cols) | 0;

      let r = 0;
      let g = 0;
      let b = 0;
      let px = 0;
      for (let y = y0; y < y1; y++) {
        let o = (y * W + x0) * 3;
        for (let x = x0; x < x1; x++) {
          r += linear[o];
          g += linear[o + 1];
          b += linear[o + 2];
          o += 3;
          px++;
        }
      }
      // 退化格子(cols > W など)ではセルが空になりうる。最近傍で埋める。
      if (px === 0) {
        const sx = Math.min(W - 1, x0);
        const sy = Math.min(H - 1, y0);
        const o = (sy * W + sx) * 3;
        r = linear[o];
        g = linear[o + 1];
        b = linear[o + 2];
        px = 1;
      }
      const inv = 1 / px;
      r *= inv;
      g *= inv;
      b *= inv;

      linearToOklab(p, r, g, b, lab);

      const k = j * cols + i;
      const o5 = k * 5;
      const u = ((2 * (i + 0.5)) / cols - 1) * aX;
      const Lp = (lab[0] - lMid) / sL;
      const ap = lab[1] / sC;
      const bp = lab[2] / sC;
      out.base[o5] = u;
      out.base[o5 + 1] = v;
      out.base[o5 + 2] = Lp;
      out.base[o5 + 3] = ap;
      out.base[o5 + 4] = bp;

      const o3 = k * 3;
      out.colors[o3] = r;
      out.colors[o3 + 1] = g;
      out.colors[o3 + 2] = b;

      const n2 = u * u + v * v + Lp * Lp + ap * ap + bp * bp;
      if (n2 > maxNorm2) maxNorm2 = n2;
    }
  }

  return { count, maxNorm: Math.sqrt(maxNorm2) };
}
