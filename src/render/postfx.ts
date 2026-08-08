// VENDORED_FROM: ops324/dimension@8cd37d8ffe74017acd18c1907195e36a20d9ec19 src/render/postfx.ts
// STATUS: MODIFIED
//
// 変更点:
//   - **CompressPass を新設**し、OutputPass の**前**（リニア空間）へ挿す（SPEC §4.5）
//   - Capture パスを鎖の最後に受け取れるようにした（`src/core/capture.ts`）
//   - bloom / grade を**既定オフ**にした。1a-iii の忠実性ラダーは後処理ゼロが基準で、
//     定数の再測定は Phase 2（SPEC §8 のフェーズ表）
//   - 親の bloom/grade 定数はそのまま残す（Phase 2 の出発点。勝手に「改善」しない）
//   - **Phase 2a: `hdrPass` を受け取れるようにした**（`OutputPass` の**前**に挿す）。
//     鎖の最後の 8bit capture では 1.0 超と 1.0 ちょうどが区別できず、
//     `CompressPass` が管理する量を測る口がどこにも無かった（`core/capture.ts` の `HdrCapture`）。
//     bloom / grade / compress の定数そのものは 2a では**まだ触っていない**
//   - **Phase 2b: 定数を外へ出し、光過敏の配慮を本物にした**
//     - bloom の定数を **`core/bloom.ts` へ出した**（`bloom.test.ts` が「閾値 > 平均色の輝度」を
//       node で見張る。閾値は `d = 0` の目標リニア輝度 0.265546 の 1.0544 倍しかない）。
//       ここに置いたままだと、閾値を壊す変異が `vendor.test.ts` の sha256 にしか
//       引っかからず、「何を守っている歯か」が言えなくなる
//     - `uKnee` / `uStrength` の値を `core/compress.ts` から取る（この repo で新しく置かれた
//       未計測のリテラル `0.8` を、実測に基づく定数へ差し替えた）
//     - `reduceMotion` を**構築時に 1 回読む定数から、外から設定できる状態へ**変えた。
//       あの 1 行が握っていたのは既定オフの `gradePass` の `uTime` だけで、
//       **配慮を有効にしてもフレームバッファは 1 ビットも変わらなかった**（`core/motion.ts`）

/**
 * ポストプロセスの鎖。
 *
 * ```
 * RenderPass(HalfFloat + MSAA) → Bloom → CompressPass → OutputPass(sRGB) → Grade → [Capture]
 * ```
 *
 * ## `CompressPass` が OutputPass の**前**にある理由（SPEC §4.5）
 *
 * `NeutralToneMapping` は恒等ではない（sRGB 128 → 116、63 → 33）。`dimLevel = 2` は
 * この作品が乗っている唯一の錨で、忠実性テストは読み戻して元 RGB と比較するので、
 * トーンマップを入れると**正しく実装しても必ず落ちる**。よって
 * `renderer.toneMapping = NoToneMapping` 固定。
 *
 * 一方、dimLevel が上がると加算が 1.0 を超える。その圧縮を担うのが `CompressPass` で、
 * **リニア空間**（OutputPass の前）で、`uStrength` を dimLevel で駆動する。
 * `uStrength = 0` のとき**厳密な恒等**でなければならない ── そうでないと
 * アンカー窓で錨が動く。シェーダはそのために `mix()` ではなく早期 return で書いてある。
 *
 * ## 「後処理オフ」を composer 迂回で実装してはいけない
 *
 * `WebGLPrograms.js:212` により、レンダーターゲットへ描くときは出力エンコードが恒等、
 * 画面へ直接描くときは sRGB エンコードが**フラグメントごと・ブレンドの前**に入る。
 * つまり composer を迂回すると**加算の演算そのものが変わる**（実測: 0x808080 を
 * 加算で 2 枚重ねると、composer 経路は 176、画面直描画は飽和して 255）。
 * → オフにするときも `composer.render()` は保ち、`pass.enabled = false` にする。
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { Pass } from 'three/addons/postprocessing/Pass.js';
import {
  BLOOM_BASE_RADIUS,
  BLOOM_BASE_STRENGTH,
  BLOOM_BASE_THRESHOLD,
} from '../core/bloom';
import { COMPRESS_KNEE } from '../core/compress';
import { decideReducedMotion, reducedMotionQuery } from '../core/motion';

export interface PostFXOptions {
  samples?: number;
  /** 鎖の最後に挿す読み戻しパス（`src/core/capture.ts`） */
  capturePass?: Pass;
  /**
   * **`OutputPass` の前**に挿す HDR 読み戻しパス（Phase 2・`core/capture.ts` の `HdrCapture`）。
   * ここでしか「1.0 を超えた値」を観測できない ── 後ろで見ると sRGB エンコード済みで、
   * 8bit の capture はさらにクリップする。
   */
  hdrPass?: Pass;
}

