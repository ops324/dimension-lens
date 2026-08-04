/**
 * EXIF の向きを、デコーダが**適用したかどうか**を実行時に観測する道具。
 *
 * ## この作品で最も「測らずに書きたくなる」場所
 *
 * 素直な設計は「EXIF を自分でパースして、自分で画素を回す」である。
 * **Chrome 148 では確実に二重適用になる。** 実測(ori=6 を注入した 4×2 の JPEG):
 *
 * | 経路 | 結果 |
 * |---|---|
 * | `createImageBitmap(blob)` 既定 | 2×4(90°CW 適用済み) |
 * | `{ imageOrientation: 'from-image' }` | 2×4 |
 * | **`{ imageOrientation: 'none' }`** | **2×4 —— 例外も投げず、効きもしない** |
 * | `<img>` の `naturalWidth/Height` | 2×4 |
 *
 * しかも `{ imageOrientation: 'lens-bogus' }` は **TypeError を投げる**。つまり
 * `'none'` は「黙って無視された未知メンバ」ではなく、**認識された上で無効**である。
 * SPEC §4.7 が記録している「Safari は未知のディクショナリメンバを黙って無視する」より
 * 一段悪い型で、**「オプションが例外を投げるか」では検出できない。**
 *
 * → 残る検出手段は 1 つだけ: **向きが分かっている画像を実際に通す。**
 *
 * ## 設計
 *
 * `ORIENT_PROBE_JPEG` は 317 バイトの JPEG で、画素は 2×1(左=白・右=黒)、
 * EXIF に Orientation=6(90°CW) だけが入っている。
 *
 *   - デコーダが向きを適用する → **1×2** が返る
 *   - 適用しない → **2×1** が返る
 *   - デコードできない → `'unknown'`
 *
 * この 3 値だけを持ち、**適用されている限り LENS は画素を一切回さない。**
 * `'not-applied'` を観測した環境で自前回転を書くのは Phase 1c
 * (Chrome では絶対に走らない経路をいま書くと、テストは緑・実機は未検証の死にコードになる)。
 */

import type { OrientationSupport } from './protocol';

/**
 * probe 用 JPEG(base64、317 バイト)。
 *
 * 生成手順は再現可能: 2×1 の canvas(左 #fff / 右 #000)を `toBlob('image/jpeg', 0.5)` し、
 * APP0(JFIF) と APP2(ICC) を剥がして、SOI 直後に APP1(Exif, TIFF little-endian,
 * IFD0 に Orientation=6 のみ)を挿入したもの。
 *
 * **この定数が壊れると probe は黙って `'unknown'` を返す**(＝向きの検証を諦める)ので、
 * `ingest.test.ts` がバイト列を自前で読み、Orientation=6 と SOF の 2×1 を固定している。
 */
export const ORIENT_PROBE_JPEG_BASE64 =
  '/9j/4QAiRXhpZgAASUkqAAgAAAABABIBAwABAAAABgAAAAAAAAD/2wBDABALDA4MChAODQ4SERATGCga'
  + 'GBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8a'
  + 'Gi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAAR'
  + 'CAABAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAbEAEAAAcAAAAAAAAAAAAAAAAA'
  + 'AQMFBjZ0sv/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIR'
  + 'AxEAPwCPuDIantze4gA//9k=';

/** probe 画像の**画素上の**寸法(EXIF を適用しなければこう見える) */
export const PROBE_UNORIENTED = { width: 2, height: 1 } as const;
/** Orientation=6 を適用したときの寸法 */
export const PROBE_ORIENTED = { width: 1, height: 2 } as const;
/** probe の EXIF が主張する向き */
export const PROBE_ORIENTATION_TAG = 6;

/** base64 定数をバイト列へ。node でもブラウザでも同じ結果になる */
export function orientProbeBytes(): Uint8Array {
  const bin = atob(ORIENT_PROBE_JPEG_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * probe の**判定だけ**を切り出した純関数(node でテストできる側)。
 *
 * `null` は「デコード自体が失敗した」。寸法がどちらとも違うときも `'unknown'` にする ──
 * 「2×1 でなければ適用された」と書くと、将来 probe 定数が壊れたときに
 * **「適用された」と嘘をつく**。安全側は常に `'unknown'`。
 */
export function decideOrientationSupport(
  decoded: { readonly width: number; readonly height: number } | null,
): OrientationSupport {
  if (!decoded) return 'unknown';
  if (decoded.width === PROBE_ORIENTED.width && decoded.height === PROBE_ORIENTED.height) {
    return 'applied';
  }
  if (decoded.width === PROBE_UNORIENTED.width && decoded.height === PROBE_UNORIENTED.height) {
    return 'not-applied';
  }
  return 'unknown';
}

/**
 * 実際に走らせる(ブラウザ / worker)。**結果は 1 回だけ測ってキャッシュする** ──
 * 取り込みのたびに 317 バイトをデコードする必要はないが、
 * 「一度も測らずに既定値を返す」よりは毎回測るほうがましなので、
 * キャッシュは成功した観測についてだけ効かせる。
 */
let cached: OrientationSupport | null = null;

export async function probeOrientationSupport(): Promise<OrientationSupport> {
  if (cached && cached !== 'unknown') return cached;
  if (typeof createImageBitmap !== 'function') return 'unknown';
  let bitmap: ImageBitmap | null = null;
  try {
    const blob = new Blob([orientProbeBytes() as unknown as BlobPart], { type: 'image/jpeg' });
    bitmap = await createImageBitmap(blob);
    cached = decideOrientationSupport({ width: bitmap.width, height: bitmap.height });
  } catch {
    cached = 'unknown';
  } finally {
    bitmap?.close();
  }
  return cached;
}

/** テスト用。実行時には呼ばない */
export function resetOrientationProbeCache(): void {
  cached = null;
}
