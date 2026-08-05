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
 * ## 潰し（Phase 1b）—— バッファは 2 つある
 *
 * `extent` が空間軸を潰すと点が**同じ位置へ重なる**。加算合成なので、そこに出るのは
 * 平均ではなく**合計**である（実測: `dimLevel = 1` で平坦場の 159.1 倍）。
 * さらに `dimLevel = 0` で格子（HIGH で 89,208 点）を 1 点へ潰すと、
 * half-float の加算が天井に当たって **−96.4%** ── ほぼ真っ黒になる。
 *
 * → **`dimLevel < 1` では列平均バッファへ差し替える**（`image/columnLine.ts`）。
 * そのうえで `sampleWeight`（`spriteGain.ts` の `collapseWeight`）が
 * 「潰れ込んだものの**平均**が中心に出る」ようにする。
 * `dimLevel = 0` の平均色は、線をさらに 1 点へ潰したものである ── 別経路ではない。
 *
 * バッファを 2 つの `ColorPointBatch` として持つのは、
 * **描画点数の取り違えを構造で塞ぐ**ため。1 つのバッチで `setDrawRange` を切り替えると、
 * 書き換えていない領域に前フレームの格子が残ったまま描かれ、
 * 「線の中心だけ読む」テストは緑のまま古い格子が背後に出る。
 *
 * ## カメラ距離
 *
 * `needDistance`（`core/fit.ts`）が唯一の源。**`safeDist`（§4.9）とは別の量**である ──
 * あちらは R⁵ の中の透視カスケードの除数（CPU 側）、こちらは three のカメラの world 距離。
 * 同じ「距離」という語だが比べても意味がない。
 *
 * `dimLevel = 2` では `extent = [1,1,0,0,0]` なので `foldExtent` が列 2,3,4 を 0 にし、
 * `p2 = p3 = p4 = 0` → カスケードの両段が `f = dist/(dist − 0) = 1` になる。
 * **アンカーでは `dist` が絵に一切効かない**（代数で確定・水準 B）。
 * `dimLevel > 2` では投影後の広がりが `dist` に依存するので、`imageHalfExtents` を
 * フレーミングの根拠にできない ── 投影後の実座標を毎フレーム走査し、
 * `framingHold` が呼吸を止める（`core/fit.ts` に機構と実測を書いた）。
 */

import * as THREE from 'three';
import { clamp01 } from '../math/ease';
import { composeRotN, foldExtent, liftProject5, safeDist } from '../math/rotationN';
import type { PlaneRotation } from '../math/rotation';
import { imageHalfExtents, type GridSpec } from '../image/grid';
import { buildColumnLine, effectiveLineCount, lineCountFor } from '../image/columnLine';
import { collapseWeight, additionDepth } from '../image/spriteGain';
import { axisPresence, type BlockScales } from '../image/stats';
import {
  framingHold,
  needDistance,
  ndcExtents,
  plateSpread,
  unionSpread,
  type Spread,
} from '../core/fit';
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
  resetPhases,
  type RotationPhases,
} from '../render/rotationSchedule';

const N = 5;

/** 列平均バッファへ切り替える dimLevel。SPEC §2 の n=1（LINE）がこの点である */
export const LINE_MAX_DIM = 1;

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

export type BufferKind = 'grid' | 'columnMeans';

export interface LensSceneSource {
  readonly grid: GridSpec;
  /** 5 f32/点 */
  readonly base: Float32Array;
  /** 3 f32/点、リニア光 */
  readonly colors: Float32Array;
  /** 3 f32 × 正準幅、リニア光。列平均バッファの源（SPEC §4.7） */
  readonly columnMeans: Float32Array;
  readonly scales: BlockScales;
  /** 正準バッファの寸法（アスペクトの源） */
  readonly width: number;
  readonly height: number;
  readonly gamut: 'srgb' | 'display-p3';
  readonly maxNorm: number;
  readonly plate: ImageBitmap | null;
}

