/**
 * 板と点群を 1 つのシーンにまとめ、`dimLevel` から毎フレームの姿を決める。
 *
 * ## 合成則（1a-iii で決めた。素案には規定が無かった）
 *
 * 板（写真そのもの）と点群（スプライトによる再構成）は**加算合成**なので、
 * 両方フル強度で描くと平坦部の値が **2 倍**になる。ΔE00 ≤ 2.0 のゲートは
 * 2 倍を絶対に通さないので、重みの規則は必須である。
 *
 *   アンカー窓 `[1.9, 2.1]` の中: **板 = 1、点群 = 厳密に 0**
 *   窓の外: `rotationGate` と**同じ門**で板 → 点群へ渡る（和は構成上つねに厳密に 1）
 *
 * 「あなたの写真そのもの」は、スプライトで再構成した近似ではなく**実際の画素**である。
 * そして動き始めることと、写真が点の雲へ解けることが、同じ 1 つの門から出る。
 *
 * ## カメラ距離
 *
 * `fitDistance`（`core/fit.ts`）が唯一の源。**`safeDist`（§4.9）とは別の量**である ──
 * あちらは R⁵ の中の透視カスケードの除数（CPU 側）、こちらは three のカメラの world 距離。
 * 同じ「距離」という語だが比べても意味がない。
 *
 * なお `dimLevel = 2` では `extent = [1,1,0,0,0]` なので `foldExtent` が列 2,3,4 を 0 にし、
 * `p2 = p3 = p4 = 0` → カスケードの両段が `f = dist/(dist − 0) = 1` になる。
 * **アンカーでは `dist` が絵に一切効かない**（代数で確定・水準 B）。
 * dimLevel > 2 では投影後の広がりが `dist` に依存するので、`imageHalfExtents` を
 * フレーミングの根拠にできるのは**アンカー付近だけ**である（Phase 1b の課題）。
 */

import * as THREE from 'three';
import { clamp01 } from '../math/ease';
import { composeRotN, foldExtent, liftProject5, safeDist } from '../math/rotationN';
import type { PlaneRotation } from '../math/rotation';
import { imageHalfExtents, type GridSpec } from '../image/grid';
import { fitDistance } from '../core/fit';
import { CAMERA_FOV } from '../core/engine';
import { Plate } from '../render/plate';
import { ColorPointBatch } from '../render/colorPointBatch';
import { TextureProbe } from '../render/textureProbe';
import {
  advancePhases,
  cloudWeight,
  createAngleBuffer,
  createPhases,
  isAnchored,
  plateWeight,
  type RotationPhases,
} from '../render/rotationSchedule';

const N = 5;

/**
 * 経路の強制。**測定のためだけに存在する。**
 *
 * SPEC §7.2 は「板経路と雲経路で別のゲートを持たない」と書いている ── 両方が
 * ΔE00 ≤ 2.0 を通らなければならない。ところが出荷時のクロスフェードは
 * アンカー窓で点群を厳密に 0 にするので、**そのままでは雲経路を dimLevel=2 で測れない**。
 *
 * `'auto'` が出荷時の挙動で、`'plate'` / `'cloud'` は測定器が一方だけを見るための口。
 * 出荷時の合成則そのものは変えない（測るために作品を変えない）。
 */
export type PathOverride = 'auto' | 'plate' | 'cloud';

export interface LensSceneSource {
  readonly grid: GridSpec;
  /** 5 f32/点 */
  readonly base: Float32Array;
  /** 3 f32/点、リニア光 */
  readonly colors: Float32Array;
  /** 正準バッファの寸法（アスペクトの源） */
  readonly width: number;
  readonly height: number;
  readonly maxNorm: number;
  readonly plate: ImageBitmap | null;
}

export interface LensSceneStats {
  dimLevel: number;
  anchored: boolean;
  plateWeight: number;
  cloudWeight: number;
  gridW: number;
  gridH: number;
  pointCount: number;
  /** セル 1 個あたりの device px */
  s0: number;
  /** `gl_PointSize`（device px） */
  spritePx: number;
  gain: number;
  cameraDistance: number;
  /** 透視カスケードの除数（カメラ距離ではない） */
  cascadeDist: number;
  frozen: boolean;
  pathOverride: PathOverride;
}

export class LensScene {
  readonly scene: THREE.Scene;
  readonly plate: Plate;
  readonly points: ColorPointBatch;

  private dimLevel = 2;
  private frozen = false;
  private pathOverride: PathOverride = 'auto';
  private readonly phases: RotationPhases = createPhases();
  private readonly angles: PlaneRotation[] = createAngleBuffer();
  private readonly matrix = new Float64Array(N * N);
  private readonly extent = new Float64Array(N);

  private source: LensSceneSource;
  private cascadeDist: number;
  private lastConfigure = { s0: 0, spritePx: 0, gain: 1 };
  private probe: TextureProbe | null = null;
  private cameraDistance = 3;

  constructor(source: LensSceneSource) {
    this.source = source;
    this.cascadeDist = safeDist(source.maxNorm);

    this.scene = new THREE.Scene();
    this.plate = new Plate({ width: source.width, height: source.height });
    this.points = new ColorPointBatch(source.grid.cols * source.grid.rows);

    if (source.plate) this.plate.setImage(source.plate);
    this.points.colors.set(source.colors);
    this.points.commitColors();

    this.scene.add(this.plate.object);
    this.scene.add(this.points.object);
  }

