/**
 * engine / quality / plate の**設定**のうち、WebGL 無しで落とせるもの。
 *
 * ここで見張るのは主に「同じ量が 2 か所にある」型の壊れ方 ──
 * SPEC §5 の単一情報源の規律は、破れても動いてしまうので、機械で見るしかない。
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CAMERA_FOV } from '../core/engine';
import { bootTier, TIERS, tierFor } from '../core/quality';
import { TIER_BUDGET } from '../image/grid';
import { fitDistance, fillRatios, DEFAULT_FILL } from '../core/fit';
import { imageHalfExtents } from '../image/grid';
import { createPlateTexture, Plate } from '../render/plate';

describe('カメラの画角', () => {
  /**
   * `fitDistance` は `fovDeg` を引数で受け取る。engine が別の値で
   * `PerspectiveCamera` を作ると、**図が帯からはみ出す形で静かに壊れる**。
   * 呼び出し側は必ず `CAMERA_FOV` を渡すこと ── この定数が唯一の源である。
   */
  it('CAMERA_FOV が公開され、fit の計算に使える値である', () => {
    expect(CAMERA_FOV).toBe(50);
    const { aX, aY } = imageHalfExtents(1024, 640);
    const input = { aX, aY, viewportAspect: 16 / 10, bandFrac: 1, fovDeg: CAMERA_FOV };
    const d = fitDistance(input);
    const r = fillRatios(input, d);
    // 「一辺に接する」＝ どちらかが厳密に fill になる
    expect(Math.max(r.x, r.y)).toBeCloseTo(DEFAULT_FILL, 12);
  });
});

describe('品質ティア', () => {
  it('ティアの点数予算が bench の測った点数と同じ表から出ている', () => {
    expect(TIERS.BALANCED.budget).toBe(TIER_BUDGET.BALANCED);
    expect(TIERS.HIGH.budget).toBe(TIER_BUDGET.HIGH);
    expect(TIERS.ULTRA.budget).toBe(TIER_BUDGET.ULTRA);
  });

  it('DPR とサンプル数がティア順に単調', () => {
    expect(TIERS.BALANCED.dpr).toBeLessThanOrEqual(TIERS.HIGH.dpr);
    expect(TIERS.HIGH.dpr).toBeLessThanOrEqual(TIERS.ULTRA.dpr);
    expect(TIERS.BALANCED.samples).toBeLessThanOrEqual(TIERS.HIGH.samples);
  });

  it('bootTier は既知のティア名だけを返す', () => {
    const name = bootTier();
    expect(Object.keys(TIERS)).toContain(name);
    expect(tierFor(name).name).toBe(name);
  });
});

describe('板のテクスチャ', () => {
  /**
   * ## `texture.flipY` は `ImageBitmap` に効かない（three のソースで確認）
   *
   * `WebGLTextures.js:918-926` は `texture.image instanceof ImageBitmap` のとき
   * `UNPACK_FLIP_Y_WEBGL` を**設定しない**。取り込み（1a-ii）は板を
   * `OffscreenCanvas.transferToImageBitmap()` で渡すので、素直に書くと**上下反転する**。
   * 反転の打ち消しは UV 変換で明示的に行う ── その規則がここにしか無いことを見張る。
   *
   * node には `ImageBitmap` が無いので、テクスチャの**設定**だけを検査する
   * （実際に反転しないことは G1 の 8 つの二面体変換が実機で見る）。
   */
  it('V を UV 変換で反転させ、flipY には頼らない', () => {
    const fake = { width: 4, height: 2 } as unknown as ImageBitmap;
    const t = createPlateTexture(fake);
    expect(t.flipY).toBe(false); // 効かないので明示的に false
    expect(t.repeat.y).toBe(-1); // v' = 1 - v
    expect(t.offset.y).toBe(1);
    expect(t.repeat.x).toBe(1);
    expect(t.offset.x).toBe(0);
    t.dispose();
  });

  /**
   * sRGB テクスチャの **mip 生成空間は GLES3 で実装定義**。板は常に拡大側なので
   * mip は 1 枚も要らない ── 実装定義の挙動を経路から外す。
   */
  it('mipmap を作らず、拡大補間はリニア光で行う', () => {
    const fake = { width: 4, height: 2 } as unknown as ImageBitmap;
    const t = createPlateTexture(fake);
    expect(t.generateMipmaps).toBe(false);
    expect(t.minFilter).toBe(THREE.LinearFilter);
    expect(t.magFilter).toBe(THREE.LinearFilter);
    // フィルタの**前**にデコードさせる＝補間がリニア光になる（G5 が実機で固定する）
    expect(t.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(t.wrapS).toBe(THREE.ClampToEdgeWrapping);
    expect(t.wrapT).toBe(THREE.ClampToEdgeWrapping);
    t.dispose();
  });

  it('板の寸法は imageHalfExtents からしか来ない（アスペクトの源が 1 つ）', () => {
    const plate = new Plate({ width: 1024, height: 640 });
    const geo = plate.object.geometry as THREE.PlaneGeometry;
    const { aX, aY } = imageHalfExtents(1024, 640);
    expect(geo.parameters.width).toBeCloseTo(aX * 2, 12);
    expect(geo.parameters.height).toBeCloseTo(aY * 2, 12);
    plate.dispose();
  });

  it('板も加算の相方として深度に依存しない', () => {
    const plate = new Plate({ width: 8, height: 8 });
    expect(plate.material.depthTest).toBe(false);
    expect(plate.material.depthWrite).toBe(false);
    expect(plate.material.toneMapped).toBe(false);
    plate.dispose();
  });

  it('不透明度 0 で描画そのものを外す（点群と二重に足さない）', () => {
    const plate = new Plate({ width: 8, height: 8 });
    plate.setOpacity(0);
    expect(plate.object.visible).toBe(false);
    plate.setOpacity(1);
    expect(plate.object.visible).toBe(true);
    expect(plate.material.opacity).toBe(1);
    plate.dispose();
  });
});
