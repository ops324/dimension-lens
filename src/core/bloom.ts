/**
 * bloom の定数（Phase 2b で `postfx.ts` から出した）。**ここが唯一の源。**
 *
 * ## なぜ移したのか
 *
 * `postfx.ts` は移植ファイルで、`vendor.test.ts` が sha256 で丸ごと固定している。
 * すると **`postfx.ts` の中の 1 文字を変えれば必ず何かが落ちる** ──
 * つまり「bloom の閾値を下げたら落ちた」という歯は、閾値を守っているのではなく
 * **移植ファイルが書き換わったことを検出しているだけ**になる（`x/x` の一種）。
 * `scripts/teeth.mjs` の台帳は「どの主張を守っているか」を記す帳簿なので、
 * その区別が付かない場所に定数を置いておくのは害である。
 *
 * → 定数をここへ出す。`bloom.test.ts` はここを見る。
 * `postfx.ts` は読むだけになり、`core/compress.ts` と同じ形になった。
 *
 * ## 閾値の意味（`bloom.test.ts` が柵を張っている）
 *
 * `UnrealBloomPass` は `luma < threshold` を完全に落とし、
 * `[threshold, threshold + smoothWidth]` で滑らかに通す。つまり:
 *
 *   - **強度**を動かしても、閾値の下の画素は 1 ビットも動かない
 *   - **閾値**を下げると、平坦部そのものが光り始める
 *
 * `d = 0` の目標リニア輝度（標本 No.0 の平均色の Rec.709 輝度）は **0.265546** で、
 * 閾値 **0.28** はその **1.0544 倍**しかない。下げると **G9 の測定点が bloom の内側へ入る**。
 * SPEC §8 が Phase 2 を 2a / 2b / 2c に割った理由がこれで、
 * **順序（柵 → 定数）が保証になっている**。
 */

/** 親が Phase 11 で実測して決めた値。**Phase 2b では触らない** */
export const BLOOM_BASE_STRENGTH = 0.4;
export const BLOOM_BASE_RADIUS = 0.25;

/**
 * bloom の閾値（リニア光の Rec.709 輝度）。
 * **`bloom.test.ts` が「平均色の輝度より十分上」を node で見張っている。**
 */
export const BLOOM_BASE_THRESHOLD = 0.28;

/**
 * Rec.709 の相対輝度の重み。**three の `LuminosityHighPassShader` と同じ値**でなければ、
 * 閾値の柵は「別の量に対する柵」になる。`postfx.ts` の `GRADE_FRAGMENT_SHADER` の
 * `LUMA` もこれと同じ 3 つ組である。
 */
export const LUMA_WEIGHTS: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

/**
 * `UnrealBloomPass` が閾値の**上**に置く立ち上がり幅（three の `smoothWidth` 既定値）。
 * 立ち上がりが上側なので、柵は「目標輝度 < 閾値」で足りる。
 */
export const BLOOM_SMOOTH_WIDTH = 0.01;

/** リニア光 RGB → Rec.709 相対輝度（bloom の高域通過が見ている量そのもの） */
export function luma709(r: number, g: number, b: number): number {
  return LUMA_WEIGHTS[0] * r + LUMA_WEIGHTS[1] * g + LUMA_WEIGHTS[2] * b;
}
