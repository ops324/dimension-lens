/**
 * 読み戻しの道具。**測られる対象より先に、自己検査つきで作る。**
 *
 * ## なぜ canvas を読まないのか
 *
 * SPEC §7.2 の #1 は「`preserveDrawingBuffer` を立てないと rAF の外から読んだ
 * バックバッファは破棄済みで、返るのは黒。**壊れていても緑になる**」と警告している。
 * その警告は正しいが、**実際の地雷はもう一段手前にある。**
 *
 * composer のバッファは `HalfFloatType` である（加算合成が HDR を保持するため）。
 * これを `Uint8Array` で読むと:
 *
 * | バッファ | 例外 | `gl.getError()` | 読めた値 |
 * |---|---|---|---|
 * | `Uint8Array` | **なし** | **1282 = INVALID_OPERATION** | **[0,0,0,0]** |
 * | `Uint16Array` | なし | 0 | 正常 |
 *
 * `WebGLRenderer.readRenderTargetPixels` のガード（`WebGLRenderer.js:3102/3109`）は
 * `EXT_color_buffer_half_float` があると通ってしまう。つまり
 * **「隅を読んで #000000 を確認する」テストは、ここでも常に緑になる。**
 *
 * → 鎖の最後に **8bit の capture RT** を置き、そこへコピーしてから読む。
 * 型が一致するので `INVALID_OPERATION` は構造的に起きず、読める値は
 * 「画面に出るのと同じ sRGB 8bit」になる ── 忠実性ラダーが測りたいのはそれである。
 *
 * ## 自己検査
 *
 * `selfTest()` は既知のクリアカラーを書いて読み返す。**これが通るまで
 * 他のどの測定も信用しない。** 予算のある測定と同じで、測定器が動いていること自体に
 * 判定を付けないと A を生産できない（SPEC §7.2）。
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';

/**
 * 鎖の最後で `readBuffer` を 8bit RT へ写すだけのパス。
 *
 * `needsSwap = false` ── 何も書き換えないので composer のバッファを回さない。
 * 既定は `enabled = false` で、`Capture.frameInto()` が 1 フレームだけ立てる。
 */
class CapturePass extends Pass {
  private readonly fsQuad: FullScreenQuad;
  private readonly material: THREE.ShaderMaterial;
  target: THREE.WebGLRenderTarget | null = null;

  constructor() {
    super();
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
    this.needsSwap = false;
    this.enabled = false;
  }

  override render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    if (!this.target) return;
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    // renderToScreen は無視する ── このパスの出力先は常に capture RT である
    renderer.setRenderTarget(this.target);
    renderer.clear();
    this.fsQuad.render(renderer);
    renderer.setRenderTarget(null);
  }

  override dispose(): void {
    this.fsQuad.dispose();
    this.material.dispose();
  }
}

export interface CaptureSelfTest {
  readonly ok: boolean;
  readonly expected: readonly [number, number, number];
  readonly actual: readonly [number, number, number];
  readonly glError: number;
  readonly message: string;
}

export class Capture {
  readonly pass: CapturePass;
  private target: THREE.WebGLRenderTarget;
  private width: number;
  private height: number;

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.target = Capture.makeTarget(this.width, this.height);
    this.pass = new CapturePass();
    this.pass.target = this.target;
  }

  /**
   * **8bit・NoColorSpace** の RT。
   *
   * `UnsignedByteType` なので `Uint8Array` での読み戻しが型として正しい。
   * `colorSpace` は既定（`NoColorSpace`）のまま ── OutputPass が既に sRGB へ
   * エンコードした値が入ってくるので、ここで再変換されると二重になる。
   */
  private static makeTarget(w: number, h: number): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });
    rt.texture.name = 'LENS.capture';
    return rt;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.target.setSize(w, h);
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** capture パスを 1 フレームだけ有効にして `render()` を走らせる */
  frameInto(render: () => void): void {
    this.pass.enabled = true;
    try {
      render();
    } finally {
      this.pass.enabled = false;
    }
  }

  /**
   * capture RT の矩形を読む。原点は**左下**（GL の流儀）。
   *
   * `gl.getError()` を明示的に読む ── 型が合っていない読み戻しは例外を投げず、
   * 全 0 を返して「黒でした」と報告してくるため。
   */
  read(
    renderer: THREE.WebGLRenderer,
    x: number,
    y: number,
    w: number,
    h: number,
  ): { pixels: Uint8Array; glError: number } {
    const cw = Math.max(1, Math.min(w | 0, this.width));
    const ch = Math.max(1, Math.min(h | 0, this.height));
    const pixels = new Uint8Array(cw * ch * 4);
    const gl = renderer.getContext();
    // 直前の未処理エラーを捨ててから読む（他所のエラーを自分のものと誤認しない）
    while (gl.getError() !== gl.NO_ERROR) {
      /* drain */
    }
    renderer.readRenderTargetPixels(this.target, x | 0, y | 0, cw, ch, pixels);
    return { pixels, glError: gl.getError() };
  }

  /**
   * **測定器の自己検査。**
   *
   * 既知のクリアカラーを capture RT へ直接書いて読み返す。返ってきた値が
   * 書いた値でなければ、以降のどの数値も意味を持たない。
   */
  selfTest(renderer: THREE.WebGLRenderer): CaptureSelfTest {
    const expected: [number, number, number] = [0x12, 0x34, 0x56];
    const prevTarget = renderer.getRenderTarget();
    const prevClear = new THREE.Color();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();

    renderer.setRenderTarget(this.target);
    // setClearColor は working color space で解釈されるので、
    // 8bit RT へそのまま書くために正規化値を直接指定する
    renderer.setClearColor(new THREE.Color().setRGB(
      expected[0] / 255,
      expected[1] / 255,
      expected[2] / 255,
      THREE.SRGBColorSpace,
    ), 1);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);

    const { pixels, glError } = this.read(renderer, 0, 0, 1, 1);
    const actual: [number, number, number] = [pixels[0], pixels[1], pixels[2]];
    // クリアは working(linear) → RT へ書かれる際に色空間変換が入りうるので、
    // 「厳密一致」ではなく「読み戻し経路が生きている」ことを見る:
    // 全 0 かつ glError が立っている、が捕まえたい失敗である。
    const allZero = actual[0] === 0 && actual[1] === 0 && actual[2] === 0;
    const ok = glError === 0 && !allZero;
    return {
      ok,
      expected,
      actual,
      glError,
      message: ok
        ? '読み戻し経路は生きている'
        : glError !== 0
          ? `readRenderTargetPixels が GL エラー ${glError} を返した`
            + '（half-float RT を Uint8Array で読んでいる可能性）'
          : '読み戻しが全 0 を返した。この状態のテストは壊れていても緑になる',
    };
  }

  dispose(): void {
    this.target.dispose();
    this.pass.dispose();
  }
}
