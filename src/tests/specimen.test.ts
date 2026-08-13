/**
 * **型 3「標本が 1 枚」を機構にする**（Phase 2c-vii）。
 *
 * ## 型 3 の正体は「1 枚しかない」ではなかった
 *
 * `core/framingEnvelope.ts` は「1024×64 横長」「1024×1 1 行」「1024×640 色相スイープ」で
 * 測ったとする表を 2 つ載せている（候補選抜の `need` 比、包絡の単調性の反例）。
 * **その 3 標本は repo に 1 バイトも無かった。** 過去の作業セッションでその場で作られ、
 * **数字だけが残っていた** ── だから誰もその表を検算できない。
 *
 * 独立監査が同名の標本を作って測ったところ、単調性の反例は主張の 46/1001・−4.49% に対し
 * **4/1001・−0.971%**、候補選抜の `need` 比は主張の 91.572% に対し **100.000%** だった。
 * 桁が違うのは監査が間違えたからではなく、**別物を測ったから**である。
 *
 * → **標本が 1 枚しかないのではなく、複数枚あるように書かれていた。**
 * これは「1 枚でしか確かめていない」より一段悪い ── 反証の手段ごと失われている。
 *
 * ## 機構
 *
 * `image/fixture.ts` の `SPECIMEN_LEDGER` に標本を実装して載せる。
 * **引用値は台帳の ID と寸法で指す。** この 1 本は台帳が実際に**判別する**ことを要求する ──
 * 台帳を 1 枚に戻すと比が厳密に 1 になって赤くなる。
 *
 * ## この機構自身の限界（正直に）
 *
 * - **古い表の数字は復元できない。** ここで作った標本は同名だが**別物**である。
 *   `framingEnvelope.ts` の 2 つの表は、この台帳で測り直すまで出所を持たない
 * - **標本軸だけである。** ティア軸は node で回せるが、ラダー（GPU）は依然として
 *   標本 1・ティア 1・viewport 1 のままで、**ラダーの 72 行中 44 行が標本に依存する**
 * - **`d = 0` と `d = 2` では標本軸が効かない**（下記）。歯を置ける場所が限られる
 */

import { describe, expect, it } from 'vitest';
import { SPECIMEN_LEDGER } from '../image/fixture';
import { linearizeRgba } from '../image/linearize';
import { computeScales, computeStats } from '../image/stats';
import { fitGrid, TIER_BUDGET } from '../image/grid';
import { K_SPRITE } from '../image/spriteGain';
import { makeLiftPayload } from '../ingest/session';
import { LensScene } from '../scene/lensScene';

type TierName = 'BALANCED' | 'HIGH' | 'ULTRA';

function sceneFor(spec: (typeof SPECIMEN_LEDGER)[number], tier: TierName) {
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
  return { scene, grid };
}

/** `stats()` を平らな数値の表に落とす */
function observe(scene: LensScene): Record<string, number> {
  const flat: Record<string, number> = {};
  for (const [k, v] of Object.entries(scene.stats() as unknown as Record<string, unknown>)) {
    if (typeof v === 'number') flat[k] = v;
    else if (v && typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (typeof v2 === 'number') flat[`${k}.${k2}`] = v2;
      }
    }
  }
  return flat;
}

