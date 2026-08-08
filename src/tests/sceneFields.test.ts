/**
 * Phase 2b が `LensScene` へ足した 2 本の配線を、**node で**押さえる。
 *
 *   - `setReducedMotion` が**回転そのもの**を止める（＝ 投影後の座標が動かない）
 *   - `setColorField` が**色だけ**を差し替える（＝ 位置は 1 ビットも動かない）
 *
 * ## なぜ純関数の検査だけでは足りないのか（Phase 1c の教訓の再演）
 *
 * `robustness.test.ts` が記録しているとおり、`axisPresence` を純関数として検査しても
 * **`lensScene` がそれを呼んでいることは検査していなかった** ── 呼び出しを
 * 全 true のリテラルへ置き換えても 320 件が緑だった。
 *
 * Phase 2b の `prefers-reduced-motion` はまさにその形で偽だった:
 * 判定は在り、`postfx.setTime` に 1 行在り、**しかし絵は 1 画素も変わらなかった**。
 * だから判定（`motion.test.ts`）とは別に、**シーンまで届いていること**をここで見る。
 *
 * `LensScene` は three のオブジェクトを組むが **WebGL コンテキストは要らない**ので、
 * node で構築して `update()` を回し、`points.positions` / `points.colors` を直接読める。
 */

import { describe, expect, it } from 'vitest';
import { makeLiftPayload } from '../ingest/session';
import { linearizeRgba } from '../image/linearize';
import { computeScales, computeStats, type Canonical } from '../image/stats';
import { fitGrid } from '../image/grid';
import { makeSpecimen0 } from '../image/fixture';
import { LensScene } from '../scene/lensScene';

function specimenCanonical(): Canonical {
  const s = makeSpecimen0();
  return linearizeRgba(s.rgba, s.width, s.height, 'srgb');
}

function build(): LensScene {
  const canonical = specimenCanonical();
  const stats = computeStats(canonical);
  const scales = computeScales(stats);
  const grid = fitGrid(canonical.width, canonical.height, 40_000);
  const lifted = makeLiftPayload(canonical, grid, scales);
  return new LensScene({
    grid,
    base: lifted.base,
    colors: lifted.colors,
    columnMeans: stats.columnMeans,
    scales,
    width: canonical.width,
    height: canonical.height,
    gamut: canonical.gamut,
    maxNorm: lifted.maxNorm,
    plate: null,
  });
}

/** 描画点数ぶんの位置を控える（`update` が書き込む先そのもの） */
function snapshot(scene: LensScene): Float32Array {
  return Float32Array.from(scene.points.positions.subarray(0, scene.stats().pointCount * 3));
}

