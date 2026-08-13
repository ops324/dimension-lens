/**
 * 加算合成の**残差の機構**を切り分けるための、node で回るモデル群と、
 * それを区別できる値の並び（`blendCases()`）。
 *
 * ## 仮説は 3 つ立てた（SPEC §4.6 訂正 4 の宿題）。**当たったのは 4 つ目である**
 *
 * `dimLevel = 0` の残差は、位相の寄与を除いても **−5.2%（標本 No.0）/ −6.0%（二値）**
 * あり、**左右を反転しただけで 1 コード動く**（＝ 加算の順序に依存する）。
 * ところが監査の fp16 逐次丸めシミュレーションは **1% 未満**を出しており、
 * **実測とモデルが矛盾したまま Phase 2a を終えた**（水準 C）。
 *
 * 矛盾を「どちらかが雑だった」で閉じるのは、この文書がいちばん避けたい形である。
 * → **仮説を 3 つに分け、区別できる入力を作って、GPU に投票させる。**
 *
 * | モデル | 仮定 | `blendF32` / `blendF16` / `blendF16FlushSource` |
 * |---|---|---|
 * | **f32 厳密** | アキュムレータは f32。fp16 は保管形式でしかない | 残差は fp16 由来では**ない** |
 * | **fp16 round-to-nearest** | 加算のたびに fp16 へ最近接丸め（監査のモデル） | 1% 未満のはず |
 * | **fp16 + 非正規数ソースの切り捨て** | 上に加え、**ソース**が fp16 の最小正規数 `2⁻¹⁴` を下回ると 0 に潰れる | 暗い側が丸ごと消える |
 *
 * 3 番目が本命の仮説だった。SPEC §4.6 が記録した「暗い列の 1 点あたりの寄与は
 * **3.0e−5** で、half-float の最小正規数 **6.104e−5** を下回る」がその条件で、
 * **多くの GPU はブレンドユニットで非正規数を flush-to-zero する**からである。
 *
 * ## 実測は 3 つとも外した —— **答えは 4 つ目だった**（Phase 2b・ANGLE Metal / M1 Max）
 *
 * **引数**: 4 つのモデル列はそれぞれ `blendF32` / `blendF16` / `blendF16FlushSource` /
 * `blendF16TruncateToZero` に `blendCases()` の `values` を渡した値である
 * （`BLEND_MODELS` の並び順）。**実測列だけが GPU（`BlendProbe`）**で、node では出ない。
 *
 * | ケース | 実測 | f32 | fp16 RN | fp16+切り捨て | **fp16 RTZ** |
 * |---|---|---|---|---|---|
 * | `selftest-exact` | 1.75 | 1.75 | 1.75 | 1.75 | 1.75 |
 * | `f16-vs-f32` | **1.0** | 1.0009766 | 1.0 | 1.0 | 1.0 |
 * | `subnormal-tail` | **0.021759033** | 0.030719848 | 0.031188965 | **0** | 0.021759033 |
 * | `uniform-378` | **0.244628906** | 0.266649395 | 0.274169922 | 0.274169922 | 0.244628906 |
 * | `binary-bright-first` | **0.292968750** | 0.307249308 | 0.296386719 | 0.296386719 | 0.292968750 |
 * | `binary-dark-first` | **0.298828125** | 0.307249844 | 0.302246094 | 0.296386719 | 0.298828125 |
 *
 * **6 ケースすべてで `blendF16TruncateToZero` が厳密に一致した**（`Object.is`）。
 * つまりブレンドユニットは fp16 で積み、**最近接ではなく 0 方向へ切り捨てる**。
 *
 * これが §4.6 の矛盾を解く:
 *
 *   - `f16-vs-f32` が **1.0** なので、アキュムレータが f32 だという仮説は**反証された**
 *   - `subnormal-tail` が **0 でない**ので、非正規数ソースは**潰されていない**
 *   - **最近接丸めは不偏**なので誤差が打ち消し合い、監査のシミュレーションは 1% 未満を出した。
 *     **切り捨ては片側にしか外れない** ── 深度に比例して系統的に暗くなる。
 *     実測が「常に undershoot で、深度と項の大きさに比例する」形だったのはこれである。
 *
 * **これは仮説として持ち込んだものではない。** 3 つとも外れたあと、
 * 「undershoot が片側にしか出ない」という**符号の観察**から丸めモードを疑って足した ──
 * 器具が無ければ、3 つのうち一番近いものを選んで終わっていた
 * （だから `classifyBlend` は「いちばん近いモデル」を返さない。下記）。
 *
 * ### 分けられなかった区別（隠さない）
 *
 * `blendF16TruncateToZero` と「ソースも切り捨ててから足す」版は、**この 6 ケースでは
 * 1 ビットも違わない**。区別する入力を作れなかったので、区別できていない。
 * 作品への帰結は同じなので追わない。
 *
 * ## モデルを分けるだけでは足りない —— **区別できる入力**が要る
 *
 * 「モデルを 4 つ書いたが、どの入力でも 4 つとも同じ値を出す」なら、判定は `x/x` である
 * （§7.7 の `fillRatios`）。だから各ケースは**どの 2 モデルがどこで分かれるか**を明記し、
 * `blendModel.test.ts` が「**どの 2 モデルも、少なくとも 1 つのケースで分かれる**」ことを
 * 機械で見張る ── 分けられないモデルを並べても、投票にはならない。
 *
 * 分かれ目の設計:
 *
 *   - `f16-vs-f32`: `1` に `2⁻¹²` を 4 回足す。f32 は `1 + 2⁻¹⁰`、
 *     fp16 は毎回 `ulp(1)/4` なので**丸め戻って 1 のまま**。
 *   - `subnormal-tail`: `3.0e−5` を 1024 回。fp16 でもアキュムレータが小さいので
 *     **積める**が、ソースを切り捨てるなら**厳密に 0** になる。
 *   - `binary-dark-first`: 暗い項（`3.4e−5`・非正規数）を**先に**積んでから明るい項。
 *     fp16 RN では暗い側が生き残り、非正規数を潰すモデルでは消える。
 *     **明るい側を先に積む `binary-bright-first` ではその 2 つが一致する** ──
 *     つまり順序依存そのものが判別器になっている（実測の「鏡像で 1 コード動く」がこれ）。
 */

