/**
 * `CompressPass` の定数と機構（Phase 2b）。**ここが唯一の源** ── `postfx.ts` は読むだけ。
 *
 * ## `uKnee = 0.8` は親から継いだ値ですらなかった
 *
 * この定数は Phase 1a-iii で `CompressPass` を新設したときに**この repo で新しく置かれた
 * リテラル**である。親（dimension）には `CompressPass` が無い。つまり
 * 「実測で決めた」でも「親の実測を継いだ」でもなく、**一度も測っていない**。
 * そのうえ 2a まで `setCompressStrength` を呼ぶ者がどこにも無く、出荷経路では
 * パス自体が `enabled = false` だった ── **配線されていない未計測の定数**である。
 *
 * ## 測った（`readbackHDR`・988×778・ANGLE Metal / Apple M1 Max・標本 No.0）
 *
 * `OutputPass` の**前**で全面を読み、`dimLevel` と位相を掃いた分布:
 *
 * | dimLevel | p50 | p99 | p99.9 | 最大 | > 1.0 の画素 |
 * |---|---|---|---|---|---|
 * | 0 | 0.135 | 0.237 | 0.237 | **0.237** | 0 |
 * | 1 | 0.188 | 0.376 | 0.422 | **0.437** | 0 |
 * | 1.5 | 0.218 | 0.970 | 1.026 | **1.050** | 2,192 |
 * | **2（アンカー）** | 0.216 | 1.000 | 1.000 | **1.000** | **0** |
 * | 2.5 | 0.220 | 0.996 | 1.225 | **1.740** | 9,842 |
 * | 3 | 0.221 | 0.998 | 1.168 | **1.540** | 8,090 |
 * | 4 | 0.220 | 1.001 | 1.203 | **1.638** | 5,615 |
 * | 5 | 0.219 | 1.042 | 1.366 | **1.718** | 10,391 |
 *
 * 位相まで掃いた**包絡**は **2.0176**（`d = 4.25`）。
 *
 * ### ニーは 0.8 のままにする —— ただし「測ってから」
 *
 * ニー以下は `uStrength` が何であれ厳密に素通しなので、ニーの位置は
 * 「どこまでを 1 ビットも動かさないと約束するか」そのものである。満たすべき条件:
 *
 *   1. **アンカーの平坦部** sRGB 128 = リニア **0.21586**（§4.5 の錨）── 実測 p50 と一致
 *   2. **`d = 0` の平均色** リニア **0.26665**（G9 の測定点）
 *   3. 1.0（標本の白）は素通しにできない ── 素通しなら圧縮の余地が消える
 *
 * 0.8 は 2 の **3.0 倍**あり、条件を大きく満たしている。**測って足りていたので動かさない** ──
 * 動かす理由が無いのに動かすのは「勝手に改善する」である（SPEC §8）。
 * 代償は書いておく: `d = 2` で 0.8 を超える画素が **62,444 個**あり（白マーカーとランプの上端）、
 * アンカー窓を出たところではそれらが圧縮を受ける。
 *
 * ## 強度は `rotationGate` から出す —— **窓の縁で跳ねさせないため**
 *
 * 最初 `dimLevel` ごとの峰の表を引いて強度を作ろうとして、**アンカー窓の縁で
 * 強度が 0 から 4.4 へ飛ぶ**ことに気づいた。`d = 2` では 0.8 超の画素が 6 万個あるので、
 * それは**窓を出た瞬間に白がストンと落ちる**という見え方になる。
 * `rotationSchedule.ts` が門を `smoothstep`（C¹）で作ったのと同じ問題で、同じ答えでよい:
 *
 * ```
 * strength(d) = rotationGate(d) · COMPRESS_MAX_STRENGTH
 * ```
 *
 * 窓の中では `rotationGate` が**厳密に 0** を返すので、圧縮は
 * 「測ったら峰が 1.0 以下だった」という偶然ではなく**構造で**恒等になる。
 * 動き始めること・写真が雲へ解けること・圧縮が入ることが、**同じ 1 つの門**から出る。
 *
 * ## 最大強度は代数で決まる
 *
 * `y = k + (x − k)/(1 + s·(x − k))` を `x = V` で `y = 1` に落とすなら
 * `s = (V − 1) / ((1 − k)·(V − k))`。探索ではないので、残る自由度は **V だけ**である。
 * V には実測の包絡 2.0176 に **1.25 倍**の余裕を掛けた値を使う ──
 * 位相は無限に流れ続けるので、8 点の掃引で見た最大が上限だとは言えない。
 */

