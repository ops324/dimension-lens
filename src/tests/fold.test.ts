/**
 * **格子 y 軸の畳み**（Phase 2c-x）。
 *
 * ## なぜ専用のファイルが要るのか
 *
 * 独立監査が、畳みを入れる**前**に次を実演した ── 「畳みを書いたが `rows' ≡ rows`」という
 * **偽の実装**は今日の出荷と**ビット一致**し（位置 0 / 2,677,944 要素・`stats()` 0 / 364 値）、
 * `npm test` **447 件**・歯の台帳 **57 本**・`ladder --structural` が**全部緑のまま通った**。
 * さらに `spacingY` を入れ忘れた実装（雲が最大 **9.6 倍**暗い）も**全部緑**だった。
 *
 * 既存のテストが見ていない理由も個別に分かっている:
 *
 * | ファイル | なぜ動かないか |
 * |---|---|
 * | `collapse.test.ts` | `ny = grid ? rows : 1` を**テスト側の literal** で書いている（実装を読まない） |
 * | `specimen.test.ts`（2c-vii の行） | `4 * grid.rows` を `fitGrid` から計算し直す（実装の深度を読まない） |
 * | `survival.test.ts` | 往復の一致しか問わない（期待値を書かない規律の代償） |
 * | `sceneFields.test.ts` | `d = 2` でしか回さない ── そこは畳みが恒等 |
 *
 * → **観測できる量で、畳みの 4 つの性質を別々に主張する。**
 * 台帳の 2c-x の 4 本（畳まない / 柵を外す / 補正を落とす / 帯を 1 行にする）が
 * それぞれここへ当たる。
 */

import { describe, expect, it } from 'vitest';
import { SPECIMEN_LEDGER } from '../image/fixture';
import { linearizeRgba } from '../image/linearize';
import { computeScales, computeStats } from '../image/stats';
import { effectiveRowCount, fitGrid, TIER_BUDGET } from '../image/grid';
import { makeLiftPayload } from '../ingest/session';
import { LensScene } from '../scene/lensScene';
import { lineCountFor } from '../image/columnLine';

type Tier = 'BALANCED' | 'HIGH' | 'ULTRA';
const TIERS: Tier[] = ['BALANCED', 'HIGH', 'ULTRA'];

function sceneFor(spec: (typeof SPECIMEN_LEDGER)[number], tier: Tier) {
  const s = spec.make();
  const canonical = linearizeRgba(s.rgba, s.width, s.height, 'srgb');
  const stats = computeStats(canonical);
  const scales = computeScales(stats);
  const grid = fitGrid(canonical.width, canonical.height, TIER_BUDGET[tier]);
  const lifted = makeLiftPayload(canonical, grid, scales);
  const scene = new LensScene({
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
  return { scene, grid, lifted, canonical };
}

/** リニア光 RGB の単純平均 */
function meanRgb(buf: Float32Array, count: number): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < count; i++) {
    r += buf[i * 3];
    g += buf[i * 3 + 1];
    b += buf[i * 3 + 2];
  }
  return [r / count, g / count, b / count];
}

