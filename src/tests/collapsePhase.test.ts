/**
 * Phase 2a —— 潰した図の「中心」と画素格子の位相、および CPU 側の畳み込み。
 *
 * ## この 2 つは G9 の −17.58% を割った 2 つの因子そのものである
 *
 * | 因子 | 大きさ | 正体 |
 * |---|---|---|
 * | サブピクセル位相 | **−13.08%** | 図の中心にフラグメントが無い（測定の定義の問題） |
 * | 不等な加算項の half-float 累積 | −5.2%（画像依存） | 378 点を重ねていたこと |
 *
 * どちらも**画素を読まずに node で採点できる部分がある** ── そこをここで固定する。
 * GPU が要る部分（実際に読める値）は `npm run ladder` が見る。両者を混ぜない。
 */

import { describe, expect, it } from 'vitest';
import {
  collapseWeight,
  F,
  K_SPRITE,
  centreFragmentOffset,
  spritePhaseFactor,
} from '../image/spriteGain';
import { LINE_MAX_POINTS, effectiveLineCount, lineCountFor } from '../image/columnLine';
import { HDR_SELFTEST_VALUE, halfToFloat } from '../core/capture';

describe('中心フラグメントの位相（Phase 2a）', () => {
  it('DPR 2 の drawingBuffer は必ず偶数×偶数 → 中心は画素の角、位相は各軸 0.5', () => {
    // 実際に測っている寸法
    expect(centreFragmentOffset(988, 778)).toEqual({ x: 0.5, y: 0.5 });
    // 偶数であるかぎり寸法に依らない
    for (const w of [2, 100, 640, 1976]) {
      expect(centreFragmentOffset(w, w).x).toBe(0.5);
    }
  });

  it('奇数寸法なら中心は画素中心そのもの → 位相は厳密に 0', () => {
    // `npm run ladder` の G9z がこの構成を実際に作って、モデルを通さずに測る
    expect(centreFragmentOffset(741, 585)).toEqual({ x: 0, y: 0 });
    expect(centreFragmentOffset(741, 778)).toEqual({ x: 0, y: 0.5 });
  });

  it('位相減衰は §7.7 の実測値を再現する（S = 8.654148・F = 21）', () => {
    const S = 8.654148148148145;
    // 両軸潰れる d=0
    expect(spritePhaseFactor(0.5, 0.5, S)).toBeCloseTo(0.8691864478430351, 15);
    // y だけ潰れる d=1
    expect(spritePhaseFactor(0, 0.5, S)).toBeCloseTo(0.9323016935751189, 15);
    // 位相ゼロの構成では厳密に 1
    expect(spritePhaseFactor(0, 0, S)).toBe(1);
  });

  it('位相減衰は `exp(−F·r²)` そのもの —— 独立に書いた式と一致する', () => {
    // **参照実装を独立に書く**（§7.1）。`spritePhaseFactor` を呼び直さない
    const S = 7.5;
    for (const [ox, oy] of [[0.5, 0.5], [0.25, 0], [0, 0.5], [0.5, 0.125]]) {
      const r = Math.hypot(ox, oy) / S;
      expect(spritePhaseFactor(ox, oy, S)).toBeCloseTo(Math.exp(-F * r * r), 15);
    }
  });

  it('スプライトが大きいほど位相の代償は小さい（S → ∞ で 1 へ）', () => {
    const small = spritePhaseFactor(0.5, 0.5, 4);
    const big = spritePhaseFactor(0.5, 0.5, 32);
    expect(small).toBeLessThan(big);
    // S = 32 px でも代償は残る（0.98980）。**「大きくすれば消える」ではない** ──
    // 消えるのは位相が 0 の構成だけで、そこは寸法の**偶奇**が決める
    expect(big).toBeCloseTo(0.9898, 4);
    expect(small).toBeCloseTo(0.5188, 4);
    // 病的入力で NaN を返さない
    expect(spritePhaseFactor(0.5, 0.5, 0)).toBe(1);
    expect(spritePhaseFactor(0.5, 0.5, -1)).toBe(1);
  });

  it('§7.7 の「深度 378」の構成は、位相だけで sRGB 141 → 132 になる', () => {
    // 1c が記録した −17.58% のうち **−13.08% は幾何でも GPU でもなく、ここ**である。
    // 一様グレー 1024×640 を投入した実測（加算項がすべて等しい）で確かめてある:
    // d=2 → 140〜141 / d=1 → 136〜137 / d=0 → 132、予測は 141 / 136.54 / 132.20。
    const S = 8.654148148148145;
    const toLinear = (c: number): number =>
      c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    const toCode = (l: number): number =>
      255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
    const centre = toLinear(141 / 255);
    expect(toCode(centre * spritePhaseFactor(0.5, 0.5, S))).toBeCloseTo(132.2, 1);
    expect(toCode(centre * spritePhaseFactor(0, 0.5, S))).toBeCloseTo(136.5, 1);
  });
});

