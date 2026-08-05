/**
 * フレーミング（Phase 1b）。
 *
 * ## `fillRatios` を採点者にしてはいけない
 *
 * 既存の `fit.test.ts` / `engineConfig.test.ts` は `fillRatios(i, fitDistance(i))` を見ている。
 * これは**恒等な変換**で、`d = max(a)/(fill·t)` を `a/(d·t)` に代入すると
 * `t` も `fill` も約分される。監査が実際に壊して確認したところ:
 *
 * | 壊し方 | 既存 222 件 |
 * |---|---|
 * | `fitDistance` を 1.05 倍 | ❌ 36 件失敗 |
 * | **半角変換 `/360` を `/180` へ（両関数とも）** | ✅ **緑（穴）** |
 * | **`DEFAULT_FILL` 0.86 → 0.95** | ✅ **緑（穴）** |
 *
 * → ここでは **three の `PerspectiveCamera` が作る投影行列**を採点者にする。
 * 画角の半角変換は three の側にあるので、`fit.ts` が `/180` に化けたら NDC がずれる。
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  DEFAULT_FILL,
  fitDistance,
  framingHold,
  needDistance,
  ndcExtents,
  plateSpread,
  unionSpread,
} from '../core/fit';
import { CAMERA_FOV } from '../core/engine';
import { imageHalfExtents, fitGrid } from '../image/grid';
import { makeSpecimen0, SPECIMEN_H, SPECIMEN_W } from '../image/fixture';
import { linearizeRgba } from '../image/linearize';
import { computeScales, computeStats } from '../image/stats';
import { lift } from '../image/lift';
import { composeRotN, foldExtent, liftProject5, safeDist } from '../math/rotationN';
import {
  advancePhases,
  createAngleBuffer,
  createPhases,
  rotationGate,
} from '../render/rotationSchedule';
import { clamp01 } from '../math/ease';

/**
 * 独立した採点者。**`fit.ts` の `tan` を一切使わない** ──
 * three が組み立てた投影行列で点を NDC へ落とす。
 */
function ndcOf(
  point: THREE.Vector3,
  distance: number,
  viewportAspect: number,
): { x: number; y: number } {
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, viewportAspect, 0.01, 200);
  camera.position.set(0, 0, distance);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const v = point.clone().project(camera);
  return { x: v.x, y: v.y };
}

describe('needDistance', () => {
  /**
   * **アンカーの構図が 1 ビットも動かないことが、この 1 本の主張である。**
   * `Object.is` で見る ── 「ほぼ同じ」を許すと 0.3% の変化が全部通る。
   */
  it('zHi = 0 では fitDistance と厳密に一致する', () => {
    for (const [w, h] of [[1024, 640], [640, 1024], [512, 512], [4000, 1000]]) {
      const { aX, aY } = imageHalfExtents(w, h);
      for (const viewportAspect of [16 / 9, 1.2699, 1, 9 / 16]) {
        for (const bandFrac of [1, 0.7, 0.45]) {
          const input = { aX, aY, viewportAspect, bandFrac, fovDeg: CAMERA_FOV };
          const a = fitDistance(input);
          const b = needDistance(input, plateSpread(aX, aY));
          expect(Object.is(a, b), `${w}×${h} / ${viewportAspect} / ${bandFrac}`).toBe(true);
        }
      }
    }
  });

  it('zHi が正なら、その分だけ後ろへ下がる', () => {
    const { aX, aY } = imageHalfExtents(1024, 640);
    const input = { aX, aY, viewportAspect: 1.2699, bandFrac: 1, fovDeg: CAMERA_FOV };
    const base = needDistance(input, { aX, aY, zHi: 0 });
    expect(needDistance(input, { aX, aY, zHi: 0.5 })).toBeCloseTo(base + 0.5, 12);
  });

  /**
   * ## 画角の採点者を three にする（既存の穴を塞ぐ）
   *
   * `fillRatios` は `fitDistance` の逆関数なので `t` が約分される。
   * three の投影行列は独立なので、半角変換が化けたらここで落ちる。
   */
  it('その距離で図の角が帯にちょうど接する（three の投影行列で採点）', () => {
    for (const [w, h] of [[1024, 640], [640, 1024], [512, 512]]) {
      const { aX, aY } = imageHalfExtents(w, h);
      for (const viewportAspect of [16 / 9, 1.2699, 0.6]) {
        const input = { aX, aY, viewportAspect, bandFrac: 1, fovDeg: CAMERA_FOV };
        const d = fitDistance(input);
        const n = ndcOf(new THREE.Vector3(aX, aY, 0), d, viewportAspect);
        // NDC は [-1, 1]。fill = 0.86 なら長い辺がちょうど 0.86 に届く
        const reach = Math.max(Math.abs(n.x), Math.abs(n.y));
        expect(reach, `${w}×${h} / ${viewportAspect}`).toBeCloseTo(DEFAULT_FILL, 9);
      }
    }
  });

  /**
   * `DEFAULT_FILL` は**実機で測った値**である（1a-iii の G1 が
   * `fillRatios.x = 0.86` を PR に貼っている）。距離と充填は互いに約分されるので、
   * 定数そのものを固定しないと 0.95 へ動かしても全テストが緑になる（監査が確認）。
   */
  it('DEFAULT_FILL が 1a-iii の実測値のまま', () => {
    expect(DEFAULT_FILL).toBe(0.86);
  });
});

