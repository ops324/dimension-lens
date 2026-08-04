/**
 * sRGB 伝達関数。
 *
 * **原色行列は受け取らない。** Display P3 は sRGB と**同じ区分伝達関数**を使う ──
 * 違うのは原色(色域)だけである。これを取り違えるのはよくある、そして高くつく誤りなので
 * ここに書いておく。原色の違いは `oklab.ts` の行列が担う。
 *
 * 2.2 乗の近似は使わない。厳密な区分関数を使う ── SPEC §罠「sRGB デコードは CPU の責任」の通り、
 * ここを誤ると見た目が明るくなるだけでなく、OKLab がリニア sRGB 上で定義されているために
 * **軸 2,3,4 の幾何が誤る**(§1 優先度1 違反)。
 */

/** sRGB エンコード値 [0,1] → リニア光 [0,1]。区分関数(近似ではない) */
export function srgbToLinear(s: number): number {
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** リニア光 [0,1] → sRGB エンコード値 [0,1]。OETF */
export function linearToSrgb(l: number): number {
  return l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
}

/**
 * 8bit コード値 → リニア光の参照表。**worker の唯一のデコーダ。**
 *
 * 256 エントリなので 8bit 入力に対しては厳密(丸め誤差すら無い)。
 * 「LUT が一度だけ適用されたか」は `lift.test.ts` が
 * 「sRGB 128 → 0.21586」で見張る ── 二重適用なら `LUT[55] = 0.0382` で 5.6 倍ずれ、見逃しようがない。
 */
export const SRGB_TO_LINEAR_LUT: Float64Array = (() => {
  const lut = new Float64Array(256);
  for (let i = 0; i < 256; i++) lut[i] = srgbToLinear(i / 255);
  return lut;
})();

/** リニア光 → 8bit コード値(丸め)。表示のためだけに使う終端関数 */
export function linearToCode(l: number): number {
  const s = linearToSrgb(l < 0 ? 0 : l > 1 ? 1 : l);
  return Math.round(s * 255);
}

/** リニア RGB → `#rrggbb`。**エンコードはここが最後の一点** */
export function linearToHex(r: number, g: number, b: number): string {
  const h = (v: number) => linearToCode(v).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