describe('格子 y 軸の畳み（Phase 2c-x）', () => {
  /**
   * **純関数の性質。** `extentY = 1` で恒等、`rows/2` より上では畳まない。
   * 台帳の「柵を外す」変異がここへ当たる。
   */
  it('`effectiveRowCount` は恒等点を持ち、帯が 1 行になる範囲では畳まない', () => {
    for (const rows of [1, 2, 3, 9, 74, 157, 236, 315]) {
      // `extentY = 1`（アンカー）は厳密に恒等
      expect(effectiveRowCount(1, rows), `rows=${rows}`).toBe(rows);
      expect(effectiveRowCount(1.5, rows), `rows=${rows}`).toBe(rows);
      // `extentY = 0` は 1 点
      expect(effectiveRowCount(0, rows), `rows=${rows}`).toBe(1);
      for (let k = 0; k <= 2000; k++) {
        const e = k / 2000;
        const n = effectiveRowCount(e, rows);
        expect(n, `rows=${rows} e=${e}`).toBeGreaterThanOrEqual(1);
        expect(n, `rows=${rows} e=${e}`).toBeLessThanOrEqual(rows);
        /**
         * **柵**: 畳んだなら、どの帯も源の行を 2 本以上含む。
         * `floor` の厳密分割なので `2n ≤ rows` がその条件そのものである
         * （実測: `rows = 236` では `n = 119` から 1 行の帯が現れる）。
         */
        if (n !== rows) expect(2 * n, `rows=${rows} e=${e} n=${n}`).toBeLessThanOrEqual(rows);
      }
    }
  }, 60_000);

  /**
   * **アンカーが 1 ビットも動かない。** `d = 2` では `extentY = 1` なので
   * `rows' = rows`、間隔比が厳密 1、`collapseWeight` が `x/x` で厳密 1。
   */
  it('`d = 2` のアンカーは全標本 × 全ティアで恒等（18/18 セル）', () => {
    let cells = 0;
    for (const spec of SPECIMEN_LEDGER) {
      for (const tier of TIERS) {
        cells++;
        const { scene, grid } = sceneFor(spec, tier);
        scene.setDimLevel(2);
        scene.update(0);
        const s = scene.stats();
        expect(s.gridRowsDrawn, `${spec.id}/${tier}`).toBe(grid.rows);
        expect(s.pointCount, `${spec.id}/${tier}`).toBe(grid.cols * grid.rows);
        expect(Object.is(s.sampleWeight, 1), `${spec.id}/${tier} sw=${s.sampleWeight}`).toBe(true);
      }
    }
    expect(cells).toBe(18);
  }, 60_000);

  /**
   * **潰しの補正が畳みに追随している。**
   *
   * 畳みは点の間隔を `s0y` へ戻すので、`collapseWeight` の比は **1 の近傍**に留まる。
   * `spacingY` を入れ忘れると、分母が `rows` 行ぶんの被覆のままなので
   * `sampleWeight ≈ extentY` になる ── つまり雲が `1/(d−1)` 倍暗く出る。
   * 独立監査の実測: `d ∈ (1,2]` の 1039 点中 **618 点で −50% 超**・最悪 **−90.12%**。
   *
   * **アンカーの厳密 1 は入れ忘れても保たれる**（`1 · rows / rows` が厳密 1）ので、
   * `d = 2` だけを見る行ではこの誤りは 1 つも捕まらない。**帯の中を見る。**
   *
   * ## 窓は機構から出す（§0.1 規律 9）
   *
   * 間隔比は `(e·rows) / round(e·rows)` なので、`n = round(e·rows)` に対して
   * `[2n/(2n+1), 2n/(2n−1)]` に入り、最悪は `n = 1` の `[2/3, 2]`。被覆はその滑らかな
   * 関数なので、**畳んでいるかぎり `sampleWeight` は O(1) に留まる**（構造）。
   * 補正を落とすと分母が `rows` 行ぶんのままなので `sampleWeight ≈ extentY` になり、
   * **`extentY → 0` で 0 へ落ちる**（桁が違う ── 監査の実測で最悪 0.0988）。
   *
   * 実測の窓（18 セル・折れ点の両側＋4000 点の一様掃引）:
   * **最小 0.857051**（`row1/ULTRA` @ d=1.208334）／**最大 1.492992**（`wide/ULTRA` @ d=1.005）。
   * 判定はこの実測に余白を付けた `(0.85, 1.5)` で、**O(1) と O(extentY) を分ける**のが役目である。
   */
  it('畳んだ帯でも `sampleWeight` は O(1) に留まる（補正を落とすと `extentY` へ落ちる）', () => {
    const worst: string[] = [];
    for (const spec of SPECIMEN_LEDGER) {
      for (const tier of TIERS) {
        const { scene, grid } = sceneFor(spec, tier);
        let lo = Infinity;
        let hi = -Infinity;
        let loAt = 0;
        for (let k = 1; k <= 400; k++) {
          const e = k / 400;
          scene.setDimLevel(1 + e);
          scene.update(0);
          const s = scene.stats();
          if (s.gridRowsDrawn === grid.rows) continue; // 畳んでいない帯は対象外
          if (s.sampleWeight < lo) { lo = s.sampleWeight; loAt = 1 + e; }
          if (s.sampleWeight > hi) hi = s.sampleWeight;
        }
        if (lo !== Infinity) {
          worst.push(`${spec.id}/${tier}=${lo.toFixed(4)}@${loAt.toFixed(4)}`);
          expect(lo, `${spec.id}/${tier} の最小 sampleWeight（@d=${loAt}）`).toBeGreaterThan(0.85);
          expect(hi, `${spec.id}/${tier} の最大 sampleWeight`).toBeLessThan(1.5);
        }
      }
    }
    // 畳む帯を実際に通った標本が在ること（この行が空なら上の expect は 1 度も走っていない）
    expect(worst.length, worst.join(' ')).toBeGreaterThanOrEqual(12);
  }, 120_000);

  /**
   * **畳みは平均であって間引きではない。**
   *
   * 帯平均は全体平均を（帯が等分なら厳密に）保つ。帯の上端 1 行だけを採る間引きは
   * 保たない ── 独立監査の実測では標本 No.0・`rows' = 1` で相対輝度誤差 **288.4%**、
   * **378 点すべて**が ΔE00 の予算 3.0 を超える。
   *
   * 観測は `scene.points.colors`（実際に描く色）で行う ── `stats()` には出ない量なので、
   * ここだけはバッファを直接読む。
   */
  it('畳んだ色の平均が、源の格子の色の平均と一致する（間引きなら外れる）', () => {
    for (const spec of SPECIMEN_LEDGER) {
      const { scene, grid, lifted } = sceneFor(spec, 'HIGH');
      const ref = meanRgb(lifted.colors, grid.cols * grid.rows);
      let checked = 0;
      for (const e of [0.004, 0.01, 0.05, 0.1, 0.2, 0.35, 0.5]) {
        scene.setDimLevel(1 + e);
        scene.update(0);
        const s = scene.stats();
        if (s.gridRowsDrawn === grid.rows) continue;
        checked++;
        const got = meanRgb(scene.points.colors, grid.cols * s.gridRowsDrawn);
        for (let c = 0; c < 3; c++) {
          // 帯幅が割り切れないぶんの残差だけが残る。**桁で効く間引きはここを通れない**
          const rel = ref[c] === 0 ? Math.abs(got[c]) : Math.abs(got[c] / ref[c] - 1);
          expect(rel, `${spec.id} e=${e} ch=${c} 源=${ref[c]} 畳み=${got[c]}`).toBeLessThan(0.02);
        }
      }
      expect(checked, `${spec.id} は畳む帯を 1 点も通らなかった`).toBeGreaterThan(0);
    }
  }, 120_000);

  /**
   * **線の点数の過大申告**（Phase 2c-x で直した。畳みの手本が持っていた穴）。
   *
   * `buildColumnLine` は `n = min(count, width)` で切るのに、2c-ix まで呼び出し側は
   * 返り値を捨てて `lineCount` を代入していた。独立監査が **18 セル中 6 セル**
   * （`gray` / `mono` の 64×40、3 ティアとも）で過大申告を実測した。
   */
  it('`linePoints` は実際に書かれた点数と一致する（18/18 セル）', () => {
    const bad: string[] = [];
    let cells = 0;
    for (const spec of SPECIMEN_LEDGER) {
      for (const tier of TIERS) {
        cells++;
        const { scene, grid, canonical } = sceneFor(spec, tier);
        scene.setDimLevel(1);
        scene.update(0);
        const s = scene.stats();
        const wrote = Math.max(1, Math.min(lineCountFor(grid.cols), canonical.width));
        if (s.linePoints !== wrote) {
          bad.push(`${spec.id}/${tier} 申告=${s.linePoints} 実体=${wrote}`);
        }
      }
    }
    expect(cells).toBe(18);
    expect(bad, bad.join(' / ')).toEqual([]);
  }, 60_000);

  /**
   * **線を描くフレームでは格子の行数を漏らさない**（2c-vi が `linePoints` について
   * 直したのと対称。片方だけ直すと、同じ型の嘘が反対側に残る）。
   */
  it('`gridRowsDrawn` と `linePoints` は互いのフレームで 0 を返す', () => {
    const { scene, grid } = sceneFor(SPECIMEN_LEDGER[0], 'HIGH');
    // 一度 d = 0 まで落として線バッファを 1 点にしてから格子へ戻す
    for (const d of [0, 0.5, 1, 1.2, 3, 0.5, 2]) {
      scene.setDimLevel(d);
      scene.update(0);
      const s = scene.stats();
      if (s.buffer === 'grid') {
        expect(s.linePoints, `d=${d}`).toBe(0);
        expect(s.gridRowsDrawn, `d=${d}`).toBeGreaterThan(0);
        expect(s.gridRowsDrawn, `d=${d}`).toBeLessThanOrEqual(grid.rows);
      } else {
        expect(s.gridRowsDrawn, `d=${d}`).toBe(0);
        expect(s.linePoints, `d=${d}`).toBeGreaterThan(0);
      }
    }
  }, 60_000);
});
