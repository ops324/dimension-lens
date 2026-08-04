/**
 * スプライトの正規化ゲイン。「平坦な面が、点数にも DPR にも依らず本来の値で出る」ための係数。
 *
 * スプライトは `w(r) = exp(−F·r²)`、`r = |gl_PointCoord − 0.5|`、`r² > 0.25` で `discard`。
 * 光る円の直径は `S = gl_PointSize` device px。
 *
 * ── 定数の由来(実測)
 *
 * 設計当初の `F = 6, kSprite = 1.7` は**平坦場リップル 44.7%** だった。原因は幾何で、
 * 光る半径が `kSprite/2 = 0.85` セルしかなく、**軸方向の隣接点(距離 1.0 セル)が
 * `discard` で丸ごと消える**。格子点の上では自分 1 個、セル中心では 4 個が寄与し、
 * 被覆数が 1→2→4 と振れる。親の `F = 17` は線のグローの芯を締めるための値で、
 * 写真の格子には再構成のための重なりが要る。
 *
 * (F, kSprite) を探索して **F = 21, kSprite = 3.85 → リップル 0.68%** を採用した。
 * 代償は fill が `kSprite²` に比例して 2.89 → **14.8 倍**、
 * オーバードローは常時 `π/4·kSprite² ≈ 11.6 × フレームバッファ`。
 * **これは Phase 2 のフィルレート測定の対象として記録する**(隠さない)。
 */

/** ガウシアンの減衰。実測で決めた値。単独で動かさないこと(kSprite と組) */
export const F = 21;
/** スプライト直径 / セル間隔。同上 */
export const K_SPRITE = 3.85;

/** 連続近似のエネルギー `∫∫ exp(−F r²) [r²≤1/4] = (π/F)(1 − e^{−F/4})`(S² で割った値) */
export function analyticK(f = F): number {
  return (Math.PI / f) * (1 - Math.exp(-f / 4));
}

/**
 * 離散化されたスプライトのエネルギー。
 *
 * **なぜ解析式ではなく数値表か。** GPU は連続円ではなく離散グリッドをラスタライズするので、
 * `Ksum(F,S)/S² → K(F)` は `S → ∞` でしか成り立たない。小さい `S` では
 * `discard` 境界が取り込む画素数が S ごとに変わるため、比が**振動する**。
 * これは較正であって公式ではないので、データとして持つ。
 *
 * ただし「駆動側の `gl_PointCoord` 規約やドライバの丸めを吸収する」とは**言えない** ──
 * CPU で作る表は我々の規約を*符号化*するだけで、食い違うドライバは吸収できない。
 * それは G2 が実測で当てる(実効 Ksum をフィットして表と 2% 以内か見る)。
 */
export function ksum(f: number, s: number): number {
  const n = Math.max(1, Math.ceil(s));
  let acc = 0;
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      const dx = (px + 0.5) / s - 0.5;
      const dy = (py + 0.5) / s - 0.5;
      const r2 = dx * dx + dy * dy;
      if (r2 <= 0.25) acc += Math.exp(-f * r2);
    }
  }
  return acc;
}

/** 表の刻み: S ∈ [1, 16]、0.125 刻みで 121 点 */
export const KSUM_S_MIN = 1;
export const KSUM_S_MAX = 16;
export const KSUM_STEP = 0.125;

export const KSUM_TABLE: Float64Array = (() => {
  const n = Math.round((KSUM_S_MAX - KSUM_S_MIN) / KSUM_STEP) + 1;
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = ksum(F, KSUM_S_MIN + i * KSUM_STEP);
  return t;
})();

/** 表を線形補間して `Ksum(F, s)` を返す。範囲外は解析式 `K·s²` に落とす */
export function ksumLookup(s: number): number {
  if (s <= KSUM_S_MIN) return ksum(F, Math.max(0.25, s));
  if (s >= KSUM_S_MAX) return analyticK() * s * s;
  const t = (s - KSUM_S_MIN) / KSUM_STEP;
  const i = Math.floor(t);
  const frac = t - i;
  return KSUM_TABLE[i] * (1 - frac) + KSUM_TABLE[i + 1] * frac;
}

/**
 * 平坦場を本来の値で再構成するための、1 スプライトあたりの輝度係数。
 *
 * `s0` = セル 1 個あたりの device px。`S = K_SPRITE · s0`。
 * `g = s0² / Ksum(F, S)` ── 連続近似では `1/(K·kSprite²)` に潰れ、
 * **点数にも DPR にも依らない定数**になる(s0 と S が同じ比で動くため)。
 */
export function gainFor(s0: number): number {
  const s = K_SPRITE * s0;
  return (s0 * s0) / ksumLookup(s);
}

/**
 * 平坦場のリップル(peak-to-peak / 平均)。テストと定数探索のための参照実装。
 * セル単位で評価する ── 格子点間隔 1、光る半径 `k/2`。
 */
export function latticeRipple(
  f: number,
  k: number,
  samples = 200,
): { p2p: number; mean: number; min: number; max: number } {
  const rad = k / 2;
  const R = Math.ceil(rad) + 1;
  let mn = Infinity;
  let mx = -Infinity;
  let sum = 0;
  for (let j = 0; j < samples; j++) {
    for (let i = 0; i < samples; i++) {
      const fx = i / samples;
      const fy = j / samples;
      let v = 0;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const d = Math.hypot(fx - dx, fy - dy);
          if (d < rad) v += Math.exp(-f * (d / k) ** 2);
        }
      }
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sum += v;
    }
  }
  const mean = sum / (samples * samples);
  return { p2p: (mx - mn) / mean, mean, min: mn, max: mx };
}
