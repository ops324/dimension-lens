/**
 * `CompressPass` の定数と機構（Phase 2b）。
 *
 * ## この 1 ファイルが引き受けている主張
 *
 *   1. **ニーは錨より上にある** ── `d = 2` の平坦部（0.21586）と `d = 0` の平均色（0.26665）は
 *      `uStrength` が何であれ 1 ビットも動かない
 *   2. **アンカー窓では強度が厳密に 0** ── しかも「峰が 1.0 以下だった」という測定の偶然ではなく、
 *      `rotationGate` と同じ門から出る**構造**として
 *   3. **実測した峰が、圧縮後に全部 1.0 以下へ入る** ── 強度が足りているかを、
 *      探索ではなく実測データに対する検算で確かめる
 *
 * `uKnee = 0.8` は Phase 1a-iii でこの repo に置かれた**未計測のリテラル**で、
 * 親（dimension）には `CompressPass` そのものが無い。2a まで `setCompressStrength` を
 * 呼ぶ者もいなかった ── **配線されていない未計測の定数**だった。
 * 2b で `readbackHDR` により分布を測り、配線し、ここに柵を置いた。
 */

import { describe, expect, it } from 'vitest';
import {
  ANCHOR_FLAT_LINEAR,
  COMPRESS_DESIGN_PEAK,
  COMPRESS_KNEE,
  COMPRESS_MAX_STRENGTH,
  MEASURED_HDR_PEAKS,
  MEASURED_PEAK_ENVELOPE,
  PEAK_MARGIN,
  compressChannel,
  compressStrengthFor,
  strengthForPeak,
} from '../core/compress';
import { ANCHOR_MAX, ANCHOR_MIN } from '../render/rotationSchedule';
import { srgbToLinear } from '../color/srgb';

/** `d = 0` の目標リニア輝度（`bloom.test.ts` と同じ値。SPEC §8 が記録している） */
const D0_TARGET_LUMA = 0.26665;

describe('ニーの位置', () => {
  it('アンカーの平坦部（sRGB 128）がニーの下にある', () => {
    expect(ANCHOR_FLAT_LINEAR).toBeCloseTo(srgbToLinear(128 / 255), 15);
    expect(ANCHOR_FLAT_LINEAR).toBeLessThan(COMPRESS_KNEE);
  });

  it('d = 0 の平均色がニーの下にある', () => {
    expect(D0_TARGET_LUMA).toBeLessThan(COMPRESS_KNEE);
  });

  it('ニー以下は強度に依らず厳密な恒等（0 から 4 桁ぶん掃く）', () => {
    for (const s of [0, 1e-6, 0.5, COMPRESS_MAX_STRENGTH, 1e4]) {
      for (let x = 0; x <= COMPRESS_KNEE; x += COMPRESS_KNEE / 512) {
        expect(Object.is(compressChannel(x, s), x)).toBe(true);
      }
      expect(Object.is(compressChannel(COMPRESS_KNEE, s), COMPRESS_KNEE)).toBe(true);
      expect(Object.is(compressChannel(ANCHOR_FLAT_LINEAR, s), ANCHOR_FLAT_LINEAR)).toBe(true);
      expect(Object.is(compressChannel(D0_TARGET_LUMA, s), D0_TARGET_LUMA)).toBe(true);
    }
  });

  it('強度 0 はニーの上でも厳密な恒等（シェーダの早期 return と同じ約束）', () => {
    for (const x of [0.9, 1, 1.5, 2, 10]) {
      expect(Object.is(compressChannel(x, 0), x)).toBe(true);
    }
  });
});