import { srgbToLinear } from '../color/srgb';

/** fp16 の最小**正規**数 `2⁻¹⁴`。非正規数の切り捨てはこの線で起きる */
export const F16_MIN_NORMAL = 2 ** -14;
/** fp16 の最小非正規数 `2⁻²⁴`（＝ 非正規域の ulp） */
export const F16_MIN_SUBNORMAL = 2 ** -24;
/** fp16 の最大有限値 */
export const F16_MAX = 65504;
/** これ以上は最近接丸めで Infinity へ行く（65504 と 65536 の中点） */
const F16_OVERFLOW_TIE = 65520;

/** 最近接偶数丸め。`Math.round` は .5 を常に上へ送るので使えない */
function roundTiesToEven(q: number): number {
  const floor = Math.floor(q);
  const frac = q - floor;
  if (frac > 0.5) return floor + 1;
  if (frac < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * f64 → fp16（IEEE 754 binary16・最近接偶数）→ f64。
 *
 * **`Float16Array` を使わずに書く。** `core/capture.ts` の `halfToFloat` が
 * デコード側の独立な実装であるのと同じ理由で、こちらもエンコード側を自前で持つ ──
 * `blendModel.test.ts` が両者を突き合わせる（`Float16Array` が在る環境では
 * それとも突き合わせる）。同じ実装を 2 回呼んで一致を確かめるのは検証ではない。
 */
export function f16(value: number): number {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return value;
  const sign = value < 0 ? -1 : 1;
  const r = quantize(Math.abs(value), roundTiesToEven);
  if (r >= F16_OVERFLOW_TIE) return sign * Infinity;
  return sign * r;
}

/**
 * f64 → fp16（**0 方向へ切り捨て**）→ f64。
 *
 * **実測が選んだ丸めモードである**（上の表）。最近接と違って**片側にしか外れない**ので、
 * 深度 `n` の加算では誤差が打ち消し合わず、`n · ulp` まで系統的に暗くなる ──
 * §4.6 の「常に undershoot」「深度と項の大きさに比例」がここから出る。
 *
 * 飽和は最大有限値で止める（切り捨てなので Infinity へは行かない）。
 */
export function f16TruncateToZero(value: number): number {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return value;
  const sign = value < 0 ? -1 : 1;
  return sign * Math.min(quantize(Math.abs(value), Math.floor), F16_MAX);
}

/**
 * `x > 0` を fp16 の格子へ乗せる。非正規域は指数を −14 に固定して `ulp = 2⁻²⁴` にする。
 * **丸め方だけを引数で受け取る** ── 格子の作り方を 2 か所に書かないため（SPEC §5）。
 */
function quantize(x: number, round: (q: number) => number): number {
  let e = Math.floor(Math.log2(x));
  if (e < -14) e = -14;
  if (e > 15) e = 15;
  const ulp = 2 ** (e - 10);
  return round(x / ulp) * ulp;
}

// ------------------------------------------------------- モデル（仮説 3 + 実測 1）

/**
 * **モデル 1: f32 厳密。** fp16 は保管形式でしかなく、加算は f32 で行われる、という仮定。
 * これが当たるなら、実測の −5.2% は fp16 の丸め**ではない**別の機構から来ている。
 */
export function blendF32(values: ArrayLike<number>): number {
  let acc = 0;
  for (let i = 0; i < values.length; i++) acc = Math.fround(acc + values[i]);
  return acc;
}

/**
 * **モデル 2: fp16 最近接丸め。** 加算そのものは f32 で行い、
 * **結果を書き戻すときだけ** fp16 へ丸める（＝ 監査がシミュレートしたモデル）。
 */
export function blendF16(values: ArrayLike<number>): number {
  let acc = 0;
  for (let i = 0; i < values.length; i++) acc = f16(acc + values[i]);
  return acc;
}

/**
 * **モデル 3: fp16 ＋ 非正規数ソースの切り捨て。**
 *
 * ブレンドユニットが**ソース側**の非正規数を 0 に潰す（flush-to-zero）仮定。
 * アキュムレータ側は潰さない ── 潰す実装もありうるが、それは別のモデルである。
 * **この仮説は実測に反証された**（`subnormal-tail` が 0 にならなかった）。
 */
export function blendF16FlushSource(values: ArrayLike<number>): number {
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    acc = f16(acc + (Math.abs(v) < F16_MIN_NORMAL ? 0 : v));
  }
  return acc;
}

/**
 * **モデル 4: fp16 ＋ 0 方向への切り捨て。** 実測が選んだモデル（上の表・6/6 が厳密一致）。
 *
 * **持ち込んだ仮説ではない** ── 3 つとも外れ、しかも実測が常に予測より小さかったので、
 * 「片側にしか外れない = 丸めモード」を疑って足した。
 */
export function blendF16TruncateToZero(values: ArrayLike<number>): number {
  let acc = 0;
  for (let i = 0; i < values.length; i++) acc = f16TruncateToZero(acc + values[i]);
  return acc;
}

export type BlendModelKey = 'f32' | 'f16' | 'f16-flush' | 'f16-rtz';

export interface BlendModel {
  readonly key: BlendModelKey;
  readonly name: string;
  readonly run: (values: ArrayLike<number>) => number;
}

export const BLEND_MODELS: readonly BlendModel[] = [
  { key: 'f32', name: 'f32 厳密（fp16 は保管形式でしかない）', run: blendF32 },
  { key: 'f16', name: 'fp16 最近接丸め（監査のモデル）', run: blendF16 },
  {
    key: 'f16-flush',
    name: 'fp16 ＋ 非正規数ソースの切り捨て',
    run: blendF16FlushSource,
  },
  {
    key: 'f16-rtz',
    name: 'fp16 ＋ 0 方向への切り捨て（**実測が選んだモデル**）',
    run: blendF16TruncateToZero,
  },
];

/**
 * Phase 2b の実測で 6/6 が厳密一致したモデル。**ラダーがこの ID を採点する。**
 *
 * ここを別の ID に書き換えると `blendModel.test.ts` が落ちる ── そうしておかないと、
 * 「どのモデルが当たったか」がコメントの中だけの主張になる。
 */
export const OBSERVED_BLEND_MODEL: BlendModelKey = 'f16-rtz';

// ------------------------------------------------------------- 規定した値の並び

export interface BlendCase {
  readonly key: string;
  readonly name: string;
  /** 積む順序そのものが意味を持つ。**並べ替えてはいけない** */
  readonly values: Float64Array;
  /** このケースで分かれるモデルの組。空なら「どれも分かれない」（＝ 自己検査用） */
  readonly separates: readonly (readonly [BlendModelKey, BlendModelKey])[];
  readonly why: string;
}

/**
 * §4.6 の二値実験を再現するための 1 点あたりの寄与。
 *
 * `gain · sampleWeight` = **0.4530724335144705 × 0.0058472** ── どちらも Phase 1b/2a の
 * 実測値（前者は §7.7 のアンカー表、後者は `collapseWeight` の実測表）。
 * この係数を掛けた結果、**コード 30 の列は 3.4e−5 になり fp16 の最小正規数を下回る** ──
 * SPEC §4.6 が「暗い列の 1 点あたりの寄与は 3.0e−5」と記録したのがこの量である。
 */
const GAIN_TIMES_SAMPLE_WEIGHT = 0.4530724335144705 * 0.0058472;

/** §4.6 の「左 199 / 右 30 の二値」の 1 点あたり寄与 */
export function binaryContribution(code: number): number {
  return srgbToLinear(code / 255) * GAIN_TIMES_SAMPLE_WEIGHT;
}

function repeat(value: number, n: number): Float64Array {
  const out = new Float64Array(n);
  out.fill(value);
  return out;
}

/**
 * **器具に食わせる値の並び。** node（モデル）とブラウザ（`BlendProbe`）が
 * **同じ定義**を読む ── 別々に書くと、食い違ったときにどちらが違うのか言えない。
 * 独立でなければならないのは*モデルと GPU* であって、*入力*ではない。
 */
export function blendCases(): BlendCase[] {
  const bright = binaryContribution(199);
  const dark = binaryContribution(30);

  /** §4.6 の「左 199 / 右 30」＝ 明るい 199 列と暗い 179 列。順序だけを入れ替える */
  const binary = (darkFirst: boolean): Float64Array => {
    const out = new Float64Array(378);
    for (let i = 0; i < 378; i++) {
      const isDark = darkFirst ? i < 179 : i >= 199;
      out[i] = isDark ? dark : bright;
    }
    return out;
  };

  return [
    {
      key: 'selftest-exact',
      name: '自己検査: 1 + 0.5 + 0.25（どの段でも fp16 で厳密）',
      values: Float64Array.from([1, 0.5, 0.25]),
      separates: [],
      why: '4 モデルとも 1.75。**器具が 1.75 を返さないなら、以降のどの数値も意味を持たない**',
    },
    {
      key: 'f16-vs-f32',
      name: '1 に 2⁻¹² を 4 回足す',
      values: Float64Array.from([1, 2 ** -12, 2 ** -12, 2 ** -12, 2 ** -12]),
      separates: [['f32', 'f16']],
      why: 'f32 は 1 + 2⁻¹⁰、fp16 は毎回 ulp(1)/4 なので**丸め戻って 1 のまま**',
    },
    {
      key: 'subnormal-tail',
      name: '3.0e−5（fp16 の非正規数）を 1024 回',
      values: repeat(3.0e-5, 1024),
      separates: [
        ['f16', 'f16-flush'],
        ['f32', 'f16-flush'],
        ['f16', 'f16-rtz'],
        ['f16-flush', 'f16-rtz'],
      ],
      why: 'アキュムレータが小さいので fp16 でも積めるが、**ソースを切り捨てるなら厳密に 0**',
    },
    {
      key: 'uniform-378',
      name: '等しい項 378 個（§4.6 の「項がすべて等しい」＝ 残差 ≈ 0%）',
      values: repeat(0.26665 / 378, 378),
      separates: [
        ['f32', 'f16'],
        ['f32', 'f16-rtz'],
        ['f16', 'f16-rtz'],
      ],
      why: '実測で残差 ≈ 0% だった条件。ここで大きな残差が出るなら前提から違う',
    },
    {
      key: 'binary-bright-first',
      name: '§4.6 の二値: 明るい 199 列 → 暗い 179 列',
      values: binary(false),
      separates: [
        ['f32', 'f16'],
        ['f32', 'f16-flush'],
        ['f16', 'f16-rtz'],
      ],
      why: '暗い項がアキュムレータ 0.3 に対して ulp の 1/7 なので、**fp16 でも切り捨てでも消える** ──'
        + ' このケースは 2 つの fp16 モデルを分けない。**分けないことを書いておく**',
    },
    {
      key: 'binary-dark-first',
      name: '§4.6 の二値の**鏡像**: 暗い 179 列 → 明るい 199 列',
      values: binary(true),
      separates: [
        ['f16', 'f16-flush'],
        ['f32', 'f16-flush'],
        ['f16', 'f16-rtz'],
        ['f16-flush', 'f16-rtz'],
      ],
      why: '暗い項を先に積めば fp16 では生き残る。**切り捨てモデルだけが消す** ──'
        + ' 実測の「鏡像で 1 コード動く」順序依存が、そのまま判別器になっている',
    },
  ];
}

// --------------------------------------------------------------------- 判定

export interface BlendVerdict {
  readonly key: string;
  readonly measured: number;
  readonly predicted: Record<BlendModelKey, number>;
  /** 相対誤差（|測定 − 予測| / max(|予測|, floor)） */
  readonly relError: Record<BlendModelKey, number>;
  /** 相対誤差が `tolerance` 以内のモデル。**0 個も 2 個以上もありうる** */
  readonly matches: BlendModelKey[];
}

/**
 * 測定値がどのモデルと一致するかを返す。
 *
 * **「いちばん近いモデル」を返さない。** 最近傍で答えを作ると、3 モデルとも
 * 実測から遠くても必ず 1 つが「勝つ」── どのモデルも当たっていないという結論が
 * 出せなくなる。閾値を置いて `matches` を返し、**0 個なら 0 個と報告する**。
 *
 * `floor` は「予測が 0 のとき相対誤差が定義できない」ための下駄で、
 * fp16 の最小正規数を使う（それより小さい差は fp16 の RT に載らない）。
 *
 * **既定の許容 `1e−6` は実質的に厳密一致である。** fp16 の 1 ulp は相対 `2⁻¹¹ ≈ 4.9e−4`
 * なので、意味のある差はすべてこれより 2 桁以上大きい。ここを緩めると
 * `f16-vs-f32` のケース（両者の差が `9.76e−4`）で **2 つのモデルが同時に「一致」する** ──
 * 投票が成立しなくなるので、許容は**最小の分離幅より小さく**なければならない。
 */
export function classifyBlend(
  key: string,
  values: ArrayLike<number>,
  measured: number,
  tolerance = 1e-6,
): BlendVerdict {
  const predicted = {} as Record<BlendModelKey, number>;
  const relError = {} as Record<BlendModelKey, number>;
  const matches: BlendModelKey[] = [];
  for (const m of BLEND_MODELS) {
    const p = m.run(values);
    predicted[m.key] = p;
    const denom = Math.max(Math.abs(p), F16_MIN_NORMAL);
    const e = Math.abs(measured - p) / denom;
    relError[m.key] = e;
    if (e <= tolerance) matches.push(m.key);
  }
  return { key, measured, predicted, relError, matches };
}