function identical(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

describe('光過敏の配慮がシーンまで届く', () => {
  /**
   * **これが Phase 2a まで存在しなかった主張である。**
   * `d = 3` は門が開いているので、配慮が無ければ位相は毎フレーム進む。
   */
  it('配慮を入れると、門が開いていても投影座標が 1 ビットも動かない', () => {
    const scene = build();
    scene.setDimLevel(3);
    scene.setReducedMotion(true);
    scene.update(1 / 60);
    const a = snapshot(scene);
    for (let i = 0; i < 120; i++) scene.update(1 / 60);
    expect(identical(a, snapshot(scene))).toBe(true);
    expect(scene.isReducedMotion()).toBe(true);
    expect(scene.stats().reducedMotion).toBe(true);
  });

  /**
   * **こちら側が本体。** 「オンで止まる」だけを見ると、
   * 何もしていない実装（＝ 2a までの状態）でも緑になる。
   */
  it('配慮を切ると動く（何もしていない実装と区別する）', () => {
    const scene = build();
    scene.setDimLevel(3);
    scene.setReducedMotion(false);
    scene.update(1 / 60);
    const a = snapshot(scene);
    for (let i = 0; i < 120; i++) scene.update(1 / 60);
    expect(identical(a, snapshot(scene))).toBe(false);
  });

  /**
   * `freezeRotation` は測定器の口で、測定の前後で必ず戻される。
   * 配慮と同じフラグを共用していたら、**測定が終わった瞬間に配慮が解除される**。
   */
  it('配慮と測定用の凍結が別の状態である', () => {
    const scene = build();
    scene.setDimLevel(3);
    scene.setReducedMotion(true);
    scene.freezeRotation(true);
    scene.freezeRotation(false); // 測定器が凍結だけを戻す
    scene.update(1 / 60);
    const a = snapshot(scene);
    for (let i = 0; i < 120; i++) scene.update(1 / 60);
    expect(identical(a, snapshot(scene))).toBe(true);
    expect(scene.stats().frozen).toBe(false);
    expect(scene.stats().reducedMotion).toBe(true);
  });

  /** アンカー窓では門が閉じているので、配慮の有無に関わらず動かない（対照） */
  it('アンカー窓では配慮の有無に関わらず動かない', () => {
    for (const reduced of [true, false]) {
      const scene = build();
      scene.setDimLevel(2);
      scene.setReducedMotion(reduced);
      scene.update(1 / 60);
      const a = snapshot(scene);
      for (let i = 0; i < 120; i++) scene.update(1 / 60);
      expect(identical(a, snapshot(scene)), `reduced=${reduced}`).toBe(true);
    }
  });
});

describe('色場の差し替え（G12 の前提）', () => {
  /**
   * **G12 が model-free でいられる根拠がこれである。**
   * 幾何が動いていたら、重ね合わせのずれが「色の効果」なのか「別の絵を測った」のか
   * 区別できない。
   *
   * **`update()` の前と後の両方で見る**（Phase 2b・`npm run teeth` が抜けた歯として教えた）。
   *
   * 最初は `setColorField` のあと `update()` を回してから比べていた。ところが
   * `update()` は `liftProject5` で位置バッファを毎フレーム書き直すので、
   * **`setColorField` が位置を壊しても次の `update()` が消してしまう** ──
   * 実測で `positions[0] += 1e-3` を注入しても 391 件が緑だった。
   * 「幾何を触っていない」を主張したいなら、**触った直後**を見なければならない。
   */
  it('色場を変えても投影座標が 1 ビットも動かない（update の前と後の両方）', () => {
    const scene = build();
    scene.setDimLevel(3);
    scene.freezeRotation(true);
    scene.update(1 / 60);
    const geom = snapshot(scene);
    for (const mode of ['mean', 'image+mean', 'image'] as const) {
      scene.setColorField(mode);
      // ① 差し替えた直後（`update` が上書きする前）
      expect(identical(geom, snapshot(scene)), `${mode} 直後`).toBe(true);
      // ② 次のフレームを回したあと
      scene.update(1 / 60);
      expect(identical(geom, snapshot(scene)), `${mode} update 後`).toBe(true);
      expect(scene.stats().colorField).toBe(mode);
    }
  });

  it('mean は全点が画像のリニア平均になる', () => {
    const scene = build();
    scene.update(1 / 60);
    const mean = scene.stats().meanColor;
    expect(mean[0]).toBeGreaterThan(0);
    scene.setColorField('mean');
    const n = scene.stats().pointCount * 3;
    for (let i = 0; i < n; i += 3) {
      expect(scene.points.colors[i]).toBe(Math.fround(mean[0]));
      expect(scene.points.colors[i + 1]).toBe(Math.fround(mean[1]));
      expect(scene.points.colors[i + 2]).toBe(Math.fround(mean[2]));
    }
  });

  /**
   * **`image+mean` が本当に和であること。** ここが恒等なら G12 の重ね合わせは
   * 「同じ絵を 2 回測って差が 0」になり、常に緑になる（`x/x`）。
   */
  it('image+mean が image と mean の和である', () => {
    const scene = build();
    scene.update(1 / 60);
    const mean = scene.stats().meanColor;
    const n = scene.stats().pointCount * 3;
    scene.setColorField('image');
    const base = Float32Array.from(scene.points.colors.subarray(0, n));
    scene.setColorField('image+mean');
    for (let i = 0; i < n; i += 3) {
      expect(scene.points.colors[i]).toBe(Math.fround(base[i] + mean[0]));
    }
    // 恒等ではないこと（画像がすべて平均色でない限り）
    expect(identical(base, Float32Array.from(scene.points.colors.subarray(0, n)))).toBe(false);
  });

  /** 出荷時は必ず `'image'`。測定用の口が既定を汚していない */
  it('既定は image', () => {
    expect(build().stats().colorField).toBe('image');
  });

  /** 画像のリニア平均が `bloom.test.ts` の計算と一致する（同じ量が 2 か所でずれていない） */
  it('meanColor が標本 No.0 のリニア平均と一致する', () => {
    const mean = build().stats().meanColor;
    expect(mean[0]).toBeCloseTo(0.267656, 4);
    expect(mean[1]).toBeCloseTo(0.264427, 4);
    expect(mean[2]).toBeCloseTo(0.270423, 4);
  });
});