export interface PostFX {
  readonly composer: EffectComposer;
  readonly renderPass: RenderPass;
  readonly bloomPass: UnrealBloomPass;
  readonly compressPass: ShaderPass;
  readonly gradePass: ShaderPass;
  readonly samples: number;
  setSize(width: number, height: number, pixelRatio: number): void;
  setTime(t: number): void;
  setSamples(samples: number): void;
  setBloomEnabled(on: boolean): void;
  setGradeEnabled(on: boolean): void;
  setCompressEnabled(on: boolean): void;
  /** `dimLevel` 由来の圧縮強度。0 で厳密な恒等 */
  setCompressStrength(strength: number): void;
  /**
   * 光過敏の配慮（Phase 2b）。ここが握るのは `gradePass` の `uTime` だけで、
   * **回転そのものは `lensScene` が止める** ── どちらか片方では絵が止まらない。
   */
  setReducedMotion(on: boolean): void;
  /**
   * いま有効な後処理パスの名前（DEV フックと PR の証跡用）。
   *
   * **これを G6 の採点者にしてはいけない**（監査 F.1）。自分が書いたフラグを
   * 読み返すだけなので、パスが実際に絵へ効いているかを 1 ビットも主張しない ──
   * `x/x` の典型である。G6 は画素を読んで採点する（`scripts/ladder.mjs`）。
   */
  enabledPasses(): string[];
}

const DEFAULT_SAMPLES = 4;

/**
 * bloom の定数は **`core/bloom.ts` が唯一の源**（Phase 2b で出した）。
 * ここに数字を書き戻すと、`bloom.test.ts` の柵が
 * 「移植ファイルが書き換わったこと」しか検出しなくなる（`core/bloom.ts` に理由を書いた）。
 */
export { BLOOM_BASE_RADIUS, BLOOM_BASE_STRENGTH, BLOOM_BASE_THRESHOLD } from '../core/bloom';

const GRADE_VIGNETTE = 0.18;
const GRADE_GRAIN = 0.015;
const GRADE_ABERRATION = 0.4;

const FULLSCREEN_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * リニア空間のソフトニー圧縮。**`uStrength = 0` で厳密な恒等**。
 *
 * ニー以下（`x ≤ k`）は完全に素通しなので、`dimLevel = 2` の平坦部（リニア 0.216）は
 * `uStrength` が何であれ 1 ビットも動かない。錨を後処理から守る形をシェーダ側にも持たせる。
 */
const COMPRESS_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform sampler2D tDiffuse;
uniform float uStrength;   // 0 = 恒等
uniform float uKnee;       // ここ以下は素通し

varying vec2 vUv;

float compressChannel(float x) {
  if (x <= uKnee) return x;
  float over = x - uKnee;
  // 1/(1+over) 型のソフトニー。uStrength=0 では over がそのまま戻る
  float compressed = over / (1.0 + uStrength * over);
  return uKnee + compressed;
}

void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  if (uStrength <= 0.0) {
    gl_FragColor = c;   // 早期 return: mix() を通さない（§4.5 の教訓）
    return;
  }
  gl_FragColor = vec4(
    compressChannel(c.r),
    compressChannel(c.g),
    compressChannel(c.b),
    c.a
  );
}
`;

const GRADE_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform sampler2D tDiffuse;
uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uStrength;

varying vec2 vUv;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 d = vUv - 0.5;
  float r2 = dot(d, d);

  vec2 shift = d * inversesqrt(max(r2, 1e-6)) * (uStrength.z * r2 * 2.0) / uResolution;
  vec3 color = vec3(
    texture2D(tDiffuse, vUv + shift).r,
    texture2D(tDiffuse, vUv).g,
    texture2D(tDiffuse, vUv - shift).b
  );

  float rr = sqrt(r2) * 1.41421356;
  color *= 1.0 - uStrength.x * smoothstep(0.55, 1.15, rr);

  float lum = dot(color, LUMA);
  float grain = (hash12(gl_FragCoord.xy + uTime * 137.0) - 0.5) * uStrength.y;
  color += grain * (1.0 - 0.7 * smoothstep(0.55, 1.0, lum));

  color += (hash12(gl_FragCoord.xy + 17.31) - 0.5) * (1.0 / 255.0);

  gl_FragColor = vec4(color, 1.0);
}
`;

