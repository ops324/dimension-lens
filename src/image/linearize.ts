/**
 * RGBA8 → 正準リニアバッファ。**LUT はここで、ちょうど 1 回だけ適用される。**
 *
 * 二重適用は「なんとなく良いけど暗い」という気づかれにくい形で出るので、
 * `lift.test.ts` が sRGB 128 → 0.21586 を見張る ──
 * 二重なら `LUT[round(0.21586·255)] = LUT[55] = 0.0382` で 5.6 倍ずれ、見逃しようがない。
 */

import { SRGB_TO_LINEAR_LUT } from '../color/srgb';
import type { Canonical } from './stats';

/**
 * `ImageData` 相当(RGBA8)をリニア光の f32 バッファへ。アルファは捨てる
 * (Phase 1a は不透明画像のみ。α を軸にするのは Phase 6)。
 */
export function linearizeRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  gamut: 'srgb' | 'display-p3' = 'srgb',
): Canonical {
  const n = width * height;
  const linear = new Float32Array(n * 3);
  const lut = SRGB_TO_LINEAR_LUT;
  for (let i = 0, o = 0, p = 0; i < n; i++, o += 3, p += 4) {
    linear[o] = lut[rgba[p]];
    linear[o + 1] = lut[rgba[p + 1]];
    linear[o + 2] = lut[rgba[p + 2]];
  }
  return { linear, width, height, gamut };
}
