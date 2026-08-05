// VENDORED_FROM: ops324/dimension@8cd37d8ffe74017acd18c1907195e36a20d9ec19 src/render/pointBatch.ts
// STATUS: MODIFIED
//
// 変更点:
//   - 単色 uniform (uColor) → **点ごとのリニア光 RGB** 属性 (aColor)
//   - BufferGeometry → InstancedBufferGeometry（SPEC §3、モード B への布石）
//   - 深度キュー用の aBright を削除（写真の忠実性が目的なので明るさを触らない）
//   - gl_PointSize をセル間隔から導く（kSprite 倍）+ 正規化ゲイン uGain
//   - falloff の既定 17（親の線用）→ F = 21（spriteGain.ts の実測値）

/**
 * R⁵ の格子点を投影した点群。
 *
 * ## `InstancedBufferGeometry` の既定値は**絵を消す**（three のソースで確認）
 *
 * SPEC §3 は「Phase 1 の時点で `colorPointBatch` を `InstancedBufferGeometry`
 * （`instanceCount = 1`）で書く。Phase 1 のコストはゼロ（同じ 1 ドローコール）」と書いている。
 * これは真だが、**条件が書かれていない。**
 *
 * `InstancedBufferGeometry.js` の既定は `this.instanceCount = Infinity`。
 * per-instance 属性が 1 つも無いと three は `maxInstanceCount` を決められず、
 * `gl.drawArraysInstanced(POINTS, 0, n, Infinity)` が発行される。
 * WebIDL の `GLsizei` 変換で `Infinity` は **0** になるので:
 *
 *   - 点が 1 つも描かれない
 *   - `gl.getError()` は **0（NO_ERROR）**
 *   - `renderer.info.render.calls` は **1**（ドローコールは出ている）
 *   - シェーダのコンパイルも成功する
 *
 * デバッグの取っ掛かりが 1 つも無い壊れ方をする。
 * → **`instanceCount` を明示的に 1 にする。** `colorPointBatch.test.ts` が
 * `=== 1` を機械で見る（`!== Infinity` ではなく `=== 1` ── 誤った有限値も落とすため）。
 */

import * as THREE from 'three';
import { F, K_SPRITE, gainFor } from '../image/spriteGain';

export interface ColorPointBatchOptions {
  /** カメラに寄ったときの暴走防止（device px）。GL の上限は別途クランプされる */
  maxSize?: number;
  pixelRatio?: number;
}

const VERTEX_SHADER = /* glsl */ `
attribute vec3 aColor;

uniform float uSpriteWorld;   // スプライト直径（ワールド単位）= kSprite × セル間隔
uniform float uPxPerWorld;    // 深度 1 でのワールド→device px 倍率
uniform float uMaxSize;

varying vec3 vColor;

void main() {
  vColor = aColor;

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;

  // 透視での見かけサイズ。セル間隔と同じ比で縮むので、被覆数は深度に依らない
  float size = uSpriteWorld * uPxPerWorld / max(-mv.z, 1e-3);
  gl_PointSize = min(size, uMaxSize);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform float uF;
uniform float uGain;
uniform float uWeight;   // 板とのクロスフェード。アンカー窓の中では厳密に 0

varying vec3 vColor;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  // 円の外は捨てる。MSAA でもフラグメント全体が死ぬ（＝ ksum 較正は MSAA に依らない）
  if (r2 > 0.25) discard;

  float w = exp(-uF * r2);

  // AdditiveBlending は (SrcAlpha, One)。alpha は 1.0 固定で輝度は rgb へ集約する。
  // 色は**リニア光**のまま出す ── sRGB エンコードは鎖の最後（OutputPass）が 1 回だけ行う。
  gl_FragColor = vec4(vColor * (uGain * uWeight * w), 1.0);
}
`;

export class ColorPointBatch {
  readonly maxPoints: number;
  /** 投影後の R³ 座標 [x,y,z] × maxPoints。`liftProject5` の出力先 */
  readonly positions: Float32Array;
  /** 点ごとの**リニア光** RGB */
  readonly colors: Float32Array;
  readonly geometry: THREE.InstancedBufferGeometry;
  readonly material: THREE.ShaderMaterial;
  readonly object: THREE.Points;

