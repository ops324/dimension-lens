/**
 * 機能検出。**「メンバが実装されているか」と「実際に効いたか」は別の質問である。**
 *
 * SPEC §4.7 は「Safari は未知のディクショナリメンバを黙って無視するので、
 * `bitmap.width` を要求値と比較して機能検出すること」と書いている。これは結論としては
 * 正しいが、原因の帰属が一段ずれている ── 実測すると **Chrome 148 でも**
 * `createImageBitmap(src, { lensNoSuchMember: 1 })` は素通りする。未知メンバの黙殺は
 * WebIDL のディクショナリ全般の挙動であって、Safari 固有の欠陥ではない。
 * Safari で問題になったのは `resizeWidth` を**実装していなかった**からで、
 * そのとき初めてそれが「未知のメンバ」になった。
 *
 * そして、この違いを直接突く手が 1 つある: **列挙値は検証される。**
 * `{ imageOrientation: 'lens-bogus' }` は TypeError を投げるが、
 * `{ lensNoSuchMember: 'lens-bogus' }` は投げない。つまり
 *
 *   - 不正な列挙値で TypeError → **そのメンバは実装されている**
 *   - 例外なく解決した → **そのメンバは存在しない(黙殺された)**
 *
 * ただしこれで分かるのは「実装されている」までで、**効いたかどうかは別**である
 * (`imageOrientation` がまさにその例: メンバは実装済みなのに `'none'` は効かない)。
 * だから両方を測り、両方を持ち回る。
 */

import type { Gamut, OrientationSupport } from './protocol';
import { probeOrientationSupport } from './orientProbe';

/**
 * 注記の識別子。**文言は `copy.ts` にあり、ここには無い。**
 *
 * 1b までは `notes: string[]` に日本語を直接 push しており、`ingest.test.ts` の 5 件が
 * `notes.join()` の**部分一致**で採点していた ── 純関数テストが「判断」ではなく
 * 「文言」を検査している状態で、`protocol.ts` が禁じた「文言で分岐する」の裏返しだった。
 * ID にすると、文言を書き換えてもテストは落ちず、判断を変えたときだけ落ちる。
 */
export type CapabilityNoteId =
  | 'no-create-image-bitmap'
  | 'no-2d-context'
  | 'resize-ignored'
  | 'no-offscreen-canvas'
  | 'exif-not-applied'
  | 'exif-unknown'
  | 'image-data-color-space-unexpected';

/** 素の観測。**判断を混ぜない** ── 判断は `summarizeCapabilities` の仕事 */
export interface RawCapabilities {
  readonly hasCreateImageBitmap: boolean;
  readonly hasOffscreenCanvas: boolean;
  readonly hasWorker: boolean;
  readonly has2dContext: boolean;
  /** 不正な列挙値が TypeError を投げたか = メンバが実装されているか */
  readonly optionMembers: {
    readonly imageOrientation: boolean;
    readonly resizeQuality: boolean;
    readonly colorSpaceConversion: boolean;
    readonly premultiplyAlpha: boolean;
  };
  /** `resizeWidth/Height` を渡して**実際にその寸法が返ったか**。null は未実施 */
  readonly resizeEffective: boolean | null;
  /** EXIF の向きをデコーダが適用したか(`orientProbe.ts` の実測) */
  readonly orientation: OrientationSupport;
  /** `getImageData()` が返す色空間。**リテラルを書かず、読んだ値を使う** */
  readonly imageDataColorSpace: string | null;
  readonly hardwareConcurrency: number;
}

