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
    // **リニア空間で指定する。** sRGB で渡すと three が working(linear) へ変換してから
    // RT へ書くので、読み戻る値は指定した符号値と一致しない ── そこで
    // 「厳密一致」を諦めて「全 0 でなければ良し」に緩めると、
    // **測定器の自己検査そのものが「壊れていても緑」になる。**
    // 8bit で厳密に表せる値をリニアのまま置けば、往復は恒等でなければならない。
    const expected: [number, number, number] = [128, 64, 32];
    const prevTarget = renderer.getRenderTarget();
    const prevClear = new THREE.Color();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();

    renderer.setRenderTarget(this.target);
    renderer.setClearColor(new THREE.Color().setRGB(
      expected[0] / 255,
      expected[1] / 255,
      expected[2] / 255,
      THREE.LinearSRGBColorSpace,
    ), 1);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);

    const { pixels, glError } = this.read(renderer, 0, 0, 1, 1);
    const actual: [number, number, number] = [pixels[0], pixels[1], pixels[2]];
    // ドライバの丸めだけを許す（±1）。それ以上ずれたら往復が恒等ではない
    const maxErr = Math.max(
      Math.abs(actual[0] - expected[0]),
      Math.abs(actual[1] - expected[1]),
      Math.abs(actual[2] - expected[2]),
    );
    const allZero = actual[0] === 0 && actual[1] === 0 && actual[2] === 0;
    const ok = glError === 0 && maxErr <= 1;
    return {
      ok,
      expected,
      actual,
      glError,
      message: ok
        ? `読み戻しの往復が恒等（最大誤差 ${maxErr}）`
        : glError !== 0
          ? `readRenderTargetPixels が GL エラー ${glError} を返した`
            + '（half-float RT を Uint8Array で読んでいる可能性）'
          : allZero
            ? '読み戻しが全 0 を返した。この状態のテストは壊れていても緑になる'
            : `読み戻しが書いた値と一致しない（期待 ${expected.join(',')} / 実測 ${actual.join(',')}）`,
    };
  }

  dispose(): void {
    this.target.dispose();
    this.pass.dispose();
  }
}

/** half-float(IEEE 754 binary16) → f32。`Float16Array` の有無に依存させない */
export function halfToFloat(h: number): number {
  const s = (h & 0x8000) !== 0 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24; // 非正規数（ここが 0 になる実装を疑うために要る）
  if (e === 31) return m === 0 ? s * Infinity : NaN;
  return s * (m + 1024) * 2 ** (e - 25);
}

/**
 * **リニア HDR のまま読む口**（Phase 2）。`Capture` とは測る対象が違う。
 *
 * `Capture` は鎖の最後の 8bit RT を読むので、報告できるのは「画面に出るのと同じ値」──
 * つまり **1.0 を超えた値と 1.0 ちょうどを区別できない**。`CompressPass` が管理する量は
 * まさにそれなので、あの口だけで圧縮を測ると「クリップが消えた」しか言えず、
 * **正しい強度と 10 倍間違えた強度が同じ見出しを出す**。
 *
 * → `OutputPass` の**前**（＝ sRGB エンコード前・リニア空間）に写しを取る。
 * `HalfFloatType` なので §4.17 のとおり **`Uint16Array`** で読む
 * （`Uint8Array` は例外を投げずに `INVALID_OPERATION` と全 0 を返す）。
 */
/**
 * HDR 自己検査で往復させる値。**1 つは必ず 1.0 を超えていなければならない** ──
 * この口の存在理由が「1.0 超と 1.0 ちょうどを区別すること」だからで、
 * 1.0 以下だけで通した自己検査は 8bit の `Capture` と同じことしか確かめていない。
 * 3 つとも fp16 で厳密に表せるので、往復は恒等でなければならない。
 * `capture.test.ts` が「最大値 > 1」を node で見張る（`npm run teeth` の台帳にも在る）。
 */
export const HDR_SELFTEST_VALUE: readonly [number, number, number] = [2.5, 0.25, 0.0625];

export class HdrCapture {
  readonly pass: CapturePass;
  private target: THREE.WebGLRenderTarget;
  private width: number;
  private height: number;

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.target = HdrCapture.makeTarget(this.width, this.height);
    this.pass = new CapturePass();
    this.pass.target = this.target;
  }

  private static makeTarget(w: number, h: number): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });
    rt.texture.name = 'LENS.captureHDR';
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

  frameInto(render: () => void): void {
    this.pass.enabled = true;
    try {
      render();
    } finally {
      this.pass.enabled = false;
    }
  }

  /** 原点は左下（GL の流儀）。返すのは RGBA の f32（half をデコードした値） */
  read(
    renderer: THREE.WebGLRenderer,
    x: number,
    y: number,
    w: number,
    h: number,
  ): { pixels: Float32Array; glError: number } {
    const cw = Math.max(1, Math.min(w | 0, this.width));
    const ch = Math.max(1, Math.min(h | 0, this.height));
    const raw = new Uint16Array(cw * ch * 4);
    const gl = renderer.getContext();
    while (gl.getError() !== gl.NO_ERROR) {
      /* drain */
    }
    renderer.readRenderTargetPixels(this.target, x | 0, y | 0, cw, ch, raw);
    const glError = gl.getError();
    const pixels = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) pixels[i] = halfToFloat(raw[i]);
    return { pixels, glError };
  }

  /**
   * **測定器の自己検査。** `Capture.selfTest` と同じ規律で、こちらは
   * **1.0 を超える値を置く** ── この口の存在理由が「1.0 超を区別すること」だからである。
   * 2.5 / 0.25 / 0.0625 はどれも fp16 で厳密に表せるので、往復は恒等でなければならない。
   */
  selfTest(renderer: THREE.WebGLRenderer): CaptureSelfTest {
    const expected: [number, number, number] = [...HDR_SELFTEST_VALUE];
    const prevTarget = renderer.getRenderTarget();
    const prevClear = new THREE.Color();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();

    renderer.setRenderTarget(this.target);
    renderer.setClearColor(
      new THREE.Color().setRGB(expected[0], expected[1], expected[2], THREE.LinearSRGBColorSpace),
      1,
    );
    renderer.clear(true, false, false);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);

    const { pixels, glError } = this.read(renderer, 0, 0, 1, 1);
    const actual: [number, number, number] = [pixels[0], pixels[1], pixels[2]];
    const exact =
      Object.is(actual[0], expected[0])
      && Object.is(actual[1], expected[1])
      && Object.is(actual[2], expected[2]);
    const ok = glError === 0 && exact;
    return {
      ok,
      expected,
      actual,
      glError,
      message: ok
        ? 'HDR 読み戻しの往復が厳密に恒等（1.0 超を含む）'
        : glError !== 0
          ? `readRenderTargetPixels が GL エラー ${glError} を返した（型が合っていない）`
          : `HDR 読み戻しが書いた値と一致しない（期待 ${expected.join(',')} / 実測 ${actual.join(',')}）`,
    };
  }

  dispose(): void {
    this.target.dispose();
    this.pass.dispose();
  }
}
