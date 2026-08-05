/**
 * 正準リニアバッファの統計と、ブロック等方正規化のスケール。
 *
 * **平均は必ず正準バッファから取る。格子からではない。** SPEC §4.7 の通り、
 * 縮約はリニア光で自分でやるのが前提で、格子は既に箱平均を経ている ──
 * そこから平均を取り直すと「平均の平均」になり、セル寸法が割り切れないときにずれる。
 */

import { linearToHex } from '../color/srgb';
import { linearToOklab, primariesFor, type RgbPrimaries } from '../color/oklab';

export interface Canonical {
  /** リニア光 RGB、3 f32/px、row-major、行 0 = 画像の**上端**、premultiply なし */
  readonly linear: Float32Array;
  readonly width: number;
  readonly height: number;
  readonly gamut: 'srgb' | 'display-p3';
}

export interface ImageStats {
  readonly meanLinear: readonly [number, number, number];
  readonly meanHex: string;
  readonly meanOklab: readonly [number, number, number];
  /** 3 f32 × 正準幅。Phase 1b の列平均バッファがこれを使う */
  readonly columnMeans: Float32Array;
  readonly lightness: {
    readonly p01: number;
    readonly p50: number;
    readonly p99: number;
    readonly span: number;
    readonly degenerate: boolean;
  };
  readonly chroma: {
    readonly p50: number;
    readonly p95: number;
    readonly max: number;
    readonly degenerate: boolean;
  };
  readonly gamut: 'srgb' | 'display-p3';
  /** いずれかのチャンネルが厳密に 0 / 1 の画素の割合 */
  readonly clipLow: number;
  readonly clipHigh: number;
  readonly pixelCount: number;
  /** OKLab 統計に使った標本数(全画素とは限らない ── 下記 SAMPLE_TARGET) */
  readonly sampleCount: number;
}

/**
 * ブロック等方正規化のスケール。**幾何(aX/aY)はここに持たない** ──
 * `imageHalfExtents` が唯一の源で、同じ事実を 2 箇所に置くと食い違ったときに
 * どちらが正しいか言えなくなる。
 */
export interface BlockScales {
  readonly lMid: number;
  /** 明度ブロックのスカラー。退化時は厳密に 1 */
  readonly sL: number;
  /** 彩度ブロックの**唯一の**スカラー。退化時は厳密に 1 */
  readonly sC: number;
  readonly degenerate: { readonly lightness: boolean; readonly chroma: boolean };
}

/** 半スパンがこれ未満なら「この画像には明度軸が無い」 */
export const L_MIN_SPAN = 0.01;
/** p95 彩度半径がこれ未満なら「この画像には色軸が無い」。OKLab 単位、ΔE ≈ 0.5 相当 */
export const C_MIN_P95 = 0.002;

/** 彩度ヒストグラムの上限(sRGB 最大 0.3225 / P3 最大 0.3685 に余裕を持たせる) */
const RMAX = 0.4;
const BINS = 1024;

/**
 * OKLab 統計の標本数上限。
 *
 * OKLab は 1 画素あたり cbrt を 3 回使うので、4.19 MP を全走査すると 1200 万回になる。
 * 決定的な等間隔間引き(画像寸法から stride を計算)で標本を取る ──
 * **乱択にはしない**。同じ写真が再読み込みのたびに違う色で出てしまい、
 * `fixture.test.ts` が flaky になる。
 *
 * 平均色と列平均は**全画素**から取る(cbrt が要らないので安い)。
 */
const SAMPLE_TARGET = 262144;

function percentileFromHistogram(
  hist: Int32Array,
  total: number,
  q: number,
  lo: number,
  hi: number,
): number {
  if (total === 0) return lo;
  const target = q * total;
  let acc = 0;
  const w = (hi - lo) / hist.length;
  for (let b = 0; b < hist.length; b++) {
    const next = acc + hist[b];
    if (next >= target) {
      // bin 内を線形補間して量子化バイアスを消す
      const within = hist[b] === 0 ? 0 : (target - acc) / hist[b];
      return lo + (b + within) * w;
    }
    acc = next;
  }
  return hi;
}

