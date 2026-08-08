/**
 * 位相包絡（`core/framingEnvelope.ts`・Phase 2c-ii）。
 *
 * ## この 1 ファイルが引き受けている主張
 *
 *   1. **`extent` の式が 1 か所にしかない** ── 包絡が `lensScene` と違う図を測っていたら、
 *      見積もりは正しい数字の顔をした別物になる
 *   2. **位相の掃きは閉軌道を掃いている** ── `θ_k = ω_k·s`、周期 `2000π`
 *   3. **候補をノルム上位に絞ってよい** ── 増幅 `r·dist/(dist−r)` が `r` について単調
 *   4. **包絡は実際に包絡している** ── 掃いていない位相を当てても超えない（実測で margin を出す）
 *
 * 4 が本体である。1〜3 はそれを支える前提で、どれが壊れても 4 は静かに嘘になる。
 */

import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_CANDIDATES,
  ENVELOPE_DIM_STEP,
  ENVELOPE_PHASES,
  ENVELOPE_SLOTS,
  ORBIT_PERIOD,
  createEnvelopeCache,
  createEnvelopeScratch,
  envelopeFor,
  extentFor,
  framingEnvelope,
  probePhases,
  selectCandidates,
  slotFor,
} from '../core/framingEnvelope';
import { PLANES } from '../render/rotationSchedule';
import { composeRotN, foldExtent, liftProject5, safeDist } from '../math/rotationN';
import { makeSpecimen0 } from '../image/fixture';
import { linearizeRgba } from '../image/linearize';
import { computeScales, computeStats } from '../image/stats';
import { fitGrid, TIER_BUDGET } from '../image/grid';
import { makeLiftPayload } from '../ingest/session';
import { clamp01 } from '../math/ease';
import { LensScene } from '../scene/lensScene';

function specimen() {
  const s = makeSpecimen0();
  const canonical = linearizeRgba(s.rgba, s.width, s.height, 'srgb');
  const stats = computeStats(canonical);
  const scales = computeScales(stats);
  const grid = fitGrid(canonical.width, canonical.height, TIER_BUDGET.HIGH);
  const lifted = makeLiftPayload(canonical, grid, scales);
  return {
    base: lifted.base,
    count: grid.cols * grid.rows,
    cascadeDist: safeDist(lifted.maxNorm),
    axisPresent: [true, true, true, true, true],
  };
}

const ALL_PRESENT = [true, true, true, true, true];

describe('extent の式は 1 か所にしかない', () => {
  /**
   * **`lensScene` が使っていた式そのもの**（`clamp01(d - k)`、退化軸は 0）。
   * ここが一致しなくなったら、包絡は別の図についての数字になる。
   */
  it('clamp01(d − k) と一致し、退化軸は dimLevel に依らず 0', () => {
    const out = new Float64Array(5);
    for (let d = 0; d <= 5; d += 0.125) {
      extentFor(d, ALL_PRESENT, out);
      for (let k = 0; k < 5; k++) {
        expect(out[k], `d=${d} k=${k}`).toBe(clamp01(d - k));
      }
    }
    const degenerate = [true, true, false, true, false];
    for (const d of [0, 1.5, 3, 5]) {
      extentFor(d, degenerate, out);
      expect(out[2]).toBe(0);
      expect(out[4]).toBe(0);
    }
  });
});