describe('潰れた軸を CPU 側で畳む（Phase 2a）', () => {
  it('`extentX = 1` では上限に厳密に戻る —— d=1 の絵は 1 ビットも動かない', () => {
    for (const n of [1, 4, 378, LINE_MAX_POINTS]) {
      expect(effectiveLineCount(1, n)).toBe(n);
      // 1 を超える入力（あり得ないが）でも上限を割らない
      expect(effectiveLineCount(2, n)).toBe(n);
    }
  });

  it('`extentX = 0` では 1 点 —— SPEC §2 の MEAN は「平均色の**一点**」である', () => {
    expect(effectiveLineCount(0, 378)).toBe(1);
    expect(effectiveLineCount(-1, 378)).toBe(1);
    expect(effectiveLineCount(Number.NaN, 378)).toBe(378);
  });

  it('画面上の点間隔が `s0x` に保たれる —— これが畳む量を決めている', () => {
    // 間隔 = extentX · s0x · lineCount / n。n = extentX·lineCount なら間隔 = s0x
    const lineCount = 378;
    const s0x = 2.247830687830687;
    for (const e of [0.25, 0.5, 0.75, 0.9]) {
      const n = effectiveLineCount(e, lineCount);
      const spacing = (e * s0x * lineCount) / n;
      // 丸めのぶんだけずれる。1 点の丸めが効くので許容は 1/n
      expect(Math.abs(spacing / s0x - 1)).toBeLessThan(1 / n + 1e-12);
    }
  });

  it('単調非減少 —— 潰れるほど点は減る（増える方向へ跳ばない）', () => {
    let prev = 0;
    for (let e = 0; e <= 1.0001; e += 0.005) {
      const n = effectiveLineCount(Math.min(1, e), 378);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
    expect(prev).toBe(378);
  });

  it('加算深度が `dimLevel = 0` で 1 になる —— 不等な項の累積そのものが消える', () => {
    // 1b は `LINE_MAX_POINTS = 512` を「深度 512 なら最悪 ΔE00 1.364」から決めたが、
    // §4.6 のあの表は**加算項がすべて等しい**場合の実測だった。Phase 2 の実測:
    // 一様グレーでは深度 378 でも残差 ≈ 0、標本 No.0 では −5.2%、
    // 左右反転しただけの二値画像では −6.0% と −4.5%（**順序で 1 コード動く**）。
    // → 深度の上限だけでは守れない。潰れた軸は先に畳む。
    expect(effectiveLineCount(0, lineCountFor(378))).toBe(1);
  });
});

describe('half-float のデコード（HDR 読み戻しの土台）', () => {
  it('既知の値を厳密に往復する', () => {
    expect(halfToFloat(0x3c00)).toBe(1);
    expect(halfToFloat(0x4000)).toBe(2);
    expect(halfToFloat(0x0000)).toBe(0);
    expect(halfToFloat(0xbc00)).toBe(-1);
    expect(halfToFloat(0x4100)).toBe(2.5);
    expect(halfToFloat(0x3400)).toBe(0.25);
  });

  it('非正規数を 0 に潰さない —— そこを見たくてこの口を作った', () => {
    // 最小の非正規数。ここを 0 にする実装だと「暗い列が消えた」を観測できない
    expect(halfToFloat(0x0001)).toBe(2 ** -24);
    // 最小の正規数
    expect(halfToFloat(0x0400)).toBe(2 ** -14);
    // 実測で問題になった大きさ（暗い列の 1 点あたりの寄与 3.0e−5）は非正規数の側にある
    expect(3.0e-5).toBeLessThan(2 ** -14);
  });

  it('HDR 自己検査は **1.0 を超える値**を往復させる', () => {
    // 1.0 以下だけで通した自己検査は、8bit の `Capture` と同じことしか確かめていない。
    // この口は「1.0 超と 1.0 ちょうどを区別できる」ことのためだけに在る。
    expect(Math.max(...HDR_SELFTEST_VALUE)).toBeGreaterThan(1);
    // 3 つとも fp16 で厳密に表せること（表せなければ「恒等」を要求できない）
    for (const v of HDR_SELFTEST_VALUE) {
      const e = Math.floor(Math.log2(v));
      expect(Object.is(v / 2 ** (e - 10) % 1, 0)).toBe(true);
    }
  });

  it('Inf と NaN を区別する', () => {
    expect(halfToFloat(0x7c00)).toBe(Infinity);
    expect(halfToFloat(0xfc00)).toBe(-Infinity);
    expect(Number.isNaN(halfToFloat(0x7e00))).toBe(true);
  });
});

describe('定数の同一性', () => {
  it('位相の式が使う F は、シェーダと同じ 1 つの定数である', () => {
    expect(F).toBe(21);
    expect(K_SPRITE).toBe(3.85);
  });
});

describe('アンカーの厳密 1 は、ティアに依らず構造で守られる（Phase 2a）', () => {
  /**
   * **これは CI が ubuntu の runner で BALANCED ティアに落ちて初めて出た。**
   *
   * §2.3 は「`extentX = extentY = 1` のとき分子と分母は**同じ引数で同じ関数**を呼ぶので
   * `x/x` すなわち厳密に 1」と書いていたが、基準に `AXIS_UNBOUNDED` を渡していたので
   * **同じ引数ではなかった**。HIGH（378×236）で厳密 1 だったのは数値の偶然で、
   * BALANCED（251×157）では **0.9999999999999996** になる。
   *
   * `collapse.test.ts` の `Object.is(…, 1)` はこの機体のティアでしか緑にならない
   * **機体依存のテスト**だった ── だから両ティアで見る。
   */
  const TIERS: [string, number, number, number][] = [
    ['HIGH', 378, 236, 2.247830687830687],
    ['BALANCED', 251, 157, 3.3851792828685254],
    ['ULTRA 相当', 489, 326, 1.7376],
  ];

  it('基準の点数を渡せば、どのティアでも `Object.is(…, 1)`', () => {
    // **セルの縦横比も振る。** 最初 `s0y = s0 * 1.001` だけで書いて、
    // `npm run teeth` に「壊しても緑」と言われた ── その比では BALANCED でも
    // たまたま厳密 1 になり、**まさに直したはずの偶然の上でテストしていた**。
    for (const [, cols, rows, s0] of TIERS) {
      for (const ratio of [1, 1.001, 0.999, 1.0017]) {
        const w = collapseWeight({
          s0x: s0, s0y: s0 * ratio, extentX: 1, extentY: 1,
          nx: cols, ny: rows, refNx: cols, refNy: rows, spritePx: K_SPRITE * s0,
        });
        expect(Object.is(w, 1)).toBe(true);
      }
    }
  });

  it('基準を省く（＝無限格子）と、ティアによって厳密 1 が崩れる —— これが元の姿', () => {
    // CI（ubuntu-24.04 / BALANCED）が出したのと同じ構成
    const [, cols, rows, s0] = TIERS[1];
    const w = collapseWeight({
      s0x: s0, s0y: s0, extentX: 1, extentY: 1,
      nx: cols, ny: rows, spritePx: K_SPRITE * s0,
    });
    expect(w).toBe(0.9999999999999996);
    // **1 に「近い」だけで、厳密ではない。** 絵は 1 ビットも動かないが、
    // 「構造で守られる」という主張のほうが偽だった
    expect(Object.is(w, 1)).toBe(false);
    expect(w).toBeCloseTo(1, 12);
  });

  it('潰した構成では基準を渡しても 1 にならない（補正が生きている）', () => {
    const [, cols, rows, s0] = TIERS[0];
    const line = collapseWeight({
      s0x: s0, s0y: s0, extentX: 1, extentY: 0,
      nx: cols, ny: 1, refNx: cols, refNy: rows, spritePx: K_SPRITE * s0,
    });
    expect(line).toBeGreaterThan(1.4);
    expect(line).toBeLessThan(1.6);
  });
});