export function computeStats(src: Canonical): ImageStats {
  const { linear, width, height, gamut } = src;
  const n = width * height;
  const p: RgbPrimaries = primariesFor(gamut);

  // ---- パス 1: 全画素。平均・列平均・クリップ。cbrt なし ----
  const columnMeans = new Float32Array(width * 3);
  const colAcc = new Float64Array(width * 3);
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let clipLow = 0;
  let clipHigh = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const o = (row + x) * 3;
      const r = linear[o];
      const g = linear[o + 1];
      const b = linear[o + 2];
      sr += r;
      sg += g;
      sb += b;
      const c = x * 3;
      colAcc[c] += r;
      colAcc[c + 1] += g;
      colAcc[c + 2] += b;
      if (r <= 0 || g <= 0 || b <= 0) clipLow++;
      if (r >= 1 || g >= 1 || b >= 1) clipHigh++;
    }
  }
  const invN = 1 / n;
  const meanLinear: [number, number, number] = [sr * invN, sg * invN, sb * invN];
  const invH = 1 / height;
  for (let x = 0; x < width; x++) {
    columnMeans[x * 3] = colAcc[x * 3] * invH;
    columnMeans[x * 3 + 1] = colAcc[x * 3 + 1] * invH;
    columnMeans[x * 3 + 2] = colAcc[x * 3 + 2] * invH;
  }

  // ---- パス 2: 決定的に間引いた標本で OKLab 統計 ----
  const stride = Math.max(1, Math.floor(n / SAMPLE_TARGET));
  const lHist = new Int32Array(BINS);
  const cHist = new Int32Array(BINS);
  const lab = new Float64Array(3);
  const binScale = BINS / (RMAX * RMAX);
  const cMin2 = C_MIN_P95 * C_MIN_P95;
  let sampleCount = 0;
  let achromatic = 0; // r² ≤ C_MIN² の**厳密な**個数
  let maxC = 0;
  for (let i = 0; i < n; i += stride) {
    const o = i * 3;
    linearToOklab(p, linear[o], linear[o + 1], linear[o + 2], lab);
    const L = lab[0];
    const r2 = lab[1] * lab[1] + lab[2] * lab[2];
    sampleCount++;
    if (r2 <= cMin2) achromatic++;
    if (r2 > maxC) maxC = r2;
    let lb = (L * BINS) | 0;
    if (lb < 0) lb = 0;
    else if (lb >= BINS) lb = BINS - 1;
    lHist[lb]++;
    let cb = (r2 * binScale) | 0;
    if (cb < 0) cb = 0;
    else if (cb >= BINS) cb = BINS - 1;
    cHist[cb]++;
  }

  const p01 = percentileFromHistogram(lHist, sampleCount, 0.01, 0, 1);
  const p50 = percentileFromHistogram(lHist, sampleCount, 0.5, 0, 1);
  const p99 = percentileFromHistogram(lHist, sampleCount, 0.99, 0, 1);
  const span = (p99 - p01) / 2;

  const cp50 = Math.sqrt(percentileFromHistogram(cHist, sampleCount, 0.5, 0, RMAX * RMAX));
  const cp95 = Math.sqrt(percentileFromHistogram(cHist, sampleCount, 0.95, 0, RMAX * RMAX));

  /**
   * 退化判定は**ヒストグラムから取らない。**
   *
   * bin 幅は r² で 1.5625e-4 なので bin 0 は r ∈ [0, 0.0125] を覆う。しきい値 0.002 は
   * その 1/39 で、bin の中に埋もれている ── 純グレースケール(全標本 r²=0)でも
   * 補間 p95 は 0.0122 と出て、**退化が絶対に発火しない**。実測で確認済み。
   *
   * 「p95 < C_MIN」は「r² ≤ C_MIN² の画素が 95% を超える」と同値なので、
   * 同じループで厳密に数える(比較 1 回)。SPEC §2.2 の「その軸は存在しないと表明する」が
   * 機能するかどうかが、この 1 行に掛かっている。
   */
  const chromaDegenerate = achromatic > 0.95 * sampleCount;
  const lightnessDegenerate = span < L_MIN_SPAN;

  linearToOklab(p, meanLinear[0], meanLinear[1], meanLinear[2], lab);

  return {
    meanLinear,
    meanHex: linearToHex(meanLinear[0], meanLinear[1], meanLinear[2]),
    meanOklab: [lab[0], lab[1], lab[2]],
    columnMeans,
    lightness: { p01, p50, p99, span, degenerate: lightnessDegenerate },
    chroma: {
      p50: cp50,
      p95: cp95,
      max: Math.sqrt(maxC),
      degenerate: chromaDegenerate,
    },
    gamut,
    clipLow: clipLow / n,
    clipHigh: clipHigh / n,
    pixelCount: n,
    sampleCount,
  };
}

/**
 * ブロック等方正規化のスケール。
 *
 * 規則は「**スパンで割らない。スケールを置く**」── 測った微小値を*使う*のではなく
 * *置き換える*ので、`0/0` が構造的に発生しない。
 */
/**
 * 5 軸 `[u, v, L, a, b]` のそれぞれが**この画像に存在するか**（SPEC §2.2）。
 *
 * 空間軸 (u, v) は常に存在する ── 画像が 1×1 でも「縦と横」は概念として在る。
 * 明度ブロックが退化すれば軸 2 が、彩度ブロックが退化すれば軸 3・4 が同時に落ちる
 * （彩度は **1 スカラー**で正規化されるので、a と b が別々に退化することはない。§2.1）。
 *
 * **`lensScene` が `extent` を 0 に固定するのに使う。** 純関数なので node で採点できる ──
 * 退化の表明が「シーンに届いているか」を、ブラウザを起動せずに落とせる。
 */
export function axisPresence(scales: BlockScales): boolean[] {
  const { lightness, chroma } = scales.degenerate;
  return [true, true, !lightness, !chroma, !chroma];
}

/**
 * 退化の種類。`copy.ts` の `DEGENERATE_COPY` の鍵になる。`null` は「退化していない」。
 * **`'both'` を `'chroma'` に丸めない** ── 単色画像に「色の軸がありません」とだけ言うと、
 * 明度の軸は動くという含意になり、偽になる。
 */
export function degeneracyKind(scales: BlockScales): 'chroma' | 'lightness' | 'both' | null {
  const { lightness, chroma } = scales.degenerate;
  if (lightness && chroma) return 'both';
  if (chroma) return 'chroma';
  if (lightness) return 'lightness';
  return null;
}

export function computeScales(stats: ImageStats): BlockScales {
  const lightness = stats.lightness.degenerate;
  const chroma = stats.chroma.degenerate;
  return {
    lMid: (stats.lightness.p01 + stats.lightness.p99) / 2,
    sL: lightness ? 1 : stats.lightness.span,
    sC: chroma ? 1 : stats.chroma.p95,
    degenerate: { lightness, chroma },
  };
}