export interface CapabilityReport extends RawCapabilities {
  /** 取り込みが成立するか。false なら Phase 1c の空状態へ落とす */
  readonly canIngest: boolean;
  /** 縮小をデコーダに任せてよいか。false なら canvas で縮小する */
  readonly canResizeInDecoder: boolean;
  /** worker を使えるか(使えないならメインスレッドで同じ純関数を通す) */
  readonly canUseWorker: boolean;
  /**
   * 向きに関する残りリスク。
   * - `'none'`: デコーダが適用済み。LENS は何もしない(**これが唯一の実測済み経路**)
   * - `'unknown'`: probe が失敗した。向きは検証されていない
   * - `'must-orient-manually'`: デコーダが適用しない。**Phase 1c の担当**
   */
  readonly orientationRisk: 'none' | 'unknown' | 'must-orient-manually';
  /**
   * 入力の色域として採用する値。**Phase 1c でも `'srgb'` 固定**（下記）。
   * この 1 つの値が `decode.ts` の canvas・`getImageData`・`linearizeRgba` の
   * **3 箇所すべて**へ流れる ── 1b までは各所にリテラルが独立に置かれていた。
   */
  readonly gamut: Gamut;
  /** 注記の**識別子**。文言は `copy.ts` の `CAPABILITY_NOTE_COPY` にある */
  readonly noteIds: readonly CapabilityNoteId[];
}

/**
 * **入力の色域の単一情報源。** `decode.ts` の canvas・`getImageData`・`linearizeRgba` は
 * すべてこの 1 つの値から流れる（1b までは各所に `'srgb'` のリテラルが独立に置かれていた）。
 *
 * ## Phase 1c でも `'srgb'` に固定する理由（**1a-ii の「Phase 1c で通す」を撤回した**）
 *
 * 1a-ii の本節は「4 つが同時に揃えば通る／1 つでも外すと黙って誤る。実配線は Phase 1c」と
 * 書いていた。**前半が偽である**（Phase 1c で実測）。Display P3 の ICC を付けた 8×8 PNG を
 * 6 通りの構成で読み戻すと、**「4 箇所を揃えた」構成が実装ごとに違う値を返す**:
 *
 * | 構成 | Chromium 148 | Safari 18.6 |
 * |---|---|---|
 * | 既定 csc / sRGB canvas / `getImageData()` ← **現行** | `[255,0,0]` | `[255,0,0]` |
 * | `csc:'none'` / P3 canvas / `{display-p3}` ← **「4 箇所揃えた」** | **`[215,69,50]`** | **`[234,51,35]`** |
 * | `csc:'default'` / P3 canvas / `{display-p3}` | `[234,51,35]` | `[234,51,35]` |
 *
 * `colorSpaceConversion: 'none'` の**意味論が実装間で割れている**（Chromium では
 * 3 行目と 2 行目が違い、Safari では同じ）。§4.13 の「実装されているか / 効いたか」の
 * 2 問では足りず、3 問目「**同じ意味で効いたか**」があり、それは寸法のような
 * 一次元の観測では捕まらない。
 *
 * → **現行の構成だけが 2 実装で一致する。** `'srgb'` 固定は消極的な保留ではなく、
 * いま唯一クロスブラウザで安定な選択である。P3 を通すのは、
 * 「通さないことの代償」（広色域の被写体で彩度がどれだけ落ちるか）を ΔE00 で測ってから。
 */
export const GAMUT: Gamut = 'srgb';

/** 観測 → 判断。**純関数**なので node でテストできる（文言は持たない ── `copy.ts`） */
export function summarizeCapabilities(raw: RawCapabilities): CapabilityReport {
  const noteIds: CapabilityNoteId[] = [];

  const canIngest = raw.hasCreateImageBitmap && raw.has2dContext;
  if (!raw.hasCreateImageBitmap) noteIds.push('no-create-image-bitmap');
  if (!raw.has2dContext) noteIds.push('no-2d-context');

  const canResizeInDecoder = raw.resizeEffective === true;
  if (raw.resizeEffective === false) noteIds.push('resize-ignored');

  const canUseWorker = raw.hasWorker && raw.hasOffscreenCanvas;
  if (raw.hasWorker && !raw.hasOffscreenCanvas) noteIds.push('no-offscreen-canvas');

  let orientationRisk: CapabilityReport['orientationRisk'];
  switch (raw.orientation) {
    case 'applied':
      orientationRisk = 'none';
      break;
    case 'not-applied':
      orientationRisk = 'must-orient-manually';
      noteIds.push('exif-not-applied');
      break;
    default:
      orientationRisk = 'unknown';
      noteIds.push('exif-unknown');
  }

  if (raw.imageDataColorSpace && raw.imageDataColorSpace !== 'srgb') {
    noteIds.push('image-data-color-space-unexpected');
  }

  return {
    ...raw,
    canIngest,
    canResizeInDecoder,
    canUseWorker,
    orientationRisk,
    gamut: GAMUT,
    noteIds,
  };
}