export interface LensSceneStats {
  dimLevel: number;
  anchored: boolean;
  plateWeight: number;
  cloudWeight: number;
  /** 描画中のバッファ */
  buffer: BufferKind;
  gridW: number;
  gridH: number;
  /** いま描いている点数（バッファによって変わる） */
  pointCount: number;
  /** 列平均バッファの**上限**点数 */
  lineCount: number;
  /** そのフレームで実際に描いている線の点数（Phase 2 の `effectiveLineCount`） */
  linePoints: number;
  /** セル 1 個あたりの device px */
  s0: number;
  /** `gl_PointSize`（device px） */
  spritePx: number;
  gain: number;
  /** `gainFor` の較正域の内側か。外れたら PR に書く */
  calibrated: boolean;
  /** 潰しの補正。`dimLevel = 2` で厳密に 1 */
  sampleWeight: number;
  /** half-float に積まれる加算回数の見積もり（点数ではない） */
  additionDepth: number;
  /**
   * 5 軸 `[u, v, L, a, b]` がこの画像に存在するか（Phase 1c・SPEC §2.2）。
   * **`extent` を 0 に固定する側の観測点。** これを出さないと
   * 「退化の表明がシーンへ届いているか」を機械で見る手段が無い。
   */
  axisPresent: boolean[];
  /** そのフレームの `extent`。退化軸は `dimLevel` に依らず 0 */
  extent: number[];
  cameraDistance: number;
  /** ホールド前の、その位相での厳密な必要距離 */
  needDistance: number;
  /** 図の投影後の広がり */
  spread: Spread;
  /** 帯に対する充填（1 を超えたらはみ出している） */
  fill: { x: number; y: number };
  /** 透視カスケードの除数（カメラ距離ではない） */
  cascadeDist: number;
  frozen: boolean;
  pathOverride: PathOverride;
}

interface LayoutParams {
  viewportAspect: number;
  bandFrac: number;
  pxPerWorld: number;
  maxPointSize: number;
}

export class LensScene {
  readonly scene: THREE.Scene;
  readonly plate: Plate;
  /** 格子（`dimLevel ≥ 1`） */
  points: ColorPointBatch;
  /** 列平均線（`dimLevel < 1`）。**別インスタンスにして描画点数の取り違えを塞ぐ** */
  line: ColorPointBatch;

  private dimLevel = 2;
  private lastDimLevel = 2;
  private frozen = false;
  private pathOverride: PathOverride = 'auto';
  private readonly phases: RotationPhases = createPhases();
  private readonly angles: PlaneRotation[] = createAngleBuffer();
  private readonly matrix = new Float64Array(N * N);
  private readonly extent = new Float64Array(N);
  /**
   * 軸が存在するか（SPEC §2.2 の「その軸は存在しないと表明する」の、実装側）。
   * 添字は `[u, v, L, a, b]`。`setSource` が `scales.degenerate` から作る。
   */
  private axisPresent: boolean[] = [true, true, true, true, true];

  private source: LensSceneSource;
  private cascadeDist: number;
  private lineCount = 1;
  /** 列平均線の base。**フィールド宣言はコンストラクタの `applySource` より前でなければならない**
   * （`useDefineForClassFields` は宣言順に初期化するので、後ろに書くと書き込みが上書きされる） */
  private lineBase = new Float32Array(N);
  /**
   * いま線バッファに入っている点数（`effectiveLineCount`）。**`lineCount` とは別物。**
   * `-1` は「まだ一度も組んでいない」── 0 や 1 は正当な値なので番兵に使えない。
   */
  private linePoints = -1;
  private gridConfig = { s0: 0, s0y: 0, spritePx: 0, gain: 1, calibrated: true };
  private lineConfig = { s0: 0, s0y: 0, spritePx: 0, gain: 1, calibrated: true };
  private probe: TextureProbe | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private layoutParams: LayoutParams = {
    viewportAspect: 1,
    bandFrac: 1,
    pxPerWorld: 100,
    maxPointSize: 256,
  };
  private cameraDistance = 3;
  private heldDistance = 0;
  private lastNeed = 3;
  private lastSpread: Spread = { aX: 0, aY: 0, zHi: 0 };
  private lastSampleWeight = 1;
  private lastDepth = 1;

