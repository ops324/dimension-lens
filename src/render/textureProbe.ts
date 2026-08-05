/**
 * 板のテクスチャを**指定した位置で 1 点だけ**サンプルする測定器。
 *
 * ## なぜ画面の読み戻しでは測れないのか
 *
 * G5 が問いたいのは「板の拡大補間はリニア光か、ガンマ空間か」で、答えは
 * 黒白 2px の**中点**が 188 か 128 かで決まる。ところが画面に出ている板は
 * viewport に合わせて任意の倍率で出るので、**中点を一度もサンプルしない**ことがある
 * （実測: 標本 No.0 は 1024 → 848 device px の縮小になり、2px チェッカーが
 * 解像してしまって領域平均は 166 という解釈できない値になった）。
 * サンプル位置が測定器の側で決まらない測定は、緑になっても意味がない。
 *
 * → テクセル座標を直接指定して 1×1 の RT へ描き、読む。倍率も位相も測定器が握る。
 *
 * `SRGBColorSpace` のテクスチャはハードウェアが**フィルタの前**にデコードするので、
 * 期待値はリニア光平均（黒白の中点なら sRGB **188**）。デコードが後なら 128 になる。
 * これは GPU が教えてくれる事実ではなく**こちらの決定**で、G5 はその回帰ロックである。
 */

import * as THREE from 'three';

const VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tMap;
uniform vec2 uUv;
void main() { gl_FragColor = texture2D(tMap, uUv); }
`;

export class TextureProbe {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly material: THREE.ShaderMaterial;
  private readonly pixels = new Uint8Array(4);

  constructor() {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: { tMap: { value: null }, uUv: { value: new THREE.Vector2(0.5, 0.5) } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
    this.camera = new THREE.Camera();
  }

  /**
   * テクスチャを**画像画素座標**でサンプルする。
   *
   * `imgX` / `imgY` は原点が画像の左上、単位は元画像の画素。整数 + 0.5 が
   * テクセル中心、整数ちょうどが隣り合うテクセルの**中点**である
   * （＝ 補間の空間を問う位置）。
   *
   * ## `repeat` / `offset` はここでは効かない（最初これで背景を読んでいた）
   *
   * 板のテクスチャは `repeat.y = -1 / offset.y = 1` で V を反転してあるが、
   * それは three の**組み込みシェーダ**が `uvTransform` uniform として適用するもので、
   * 自前の `texture2D(tMap, uv)` には**一切掛からない**。
   * 最初この規約を二重に通してしまい、チェッカーではなく背景の平坦部を
   * サンプルして「白も黒も中点も全部同じ値」という結果を得た。
   * → ここでは**アップロードされたままの向き**（`ImageBitmap` なので画像行 0 が v=0）で読む。
   *
   * ## 返る値は**リニア光**である
   *
   * テクスチャは `SRGBColorSpace` なのでハードウェアがサンプル時にデコードし、
   * 1×1 の RT は `NoColorSpace` なので再エンコードされない。つまり返る 8bit は
   * **リニア値 × 255**。sRGB のコード値と比べたいなら `linearToCode()` を通すこと
   * （黒白の中点なら リニア 0.5 → 128/255 → sRGB **188**、
   * ガンマ空間平均なら リニア 0.2159 → 55/255 → sRGB **128**）。
   */
  sample(
    renderer: THREE.WebGLRenderer,
    texture: THREE.Texture,
    imgX: number,
    imgY: number,
    imgW: number,
    imgH: number,
  ): { rgb: [number, number, number]; glError: number; uv: [number, number] } {
    const u = imgX / imgW;
    // `ImageBitmap` は UNPACK_FLIP_Y_WEBGL が効かないので、画像行 0 が v=0 に載っている。
    // 板の V 反転（repeat/offset）は組み込みシェーダの uvTransform であって、ここには掛からない。
    const v = imgY / imgH;
    (this.material.uniforms.uUv.value as THREE.Vector2).set(u, v);
    this.material.uniforms.tMap.value = texture;

    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prev);

    const gl = renderer.getContext();
    while (gl.getError() !== gl.NO_ERROR) {
      /* drain */
    }
    renderer.readRenderTargetPixels(this.target, 0, 0, 1, 1, this.pixels);
    return {
      rgb: [this.pixels[0], this.pixels[1], this.pixels[2]],
      glError: gl.getError(),
      uv: [u, v],
    };
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
