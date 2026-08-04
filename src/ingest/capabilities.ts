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

import type { OrientationSupport } from './protocol';
import { probeOrientationSupport } from './orientProbe';

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
  /** 入力の色域として採用する値。1a-ii は srgb 固定(下記) */
  readonly gamut: 'srgb' | 'display-p3';
  /** 読み出し欄(Phase 3)と PR にそのまま貼れる、人間可読の注記 */
  readonly notes: readonly string[];
}

/**
 * 観測 → 判断。**純関数**なので node でテストできる。
 *
 * ## `gamut` を 1a-ii では `'srgb'` に固定する理由
 *
 * Display P3 を実際に通すには **4 つが同時に揃う**必要がある:
 * (1) `colorSpaceConversion` を既定のままにする、(2) キャンバスを
 * `{ colorSpace: 'display-p3' }` で作る、(3) `getImageData({ colorSpace: 'display-p3' })`、
 * (4) `Canonical.gamut` を合わせる。1 つでも外すと**黙って色相が誤る**
 * (`oklab.ts` の `primariesFor` が原色行列を切り替えるため。SPEC §1 の優先度 1 違反)。
 * しかも node には `getImageData` が無いので、この 4 点の整合を vitest では守れない。
 *
 * → **1a-ii は `'srgb'` 固定**とし、観測した `imageDataColorSpace` が srgb でなければ
 * 注記に出して**気づける形で**残す。P3 の実配線は Phase 1c。
 */
export function summarizeCapabilities(raw: RawCapabilities): CapabilityReport {
  const notes: string[] = [];

  const canIngest = raw.hasCreateImageBitmap && raw.has2dContext;
  if (!raw.hasCreateImageBitmap) notes.push('createImageBitmap がありません。取り込みできません。');
  if (!raw.has2dContext) notes.push('2D コンテキストが取れません。取り込みできません。');

  const canResizeInDecoder = raw.resizeEffective === true;
  if (raw.resizeEffective === false) {
    notes.push(
      'デコーダの resizeWidth/Height が無視されました(例外は出ていません)。'
        + ' 縮小は canvas 側で行います。',
    );
  }

  const canUseWorker = raw.hasWorker && raw.hasOffscreenCanvas;
  if (raw.hasWorker && !raw.hasOffscreenCanvas) {
    notes.push('OffscreenCanvas がないため、取り込みはメインスレッドで行います。');
  }

  let orientationRisk: CapabilityReport['orientationRisk'];
  switch (raw.orientation) {
    case 'applied':
      orientationRisk = 'none';
      break;
    case 'not-applied':
      orientationRisk = 'must-orient-manually';
      notes.push(
        'このブラウザは EXIF の向きを適用しません。'
          + ' 縦向きで撮った写真が横倒しで出ることがあります(Phase 1c で対応)。',
      );
      break;
    default:
      orientationRisk = 'unknown';
      notes.push('EXIF の向きの扱いを検証できませんでした。');
  }

  if (raw.imageDataColorSpace && raw.imageDataColorSpace !== 'srgb') {
    notes.push(
      `getImageData が ${raw.imageDataColorSpace} を返しています。`
        + ' Phase 1a-ii は sRGB 固定で扱います(Display P3 の配線は Phase 1c)。',
    );
  }

  return {
    ...raw,
    canIngest,
    canResizeInDecoder,
    canUseWorker,
    orientationRisk,
    gamut: 'srgb',
    notes,
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