describe('標本の台帳', () => {
  it('台帳は 6 枚。すべて決定的（2 回呼んでバイト一致）', () => {
    expect(SPECIMEN_LEDGER.length).toBe(6);
    for (const spec of SPECIMEN_LEDGER) {
      const a = spec.make();
      const b = spec.make();
      expect(a.width, spec.id).toBe(spec.w);
      expect(a.height, spec.id).toBe(spec.h);
      expect(a.rgba.length, spec.id).toBe(spec.w * spec.h * 4);
      let diff = 0;
      for (let i = 0; i < a.rgba.length; i++) if (a.rgba[i] !== b.rgba[i]) diff++;
      expect(diff, `${spec.id} が決定的でない`).toBe(0);
    }
  });

  /**
   * **台帳が実際に判別することを要求する。**
   *
   * 期待値は書かない（`survival.test.ts` と同じ規律）── 「散る観測量が在ること」だけを問う。
   * **台帳を 1 枚に戻すと、すべての比が厳密に 1 になってここが赤くなる。**
   *
   * **実測（Phase 2c-vii・`d = 3` / HIGH / 6 標本 / 29 観測量）**: 厳密同一 11・散る 18。
   * 強い判別量は `spread.aY` **717.19 倍**・`spread.zHi` **552.10 倍**・
   * `fill.y` **521.61 倍**・`s0` と `spritePx` **18.44 倍**・`gridH` **26.22 倍**。
   *
   * 参考: repo に 3 枚しか無かったとき（No.0 / gray / mono）は最強でも
   * `spread.zHi` の 392.92 倍で、`sampleWeight` は**厳密同一**だった ──
   * **台帳を増やすまで、標本軸には歯が立たなかった。**
   */
  it('標本を変えると散る観測量が在る（1 枚に戻すと赤くなる）', () => {
    const per: Record<string, number[]> = {};
    for (const spec of SPECIMEN_LEDGER) {
      const { scene } = sceneFor(spec, 'HIGH');
      scene.setDimLevel(3);
      scene.update(1 / 60);
      for (const [k, v] of Object.entries(observe(scene))) (per[k] ??= []).push(v);
    }
    const spread = Object.entries(per).filter(([, vs]) => !vs.every((v) => Object.is(v, vs[0])));
    expect(spread.length, `散った観測量: ${spread.map(([k]) => k).join(' ')}`).toBeGreaterThan(10);
    // 桁で散る量が在ること ── 「わずかに違う」では標本軸を張ったことにならない
    const orders = spread.filter(([, vs]) => {
      const mn = Math.min(...vs.map(Math.abs));
      const mx = Math.max(...vs.map(Math.abs));
      return mn === 0 ? mx > 0 : mx / mn > 100;
    });
    expect(orders.length, `100 倍以上散った量: ${orders.map(([k]) => k).join(' ')}`).toBeGreaterThanOrEqual(3);
  }, 60_000);

  /**
   * ## **歯を置けない場所を記録する**
   *
   * `d = 0` と `d = 2`（アンカー窓）では、構図に関する観測量が**全標本で厳密に同一**である。
   * アンカー窓は `rotationGate` が厳密に 0 で点群の重みが 0 なので、
   * フレーミングが板だけで決まる ── 板は画像のアスペクトだけで決まり、中身を見ない。
   *
   * **ラダーが標本 1 枚で緑を保てているのはこれが理由である**（ラダーのアンカー行は `d = 2`）。
   * → **標本軸の歯は `d ∉ {0, 2}` に置かなければならない。**
   */
  it('d = 2（アンカー窓）では構図が全標本で厳密に同一 —— ここに歯は置けない', () => {
    const seen: Record<string, number[]> = {};
    for (const spec of SPECIMEN_LEDGER) {
      const { scene } = sceneFor(spec, 'HIGH');
      scene.setDimLevel(2);
      scene.update(1 / 60);
      for (const [k, v] of Object.entries(observe(scene))) (seen[k] ??= []).push(v);
    }
    for (const k of ['cameraDistance', 'needDistance', 'fill.x', 'spread.zHi', 'sampleWeight']) {
      const vs = seen[k];
      expect(vs.every((v) => Object.is(v, vs[0])), `${k} = ${vs.join(' / ')}`).toBe(true);
    }
  }, 60_000);

  /**
   * ## **`n ≤ 512` の破れは標本依存だった**（Phase 2c-vii で実測）
   *
   * SPEC §4.6.1 は「加算深度の最大は `4 × rows` で、HIGH 944 / BALANCED 628 / ULTRA 1260 ──
   * 3 ティアとも 512 超」と書いている。**それは標本 No.0 のアスペクトについての主張である。**
   *
   * | 標本 | 寸法 | BALANCED | HIGH | ULTRA |
   * |---|---|---|---|---|
   * | No.0 / gray / mono / hue | 〜1024×640 | 628 | 944 | 1260 |
   * | **wide** | 1024×64 | **196** | **296** | **400** |
   * | **row1** | 1024×1 | **24** | **36** | **48** |
   *
   * 横長と 1 行画像では **3 ティアとも 512 以下**。`rows` は格子の行数なので、
   * 横長ほど小さくなる ── **`4 × rows` が 512 を超えるかどうかはアスペクトが決める。**
   *
   * さらに `scripts/ladder.mjs` の `G10_RECORDED` は `rows` を鍵にした表なので、
   * 台帳の別の標本を通すと `expected === undefined` → `record(…, null)` ＝ **採点しない**
   * になる（赤くならずに消える）。**そこは 2c-vii では直していない**（ラダーは GPU ゲート）。
   */
  it('`4 × rows` が 512 を超えるかはアスペクトが決める（畳む前の量）', () => {
    const breaks: string[] = [];
    const holds: string[] = [];
    for (const spec of SPECIMEN_LEDGER) {
      for (const tier of ['BALANCED', 'HIGH', 'ULTRA'] as const) {
        const { grid } = sceneFor(spec, tier);
        (4 * grid.rows > 512 ? breaks : holds).push(`${spec.id}/${tier}=${4 * grid.rows}`);
      }
    }
    // No.0 系は超える（SPEC §4.6.1 の主張）
    expect(breaks.some((b) => b.startsWith('No.0/')), breaks.join(' ')).toBe(true);
    // **そして超えない標本が在る** ── 主張はアスペクトについてのものだった
    expect(holds.filter((h) => h.startsWith('wide/')).length, holds.join(' ')).toBe(3);
    expect(holds.filter((h) => h.startsWith('row1/')).length, holds.join(' ')).toBe(3);
  }, 60_000);

  /**
   * **上の 1 本は実装の深度を 1 度も読んでいない**（Phase 2c-x で判明）。
   *
   * `4 * grid.rows` を `fitGrid` から計算し直しているだけなので、
   * **2c-x が畳みを入れて破れを閉じても、緑のまま「破れが在る」と主張し続ける。**
   * 独立監査が「落ちてほしいのに落ちないもの」として名指しした 5 本のうちの 1 本である
   * （残り 4 本も同じ型 ── `collapse.test.ts` は `ny` をテスト側の literal で書いており、
   * `sceneFields` / `survival` は `d = 2` か往復一致しか見ていない）。
   *
   * → **実装が実際に出す深度**を読む行をここへ足す。上の行は「畳む前の量」の記録として残す
   * （2 つは別の主張である ── 片方を消すと、どちらが直ったのかが読めなくなる）。
   */
  it('畳みを入れたあと、実装が出す深度は全標本 × 全ティアで 512 以下', () => {
    const over: string[] = [];
    const seen: string[] = [];
    for (const spec of SPECIMEN_LEDGER) {
      for (const tier of ['BALANCED', 'HIGH', 'ULTRA'] as const) {
        const { scene, grid } = sceneFor(spec, tier);
        let worst = 0;
        let worstAt = 0;
        // 折れ点は `extentY = K_SPRITE·ρ/m` に在る（`ρ = s0/s0y`。Phase 2c-x で訂正）。
        // ρ を落とすと −3.8%〜+0.4% ずれるので、**両方の族**とその周辺を通す。
        const eps: number[] = [];
        for (let m = 1; m <= grid.rows; m++) {
          for (const k of [K_SPRITE / m, (K_SPRITE * (grid.cols / grid.rows)) / m]) {
            if (k > 0 && k <= 1) eps.push(k * 0.999999, k, k * 1.000001);
          }
          // 畳み自身の折れ点（`rows'` が 1 変わる境界）
          const f = (m + 0.5) / grid.rows;
          if (f > 0 && f <= 1) eps.push(f * 0.999999, f, f * 1.000001);
        }
        eps.push(Number.EPSILON, 1e-7, 1e-4, 1e-3, 0.5, 1);
        for (const e of eps) {
          scene.setDimLevel(1 + e);
          scene.update(0);
          const d = scene.stats().modelledAdditionDepth;
          if (d > worst) { worst = d; worstAt = 1 + e; }
        }
        seen.push(`${spec.id}/${tier}=${worst}@${worstAt.toFixed(7)}`);
        if (worst > 512) over.push(`${spec.id}/${tier}=${worst}@${worstAt.toFixed(7)}`);
      }
    }
    expect(seen.length).toBe(18);
    expect(over, `予算 n ≤ 512 を破った: ${over.join(' ')} / 全 ${seen.join(' ')}`).toEqual([]);
    // **この行が「畳みが効いている」ことを主張する。** 畳みを外すと No.0 系 12 セルが 512 超になる
    expect(seen.some((s) => s.startsWith('No.0/HIGH='))).toBe(true);
  }, 120_000);
});
