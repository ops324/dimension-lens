/**
 * Blob → 正準リニアバッファ。**2 段デコード。**
 *
 * ## なぜ 1 回で縮小しないのか
 *
 * 素直な形は `createImageBitmap(blob, { resizeWidth: 2048, resizeQuality: 'high' })` の
 * 1 回で済ませることで、実際そう書きたくなる。**成立しない**(すべて Chrome 148 で実測):
 *
 *  - `resizeWidth` は **EXIF 適用後の幅**に効く。縦長画像では高さが上限を超えたまま通る。
 *  - 片側しか指定できないので「長辺 ≤ 2048」を 1 回では**表現できない**。両方指定すると
 *    アスペクト比が壊れる(明示指定が勝つ)。
 *  - 無条件に渡すと**小さい画像を拡大する**(64×32 の JPEG → 2048×1024、正準 24MB)。
 *  - そのうえ**遅い**。24MP の JPEG で:
 *
 *    | | median |
 *    |---|---|
 *    | 全解像度 decode | 227.9 ms |
 *    | `{resizeWidth:2048, resizeQuality:'high'}` | 600.7 ms |
 *    | `resizeQuality` 省略(＝既定の `'low'`) | 294.5 ms |
 *
 * → **1 段目で向きの適用された寸法を確定させ、2 段目で縮小する。**
 *   1 段目の結果があるので `planResize` に渡す寸法が正しく、EXIF パーサも要らない。
 *
 * ## `resizeQuality` は明示する
 *
 * **既定は `'low'`**(仕様どおり、実測でも 294.5ms 側)。この作品の錨は
 * 「dimLevel=2 があなたの写真そのものであること」なので、取り込みで 1 回だけ払う
 * 300ms と引き換えに `'high'` を採る。ただし縮小が**ガンマ空間平均**であることは
 * high/medium/low どれでも変わらない(SPEC §4.7、Chrome 148 で再確認: 黒白 2px→1px = 128)。
 * だから縮小は 1 回だけに留め、以降の縮約は全部リニア光で自分でやる。
 */

import { linearizeRgba } from '../image/linearize';
import type { Canonical } from '../image/stats';
import { exceedsSourceLimit, planResize, type ResizePlan } from './plan';
import { IngestError, type OrientationSupport } from './protocol';

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type Any2d = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export interface DecodeOptions {
  readonly maxEdge: number;
  readonly wantPlate: boolean;
  /** `capabilities.ts` の実測。false なら最初から canvas で縮小する */
  readonly canResizeInDecoder: boolean;
}

export interface DecodeResult {
  readonly canonical: Canonical;
  /** 板のテクスチャ源(正準解像度)。転送で呼び出し側へ渡す */
  readonly plate: ImageBitmap | null;
  /** EXIF 適用後・縮小前の寸法 */
  readonly decodedWidth: number;
  readonly decodedHeight: number;
  readonly plan: ResizePlan;
  readonly resizePath: 'decoder' | 'canvas' | 'none';
  /** `getImageData` が実際に返した色空間。**推測ではなく読んだ値** */
  readonly imageDataColorSpace: string;
  readonly timings: {
    readonly decodeMs: number;
    readonly resizeMs: number;
    readonly readbackMs: number;
    readonly linearizeMs: number;
  };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : 0;
}

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  throw new IngestError('no-2d-context', 'キャンバスを作れません。');
}

/**
 * 2D コンテキストを取る。**キャンバスは必ず使い捨て** ──
 * 同じ要素への 2 回目の `getContext('2d', 別属性)` は最初の context を返し、
 * `willReadFrequently` を**黙って無視する**(実測)。
 */
function get2d(canvas: AnyCanvas): Any2d {
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as Any2d | null;
  if (!ctx) throw new IngestError('no-2d-context', '2D コンテキストを取得できません。');
  return ctx;
}

export async function decodeToCanonical(
  source: Blob,
  opts: DecodeOptions,
): Promise<DecodeResult> {
  if (!(source.size > 0)) {
    throw new IngestError('empty-source', 'ファイルが空です。');
  }
  if (typeof createImageBitmap !== 'function') {
    throw new IngestError('decode-failed', 'この環境には createImageBitmap がありません。');
  }

  // ---- 1 段目: 向きが適用された原寸を得る（ここで初めて「長辺」が確定する）----
  const t0 = now();
  let stage1: ImageBitmap;
  try {
    stage1 = await createImageBitmap(source);
  } catch (e) {
    throw new IngestError(
      'decode-failed',
      `この形式の画像を読めませんでした（${(e as Error)?.name ?? 'unknown'}）。`,
    );
  }
  const decodeMs = now() - t0;
  const decodedWidth = stage1.width;
  const decodedHeight = stage1.height;

  if (exceedsSourceLimit(decodedWidth, decodedHeight)) {
    stage1.close();
    throw new IngestError(
      'too-many-pixels',
      `画像が大きすぎます（${decodedWidth}×${decodedHeight}）。`,
    );
  }

  const plan = planResize(decodedWidth, decodedHeight, opts.maxEdge);

  // ---- 2 段目: 縮小 ----
  const t1 = now();
  let work = stage1;
  let resizePath: DecodeResult['resizePath'] = 'none';
  if (plan.resized && opts.canResizeInDecoder) {
    try {
      const stage2 = await createImageBitmap(stage1, {
        resizeWidth: plan.width,
        resizeHeight: plan.height,
        resizeQuality: 'high',
      });
      // **効いたかどうかは寸法でしか分からない**（SPEC §4.7）。
      // 黙って無視された場合はここで捕まえて canvas 経路へ落ちる。
      if (stage2.width === plan.width && stage2.height === plan.height) {
        stage1.close();
        work = stage2;
        resizePath = 'decoder';
      } else {
        stage2.close();
      }
    } catch {
      // resize が投げる環境では canvas 経路へ
    }
  }
  const resizeMs = now() - t1;

  // ---- 読み戻し ----
  const canvas = makeCanvas(plan.width, plan.height);
  const ctx = get2d(canvas);
  const t2 = now();
  if (work.width === plan.width && work.height === plan.height) {
    ctx.drawImage(work, 0, 0);
  } else {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(work, 0, 0, plan.width, plan.height);
    resizePath = 'canvas';
  }
  const imageData = ctx.getImageData(0, 0, plan.width, plan.height, { colorSpace: 'srgb' });
  const readbackMs = now() - t2;

  // ---- 板（Phase 1a-iii が使うテクスチャ源）----
  // ここで取っておかないと 1a-iii が同じ画像をもう一度デコードすることになる。
  // `transferToImageBitmap` の返り値は Transferable（転送後、元は 0×0 になる ── 実測）。
  let plate: ImageBitmap | null = null;
  if (opts.wantPlate) {
    plate =
      'transferToImageBitmap' in canvas
        ? canvas.transferToImageBitmap()
        : await createImageBitmap(canvas as HTMLCanvasElement);
  }
  work.close();

  // ---- リニア化（LUT はここでちょうど 1 回）----
  const t3 = now();
  const canonical = linearizeRgba(imageData.data, plan.width, plan.height, 'srgb');
  const linearizeMs = now() - t3;

  return {
    canonical,
    plate,
    decodedWidth,
    decodedHeight,
    plan,
    resizePath,
    imageDataColorSpace: imageData.colorSpace,
    timings: { decodeMs, resizeMs, readbackMs, linearizeMs },
  };
}

/**
 * probe の結果をそのまま持ち回るための薄い再輸出。
 * `decode.ts` は向きを**適用しない**ので、この型は記録のためだけに通る。
 */
export type { OrientationSupport };