describe('位相の掃きは閉軌道を掃く', () => {
  it('θ_k = ω_k · s（s は 1 個のスカラ）', () => {
    const out = new Float64Array(PLANES.length);
    const m = 64;
    for (const i of [0, 1, 7, 63]) {
      probePhases(i, m, out);
      const s = (ORBIT_PERIOD * i) / m;
      for (let k = 0; k < PLANES.length; k++) {
        expect(out[k]).toBeCloseTo(PLANES[k].omega * s, 9);
      }
    }
  });

  /**
   * **周期の検算。** `ω × 1000 = (110, 70, 50, 30, 23)` の gcd が 1 なので
   * `s = 2000π` で全平面が同時に 2π の整数倍へ戻る ── 平面ごとに 110/70/50/30/23 回転。
   */
  it('ORBIT_PERIOD で全平面が 2π の整数倍へ戻る', () => {
    const turns = [110, 70, 50, 30, 23];
    for (let k = 0; k < PLANES.length; k++) {
      const rev = (PLANES[k].omega * ORBIT_PERIOD) / (2 * Math.PI);
      expect(rev).toBeCloseTo(turns[k], 6);
      expect(Math.abs(rev - Math.round(rev))).toBeLessThan(1e-9);
    }
  });

  it('i = 0 は位相ゼロ（測定の起点と同じ）', () => {
    const out = new Float64Array(PLANES.length);
    probePhases(0, 64, out);
    for (let k = 0; k < PLANES.length; k++) expect(out[k]).toBe(0);
  });
});

describe('候補の選抜', () => {
  it('|E·x| の大きい順に k 個入る', () => {
    // 5 次元 8 点。ノルムが単調に増える形で置く
    const base = new Float32Array(8 * 5);
    for (let v = 0; v < 8; v++) base[v * 5] = v + 1;
    const scratch = createEnvelopeScratch(3);
    const used = selectCandidates(base, 8, [1, 1, 1, 1, 1], scratch);
    expect(used).toBe(3);
    const picked = [...scratch.candidates].sort((a, b) => a - b);
    expect(picked).toEqual([5, 6, 7]);
  });

  it('extent が 0 の軸はノルムに寄与しない', () => {
    const base = new Float32Array(3 * 5);
    base[0 * 5 + 0] = 1; // 軸 0 に 1
    base[1 * 5 + 3] = 9; // 軸 3 に 9（extent 0 なので効かない）
    base[2 * 5 + 0] = 2;
    const scratch = createEnvelopeScratch(1);
    const used = selectCandidates(base, 3, [1, 1, 1, 0, 0], scratch);
    expect(used).toBe(1);
    expect(scratch.candidates[0]).toBe(2);
  });

  it('count が k 以下ならそのまま全部入る', () => {
    const base = new Float32Array(2 * 5);
    const scratch = createEnvelopeScratch(8);
    expect(selectCandidates(base, 2, [1, 1, 1, 1, 1], scratch)).toBe(2);
  });
});