describe('unionSpread', () => {
  it('板と点群の両方を見る（点だけだとアンカーの充填がずれる）', () => {
    // 点はセル中心にあるので広がりは (1 − 1/cols)·aX にしかならない
    const cols = 378;
    const plate = plateSpread(1, 0.625);
    const cloud = { aX: (1 - 1 / cols) * 1, aY: (1 - 1 / 236) * 0.625, zHi: 0 };
    const u = unionSpread(plate, cloud);
    expect(u.aX).toBe(1);
    expect(u.aY).toBe(0.625);

    // 点だけから決めると、アンカーの充填が 0.86 からずれる
    const input = { aX: 1, aY: 0.625, viewportAspect: 1.2699, bandFrac: 1, fovDeg: CAMERA_FOV };
    const dPlate = needDistance(input, plate);
    const dCloud = needDistance(input, cloud);
    const drift = ndcExtents(input, plate, dCloud);
    expect(dCloud).toBeLessThan(dPlate);
    expect(Math.max(drift.x, drift.y)).toBeGreaterThan(DEFAULT_FILL);
    expect(Math.max(drift.x, drift.y)).toBeCloseTo(0.8623, 3);
  });

  it('null は無視する', () => {
    const s = plateSpread(1, 0.5);
    expect(unionSpread(s, null)).toEqual(s);
    expect(unionSpread(null, s)).toEqual(s);
  });
});

describe('framingHold', () => {
  it('単調非減少 ── 縮む向きには動かない（呼吸が厳密にゼロ）', () => {
    let held = framingHold(0, 3, true);
    expect(held).toBe(3);
    held = framingHold(held, 2, false);
    expect(held).toBe(3);
    held = framingHold(held, 4.5, false);
    expect(held).toBe(4.5);
    held = framingHold(held, 1, false);
    expect(held).toBe(4.5);
  });

  it('dimLevel が動いたら、その位相での厳密な必要距離へ戻る', () => {
    const held = framingHold(4.9, 1.96, true);
    expect(held).toBe(1.96);
  });

  it('初期状態と非有限は need をそのまま採る', () => {
    expect(framingHold(0, 2.5, false)).toBe(2.5);
    expect(framingHold(Number.NaN, 2.5, false)).toBe(2.5);
  });
});

/**
 * ## 図が本当に帯へ収まるか —— 実際に投影して測る（node で落とせる）
 *
 * SPEC §7.2 の「node で本当に落とせるのは純関数だけ」という境界の内側に、
 * 1b で一番危ない部分がまるごと入る ── フレーミングは純粋に幾何だからである。
 *
 * `imageHalfExtents` に据え置いた場合との対比も同時に測る（そちらは実際に破綻する）。
 */
