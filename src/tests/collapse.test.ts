/**
 * 潰しの較正（Phase 1b）。
 *
 * ## この 1 ファイルが引き受けている主張
 *
 * 「`dimLevel` をどこへ動かしても、図の中心には**その段階で意図した縮約値そのもの**が出る」
 *
 * 加算合成は 2 次元格子の平坦場しか再構成しない。`extent` が空間軸を潰すと
 * 点が重なって**合計**になる ── `dimLevel = 1` で平坦場の 159 倍、
 * `dimLevel = 0` で 39,000 倍。`sampleWeight`（`collapseWeight`）はそれを戻す係数である。
 *
 * ## 参照実装は独立でなければならない
 *
 * `spriteGain.test.ts` の `reconstructMean` は **`gainFor` の定義をそのまま書き戻した
 * 恒等な変換**で、`gainFor` を単独で壊せば落ちるが `ksum` を壊すと分子と分母が
 * 同時に動いて落ちない（監査が実際に壊して確認: `ksum` の `r² ≤ 0.25` を `0.16` にすると
 * ゲインが +2.6〜4.2% ずれるのに 222 件が緑のまま。G2b の予算 ±2% を全部外す）。
 *
 * → ここでは**真円の打ち切りで 2 次元格子を実際に足す総当たり**を参照にする。
 * 実装（`axisCoverage`）は軸ごとの正方近似なので、両者は独立に書かれている。
 */

import { describe, expect, it } from 'vitest';
import {
  F,
  K_SPRITE,
  MIN_CALIBRATED_S0,
  modelledAdditionDepth,
  analyticK,
  axisCoverage,
  collapseWeight,
  gainFor,
  isCalibratedS0,
  ksumLookup,
} from '../image/spriteGain';
import { f16Accumulate, f16RelativeError, f16SaturationCeiling } from '../image/halfFloat';
import { deltaE2000Linear } from '../color/deltaE';
import { SRGB } from '../color/oklab';

/**
 * 参照実装 —— **真円の打ち切りで格子を実際に足す**。実装とは別の書き方。
 *
 * 中心セルの中を NS×NS で掃いた平均を返す（`gainFor` のエネルギー較正と同じ流儀）。
 * 間隔 0 の軸は「全点が同じ位置」なので掃かない。
 */
function bruteReconstruct(
  dx: number,
  dy: number,
  nx: number,
  ny: number,
  spritePx: number,
  gain: number,
): number {
  const S = spritePx;
  const halfX = (nx - 1) / 2;
  const halfY = (ny - 1) / 2;
  const NS = 32;
  const reach = S / 2;
  let sum = 0;
  for (let a = 0; a < NS; a++) {
    const tx = dx > 0 ? ((a + 0.5) / NS - 0.5) * dx : 0;
    const loI = dx > 0 ? Math.max(0, Math.ceil(halfX + (tx - reach) / dx)) : 0;
    const hiI = dx > 0 ? Math.min(nx - 1, Math.floor(halfX + (tx + reach) / dx)) : nx - 1;
    for (let b = 0; b < NS; b++) {
      const ty = dy > 0 ? ((b + 0.5) / NS - 0.5) * dy : 0;
      const loJ = dy > 0 ? Math.max(0, Math.ceil(halfY + (ty - reach) / dy)) : 0;
      const hiJ = dy > 0 ? Math.min(ny - 1, Math.floor(halfY + (ty + reach) / dy)) : ny - 1;
      let v = 0;
      for (let i = loI; i <= hiI; i++) {
        const ex = tx - (i - halfX) * dx;
        for (let j = loJ; j <= hiJ; j++) {
          const ey = ty - (j - halfY) * dy;
          const r2 = (ex * ex + ey * ey) / (S * S);
          if (r2 <= 0.25) v += Math.exp(-F * r2);
        }
      }
      sum += v;
      if (dy <= 0) break; // 潰れた軸はセルが無いので 1 回で足りる
    }
    if (dx <= 0) break;
  }
  const samples = (dx > 0 ? NS : 1) * (dy > 0 ? NS : 1);
  return (gain * sum) / samples;
}

// 1a-iii の実機構成（SPEC §7.6）
const S0 = 2.2478;
const SPRITE = K_SPRITE * S0;
const GAIN = gainFor(S0);