describe('包絡は実際に包絡している（本体）', () => {
  const { base, count, cascadeDist } = specimen();

  /** その位相そのもので投影したときの広がり（`lensScene` と同じ経路で作る） */
  function spreadAtPhase(sScalar: number, extent: Float64Array): { aX: number; aY: number; zHi: number } {
    const angles = PLANES.map((p) => ({ i: p.i, j: p.j, angle: p.omega * sScalar }));
    const m = new Float64Array(25);
    composeRotN(angles, 5, m);
    foldExtent(m, 5, extent);
    const out = new Float32Array(count * 3);
    liftProject5(base, count, m, cascadeDist, out);
    let aX = 0, aY = 0, zHi = 0;
    for (let v = 0; v < count; v++) {
      const o = v * 3;
      const x = out[o] < 0 ? -out[o] : out[o];
      const y = out[o + 1] < 0 ? -out[o + 1] : out[o + 1];
      if (x > aX) aX = x;
      if (y > aY) aY = y;
      if (out[o + 2] > zHi) zHi = out[o + 2];
    }
    return { aX, aY, zHi };
  }

  /**
   * **掃いていない位相を当てる。** 包絡は「見積もりであって上界ではない」ので
   * 厳密に超えないとは主張しない ── **どれだけ超えうるか**を数字で固定する。
   *
   * 実測（標本 No.0・HIGH 格子 378×236・`d = 3`・`ENVELOPE_PHASES = 4096`）では
   * 40 個の無作為な位相のいずれも包絡を超えなかった。柵は 2% に置く ──
   * ここが動いたら `ENVELOPE_PHASES` が足りていない。
   */
  it('掃いていない 40 位相のどれも包絡を 2% 以上は超えない', () => {
    const extent = new Float64Array(5);
    extentFor(3, ALL_PRESENT, extent);
    const scratch = createEnvelopeScratch(ENVELOPE_CANDIDATES);
    const env = framingEnvelope(base, count, extent, cascadeDist, scratch, ENVELOPE_PHASES);
    let worst = 0;
    for (let i = 0; i < 40; i++) {
      // 掃いた点（i/4096 · 周期）と重ならないよう、無理数倍でずらす
      const s = ORBIT_PERIOD * ((i * Math.SQRT2) % 1);
      extentFor(3, ALL_PRESENT, extent);
      const got = spreadAtPhase(s, extent);
      worst = Math.max(
        worst,
        got.aX / env.aX,
        got.aY / env.aY,
        got.zHi / env.zHi,
      );
    }
    expect(worst, `最悪 ${(worst * 100).toFixed(2)}%`).toBeLessThan(1.02);
  });

  it('位相を増やすと包絡は単調に広がる（狭くならない）', () => {
    const extent = new Float64Array(5);
    extentFor(3, ALL_PRESENT, extent);
    const scratch = createEnvelopeScratch(ENVELOPE_CANDIDATES);
    let prev = { aX: 0, aY: 0, zHi: 0 };
    for (const m of [16, 64, 256, 1024]) {
      const env = framingEnvelope(base, count, extent, cascadeDist, scratch, m);
      expect(env.aX).toBeGreaterThanOrEqual(prev.aX - 1e-12);
      expect(env.aY).toBeGreaterThanOrEqual(prev.aY - 1e-12);
      expect(env.zHi).toBeGreaterThanOrEqual(prev.zHi - 1e-12);
      prev = env;
    }
  });

  /**
   * **候補を増やしても変わらない**＝ 単調性の議論が効いていることの確認。
   * 実測では 32 と 128 が 4 桁すべて一致する。ここが割れたら
   * 「ノルム上位だけ見ればよい」が成り立っていない。
   */
  it('候補を 32 から 128 に増やしても包絡が変わらない', () => {
    const extent = new Float64Array(5);
    extentFor(3, ALL_PRESENT, extent);
    const a = framingEnvelope(base, count, extent, cascadeDist, createEnvelopeScratch(32), 256);
    const b = framingEnvelope(base, count, extent, cascadeDist, createEnvelopeScratch(128), 256);
    expect(b.aX).toBeCloseTo(a.aX, 9);
    expect(b.aY).toBeCloseTo(a.aY, 9);
    expect(b.zHi).toBeCloseTo(a.zHi, 9);
  });

  it('点が無ければゼロを返す（カメラを原点へ呼ばない）', () => {
    const extent = new Float64Array(5);
    extentFor(3, ALL_PRESENT, extent);
    const env = framingEnvelope(new Float32Array(0), 0, extent, cascadeDist, createEnvelopeScratch(8));
    expect(env).toEqual({ aX: 0, aY: 0, zHi: 0 });
  });
});

