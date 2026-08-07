/**
 * 加算合成そのものを、**作品を通さずに**測る器具（Phase 2b）。
 *
 * ## なぜ作品越しに測ってはいけないのか
 *
 * SPEC §4.6 訂正 4 は「`dimLevel = 0` の残差 −5.2% / −6.0% を予測するモデルが無い」
 * （水準 C）で終わっている。ところがラダー越しに測ると、読める値には
 * **スプライトの被覆・`gainFor` の較正・`collapseWeight`・中心の位相**が全部乗っている。
 * どれか 1 つでも取り違えていれば、残差はそこへ吸われる ── 実際 Phase 2a は
 * G9 の −17.58% のうち **位相の 13.08%** をそうやって取り違えていた。
 *
 * → **規定した K 個の値を、規定した順序で、HDR の RT へ加算合成で積んで読み返す。**
 * 光学も幾何も較正も無い。残るのは「GPU のブレンドユニットが何をするか」だけである。
 * `orientProbe`（デコーダが EXIF を適用したか）/ `textureProbe`（拡大補間がリニア光か）と
 * 同じ型 ── **1 つの機構だけを、それが動く最小の構成で問う。**
 *
 * ## 読み戻しは Uint16Array（§4.17）
 *
 * `HalfFloatType` の RT を `Uint8Array` で読むと、three のガードは
 * `EXT_color_buffer_half_float` があると通ってしまい、**例外を投げずに
 * `INVALID_OPERATION` と全 0 を返す**。全 0 は「ブレンドが全部消えた」と読めてしまうので、
 * この器具に限っては最悪の失敗モードである。デコードは `core/capture.ts` の
 * `halfToFloat`（`Float16Array` に依存しない独立実装）を使う。
 *
 * ## 自己検査
 *
 * `selfTest()` は `1 + 0.5 + 0.25` を積む ── どの中間和も fp16 で厳密なので、
 * **1.75 でなければならない**。これが通らないうちは、以降のどの残差の議論も
 * 「器具が壊れている」と区別がつかない（§7.2）。
 *
 * ## 出荷経路との既知の差（隠さない）
 *
 * | | composer のバッファ | この器具 |
 * |---|---|---|
 * | 型 | `HalfFloatType` | 同じ |
 * | ブレンド | `AdditiveBlending`（SrcAlpha, One） | 同じ |
 * | MSAA | `samples = 4` | **無し** |
 * | 寸法 | drawingBuffer 全面 | **1×1** |
 *
 * MSAA を外してあるのは、ブレンドがサンプルごとに走る以上、1 フラグメントが
 * 全サンプルを覆う構成では解決後の値が同じになるためである。**同じ「はず」なので
 * 外した**という判断であって、測っていない ── ここに書いておく。
 */

import * as THREE from 'three';
import { halfToFloat } from '../core/capture';

const VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/**
 * **`uValue` はそのまま出す。** 何かの関数を通すと、その関数の丸めが
 * ブレンドの丸めと混ざって切り分けられなくなる。`highp` を明示するのは、
 * `mediump` に落ちた実装では f32 のソースを作れないためである。
 */
const FRAG = /* glsl */ `
precision highp float;
uniform vec3 uValue;
void main() { gl_FragColor = vec4(uValue, 1.0); }
`;

export interface BlendProbeResult {
  /** 積み終わったあとの RGB（リニア・half-float をデコードした f32） */
  readonly rgb: [number, number, number];
  /** 積んだ回数 */
  readonly count: number;
  readonly glError: number;
}

export class BlendProbe {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly material: THREE.ShaderMaterial;
  private readonly raw = new Uint16Array(4);

  constructor() {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });
    this.target.texture.name = 'LENS.blendProbe';
    this.material = new THREE.ShaderMaterial({
      uniforms: { uValue: { value: new THREE.Vector3(0, 0, 0) } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      // **`colorPointBatch` と同じ設定でなければ、同じブレンドを測っていない**
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
    });
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
    this.camera = new THREE.Camera();
  }

  /**
   * `values` を**その順序で** 1 個ずつ加算合成する。
   *
   * 1 値 = 1 ドローコールである。まとめて 1 パスで足すと、
   * どの順序で丸められたかがドライバの都合になり、**順序依存そのものを問えない**
   * （§4.6 の「左右を反転しただけで 1 コード動く」がこの器具の主題である）。
   */
  accumulate(renderer: THREE.WebGLRenderer, values: ArrayLike<number>): BlendProbeResult {
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const uValue = this.material.uniforms.uValue.value as THREE.Vector3;

    renderer.setRenderTarget(this.target);
    // 最初の 1 回だけ 0 へ落とす。以降は**絶対にクリアしない**（積むのが目的）
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.autoClear = false;

    const n = values.length;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      uValue.set(v, v, v);
      renderer.render(this.scene, this.camera);
    }

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);

    const gl = renderer.getContext();
    while (gl.getError() !== gl.NO_ERROR) {
      /* drain */
    }
    renderer.readRenderTargetPixels(this.target, 0, 0, 1, 1, this.raw);
    const glError = gl.getError();
    return {
      rgb: [halfToFloat(this.raw[0]), halfToFloat(this.raw[1]), halfToFloat(this.raw[2])],
      count: n,
      glError,
    };
  }

  /**
   * **器具の自己検査。** `1 + 0.5 + 0.25` はどの中間和も fp16 で厳密なので、
   * 返り値は **1.75 でなければならない**（3 チャンネルとも）。
   */
  selfTest(renderer: THREE.WebGLRenderer): {
    ok: boolean;
    actual: [number, number, number];
    glError: number;
    message: string;
  } {
    const r = this.accumulate(renderer, [1, 0.5, 0.25]);
    const exact = r.rgb.every((v) => Object.is(v, 1.75));
    const ok = r.glError === 0 && exact;
    return {
      ok,
      actual: r.rgb,
      glError: r.glError,
      message: ok
        ? '加算合成の器具が厳密な 1.75 を返した'
        : r.glError !== 0
          ? `readRenderTargetPixels が GL エラー ${r.glError} を返した`
            + '（half-float RT を Uint16Array 以外で読んでいる可能性）'
          : `1 + 0.5 + 0.25 が 1.75 にならない（実測 ${r.rgb.join(',')}）`
            + ' —— 器具が壊れているので、残差の議論はできない',
    };
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
