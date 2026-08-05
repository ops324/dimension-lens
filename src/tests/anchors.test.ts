/**
 * **アンカーが動いていないことを、ブラウザを起動せずに見る**（Phase 1c で足した）。
 *
 * §7.6 / §7.7 は「G0〜G7 は毎フェーズ再実行して 1a-iii の値と一致することを見る ──
 * アンカーが動いていたら、以降のどの数値にも意味がない」と要求している。
 * **その手順はリポジトリのどこにも自動化されていなかった**（`grep -rn "G0"` はコメントのみ、
 * `package.json` の scripts は dev/build/preview/test/bench だけ）── 毎フェーズ、
 * 手でブラウザを叩いていた。
 *
 * ## アンカーは GPU に依らない
 *
 * §7.7 の表のアンカー行（`s0` / `gain` / カメラ距離 / カスケード `dist` /
 * `fillRatios.x` / `maxNorm` / 格子 / `meanHex`）は、
 * **(drawingBuffer の寸法, viewport アスペクト, bandFrac) と決定的な標本**の 2 つだけで
 * 完全に決まる。three も rAF も GL も関与しない。だから node で厳密に再現できる。
 *
 * ## 採点者を `fit.ts` 自身にしない
 *
 * §7.7 は `fillRatios(i, fitDistance(i))` が **`fitDistance` の逆関数**なので
 * `fill` に恒等に潰れ、画角の半角変換も `DEFAULT_FILL` も検査できなかったことを
 * 記録している（1a-iii の 222 件が緑だった穴）。
 * ここでも同じ罠があるので、**距離の検算は three の `PerspectiveCamera` が作る
 * 投影行列で行う**（`framing.test.ts` と同じ方針）。
 *
 * ## ここが緑でも、実機を測らなくてよいことにはならない
 *
 * これが押さえるのは「CPU 側の量が動いていないこと」までである。
 * G0（背景が厳密 0）・G2b（実効ゲイン）・G5（板の補間がリニア光）は
 * **読み戻しに依存する**ので、node では原理的に測れない。
 * ブラウザ側は「node の予測値と実機の `sceneStats()` が一致するか」の 1 本だけを回す
 * ── そのために `__LENS__.setViewport()` を 1c で足した。
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CAMERA_FOV } from '../core/engine';
import { DEFAULT_FILL, fillRatios, needDistance, plateSpread } from '../core/fit';
import { fitGrid, imageHalfExtents, TIER_BUDGET } from '../image/grid';
import { makeSpecimen0, SPECIMEN_H, SPECIMEN_W } from '../image/fixture';
import { linearizeRgba } from '../image/linearize';
import { computeScales, computeStats } from '../image/stats';
import { makeLiftPayload } from '../ingest/session';
import { gainFor, isCalibratedS0, K_SPRITE } from '../image/spriteGain';

/**
 * §7.6 / §7.7 の実測に使った viewport。**この値でしかアンカーは再現しない。**
 *
 * 実測（Phase 1c）: ブラウザペインの既定（CSS 889×859 / drawingBuffer 1778×1718）では
 * `s0 = 4.045` / カメラ距離 `2.409` になり、§7.7 の 2.2478 / 1.9636 と**一致しない**。
 * §7.6 の見出しは「DPR 2 / drawingBuffer 988×778」と書いているが、
 * **その寸法にどうやって合わせるか**はどこにも書かれていなかった。
 */
const MEASURE = {
  cssWidth: 494,
  cssHeight: 389,
  dpr: 2,
  /** 遮蔽帯なし（`setSafeArea` を呼んでいない状態） */
  bandFrac: 1,
} as const;

const BUFFER_W = MEASURE.cssWidth * MEASURE.dpr; // 988
const BUFFER_H = MEASURE.cssHeight * MEASURE.dpr; // 778
const VIEWPORT_ASPECT = MEASURE.cssWidth / MEASURE.cssHeight;

/** `engine.pxPerWorld()` と同じ式。**drawingBuffer の高さで割り出す**（CSS px ではない） */
const PX_PER_WORLD = BUFFER_H / (2 * Math.tan((CAMERA_FOV * Math.PI) / 360));