/** 不正な列挙値を投げてメンバの実装を検出する。TypeError なら実装済み */
async function memberIsImplemented(
  source: ImageBitmapSource,
  member: string,
): Promise<boolean> {
  try {
    const bmp = await createImageBitmap(source, { [member]: 'lens-bogus' } as ImageBitmapOptions);
    bmp.close();
    return false; // 黙殺された = そのメンバは無い
  } catch (e) {
    return e instanceof TypeError || (e as Error)?.name === 'TypeError';
  }
}

/**
 * 実際に測る(ブラウザ / worker)。
 *
 * 例外を投げない ── 検出そのものが落ちて取り込み全体が止まるのは本末転倒なので、
 * 失敗は「その機能が無い」として記録する。
 */
export async function detectCapabilities(): Promise<CapabilityReport> {
  const hasCreateImageBitmap = typeof createImageBitmap === 'function';
  const hasOffscreenCanvas = typeof OffscreenCanvas === 'function';
  const hasWorker = typeof Worker === 'function';

  let has2dContext = false;
  let imageDataColorSpace: string | null = null;
  try {
    const canvas = makeProbeCanvas(1, 1);
    const ctx = canvas?.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    has2dContext = !!ctx;
    if (ctx) imageDataColorSpace = ctx.getImageData(0, 0, 1, 1).colorSpace;
  } catch {
    has2dContext = false;
  }

  const optionMembers = {
    imageOrientation: false,
    resizeQuality: false,
    colorSpaceConversion: false,
    premultiplyAlpha: false,
  };
  let resizeEffective: boolean | null = null;
  let orientation: OrientationSupport = 'unknown';

  if (hasCreateImageBitmap) {
    const src = new ImageData(4, 2);
    optionMembers.imageOrientation = await memberIsImplemented(src, 'imageOrientation');
    optionMembers.resizeQuality = await memberIsImplemented(src, 'resizeQuality');
    optionMembers.colorSpaceConversion = await memberIsImplemented(src, 'colorSpaceConversion');
    optionMembers.premultiplyAlpha = await memberIsImplemented(src, 'premultiplyAlpha');

    // 「効いたか」は寸法でしか分からない ── ここが SPEC §4.7 の要求そのもの
    try {
      const bmp = await createImageBitmap(src, { resizeWidth: 2, resizeHeight: 1 });
      resizeEffective = bmp.width === 2 && bmp.height === 1;
      bmp.close();
    } catch {
      resizeEffective = false;
    }

    try {
      orientation = await probeOrientationSupport();
    } catch {
      orientation = 'unknown';
    }
  }

  return summarizeCapabilities({
    hasCreateImageBitmap,
    hasOffscreenCanvas,
    hasWorker,
    has2dContext,
    optionMembers,
    resizeEffective,
    orientation,
    imageDataColorSpace,
    hardwareConcurrency:
      typeof navigator !== 'undefined' && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : 0,
  });
}

/**
 * 検出用の使い捨てキャンバス。
 *
 * **毎回新しく作る。** 同じ要素に 2 回目の `getContext('2d', 別の属性)` を呼ぶと、
 * ブラウザは**最初の context をそのまま返し、属性を黙って無視する**(実測)。
 * 使い回すと `willReadFrequently` や `colorSpace` の指定が効かないまま通る。
 */
function makeProbeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement | null {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return null;
}