  constructor(source: LensSceneSource) {
    this.source = source;
    this.cascadeDist = safeDist(source.maxNorm);

    this.scene = new THREE.Scene();
    this.plate = new Plate({ width: source.width, height: source.height });
    this.points = new ColorPointBatch(source.grid.cols * source.grid.rows);
    this.line = new ColorPointBatch(lineCountFor(source.grid.cols));

    this.scene.add(this.plate.object);
    this.scene.add(this.points.object);
    this.scene.add(this.line.object);

    this.applySource(source);
  }

  /** 新しい画像。バッファ長が変わるので点群は作り直す */
  setSource(source: LensSceneSource): { recreated: boolean } {
    const count = source.grid.cols * source.grid.rows;
    const recreated = count > this.points.maxPoints
      || lineCountFor(source.grid.cols) > this.line.maxPoints;
    if (recreated) {
      this.scene.remove(this.points.object);
      this.scene.remove(this.line.object);
      this.points.dispose();
      this.line.dispose();
      this.points = new ColorPointBatch(count);
      this.line = new ColorPointBatch(lineCountFor(source.grid.cols));
      this.scene.add(this.points.object);
      this.scene.add(this.line.object);
    }
    this.applySource(source);
    if (this.camera) this.layout({ camera: this.camera, ...this.layoutParams });
    return { recreated };
  }

  private applySource(source: LensSceneSource): void {
    this.source = source;
    this.cascadeDist = safeDist(source.maxNorm);
    if (source.plate) this.plate.setImage(source.plate);

    const count = source.grid.cols * source.grid.rows;
    this.points.colors.set(source.colors.subarray(0, count * 3));
    this.points.commitColors();

    // 列平均バッファは**正準バッファの列平均**から作る（格子からではない。SPEC §4.7）
    this.lineCount = lineCountFor(source.grid.cols);
    const lineBase = new Float32Array(this.lineCount * N);
    buildColumnLine(
      source.columnMeans,
      source.width,
      source.height,
      source.gamut,
      source.scales,
      this.lineCount,
      { base: lineBase, colors: this.line.colors },
    );
    this.lineBase = lineBase;
    this.linePoints = this.lineCount;
    this.line.commitColors();
    // 退化は画像ごとに決まる。空間軸(u,v)は常に存在する
    this.axisPresent = axisPresence(source.scales);
    // フレーミングの保持は画像が変われば無効
    this.heldDistance = 0;
  }

