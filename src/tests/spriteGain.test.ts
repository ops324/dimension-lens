/**
 * スプライトゲイン。
 *
 * 監査で「リップルは尺度不変なので、ゲインが**定数倍**ずれていても通ってしまう」と
 * 指摘されたので、**水準**のテストを分けて置く。リップルだけでは
 * `kSprite²` を落としても、DPR の係数を失っても、同じ数字が出る。
 */

import { describe, expect, it } from 'vitest';
import {
  analyticK,
  F,
  gainFor,
  K_SPRITE,
  ksum,
  ksumLookup,
  latticeRipple,
} from '../image/spriteGain';

describe('spriteGain 定数', () => {
  it('採用値 F=21, kSprite=3.85 の平坦場リップルは 1% 未満', () => {
    const r = latticeRipple(F, K_SPRITE);
    expect(r.p2p).toBeLessThan(0.01);
  });

  /**
   * 設計当初の値が**本当に壊れていた**ことを固定する。
   * これが落ちるようになったら、リップルの評価関数のほうが壊れている。
   */
  it('設計当初の F=6, kSprite=1.7 は 40% 超のリップルだった(歯の証明)', () => {
    const r = latticeRipple(6, 1.7);
    expect(r.p2p).toBeGreaterThan(0.4);
  });

  it('光る半径が隣接点に届いていること —— 44.7% の原因を構造で禁じる', () => {
    // kSprite/2 は軸方向の隣(1.0 セル)を超えていなければならない
    expect(K_SPRITE / 2).toBeGreaterThan(1.0);
  });

  it('連続近似の平均は K·kSprite² に一致する', () => {
    const r = latticeRipple(F, K_SPRITE);
    expect(r.mean).toBeCloseTo(analyticK(F) * K_SPRITE * K_SPRITE, 3);
  });
});

describe('Ksum 表', () => {
  it('S が大きければ解析式 K·S² に近づく(6% 以内)', () => {
    for (const S of [4, 6, 8, 12, 16]) {
      const rel = Math.abs(ksum(F, S) / (S * S) - analyticK(F)) / analyticK(F);
      expect(rel).toBeLessThan(0.06);
    }
  });

  /**
   * **単調収束は主張しない。** 設計はそう書いていたが、同じ節が
   * 「S ごとに振動する」と書いており矛盾していた ── `discard` 境界が取り込む
   * 画素数が S ごとに変わるので、実際に振動する。振動することのほうを固定する。
   */
  it('比は単調ではなく振動する(設計の主張のほうが誤りだった)', () => {
    const rel: number[] = [];
    for (let S = 2; S <= 8; S++) {
      rel.push(ksum(F, S) / (S * S) / analyticK(F));
    }
    let monotone = true;
    for (let i = 2; i < rel.length; i++) {
      if (Math.sign(rel[i] - rel[i - 1]) !== Math.sign(rel[i - 1] - rel[i - 2])) {
        monotone = false;
        break;
      }
    }
    expect(monotone).toBe(false);
  });

  it('表の補間は格子点で厳密値と一致する', () => {
    for (const S of [1, 2.125, 5.5, 10, 16]) {
      const want = S >= 16 ? analyticK(F) * S * S : ksum(F, S);
      expect(ksumLookup(S)).toBeCloseTo(want, 6);
    }
  });
});

describe('ゲインの水準(定数倍のずれを捕まえる)', () => {
  /**
   * 平坦場をゲイン `g = s0²/Ksum` で再構成したときの**平均**が入力値に一致すること。
   * 点数にも DPR にも依らないことを、2 つの (cols, DPR) 組で確かめる ──
   * これは G2 の主張を、GPU が存在する前に node で証明する。
   */
  function reconstructMean(s0: number, value: number): number {
    // 1 セルあたりの device px が s0 のとき、単位面積あたりの寄与は
    //   value · g · Ksum(F, k·s0) / s0²  = value(定義より)
    const g = gainFor(s0);
    return (value * g * ksumLookup(K_SPRITE * s0)) / (s0 * s0);
  }

  it('再構成の平均が入力値に一致する(±1%)', () => {
    for (const s0 of [1.6, 2.5, 3.2, 5.07, 8]) {
      expect(reconstructMean(s0, 0.21586)).toBeCloseTo(0.21586, 4);
    }
  });

  it('点数と DPR に依らない(2 組の差が 0.5% 以内)', () => {
    // BALANCED@DPR1 相当と ULTRA@DPR2 相当
    const a = reconstructMean(1.6, 0.5);
    const b = reconstructMean(5.07, 0.5);
    expect(Math.abs(a - b) / a).toBeLessThan(0.005);
  });

  it('kSprite² を落とすと水準がずれる(この検査に歯があることの証明)', () => {
    const s0 = 3.2;
    const correct = gainFor(s0);
    const wrong = (s0 * s0) / ksumLookup(s0); // kSprite を掛け忘れた版
    expect(Math.abs(wrong / correct - 1)).toBeGreaterThan(0.5);
  });
});
