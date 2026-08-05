/**
 * 標本 No.0 を、取り込み経路が実際に受け取る形(`Blob`)へ。
 *
 * **RGBA を直接 `linearizeRgba` に渡さない。** そうすると起動時の自己検査が
 * デコード・縮小・読み戻し・EXIF 判定を**全部飛ばして**緑になる ──
 * SPEC が最も嫌う「常に緑」そのものになる。標本を実際にエンコードして、
 * ユーザーのファイルと同じ入口から入れる。
 *
 * PNG を使う理由は可逆だから。JPEG にすると起動のたびに ΔE00 の予算を
 * 取り込み側で先食いすることになり、Phase 1a-iii の忠実性測定が
 * 「何のせいで落ちたか」を言えなくなる。
 */

import { makeSpecimen0 } from '../image/fixture';

export async function specimenBlob(): Promise<Blob> {
  const s = makeSpecimen0();
  // fixture.ts は node でも動く純関数なので `Uint8ClampedArray<ArrayBufferLike>` を返す。
  // ImageData は `ArrayBuffer` 裏付けを要求するが、ここは常に非共有バッファ。
  const data = new ImageData(s.rgba as Uint8ClampedArray<ArrayBuffer>, s.width, s.height);

  if (typeof OffscreenCanvas === 'function') {
    const c = new OffscreenCanvas(s.width, s.height);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('specimen encode: no 2d context');
    ctx.putImageData(data, 0, 0);
    return await c.convertToBlob({ type: 'image/png' });
  }

  const c = document.createElement('canvas');
  c.width = s.width;
  c.height = s.height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('specimen encode: no 2d context');
  ctx.putImageData(data, 0, 0);
  return await new Promise<Blob>((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('specimen encode: toBlob returned null'))), 'image/png');
  });
}