  /**
   * 線バッファを `n` 点で組み直す（Phase 2）。**源は正準バッファの `columnMeans`** ──
   * すでに組んだ 378 点を足し合わせ直すのではない（§4.7 の「縮約は正準バッファから」）。
   *
   * 呼ぶのは `n` が変わったときだけ。`extentX` は `dimLevel` からしか動かないので、
   * 定常状態では 1 フレームに 0 回である。
   */
  private rebuildLine(n: number): void {
    if (n === this.linePoints) return;
    this.linePoints = n;
    buildColumnLine(
      this.source.columnMeans,
      this.source.width,
      this.source.height,
      this.source.gamut,
      this.source.scales,
      n,
      { base: this.lineBase, colors: this.line.colors },
    );
    this.line.commitColors();
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
   * 位相を厳密に 0 へ戻す。**測定の再現性のためだけに存在する。**
   *
   * `freezeRotation(true)` は位相を保持するので、「凍結したから再現可能」は偽である ──
   * **どの位相で凍結したかが結果を決める**。しかも `setDimLevel` も `setPath` も
   * `renderOnce(1)` を打つので、測定の手順そのものが位相を進める
   * （飽和域では 1 フレームで平面 (0,2) が 0.105° 回る）。
   */
  resetRotation(): void {
    resetPhases(this.phases);
    this.heldDistance = 0;
  }

  /**
   * カメラとスプライトの寸法を貼り直す。リサイズと画像差し替えのときだけ呼ぶ。
   *
   * **距離そのものは毎フレーム `update()` が決める**（`dimLevel` と位相に依存するため）。
   * ここでやるのは「どの viewport で測るか」を覚えることと、両バッチの寸法較正である。
   */
  layout(params: LayoutParams & { camera: THREE.PerspectiveCamera }): void {
    this.camera = params.camera;
    this.layoutParams = {
      viewportAspect: params.viewportAspect,
      bandFrac: params.bandFrac,
      pxPerWorld: params.pxPerWorld,
      maxPointSize: params.maxPointSize,
    };
    // viewport が変われば保持していた距離の前提も変わる
    this.heldDistance = 0;
    this.refreshConfigs(this.anchorDistance());
    this.updateCamera(true);
  }

  /** アンカー（板だけ）の距離。**1a-iii と 1 ビットも変えない** */
  private anchorDistance(): number {
    const { aX, aY } = imageHalfExtents(this.source.width, this.source.height);
    return needDistance(
      { aX, aY, ...this.layoutParams, fovDeg: CAMERA_FOV },
      plateSpread(aX, aY),
    );
  }

  private refreshConfigs(distance: number): void {
    const { aX, aY } = imageHalfExtents(this.source.width, this.source.height);
    const { cols, rows } = this.source.grid;
    this.gridConfig = this.points.configure({
      cellWorld: (2 * aX) / Math.max(1, cols),
      cellWorldY: (2 * aY) / Math.max(1, rows),
      pxPerWorld: this.layoutParams.pxPerWorld,
      distance,
      maxPointSize: this.layoutParams.maxPointSize,
    });
    this.lineConfig = this.line.configure({
      cellWorld: (2 * aX) / Math.max(1, this.lineCount),
      cellWorldY: (2 * aY) / Math.max(1, rows),
      pxPerWorld: this.layoutParams.pxPerWorld,
      distance,
      maxPointSize: this.layoutParams.maxPointSize,
    });
  }

  /**
   * そのフレームで描くバッファ。
   *
   * **境界は `d ≤ 1`（端点を含む）。** SPEC §2 は `dimLevel = 1` を
   * 「LINE `[1,0,0,0,0]` 列平均の一本の線」と定めているので、その点そのものを
   * 列平均バッファが担当しなければ、看板の状態を格子の潰れ（＝ セル平均の平均）が
   * 出すことになる。§4.7 は「縮約は正準バッファから」と決めている。
   */
  private bufferKind(): BufferKind {
    return this.dimLevel <= LINE_MAX_DIM ? 'columnMeans' : 'grid';
  }

  /** 毎フレーム。回転→行列→投影→潰し補正→フレーミング→commit */
  update(dt: number): void {
    const d = this.dimLevel;
    const dimChanged = d !== this.lastDimLevel;
    this.lastDimLevel = d;
    if (!this.frozen) advancePhases(this.phases, d, dt);

    // 角度は毎フレーム絶対値で作る（誤差を蓄積させない。rotation.ts の契約）
    const gate = cloudWeight(d);
    for (let k = 0; k < this.angles.length; k++) {
      this.angles[k].angle = gate === 0 ? 0 : gate * this.phases[k];
    }

    // **退化した軸は存在しない**（SPEC §2.2）。`extent` を 0 に固定する。
    //
    // 絵は変わらない ── `computeScales` が退化時にスケールを厳密 1 へ*置く*ので
    // `a', b'` は 1e-16 のままで、`extent` が 0 でも 1 でも寄与が同じである。
    // 実測（Phase 1c・完全グレースケール 1024×640）: `d = 3 → 4 → 5` で
    // 中央 128×128 の **65,536 画素中 0 個**が相違。つまりこれは「黙って壊れる」欠落ではなく
    // **「黙って何も起きない」欠落**で、NaN より発見が遅い。
    // だからここでコードに書き、`copy.ts` の `DEGENERATE_COPY` が言葉で表明する。
    for (let k = 0; k < N; k++) {
      this.extent[k] = this.axisPresent[k] ? clamp01(d - k) : 0;
    }

    composeRotN(this.angles, N, this.matrix);
    foldExtent(this.matrix, N, this.extent);

    const kind = this.bufferKind();
    const grid = kind === 'grid';
    const batch = grid ? this.points : this.line;
    const other = grid ? this.line : this.points;
    // 潰れた軸は **CPU 側で先に畳む**（Phase 2）。`extentX = 1` では `lineCount` に
    // 厳密に戻るので `dimLevel = 1` の絵は 1 ビットも動かない（`effectiveLineCount`）。
    if (!grid) this.rebuildLine(effectiveLineCount(this.extent[0], this.lineCount));
    const base = grid ? this.source.base : this.lineBase;
    const count = grid ? this.source.grid.cols * this.source.grid.rows : this.linePoints;

    liftProject5(base, count, this.matrix, this.cascadeDist, batch.positions);
    batch.commit(count);
    other.commit(0);

    // ---- 合成則（1a-iii のまま）----
    const pw = this.pathOverride === 'plate' ? 1 : this.pathOverride === 'cloud' ? 0 : plateWeight(d);
    const cw = this.pathOverride === 'cloud' ? 1 : this.pathOverride === 'plate' ? 0 : gate;
    this.plate.setOpacity(pw);
    batch.setWeight(cw);
    other.setWeight(0);

    // ---- フレーミング（`refreshConfigs` を通すので潰しの補正より**先**）----
    // s0 は距離で決まり、`collapseWeight` は s0 で決まる。逆順に書くと
    // 補正が 1 フレーム古い s0 に乗り、リサイズ直後だけ明るさがずれる。
    this.updateCamera(dimChanged, batch.positions, count, cw > 0, pw > 0);

    // ---- 潰しの補正 ----
    const cfg = grid ? this.gridConfig : this.lineConfig;
    /**
     * **`extentX` そのものではなく「間隔の比」を渡す。**
     *
     * `collapseWeight` は現在の間隔を `extentX · s0x` として作るが、点を
     * `linePoints` 本へ畳んだあとの実際の間隔は `extentX · s0x · lineCount / linePoints`
     * である（畳んだぶん 1 点あたりの受け持ちが広がる）。`ref` の側は較正された
     * 基準格子の間隔 `s0x` のままでなければならないので、**分子だけを直す**。
     *
     * `extentX = 1` では `linePoints = lineCount` なので比は厳密に 1 で、
     * 1b の値が 1 ビットも動かない。`extentX = 0` では `linePoints = 1` なので
     * `axisCoverage(0, 1, S) = 1` ── 1 個のスプライトの中心そのものになる。
     */
    const spacingX = grid
      ? this.extent[0]
      : (this.extent[0] * this.lineCount) / Math.max(1, this.linePoints);
    const collapse = {
      s0x: cfg.s0,
      s0y: cfg.s0y,
      extentX: spacingX,
      extentY: grid ? this.extent[1] : 0,
      nx: grid ? this.source.grid.cols : this.linePoints,
      ny: grid ? this.source.grid.rows : 1,
      spritePx: cfg.spritePx,
    };
    const sampleWeight = collapseWeight(collapse);
    this.lastSampleWeight = sampleWeight;
    this.lastDepth = additionDepth(collapse);
    batch.setSampleWeight(sampleWeight);
    other.setSampleWeight(1);
  }

  /**
   * フレーミング。**投影後の実座標を走査する**（`imageHalfExtents` は
   * `dimLevel = 2` でしか図の広がりと一致しない）。
   *
   * 板と点群の**両方**を見る ── 点はセル中心にあるので広がりが
   * `(1 − 1/cols)·aX` にしかならず、点だけから決めるとアンカーの充填が
   * 0.86 → 0.8623 にずれる（実測）。
   */
  private updateCamera(
    dimChanged = true,
    positions?: Float32Array,
    count = 0,
    cloudVisible = false,
    plateVisible = true,
  ): void {
    const camera = this.camera;
    const { aX, aY } = imageHalfExtents(this.source.width, this.source.height);
    const input = { aX, aY, ...this.layoutParams, fovDeg: CAMERA_FOV };

    let cloud: Spread | null = null;
    if (cloudVisible && positions && count > 0) {
      let mx = 0;
      let my = 0;
      let zh = Number.NEGATIVE_INFINITY;
      for (let v = 0; v < count; v++) {
        const o = v * 3;
        const x = positions[o];
        const y = positions[o + 1];
        const z = positions[o + 2];
        const ax = x < 0 ? -x : x;
        const ay = y < 0 ? -y : y;
        if (ax > mx) mx = ax;
        if (ay > my) my = ay;
        if (z > zh) zh = z;
      }
      cloud = { aX: mx, aY: my, zHi: zh > 0 ? zh : 0 };
    }
    const spread = unionSpread(plateVisible ? plateSpread(aX, aY) : null, cloud);
    this.lastSpread = spread;

    /**
     * **アンカーの距離が下限である。**
     *
     * これが無いと `dimLevel = 0` で図が 1 点に潰れた瞬間 `spread` がゼロになり、
     * `needDistance` が **0** を返す ── カメラが原点に来て、点群の中に入る。
     * 監査が指摘したとおりで、`F_CLAMP` も GL エラーも何も言わない壊れ方をする。
     *
     * 下限を置くと、潰れていく図は**カメラが寄るのではなく小さくなる** ──
     * 「潰れる」という作品の主張と、こちらのほうが合っている。
     * `dimLevel = 2` では `needDistance` がちょうどこの値なので、`max` は恒等である。
     */
    const need = Math.max(this.anchorDistance(), needDistance(input, spread));
    this.lastNeed = need;
    this.heldDistance = framingHold(this.heldDistance, need, dimChanged);
    this.cameraDistance = this.heldDistance;

    if (camera) {
      camera.position.set(0, 0, this.cameraDistance);
      camera.lookAt(0, 0, 0);
    }
    // スプライトの較正は現在の距離で引き直す。**アンカーでは距離が
    // `anchorDistance()` と厳密に一致するので `gain` は 1 ビットも動かない。**
    this.refreshConfigs(this.cameraDistance);
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
    const grid = this.bufferKind() === 'grid';
    const cfg = grid ? this.gridConfig : this.lineConfig;
    const { aX, aY } = imageHalfExtents(this.source.width, this.source.height);
    const input = { aX, aY, ...this.layoutParams, fovDeg: CAMERA_FOV };
    return {
      dimLevel: d,
      anchored: isAnchored(d),
      plateWeight: plateWeight(d),
      cloudWeight: cloudWeight(d),
      buffer: grid ? 'grid' : 'columnMeans',
      gridW: this.source.grid.cols,
      gridH: this.source.grid.rows,
      pointCount: grid ? this.source.grid.cols * this.source.grid.rows : this.linePoints,
      lineCount: this.lineCount,
      // 実際に描いている線の点数（Phase 2）。`lineCount` は上限、こちらが実数
      linePoints: this.linePoints,
      s0: cfg.s0,
      spritePx: cfg.spritePx,
      gain: cfg.gain,
      calibrated: cfg.calibrated,
      sampleWeight: this.lastSampleWeight,
      additionDepth: this.lastDepth,
      // SPEC §2.2 の「その軸は存在しないと表明する」の、観測できる形（Phase 1c）
      axisPresent: [...this.axisPresent],
      extent: [...this.extent],
      cameraDistance: this.cameraDistance,
      needDistance: this.lastNeed,
      spread: this.lastSpread,
      fill: ndcExtents(input, this.lastSpread, this.cameraDistance),
      cascadeDist: this.cascadeDist,
      frozen: this.frozen,
      pathOverride: this.pathOverride,
    };
  }

  dispose(): void {
    this.plate.dispose();
    this.points.dispose();
    this.line.dispose();
    this.probe?.dispose();
    this.probe = null;
  }
}