describe('シーンへの配線（node で回す）', () => {
  function buildScene(): LensScene {
    const s = makeSpecimen0();
    const canonical = linearizeRgba(s.rgba, s.width, s.height, 'srgb');
    const stats = computeStats(canonical);
    const scales = computeScales(stats);
    const grid = fitGrid(canonical.width, canonical.height, TIER_BUDGET.HIGH);
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

  /**
   * **これが 2c-ii の主張そのもの。**
   *
   * 2c-i まで、同じ `dimLevel` に留まると図が単調に小さくなっていた
   * （実測: `d = 3` で 140 秒かけて 2.9682 → 6.0446、**2.04 倍**）。
   * 包絡を先に置いたので、**カメラ距離は経過時間の関数ではなくなった**。
   *
   * ここが落ちるのは「包絡が配線から外れた」ときである ── `framingEnvelope.ts` 側の
   * 単体テストは全部緑のまま、この 1 本だけが落ちる形になる。
   */
  it('門が全開なら、カメラ距離は 1800 フレーム回しても 1 ビットも動かない', () => {
    const scene = buildScene();
    scene.setDimLevel(3);
    scene.update(1 / 60);
    const d0 = scene.stats().cameraDistance;
    for (let i = 0; i < 1800; i++) scene.update(1 / 60);
    const d1 = scene.stats().cameraDistance;
    expect(Object.is(d1, d0), `${d0} → ${d1}`).toBe(true);
  });

  /**
   * **アンカー窓の縁で跳ねない。**
   *
   * 包絡をそのまま入れると `d = 2.1 → 2.11` でカメラが **1.9636 → 4.7330（2.41 倍）**
   * 跳んだ（実測）。そのとき板の重みはまだ 0.9976 で、**写真はまだ見えている** ──
   * つまり写真が突然 41% に縮む。→ 包絡は `cloudWeight` で入れる。
   */
  it('窓の縁を出た直後、写真の充填はほとんど動かない', () => {
    const scene = buildScene();
    scene.setDimLevel(2.1);
    scene.update(1 / 60);
    const inside = scene.stats().fill.x;
    scene.setDimLevel(2.11);
    scene.update(1 / 60);
    const outside = scene.stats().fill.x;
    // 板の重みが 0.9976 のところで充填が 1% 以上動いたら、写真が縮んで見える
    expect(Math.abs(outside - inside) / inside, `${inside} → ${outside}`).toBeLessThan(0.01);
  });

  it('アンカー窓の中では 1a-iii の距離のまま（包絡は入らない）', () => {
    const scene = buildScene();
    scene.setDimLevel(2);
    scene.update(1 / 60);
    for (let i = 0; i < 120; i++) scene.update(1 / 60);
    expect(scene.stats().fill.x).toBeCloseTo(0.86, 12);
  });
});

describe('スロットの表', () => {
  const { base, count, cascadeDist } = specimen();

  it('slotFor は [0, ENVELOPE_SLOTS) に収める', () => {
    expect(slotFor(0)).toBe(0);
    expect(slotFor(5)).toBe(ENVELOPE_SLOTS - 1);
    expect(slotFor(-1)).toBe(0);
    expect(slotFor(99)).toBe(ENVELOPE_SLOTS - 1);
    expect(slotFor(Number.NaN)).toBe(0);
    expect(slotFor(ENVELOPE_DIM_STEP)).toBe(1);
  });

  it('同じスロットは 1 度しか計算しない', () => {
    const cache = createEnvelopeCache();
    expect(cache.filled.every((f) => f === 0)).toBe(true);
    const a = envelopeFor(cache, base, count, ALL_PRESENT, 3, cascadeDist);
    const filledAfter = [...cache.filled];
    const b = envelopeFor(cache, base, count, ALL_PRESENT, 3, cascadeDist);
    expect(b).toEqual(a);
    expect([...cache.filled]).toEqual(filledAfter);
  });

  /** 刻みの間では**挟む 2 つの大きいほう**を返す（安全側） */
  it('刻みの間は隣接スロットの max', () => {
    const cache = createEnvelopeCache();
    const lo = envelopeFor(cache, base, count, ALL_PRESENT, 3, cascadeDist);
    const hi = envelopeFor(cache, base, count, ALL_PRESENT, 3.25, cascadeDist);
    const mid = envelopeFor(cache, base, count, ALL_PRESENT, 3.1, cascadeDist);
    expect(mid.aX).toBe(Math.max(lo.aX, hi.aX));
    expect(mid.aY).toBe(Math.max(lo.aY, hi.aY));
    expect(mid.zHi).toBe(Math.max(lo.zHi, hi.zHi));
  });
});
