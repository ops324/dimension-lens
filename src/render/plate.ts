/**
 * 板 —— `dimLevel = 2` で「あなたの写真そのもの」を出す面。
 *
 * ## `texture.flipY` は `ImageBitmap` に対して**効かない**（three のソースで確認）
 *
 * `WebGLTextures.js:918-926`:
 * ```js
 * const isImageBitmap = ( typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap );
 * if ( isImageBitmap === false ) {
 *   state.pixelStorei( _gl.UNPACK_FLIP_Y_WEBGL, texture.flipY );
 *   …
 * }
 * ```
 * `ImageBitmap` のときは `UNPACK_FLIP_Y_WEBGL` を**設定しない**ので、既定の
 * `flipY = true` が黙って無効になる。取り込み（Phase 1a-ii）が板を
 * `OffscreenCanvas.transferToImageBitmap()` で渡している以上、素直に
 * `new THREE.Texture(bitmap)` と書くと**板は上下反転して出る**。
 * しかも標本 No.0 はアスペクト 1.6 なので寸法では気づけず、コンソールにも何も出ない。
 *
 * → 向きの規則は**この 1 関数に閉じる**。`repeat.y = -1 / offset.y = 1` で
 * three の UV 変換として明示的に反転させる（シェーダを書かずに済み、
 * 「反転させた」という意図がコードに残る）。
 *
 * ## mipmap を経路から外す
 *
 * `Texture.js` の既定は `generateMipmaps = true`（257 行）で、
 * **sRGB テクスチャの mip 生成空間は GLES3 で実装定義**である。ある GPU では
 * リニア光平均、別の GPU ではガンマ空間平均になりうる ── 忠実性の錨が
 * GPU ごとに変わるのは受け入れられない。板は `fill = 0.86` で常に拡大側なので
 * mip は 1 枚も要らない。**`generateMipmaps = false` + `LinearFilter` に固定する。**
 *
 * ## `SRGBColorSpace` は「発見」ではなく「決定」である
 *
 * `colorSpace = SRGBColorSpace` にするとハードウェアが**フィルタの前**にデコードするので、
 * 拡大補間はリニア光で行われる（黒白 2px の中点が 188）。デコードしなければ
 * ガンマ空間の補間になる（中点 128）。GPU がどちらかを教えてくれるのではなく、
 * **こちらが選ぶ**。SPEC §4.7 が「縮約は全部リニア光で自分でやる」と決めている以上、
 * 板の拡大補間もリニア光でなければ辻褄が合わない。G5 はこの決定の回帰ロックである。
 */

import * as THREE from 'three';
import { imageHalfExtents } from '../image/grid';

/** 板のテクスチャを作る唯一の入口。**向きの規則はここにしかない** */
export function createPlateTexture(source: ImageBitmap): THREE.Texture {
  const texture = new THREE.Texture(source);
  texture.name = 'LENS.plate';

  // ImageBitmap では three が UNPACK_FLIP_Y_WEBGL を触らないので、
  // flipY は「書いても効かない」。効かないことを明示するために false を書く。
  texture.flipY = false;
  // そのぶんを UV 変換で戻す。v' = 1 - v
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.repeat.set(1, -1);
  texture.offset.set(0, 1);

  // mip を作らない（sRGB テクスチャの mip 生成空間は実装定義）
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  // フィルタの**前**にデコードさせる ＝ 拡大補間をリニア光で行う
  texture.colorSpace = THREE.SRGBColorSpace;

  texture.needsUpdate = true;
  return texture;
}

export interface PlateOptions {
  /** 取り込みが返した正準バッファの寸法（アスペクトの源） */
  readonly width: number;
  readonly height: number;
}

/**
 * 板そのもの。
 *
 * 寸法は `imageHalfExtents` から取る ── SPEC の「アスペクト比の源はこの 1 関数」
 * という規律を守るため、ここで `width / height` を再計算しない。
 */
export class Plate {
  readonly object: THREE.Mesh;
  readonly material: THREE.MeshBasicMaterial;
  private readonly geometry: THREE.PlaneGeometry;
  private texture: THREE.Texture | null = null;

  constructor(opts: PlateOptions) {
    const { aX, aY } = imageHalfExtents(opts.width, opts.height);
    this.geometry = new THREE.PlaneGeometry(aX * 2, aY * 2);
    this.material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: null,
      // 板と点群は dimLevel=2 で同一平面（z = 0）に来る。1 ULP の差に依存しないよう
      // 深度そのものを使わない ── 順序は addChild の順で決める。
      depthTest: false,
      depthWrite: false,
      transparent: true,
      // トーンマップは切ってある（§4.5）が、マテリアル側でも明示しておく
      toneMapped: false,
    });
    this.object = new THREE.Mesh(this.geometry, this.material);
    this.object.name = 'plate';
    this.object.frustumCulled = false;
    this.object.renderOrder = 0;
  }

  /** 取り込みが転送で渡してきた ImageBitmap を貼る。前のテクスチャは破棄する */
  setImage(source: ImageBitmap): void {
    const next = createPlateTexture(source);
    this.texture?.dispose();
    this.texture = next;
    this.material.map = next;
    this.material.needsUpdate = true;
  }

  /** 貼ってあるテクスチャ。**測定器（`textureProbe.ts`）だけが読む** */
  get map(): THREE.Texture | null {
    return this.texture;
  }

  /** 板の不透明度。dimLevel によるクロスフェード（§G7）が唯一の書き手 */
  setOpacity(opacity: number): void {
    this.material.opacity = opacity < 0 ? 0 : opacity > 1 ? 1 : opacity;
    this.object.visible = this.material.opacity > 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.texture?.dispose();
    this.texture = null;
  }
}