  /** 新しい画像。バッファ長が変わるので点群は作り直す */
  setSource(source: LensSceneSource): { recreated: boolean } {
    const count = source.grid.cols * source.grid.rows;
    const recreated = count > this.points.maxPoints;
    this.source = source;
    this.cascadeDist = safeDist(source.maxNorm);
    if (source.plate) this.plate.setImage(source.plate);
    if (recreated) {
      this.scene.remove(this.points.object);
      this.points.dispose();
      (this as { points: ColorPointBatch }).points = new ColorPointBatch(count);
      this.scene.add(this.points.object);
    }
    this.points.colors.set(source.colors.subarray(0, count * 3));
    this.points.commitColors();
    return { recreated };
  }

  setDimLevel(d: number): void {
    this.dimLevel = Number.isFinite(d) ? Math.min(5, Math.max(0, d)) : 2;
  }

  getDimLevel(): number {
    return this.dimLevel;
  }

  /** 回転を凍結/解除する。**位相は保持する**（解除で跳ねない） */
  freezeRotation(frozen: boolean): void {
    this.frozen = frozen;
  }

  /**
   * カメラとスプライトの寸法を貼り直す。リサイズと画像差し替えのときだけ呼ぶ。
   *
   * `fitDistance` は `imageHalfExtents` からしか aX/aY を取らない ──
   * アスペクト比の源をここで再計算しない（SPEC の単一情報源の規律）。
   */
  layout(params: {
    camera: THREE.PerspectiveCamera;
    viewportAspect: number;
    bandFrac: number;
    pxPerWorld: number;
    maxPointSize: number;
  }): void {
    const { aX, aY } = imageHalfExtents(this.source.width, this.source.height);
    const distance = fitDistance({
      aX,
      aY,
      viewportAspect: params.viewportAspect,
      bandFrac: params.bandFrac,
      fovDeg: CAMERA_FOV,
    });
    this.cameraDistance = distance;
    params.camera.position.set(0, 0, distance);
    params.camera.lookAt(0, 0, 0);

    const cellWorld = (2 * aX) / Math.max(1, this.source.grid.cols);
    this.lastConfigure = this.points.configure({
      cellWorld,
      pxPerWorld: params.pxPerWorld,
      distance,
      maxPointSize: params.maxPointSize,
    });
  }

  /** 毎フレーム。回転→行列→投影→commit */
  update(dt: number): void {
    const d = this.dimLevel;
    if (!this.frozen) advancePhases(this.phases, d, dt);

    // 角度は毎フレーム絶対値で作る（誤差を蓄積させない。rotation.ts の契約）
    const gate = cloudWeight(d);
    for (let k = 0; k < this.angles.length; k++) {
      this.angles[k].angle = gate === 0 ? 0 : gate * this.phases[k];
    }

    for (let k = 0; k < N; k++) this.extent[k] = clamp01(d - k);

    composeRotN(this.angles, N, this.matrix);
    foldExtent(this.matrix, N, this.extent);

    const count = this.source.grid.cols * this.source.grid.rows;
    liftProject5(this.source.base, count, this.matrix, this.cascadeDist, this.points.positions);
    this.points.commit(count);

    // 出荷時は同じ門から出た相補的な重み。override は測定器だけが立てる
    const pw = this.pathOverride === 'plate' ? 1 : this.pathOverride === 'cloud' ? 0 : plateWeight(d);
    const cw = this.pathOverride === 'cloud' ? 1 : this.pathOverride === 'plate' ? 0 : gate;
    this.plate.setOpacity(pw);
    this.points.setWeight(cw);
  }

  /**
   * 板のテクスチャを画像画素座標で 1 点サンプルする（G5）。
   *
   * 画面の読み戻しでは板の倍率と位相が viewport 次第なので、**中点を一度も
   * サンプルしないことがある**（実測: 標本 No.0 は 0.83 倍の縮小になり、
   * 2px チェッカーが解像して領域平均が 166 という解釈できない値になった）。
   */
  sampleTexel(
    renderer: THREE.WebGLRenderer,
    imgX: number,
    imgY: number,
  ): { rgb: [number, number, number]; glError: number; uv: [number, number] } | null {
    const map = this.plate.map;
    if (!map) return null;
    this.probe ??= new TextureProbe();
    return this.probe.sample(renderer, map, imgX, imgY, this.source.width, this.source.height);
  }

  /** 測定のための経路強制。出荷時の合成則は変えない */
  setPathOverride(mode: PathOverride): void {
    this.pathOverride = mode;
  }

  stats(): LensSceneStats {
    const d = this.dimLevel;
    return {
      dimLevel: d,
      anchored: isAnchored(d),
      plateWeight: plateWeight(d),
      cloudWeight: cloudWeight(d),
      gridW: this.source.grid.cols,
      gridH: this.source.grid.rows,
      pointCount: this.source.grid.cols * this.source.grid.rows,
      s0: this.lastConfigure.s0,
      spritePx: this.lastConfigure.spritePx,
      gain: this.lastConfigure.gain,
      cameraDistance: this.cameraDistance,
      cascadeDist: this.cascadeDist,
      frozen: this.frozen,
      pathOverride: this.pathOverride,
    };
  }

  dispose(): void {
    this.plate.dispose();
    this.points.dispose();
    this.probe?.dispose();
    this.probe = null;
  }
}
