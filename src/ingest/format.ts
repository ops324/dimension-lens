/**
 * 「読めなかった」を「なぜ読めなかったか」へ細分する、**失敗したあとにだけ**走る判定。
 *
 * ## なぜ MIME で事前に弾かないのか（Phase 1c で実測）
 *
 * 素直な設計は「`Blob.type === 'image/heic'` なら最初から断る」である。**三重に誤り**:
 *
 *  1. **Safari は HEIC を読める。** 同一の 781 バイトの HEIC で:
 *
 *     | | `createImageBitmap` |
 *     |---|---|
 *     | Chromium 148 / **Chrome 150** | `InvalidStateError` |
 *     | **Safari 18.6** | **OK 64×48** |
 *
 *     事前に弾くと、**読める利用者から機能を奪う**。
 *  2. **`Blob.type` は空でも偽装でもよい。** `image/jpeg` を名乗る HEIC も、type 無しの
 *     HEIC も、実測ではまったく同じ失敗をする。type は入力の性質を表していない。
 *  3. **`ftyp` は AVIF とも共通で、AVIF は Chrome が読める。** brand を見ずに
 *     ISO-BMFF を弾くと、読める形式まで巻き込む。
 *
 * → **デコーダに投げる。失敗した。そのときだけバイト列を見る。**
 *   これなら Safari の経路は 1 バイトも変わらず、Chrome の利用者だけが正確な文言を得る。
 *
 * ## なぜ例外の中身で分類できないのか（実測）
 *
 * `createImageBitmap` の失敗は**入力の種類によらず完全に同一**である（Chromium 148）。
 * HEIC / type を偽装した HEIC / ランダムバイト / 途中で切れた JPEG / 空 Blob / PDF /
 * SVG / AVIF マジックのみ の **9 種すべてで `name` も `message` も一字一句同じ**
 * （`InvalidStateError` / "The source image could not be decoded."）。
 * `decode.ts` は 1b までこの `name` を文言に埋めていたが、**この値は情報を 1 ビットも運んでいない。**
 */

import type { UnsupportedFormatId } from './protocol';

/** brand を読むのに要るバイト数（size 4 + 'ftyp' 4 + major brand 4） */
export const SNIFF_BYTES = 12;

const ASCII_FTYP = [0x66, 0x74, 0x79, 0x70] as const; // 'ftyp'

/**
 * 先頭バイト列から「デコーダが読めない既知の形式」を当てる。**当たらなければ `null`。**
 *
 * `null` は「JPEG だ」でも「壊れている」でもなく、**「言えることが無い」**である ──
 * 呼び出し側は `decode-failed` のままにする。安全側は常に細分しないほう。
 *
 * HEIF の major brand は `heic` / `heix` / `heim` / `heis` / `hevc` / `hevx` … と多いので
 * **`he` の前方一致 1 本**で取る。網羅は追わない ── 外れたら `decode-failed` に落ちるだけで、
 * 「読めない」という結論は変わらない。`avif` / `avis` は `a` 始まりなので当たらない
 * （**Chrome は AVIF を読めるので、当ててはいけない**）。
 */
export function sniffUnsupportedFormat(bytes: Uint8Array): UnsupportedFormatId | null {
  if (bytes.length < SNIFF_BYTES) return null;
  for (let i = 0; i < 4; i++) {
    if (bytes[4 + i] !== ASCII_FTYP[i]) return null;
  }
  // major brand = bytes[8..12)
  const b0 = bytes[8];
  const b1 = bytes[9];
  // 'h' = 0x68, 'e' = 0x65
  if (b0 === 0x68 && b1 === 0x65) return 'heif';
  return null;
}

/**
 * `Blob` の先頭だけを読む。**全体を `arrayBuffer()` しない** ──
 * 40MP の HEIC は数十 MB あり、読めないと分かっている入力を丸ごとメモリへ載せる理由が無い。
 */
export async function sniffBlob(source: Blob): Promise<UnsupportedFormatId | null> {
  if (source.size < SNIFF_BYTES) return null;
  try {
    const head = await source.slice(0, SNIFF_BYTES).arrayBuffer();
    return sniffUnsupportedFormat(new Uint8Array(head));
  } catch {
    return null;
  }
}