describe('投影後の図が帯に収まる（標本 No.0・全 dimLevel・位相を掃く）', () => {
  const spec = makeSpecimen0();
  const canonical = linearizeRgba(spec.rgba, spec.width, spec.height);
  const stats = computeStats(canonical);
  const scales = computeScales(stats);
  const grid = fitGrid(SPECIMEN_W, SPECIMEN_H, 20000); // 測定用の軽い格子
  const count = grid.cols * grid.rows;
  const base = new Float32Array(count * 5);
  const colors = new Float32Array(count * 3);
  const { maxNorm } = lift(canonical, grid, scales, { base, colors });
  const cascadeDist = safeDist(maxNorm);
  const { aX, aY } = imageHalfExtents(SPECIMEN_W, SPECIMEN_H);

  /** その dimLevel・その位相での投影後の広がり */
  function spreadAt(d: number, phases: Float64Array): { aX: number; aY: number; zHi: number } {
    const angles = createAngleBuffer();
    const gate = rotationGate(d);
    for (let k = 0; k < angles.length; k++) angles[k].angle = gate === 0 ? 0 : gate * phases[k];
    const m = new Float64Array(25);
    const ext = new Float64Array(5);
    for (let k = 0; k < 5; k++) ext[k] = clamp01(d - k);
    composeRotN(angles, 5, m);
    foldExtent(m, 5, ext);
    const out = new Float32Array(count * 3);
    liftProject5(base, count, m, cascadeDist, out);
    let mx = 0;
    let my = 0;
    let zh = Number.NEGATIVE_INFINITY;
    for (let v = 0; v < count; v++) {
      const x = Math.abs(out[v * 3]);
      const y = Math.abs(out[v * 3 + 1]);
      const z = out[v * 3 + 2];
      if (x > mx) mx = x;
      if (y > my) my = y;
      if (z > zh) zh = z;
    }
    return { aX: mx, aY: my, zHi: zh > 0 ? zh : 0 };
  }

  const VIEWPORTS: Array<[number, number, string]> = [
    [1.2699, 1, '1a-iii の実測 viewport'],
    [1.6, 1, '画像より横長'],
    [2.2, 1, '極端に横長'],
    [0.6, 0.7, '縦長 × 帯 0.7'],
  ];

  for (const [viewportAspect, bandFrac, name] of VIEWPORTS) {
    it(`${name}: どの dimLevel・どの位相でも帯を割らない`, () => {
      const input = { aX, aY, viewportAspect, bandFrac, fovDeg: CAMERA_FOV };
      const anchor = needDistance(input, plateSpread(aX, aY));
      let worstFill = 0;
      let worstAt = '';
      for (let d = 0; d <= 5.0001; d += 0.25) {
        const phases = createPhases();
        // dimLevel を動かした直後の位相から、40 秒ぶんを掃く
        let held = 0;
        for (let step = 0; step < 20; step++) {
          for (let i = 0; i < 120; i++) advancePhases(phases, d, 1 / 60);
          const cloud = spreadAt(d, phases);
          const spread = unionSpread(
            1 - rotationGate(d) > 0 ? plateSpread(aX, aY) : null,
            rotationGate(d) > 0 ? cloud : null,
          );
          const need = Math.max(anchor, needDistance(input, spread));
          held = framingHold(held, need, step === 0);
          const f = ndcExtents(input, spread, held);
          const worst = Math.max(f.x, f.y);
          if (worst > worstFill) {
            worstFill = worst;
            worstAt = `d=${d.toFixed(2)} step=${step}`;
          }
          // カメラの手前に点が来ない（`gl_PointSize` の分母が潰れない）
          expect(held - spread.zHi, `${name} ${worstAt} で近平面`).toBeGreaterThan(0.25);
        }
      }
      // 帯を割らない。ホールドは単調非減少なので、掃いた範囲では 1 度も超えない
      expect(worstFill, `最悪 ${worstAt} で ${worstFill.toFixed(4)}`).toBeLessThanOrEqual(1);
    });
  }

  /**
   * ## 据え置き（1a-iii の実装）が実際に破綻することの確認 —— **歯の証明**
   *
   * `imageHalfExtents` のままだと `dimLevel > 2` で帯を大きく割る。
   * これが落ちるようになったら、この測定のほうが壊れている。
   */
  it('`imageHalfExtents` に据え置くと帯を割る（1a-iii が C としていた項目）', () => {
    const viewportAspect = 1.2699;
    const input = { aX, aY, viewportAspect, bandFrac: 1, fovDeg: CAMERA_FOV };
    const fixed = fitDistance(input);
    const phases = createPhases();
    for (let i = 0; i < 7200; i++) advancePhases(phases, 3, 1 / 60);
    const cloud = spreadAt(3, phases);
    const f = ndcExtents(input, cloud, fixed);
    expect(Math.max(f.x, f.y)).toBeGreaterThan(1.5);
    // しかも点がカメラを越えうる（横長 viewport では距離が縮む）
    const wide = { ...input, viewportAspect: 1.6 };
    expect(fitDistance(wide) - cloud.zHi).toBeLessThan(0.25);
  });

  /**
   * ## アンカー窓の中で距離が動かない理由は 2 段ある
   *
   * 1. `rotationGate` が厳密に 0 なので**点群の重みが 0** ── 描かれないものは
   *    フレーミングに入らない（`updateCamera` は `cloudVisible` を見る）
   * 2. `d ≤ 2` では `extent[2] = clamp01(d − 2) = 0` なので図はそもそも平面
   *
   * **2 は窓の上半分では成り立たない。** `d = 2.05` では `extent[2] = 0.05` で
   * 図に厚みが出る（実測 `zHi = 0.0500`）。窓の中で構図が動かないのは
   * 1 のほうが効いているからであって、「窓の中は平面だから」ではない ──
   * ここを取り違えると、点群の重みの規則を変えたときに静かに壊れる。
   */
  it('アンカー窓では距離が 1a-iii の値と厳密に一致する（点群の重みが 0 だから）', () => {
    const input = { aX, aY, viewportAspect: 1.2699, bandFrac: 1, fovDeg: CAMERA_FOV };
    for (const d of [1.9, 1.95, 2.0, 2.05, 2.1]) {
      const phases = createPhases();
      for (let i = 0; i < 600; i++) advancePhases(phases, d, 1 / 60);
      // 窓の中では点群の重みが厳密に 0 なので、フレーミングは板だけで決まる
      expect(Object.is(rotationGate(d), 0), `d=${d}`).toBe(true);
      const need = Math.max(
        needDistance(input, plateSpread(aX, aY)),
        needDistance(input, unionSpread(plateSpread(aX, aY), null)),
      );
      expect(Object.is(need, fitDistance(input)), `d=${d}`).toBe(true);
    }
  });

  it('図が平面なのは d ≤ 2 まで。窓の上半分では既に厚みがある（実測）', () => {
    const phases = createPhases();
    expect(spreadAt(2.0, phases).zHi).toBe(0);
    expect(spreadAt(1.9, phases).zHi).toBe(0);
    // extent[2] = 0.05 が L' に掛かる。**窓の中でも平面ではない**
    expect(spreadAt(2.05, phases).zHi).toBeCloseTo(0.05, 2);
  });
});