describe('強度は代数で決まる', () => {
  it('strengthForPeak は峰をちょうど 1.0 へ落とす', () => {
    for (const peak of [1.05, 1.5, 2, 2.5219750000000003, 8]) {
      const s = strengthForPeak(peak);
      expect(compressChannel(peak, s)).toBeCloseTo(1, 12);
    }
  });

  it('峰が 1.0 以下なら強度は 0（＝ 圧縮パスが恒等）', () => {
    for (const peak of [0, 0.5, 0.9999, 1]) expect(strengthForPeak(peak)).toBe(0);
  });

  it('設計の峰は実測の包絡に余裕を掛けたもので、余裕は定数として見える', () => {
    expect(MEASURED_PEAK_ENVELOPE).toBe(Math.max(...MEASURED_HDR_PEAKS.map((p) => p.peak)));
    expect(PEAK_MARGIN).toBeGreaterThan(1);
    expect(COMPRESS_DESIGN_PEAK).toBeCloseTo(MEASURED_PEAK_ENVELOPE * PEAK_MARGIN, 12);
    expect(COMPRESS_MAX_STRENGTH).toBe(strengthForPeak(COMPRESS_DESIGN_PEAK));
  });
});

describe('出荷経路の配線', () => {
  /**
   * **アンカー窓は構造で守る。** 実測では `d = 2` の峰がちょうど 1.0 だったが、
   * 「測ったら 1.0 以下だった」という偶然に錨を預けない ──
   * 別の画像・別のティアで 1.0 を 1 ULP でも超えたら強度が立ち上がってしまう。
   */
  it('アンカー窓の全域で強度が厳密に 0', () => {
    for (let d = ANCHOR_MIN; d <= ANCHOR_MAX + 1e-12; d += 0.001) {
      expect(Object.is(compressStrengthFor(d), 0), `d=${d}`).toBe(true);
    }
    expect(Object.is(compressStrengthFor(ANCHOR_MIN), 0)).toBe(true);
    expect(Object.is(compressStrengthFor(ANCHOR_MAX), 0)).toBe(true);
  });

  /**
   * **窓の縁で跳ねないこと。** `d = 2` では 0.8 を超える画素が 6 万個ある（白マーカーと
   * ランプの上端）ので、強度が窓の縁で 0 → 4.4 へ飛ぶと**白がストンと落ちて見える**。
   * `rotationGate` は `smoothstep` なので C¹ ── 速度も 0 から始まる。
   */
  it('窓の縁から連続に立ち上がる（隣り合う刻みの差が小さい）', () => {
    let worst = 0;
    for (let d = 0; d <= 5; d += 0.005) {
      worst = Math.max(worst, Math.abs(compressStrengthFor(d + 0.005) - compressStrengthFor(d)));
    }
    // 門は 0.35 の幅で 0→1 なので、0.005 刻みの最大差は 1.5·s·(0.005/0.35) 程度
    expect(worst).toBeLessThan(0.12);
  });

  it('有限でない dimLevel では 0（NaN を強度に流さない）', () => {
    expect(compressStrengthFor(Number.NaN)).toBe(0);
    expect(compressStrengthFor(Number.POSITIVE_INFINITY)).toBe(0);
  });

  /**
   * **実測データに対する検算。** 探索で強度を決めていない証拠でもある ──
   * 表の 21 点すべてで、その `dimLevel` の門を通した強度が峰を 1.0 以下へ入れる。
   */
  it('実測した峰が全部、その dimLevel の強度で 1.0 以下へ入る', () => {
    const clipped: string[] = [];
    for (const { d, peak } of MEASURED_HDR_PEAKS) {
      const y = compressChannel(peak, compressStrengthFor(d));
      if (y > 1 + 1e-12) clipped.push(`d=${d} peak=${peak} -> ${y.toFixed(5)}`);
    }
    expect(clipped, `クリップする点: ${clipped.join(' / ')}`).toEqual([]);
  });

  /**
   * **代償を数字で残す。** 門が全開のところでは、リニア 1.0（標本の白）が
   * 0.906 まで落ちる。これは圧縮の仕事であって欠陥ではないが、
   * 「気づかないうちに白が沈んだ」にならないよう機械に書き留めておく。
   */
  it('門が全開のとき、リニア 1.0 は 0.906 付近へ落ちる（圧縮の代償）', () => {
    expect(compressChannel(1, COMPRESS_MAX_STRENGTH)).toBeCloseTo(0.9062, 3);
  });
});