function anchorState() {
  const s = makeSpecimen0();
  const canonical = linearizeRgba(s.rgba, s.width, s.height);
  const stats = computeStats(canonical);
  const scales = computeScales(stats);
  const grid = fitGrid(canonical.width, canonical.height, TIER_BUDGET.HIGH);
  const lifted = makeLiftPayload(canonical, grid, scales);

  const { aX, aY } = imageHalfExtents(s.width, s.height);
  const fitInput = {
    aX,
    aY,
    viewportAspect: VIEWPORT_ASPECT,
    bandFrac: MEASURE.bandFrac,
    fovDeg: CAMERA_FOV,
  };
  // アンカー窓では板だけが見えている（点群の重みが厳密 0）ので、
  // 距離は `plateSpread` から出る。`lensScene.anchorDistance()` と同じ経路。
  const cameraDistance = needDistance(fitInput, plateSpread(aX, aY));
  const cellWorld = (2 * aX) / grid.cols;
  const s0 = (cellWorld * PX_PER_WORLD) / cameraDistance;

  return {
    grid,
    stats,
    lifted,
    cameraDistance,
    s0,
    gain: gainFor(s0),
    spritePx: K_SPRITE * s0,
    fill: fillRatios(fitInput, cameraDistance),
  };
}

describe('アンカー（§7.7 の再実行を node で）', () => {
  const a = anchorState();

  /**
   * §7.7 の表の値と**厳密に**一致すること。`toBeCloseTo` にしない ──
   * これは物理量ではなく決定的な計算の出力なので、1 ulp でも動いたら
   * 何かが変わっている（そしてそれを知りたい）。
   */
  it('s0 と gain が 1b の値と厳密に一致する', () => {
    expect(a.s0).toBe(2.247830687830687);
    expect(a.gain).toBe(0.4530724335144705);
    expect(a.spritePx).toBe(8.654148148148145);
    // `MIN_CALIBRATED_S0 = 0.86` の 2.6 倍上。クランプはアンカーに触れない（§4.18）
    expect(isCalibratedS0(a.s0)).toBe(true);
    expect(a.s0 / 0.86).toBeGreaterThan(2.6);
  });

  it('カメラ距離とカスケード dist が 1b の値と厳密に一致する', () => {
    expect(a.cameraDistance).toBe(1.9635938049105979);
    expect(a.lifted.safeDist).toBe(3.38382867097012);
  });

  it('格子・maxNorm・平均色が 1b の値と一致する', () => {
    expect(a.grid).toEqual({ cols: 378, rows: 236 });
    expect(a.grid.cols * a.grid.rows).toBe(89_208);
    expect(a.lifted.maxNorm).toBe(1.5381039413500546);
    expect(a.stats.meanHex).toBe('#8d8d8e');
  });

  it('充填が 0.86 で、一辺に接している', () => {
    expect(Math.max(a.fill.x, a.fill.y)).toBeCloseTo(DEFAULT_FILL, 12);
    expect(a.fill.x).toBeCloseTo(0.86, 12);
  });

  /**
   * §7.7 の測定条件そのものを固定する。**寸法が違えばアンカーは再現しない**ので、
   * ブラウザ側の手順（`__LENS__.setViewport(494, 389)`）と、この定数がずれないようにする。
   */
  it('測定 viewport の定義が drawingBuffer 988×778 を与える', () => {
    expect(BUFFER_W).toBe(988);
    expect(BUFFER_H).toBe(778);
    expect(a.grid.cols / a.grid.rows).toBeCloseTo(SPECIMEN_W / SPECIMEN_H, 1);
  });

  /**
   * **独立した採点者。** `fit.ts` の `tan` を一切使わず、three が組み立てた
   * 投影行列で板の縁を NDC へ落とす。§7.7 が記録した「`fillRatios` は
   * `fitDistance` の逆関数なので恒等に潰れる」穴を、ここでは開けない。
   *
   * 歯の確認: `DEFAULT_FILL` を 0.95 にすると落ちる／`fitDistance` の
   * 半角変換を `/180` にすると落ちる（Phase 1c で実際に壊して確認した）。
   */
  it('three の投影行列で見ても、板の縁が帯の 0.86 に乗る', () => {
    const { aX, aY } = imageHalfExtents(SPECIMEN_W, SPECIMEN_H);
    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, VIEWPORT_ASPECT, 0.01, 200);
    camera.position.set(0, 0, a.cameraDistance);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    const ndcX = Math.abs(new THREE.Vector3(aX, 0, 0).project(camera).x);
    const ndcY = Math.abs(new THREE.Vector3(0, aY, 0).project(camera).y);
    // NDC は [-1,1] なので、充填率はそのまま |ndc|
    expect(Math.max(ndcX, ndcY)).toBeCloseTo(DEFAULT_FILL, 6);
    // 標本 No.0 はアスペクト 1.6 で、横が先に接する
    expect(ndcX).toBeGreaterThan(ndcY);
    expect(ndcX).toBeCloseTo(0.86, 6);
  });
});