export function buildPostFX(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  opts: PostFXOptions = {},
): PostFX {
  const cssSize = renderer.getSize(new THREE.Vector2());
  let cssWidth = Math.max(1, cssSize.x);
  let cssHeight = Math.max(1, cssSize.y);
  let ratio = renderer.getPixelRatio();
  let samples = opts.samples ?? DEFAULT_SAMPLES;

  // HalfFloat: 加算合成が 1.0 を超える HDR 値を保持するために必須（§4.6）
  const createTarget = (width: number, height: number): THREE.WebGLRenderTarget =>
    new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
      type: THREE.HalfFloatType,
      samples,
      depthBuffer: true,
      stencilBuffer: false,
    });

  const composer = new EffectComposer(
    renderer,
    createTarget(Math.round(cssWidth * ratio), Math.round(cssHeight * ratio)),
  );
  const renderPass = new RenderPass(scene, camera);

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(Math.round(cssWidth * ratio), Math.round(cssHeight * ratio)),
    BLOOM_BASE_STRENGTH,
    BLOOM_BASE_RADIUS,
    BLOOM_BASE_THRESHOLD,
  );
  bloomPass.enabled = false; // 1a-iii の基準は後処理ゼロ

  const compressPass = new ShaderPass({
    name: 'LENS.compress',
    uniforms: {
      tDiffuse: { value: null },
      uStrength: { value: 0 },
      // **`core/compress.ts` が唯一の源。** ここに数字を書くと node から見えなくなる
      uKnee: { value: COMPRESS_KNEE },
    },
    vertexShader: FULLSCREEN_VERTEX_SHADER,
    fragmentShader: COMPRESS_FRAGMENT_SHADER,
  });
  compressPass.enabled = false;

  const outputPass = new OutputPass();

  const gradePass = new ShaderPass({
    name: 'LENS.grade',
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uStrength: { value: new THREE.Vector3(GRADE_VIGNETTE, GRADE_GRAIN, GRADE_ABERRATION) },
    },
    vertexShader: FULLSCREEN_VERTEX_SHADER,
    fragmentShader: GRADE_FRAGMENT_SHADER,
  });
  gradePass.enabled = false;

  // ShaderPass は uniforms を clone するので、参照は**構築後の pass 側**から取る
  const gradeTime = gradePass.uniforms.uTime as THREE.IUniform<number>;
  const gradeResolution = gradePass.uniforms.uResolution.value as THREE.Vector2;
  const gradeStrength = gradePass.uniforms.uStrength.value as THREE.Vector3;
  const compressStrength = compressPass.uniforms.uStrength as THREE.IUniform<number>;

  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(compressPass);
  if (opts.hdrPass) composer.addPass(opts.hdrPass);
  composer.addPass(outputPass);
  composer.addPass(gradePass);
  if (opts.capturePass) composer.addPass(opts.capturePass);

  const setSize = (width: number, height: number, pixelRatio: number): void => {
    cssWidth = Math.max(1, width);
    cssHeight = Math.max(1, height);
    ratio = pixelRatio;

    composer.setPixelRatio(pixelRatio);
    composer.setSize(cssWidth, cssHeight);

    const bufferWidth = Math.max(1, Math.round(cssWidth * pixelRatio));
    const bufferHeight = Math.max(1, Math.round(cssHeight * pixelRatio));
    bloomPass.setSize(bufferWidth, bufferHeight);
    gradeResolution.set(bufferWidth, bufferHeight);

    const nativeRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    gradeStrength.y = GRADE_GRAIN * Math.min(1, pixelRatio / nativeRatio);
  };

  setSize(cssWidth, cssHeight, ratio);

  /**
   * **既定値をメディアクエリから取るが、定数にはしない**（Phase 2b）。
   *
   * 元は構築時の `const` だった。設定は途中で変わりうるうえ、この 1 行が握るのは
   * 既定オフの `gradePass` だけなので、**「配慮している」という主張が
   * フレームバッファのどこにも現れなかった**。判定の源は `core/motion.ts` へ移し、
   * ここは配られた値を持つだけにする。
   */
  let reduceMotion = decideReducedMotion(reducedMotionQuery());

  return {
    composer,
    renderPass,
    bloomPass,
    compressPass,
    gradePass,
    get samples(): number {
      return samples;
    },
    setSize,
    setTime(t: number): void {
      if (reduceMotion) return;
      gradeTime.value = t;
    },
    setSamples(next: number): void {
      const value = Math.max(0, Math.round(next));
      if (value === samples) return;
      samples = value;
      composer.reset(createTarget(Math.round(cssWidth * ratio), Math.round(cssHeight * ratio)));
      setSize(cssWidth, cssHeight, ratio);
    },
    setBloomEnabled(on: boolean): void {
      bloomPass.enabled = on;
    },
    setGradeEnabled(on: boolean): void {
      gradePass.enabled = on;
    },
    setCompressEnabled(on: boolean): void {
      compressPass.enabled = on;
    },
    setCompressStrength(strength: number): void {
      compressStrength.value = strength > 0 ? strength : 0;
    },
    setReducedMotion(on: boolean): void {
      reduceMotion = on;
    },
    enabledPasses(): string[] {
      const names: string[] = ['render'];
      if (bloomPass.enabled) names.push('bloom');
      if (compressPass.enabled) names.push('compress');
      names.push('output');
      if (gradePass.enabled) names.push('grade');
      if (opts.capturePass?.enabled) names.push('capture');
      return names;
    },
  };
}