describe('gainFor の較正域', () => {
  /**
   * **`gainFor` は今日 `Infinity` を返しうる。** `ksumLookup` の下端分岐
   * `ksum(F, max(0.25, s))` は `ceil(s) = 1` のとき中心 1 画素しか数えず、
   * その 1 画素が `r² > 0.25` に落ちると `ksum = 0` になる。
   * `uGain` に Infinity が入ると全画面が Inf になり、**GL エラーは出ない**。
   */
  it('クランプ前の素の式は実際に非有限になる（歯の証明）', () => {
    const raw = (s0: number): number => (s0 * s0) / ksumLookup(K_SPRITE * s0);
    expect(Number.isFinite(raw(0.15))).toBe(false);
    // 有限に見えても較正からは大きく外れている
    expect(Math.abs(raw(0.5) / (1 / (analyticK(F) * K_SPRITE * K_SPRITE)) - 1)).toBeGreaterThan(1);
  });

  it('gainFor は全域で有限', () => {
    for (const s0 of [1e-6, 0.05, 0.15, 0.25, 0.5, 0.86, 1, 2.2478, 8, 64, 1e4]) {
      expect(Number.isFinite(gainFor(s0)), `s0=${s0}`).toBe(true);
      expect(gainFor(s0)).toBeGreaterThan(0);
    }
  });

  it('較正域の内側では漸近値の ±2%', () => {
    const asymptote = 1 / (analyticK(F) * K_SPRITE * K_SPRITE);
    for (let s0 = MIN_CALIBRATED_S0; s0 <= 40; s0 += 0.01) {
      const rel = Math.abs(gainFor(s0) / asymptote - 1);
      expect(rel, `s0=${s0.toFixed(2)} rel=${rel}`).toBeLessThan(0.02);
    }
  });

  it('較正域の判定が s0 の境界そのものを見ている', () => {
    expect(isCalibratedS0(MIN_CALIBRATED_S0)).toBe(true);
    expect(isCalibratedS0(MIN_CALIBRATED_S0 - 1e-9)).toBe(false);
    // アンカーの s0 は境界のはるか上 ── クランプはアンカーに触れない
    expect(S0).toBeGreaterThan(MIN_CALIBRATED_S0 * 2);
  });

  /** 1a-iii が実機で測った gain が動いていないこと（G2b の −1.682% がこの値に乗っている） */
  it('アンカーの gain が 1a-iii の実測値のまま', () => {
    expect(GAIN).toBeCloseTo(0.45307, 5);
  });
});