  private readonly positionAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;

  constructor(maxPoints: number, options: ColorPointBatchOptions = {}) {
    this.maxPoints = maxPoints;
    this.positions = new Float32Array(maxPoints * 3);
    this.colors = new Float32Array(maxPoints * 3);

    this.positionAttr = new THREE.BufferAttribute(this.positions, 3);
    this.positionAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.BufferAttribute(this.colors, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);

    const geometry = new THREE.InstancedBufferGeometry();
    // **この 1 行が無いと 1 画素も描かれず、GL エラーも出ない。**
    geometry.instanceCount = 1;
    geometry.setAttribute('position', this.positionAttr);
    geometry.setAttribute('aColor', this.colorAttr);
    geometry.setDrawRange(0, 0);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);
    this.geometry = geometry;

    const pixelRatio =
      options.pixelRatio
      ?? Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, 2);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uSpriteWorld: { value: 0 },
        uPxPerWorld: { value: 100 },
        uMaxSize: { value: options.maxSize ?? 256 },
        uF: { value: F },
        uGain: { value: 1 },
        uWeight: { value: 1 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      blending: THREE.AdditiveBlending,
      // 板と同一平面（dimLevel=2 では z が厳密に 0）。1 ULP の差に結果を依存させない
      depthTest: false,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
    });
    // pixelRatio は uPxPerWorld（drawingBuffer 基準）へ畳み込むので、
    // ここでは受け取るだけで uniform を持たない ── 同じ量を 2 か所に置かない。
    void pixelRatio;

    this.object = new THREE.Points(geometry, this.material);
    this.object.name = 'colorPointBatch';
    this.object.frustumCulled = false;
    this.object.renderOrder = 1;
  }

  /**
   * 格子とカメラからスプライトの寸法とゲインを決める。
   *
   * `s0`（セル 1 個あたりの device px）は**平坦場のカメラ距離**で評価する ──
   * `gainFor` の較正が「平坦な面が本来の値で出ること」で定義されているため。
   * dimLevel > 2 で点が奥行きへ散ると s0 は点ごとに変わるが、スプライト径も
   * 同じ比で縮むので被覆数は保たれる（輝度の厳密性は Phase 1b の担当）。
   */
  configure(params: {
    /** セル間隔（ワールド単位）= 2·aX / cols */
    cellWorld: number;
    /** 深度 1 でのワールド→device px 倍率 = drawingBufferHeight / (2·tan(fov/2)) */
    pxPerWorld: number;
    /** 平坦場のカメラ距離 */
    distance: number;
    /** GL の gl_PointSize 上限 */
    maxPointSize: number;
  }): { s0: number; spritePx: number; gain: number } {
    const { cellWorld, pxPerWorld, distance, maxPointSize } = params;
    const s0 = (cellWorld * pxPerWorld) / Math.max(distance, 1e-3);
    const gain = gainFor(s0);
    const u = this.material.uniforms;
    u.uSpriteWorld.value = cellWorld * K_SPRITE;
    u.uPxPerWorld.value = pxPerWorld;
    u.uMaxSize.value = Math.min(maxPointSize, 4096);
    u.uGain.value = gain;
    return { s0, spritePx: K_SPRITE * s0, gain };
  }

  /** 位置バッファの反映と描画点数の設定 */
  commit(count: number): void {
    const n = count > 0 ? Math.min(count | 0, this.maxPoints) : 0;
    this.positionAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, n);
  }

  /** 色は画像が変わったときだけ書き換わる */
  commitColors(): void {
    this.colorAttr.needsUpdate = true;
  }

  /**
   * 板とのクロスフェードの重み。**`uGain` とは別の uniform に持つ** ──
   * ゲインへ直接掛けると `configure()` が上書きしてしまい、
   * 「リサイズしたら点群が復活する」という時々しか出ない壊れ方をする。
   */
  setWeight(weight: number): void {
    const w = weight < 0 ? 0 : weight > 1 ? 1 : weight;
    this.material.uniforms.uWeight.value = w;
    // 厳密に 0 のときは描画そのものを外す（加算なので 0 でも無害だが、
    // 「アンカー窓では点群が 1 フラグメントも走らない」を観測可能にする）
    this.object.visible = w > 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