import { rotationGate } from '../render/rotationSchedule';

/**
 * ニー（リニア光）。**ここ以下は `uStrength` が何であれ 1 ビットも動かない。**
 * `postfx.ts` の `uKnee` はこの値を読む（同じ量を 2 か所に置かない・SPEC §5）。
 */
export const COMPRESS_KNEE = 0.8;

/** `d = 2` の平坦部（sRGB 128）。ニーはこれより上でなければならない */
export const ANCHOR_FLAT_LINEAR = 0.21586050011389923;

/**
 * `dimLevel` と位相を掃いて実測した HDR の峰（`readbackHDR`・ANGLE Metal / M1 Max）。
 * **データであって参照表ではない** ── 出荷時の強度はここを引かない。
 * `compress.test.ts` が「この峰の全部が圧縮後に 1.0 以下へ入る」を検算するのに使う。
 */
export const MEASURED_HDR_PEAKS: readonly { readonly d: number; readonly peak: number }[] = [
  { d: 0, peak: 0.23718 },
  { d: 0.25, peak: 0.41895 },
  { d: 0.5, peak: 0.43774 },
  { d: 0.75, peak: 0.45068 },
  { d: 1, peak: 0.46191 },
  { d: 1.25, peak: 1.12012 },
  { d: 1.5, peak: 1.11816 },
  { d: 1.75, peak: 0.95654 },
  { d: 2, peak: 1.0 },
  { d: 2.25, peak: 1.05566 },
  { d: 2.5, peak: 1.74023 },
  { d: 2.75, peak: 1.59375 },
  { d: 3, peak: 1.70801 },
  { d: 3.25, peak: 1.91113 },
  { d: 3.5, peak: 1.7373 },
  { d: 3.75, peak: 1.91406 },
  { d: 4, peak: 2.00781 },
  { d: 4.25, peak: 2.01758 },
  { d: 4.5, peak: 1.91797 },
  { d: 4.75, peak: 1.875 },
  { d: 5, peak: 1.78711 },
];

/** 実測した包絡（上の表の最大） */
export const MEASURED_PEAK_ENVELOPE = 2.01758;

/**
 * 設計に使う峰。**位相は無限に流れるので、8 点の掃引で見た最大を上限とは呼べない。**
 * 25% の余裕を明示的な定数として置く（安全側へ倒したことを隠さない）。
 */
export const PEAK_MARGIN = 1.25;
export const COMPRESS_DESIGN_PEAK = MEASURED_PEAK_ENVELOPE * PEAK_MARGIN;

/**
 * シェーダ `COMPRESS_FRAGMENT_SHADER` の**写し**（node 側の参照実装）。
 *
 * 写しなので「シェーダが正しい」の根拠には使えない ── 使うのは
 * **ニー以下が厳密に素通しであること**と、**実測の峰が圧縮後に 1.0 以下へ入ること**を
 * node で網羅的に確かめるためだけである。シェーダ側の恒等性は
 * G6 の「強度 0 で画素まで恒等」が実機で見ている（§7.9.2 の 2 本立て）。
 */
export function compressChannel(x: number, strength: number, knee = COMPRESS_KNEE): number {
  if (!(strength > 0)) return x;
  if (x <= knee) return x;
  const over = x - knee;
  return knee + over / (1 + strength * over);
}

/**
 * 峰 `peak` を厳密に 1.0 へ落とす強度。**代数であって探索ではない。**
 * `peak ≤ 1` では 0（＝ `CompressPass` が厳密な恒等）。
 */
export function strengthForPeak(peak: number, knee = COMPRESS_KNEE): number {
  if (!(peak > 1)) return 0;
  const denom = (1 - knee) * (peak - knee);
  if (!(denom > 0)) return 0;
  return (peak - 1) / denom;
}

/** 門が全開のときの強度 */
export const COMPRESS_MAX_STRENGTH = strengthForPeak(COMPRESS_DESIGN_PEAK);

/**
 * 出荷経路の強度（Phase 2b で**初めて配線した**）。
 *
 * **アンカー窓では `rotationGate` が厳密に 0 を返すので、構造的に恒等**である ──
 * 「測ったら峰が 1.0 以下だった」という偶然に錨を預けない。
 * 窓の外では `smoothstep` で連続に立ち上がるので、白が跳ねない。
 */
export function compressStrengthFor(dimLevel: number): number {
  if (!Number.isFinite(dimLevel)) return 0;
  return rotationGate(dimLevel) * COMPRESS_MAX_STRENGTH;
}