describe('axisCoverage', () => {
  it('間隔 0 は点数そのもの（全点が重なる）', () => {
    expect(axisCoverage(0, 236, SPRITE)).toBe(236);
    expect(axisCoverage(0, 1, SPRITE)).toBe(1);
  });

  it('点が 1 個なら 1（線や点は断面の中心で読む ── 平均する面積が無い）', () => {
    expect(axisCoverage(S0, 1, SPRITE)).toBe(1);
    expect(axisCoverage(0.001, 1, SPRITE)).toBe(1);
  });

  it('間隔 → 0 で点数へ連続に近づく', () => {
    const n = 64;
    const far = axisCoverage(S0, n, SPRITE);
    const near = axisCoverage(1e-6, n, SPRITE);
    expect(far).toBeLessThan(n);
    expect(near).toBeCloseTo(n, 6);
  });

  it('間隔が細かいほど被覆が増える（単調）', () => {
    let prev = 0;
    for (const d of [4, 3, 2.2478, 1.5, 1, 0.5, 0.25]) {
      const c = axisCoverage(d, 4096, SPRITE);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });
});

describe('collapseWeight（sampleWeight）', () => {
  /**
   * ## アンカーが構造的に守られる
   *
   * `extentX = extentY = 1` では分子と分母が**同じ引数で同じ関数**を呼ぶので、
   * 戻り値は `x/x = 1` に厳密に等しい。`dimLevel = 2` の絵は 1 ビットも動かない。
   * `toBeCloseTo` ではなく `Object.is` で見る ── 「ほぼ 1」は錨ではない。
   */
  it('2 次元バッファで extent が潰れていなければ厳密に 1', () => {
    // 条件: 各軸の点数がスプライトの届く範囲（kSprite ≈ 3.85 点）を超えること。
    // ティア表の最小は BALANCED の 244×162 なので、実際の構成はすべて満たす。
    for (const [nx, ny] of [[378, 236], [64, 48], [244, 162], [8, 8]] as Array<[number, number]>) {
      const w = collapseWeight({
        s0x: S0, s0y: S0 * 1.001, extentX: 1, extentY: 1, nx, ny, spritePx: SPRITE,
      });
      expect(Object.is(w, 1), `nx=${nx} ny=${ny} → ${w}`).toBe(true);
    }
  });

  /**
   * スプライトより小さい格子では 1 にならない ── **これは正しい挙動である。**
   * 4 点しかない格子は平坦場を再構成しない（縁の効果が支配する）ので、
   * 「どんな格子でも 1」と書くと嘘になる。条件つきの主張であることを固定しておく。
   */
  it('スプライトより小さい格子では 1 にならない（条件つきの主張であることの確認）', () => {
    const w = collapseWeight({
      s0x: S0, s0y: S0, extentX: 1, extentY: 1, nx: 2, ny: 2, spritePx: SPRITE,
    });
    expect(w).toBeGreaterThan(1.1);
  });

  /**
   * **1 行しかないバッファは `extent` が 1 でも「潰れている」。**
   * 列平均バッファ（`ny = 1`）は y 方向の被覆を持たないので、補正は 1 にならない ──
   * ここを「extent が 1 だから 1 のはず」と書くと、線が 32.6% 暗いまま緑になる。
   * アンカー（`dimLevel = 2`）が使うのは常に格子バッファ（`ny = rows > 1`）である。
   */
  it('1 行のバッファは extent が 1 でも補正が 1 にならない', () => {
    const w = collapseWeight({
      s0x: S0, s0y: S0, extentX: 1, extentY: 1, nx: 1024, ny: 1, spritePx: SPRITE,
    });
    expect(w).toBeCloseTo(1.483, 2);
  });

  /**
   * ## 総当たりとの一致 —— これがこのファイルの本体
   *
   * 「その sampleWeight で描いたら、潰していないときと同じ水準が出るか」を
   * **独立に書いた真円の格子和**で確かめる。実装は軸ごとの正方近似なので、
   * 一致することは自明ではない。
   */
  it('補正後の再構成水準が、潰していないときと一致する', () => {
    const nx = 64;
    const ny = 48;
    const s0y = S0;
    const reference = bruteReconstruct(S0, s0y, nx, ny, SPRITE, GAIN);
    const worst: string[] = [];
    let maxRel = 0;
    for (const [ex, ey] of [
      [1, 1], [1, 0.8], [1, 0.5], [1, 0.2], [1, 0.05], [1, 0],
      [0.8, 0], [0.5, 0], [0.2, 0], [0.05, 0], [0, 0],
    ] as Array<[number, number]>) {
      const w = collapseWeight({
        s0x: S0, s0y, extentX: ex, extentY: ey, nx, ny, spritePx: SPRITE,
      });
      const value = bruteReconstruct(ex * S0, ey * s0y, nx, ny, SPRITE, GAIN) * w;
      const rel = Math.abs(value / reference - 1);
      if (rel > maxRel) maxRel = rel;
      worst.push(`(${ex},${ey})→${rel.toFixed(4)}`);
    }
    // 実測の最大残差。**緩めるときは新しい実測値をここに書くこと**
    expect(maxRel, worst.join(' ')).toBeLessThan(0.035);
  });

  /**
   * ## 補正が無いとどれだけ壊れるか（歯の証明）
   *
   * `sampleWeight = 1` のまま潰すと、線は列**合計**になる。
   * この倍率が 2 桁であることが、この機構が必要である理由そのものである。
   */
  it('補正が無いと線は列合計になる（sampleWeight = 1 で 2 桁ずれる）', () => {
    const nx = 64;
    const ny = 48;
    const reference = bruteReconstruct(S0, S0, nx, ny, SPRITE, GAIN);
    const collapsedLine = bruteReconstruct(S0, 0, nx, ny, SPRITE, GAIN);
    // 補正なし: rows 個ぶん積み上がる
    expect(collapsedLine / reference).toBeGreaterThan(ny * 0.5);
    // 完全な潰し
    const collapsedPoint = bruteReconstruct(0, 0, nx, ny, SPRITE, GAIN);
    expect(collapsedPoint / reference).toBeGreaterThan(nx * ny * 0.3);
  });

  /**
   * 1 列 1 点の線（列平均バッファ）は **32.6% 暗い**。
   * 失われるのは y 方向の被覆で、その定数は `F` と `kSprite` だけで決まる
   * （点数にも DPR にも s0 にも依らない）。
   */
  it('列平均線の補正は 1 次元被覆の定数 ≈ 1.483（点数にも s0 にも依らない）', () => {
    for (const [s0, n] of [[S0, 512], [S0, 64], [1.2, 300], [6.0, 128]] as Array<[number, number]>) {
      const w = collapseWeight({
        s0x: s0, s0y: s0, extentX: 1, extentY: 0, nx: n, ny: 1, spritePx: K_SPRITE * s0,
      });
      expect(w, `s0=${s0} n=${n}`).toBeCloseTo(1.483, 2);
    }
  });

  it('潰れきった点では点数の逆数に比例する（総和 → 平均）', () => {
    const a = collapseWeight({
      s0x: S0, s0y: S0, extentX: 0, extentY: 0, nx: 512, ny: 1, spritePx: SPRITE,
    });
    const b = collapseWeight({
      s0x: S0, s0y: S0, extentX: 0, extentY: 0, nx: 1024, ny: 1, spritePx: SPRITE,
    });
    expect(a / b).toBeCloseTo(2, 6);
  });

  /**
   * ## `[0, 2]` 全域を、`lensScene` と同じバッファ選択で通す
   *
   * **連続であるべきなのは `sampleWeight` そのものではない。** あれは物理を打ち消す
   * ために動く量で、実際 `d = 1.00` と `d = 1.01` の間で 1.91 倍動く
   * （最後の縦の広がりが消えると、ガウシアンで減衰していた点が全重量になるため）。
   * **連続であるべきは「読める値」のほう**である ── ここを取り違えると、
   * 補正を殺して「滑らかだから正しい」と読める。
   *
   * バッファの切り替え（`dimLevel = 1`）を跨いで測るのが要点。切り替えの両側で
   * 別のバッファ・別の点数・別の補正を通りながら、同じ水準が出なければならない。
   */
  it('dimLevel 0〜2 の全域で、読める値が基準水準に留まる（切り替えを跨いで）', () => {
    const cols = 64;
    const rows = 48;
    const lineN = cols; // lineCountFor(64) = 64
    const reference = bruteReconstruct(S0, S0, cols, rows, SPRITE, GAIN);
    let worst = 0;
    let worstAt = '';
    for (let d = 0; d <= 2.0001; d += 0.05) {
      const grid = d > 1; // `lensScene.bufferKind()` と同じ境界（d ≤ 1 は列平均線）
      const nx = grid ? cols : lineN;
      const ny = grid ? rows : 1;
      const ex = Math.min(1, Math.max(0, d));
      const ey = grid ? Math.min(1, Math.max(0, d - 1)) : 0;
      const cfg = { s0x: S0, s0y: S0, extentX: ex, extentY: ey, nx, ny, spritePx: SPRITE };
      const value = bruteReconstruct(ex * S0, ey * S0, nx, ny, SPRITE, GAIN) * collapseWeight(cfg);
      const rel = Math.abs(value / reference - 1);
      if (rel > worst) {
        worst = rel;
        worstAt = `d=${d.toFixed(2)} buffer=${grid ? 'grid' : 'line'}`;
      }
    }
    // 実測の最大残差。**緩めるときは新しい実測値をここに書くこと**
    expect(worst, `最悪 ${worstAt} で ${(worst * 100).toFixed(2)}%`).toBeLessThan(0.035);
  });

  /** 切り替え点の両側で同じ水準が出る ── 格子の潰れきりと列平均線が一致する */
  it('dimLevel = 1 の両側（格子の潰れきり / 列平均線）が一致する', () => {
    const cols = 64;
    const rows = 48;
    const gridSide = bruteReconstruct(S0, 0, cols, rows, SPRITE, GAIN)
      * collapseWeight({
        s0x: S0, s0y: S0, extentX: 1, extentY: 0, nx: cols, ny: rows, spritePx: SPRITE,
      });
    const lineSide = bruteReconstruct(S0, 0, cols, 1, SPRITE, GAIN)
      * collapseWeight({
        s0x: S0, s0y: S0, extentX: 1, extentY: 0, nx: cols, ny: 1, spritePx: SPRITE,
      });
    expect(Math.abs(gridSide / lineSide - 1)).toBeLessThan(0.01);
  });

  it('非有限な入力では 1 に倒す（絵を消さない側へ）', () => {
    const w = collapseWeight({
      s0x: 0, s0y: 0, extentX: 1, extentY: 1, nx: 0, ny: 0, spritePx: SPRITE,
    });
    expect(Number.isFinite(w)).toBe(true);
  });
});

describe('加算深度', () => {
  /**
   * **加算深度は点数ではない。** 1 フラグメントを覆うスプライトの個数である。
   * SPEC §4.6 が「n = 489（列平均バッファの点数）」としていたのは取り違えで、
   * 489 は ULTRA 格子の `cols`（489×326）であって、どの dimLevel の深度でもない。
   */
  it('2 次元格子の深度は π/4·kSprite² ≈ 11.6 のあたり（点数 89,208 ではない）', () => {
    const n = modelledAdditionDepth({
      s0x: S0, s0y: S0, extentX: 1, extentY: 1, nx: 378, ny: 236, spritePx: SPRITE,
    });
    expect(n).toBeGreaterThan(8);
    expect(n).toBeLessThan(25);
    expect(n).toBeLessThan(489); // §4.6 の取り違えを機械で否定する
  });

  it('潰しきると点数そのものになる', () => {
    expect(modelledAdditionDepth({
      s0x: S0, s0y: S0, extentX: 0, extentY: 0, nx: 512, ny: 1, spritePx: SPRITE,
    })).toBe(512);
    expect(modelledAdditionDepth({
      s0x: S0, s0y: S0, extentX: 0, extentY: 0, nx: 378, ny: 236, spritePx: SPRITE,
    })).toBe(378 * 236);
  });
});

describe('half-float の累積', () => {
  /**
   * SPEC §4.6 は「**天井は 0.03125 = 2⁻⁵**」と書いていた。**δ ≈ 1.5e−5 での 1 標本**である。
   * 正しい法則は「天井 = `2048·δ` 以上の最小の 2 冪」。
   */
  it('天井は δ に比例して動く（0.03125 は 1 標本にすぎない）', () => {
    const cases: Array<[number, number]> = [
      [9.5367431640625e-7, 0.001953125],
      [1.52587890625e-5, 0.03125],
      [1.53e-5, 0.0625],
      [1e-4, 0.25],
      [1e-3, 4],
      [3.07e-3, 8],
      [1, 2048],
    ];
    for (const [delta, ceiling] of cases) {
      expect(f16SaturationCeiling(delta), `δ=${delta}`).toBe(ceiling);
      // 実際に足して止まる場所が法則と一致する
      const buf = f16Accumulate(ceiling * 4, Math.round((ceiling * 4) / delta));
      expect(buf, `δ=${delta} で停止値`).toBeLessThanOrEqual(ceiling);
    }
  });

  /**
   * 「約 3% 暗く出る」も偽 —— **符号は定まらない**。
   * 予算を「暗くなる側」だけで組むと、overshoot 側で外す。
   */
  it('誤差の符号は定まらない（undershoot と決めつけない）', () => {
    const v = 0.21586; // sRGB 128 のリニア値
    expect(f16RelativeError(v, 489)).toBeGreaterThan(0); // overshoot
    expect(f16RelativeError(v, 512)).toBeLessThan(0); // undershoot
    expect(Math.abs(f16RelativeError(v, 2048))).toBeGreaterThan(0.05);
  });

  /**
   * ## 予算 —— **加算深度を 512 以下に抑えることが構造的な要件である**
   *
   * `LINE_MAX_POINTS = 512`（`columnLine.ts`）はこの表が決めている。
   */
  it('深度 512 以下なら ΔE00 ≤ 1.5、2048 では予算 3.0 を超える', () => {
    const dE = (a: number, b: number): number => deltaE2000Linear(SRGB, [a, a, a], [b, b, b]);
    const targets = [0.26766, 0.21586, 0.05, 0.7, 0.35, 0.12];
    const worstFor = (cap: number): number => {
      let worst = 0;
      for (const t of targets) {
        for (let n = 1; n <= cap; n++) {
          const e = dE(t, Math.max(1e-9, f16Accumulate(t, n)));
          if (e > worst) worst = e;
        }
      }
      return worst;
    };
    expect(worstFor(512)).toBeLessThan(1.5);
    // 上限を上げると予算 3.0 を割る ── だから点数を抑える（歯の証明）
    expect(worstFor(2048)).toBeGreaterThan(3.0);
  });

  /** 格子（89,208 点）のまま dimLevel = 0 へ潰すと、ほぼ全部消える */
  it('格子のまま潰すと 96% 以上失われる（バッファ差し替えが要る理由）', () => {
    const rel = f16RelativeError(0.26766, 89208);
    expect(rel).toBeLessThan(-0.9);
  });
});
