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
  COMPRESS_KNEE,
  COMPRESS_MAX_STRENGTH,
  MEASURED_HDR_PEAKS,
  MEASURED_PEAK_ENVELOPE,
  compressChannel,
  compressStrengthFor,
  strengthForPeak,
} from '../core/compress';
import { ANCHOR_MAX, ANCHOR_MIN, GATE_RAMP } from '../render/rotationSchedule';
import { srgbToLinear } from '../color/srgb';

/** `d = 0` の目標リニア輝度（`bloom.test.ts` と同じ値。SPEC §8 が記録している） */
const D0_TARGET_LUMA = 0.26665;

describe('ニーの位置', () => {
  /**
   * **ニーの値そのものの歯**（Phase 2c で足した）。
   *
   * 2b までこの定数を留めるテストは 1 本も無かった ── 監査が逆算したところ、
   * 「代償を記録する」つもりで書いた `toBeCloseTo(0.9062, 3)` の許容 ±0.0005 が
   * **`COMPRESS_KNEE` を ±0.15% で固定していた**（`PEAK_MARGIN` は ±5.2% 素通し）。
   * つまり歯が「何を守っているか」を言えない状態だった（SPEC §7.9 の台帳の趣旨に反する）。
   * ニーを 0.8 → 0.9 にしても、当時は他の 11 本が全通過した。
   *
   * ニーは「どこまでを 1 ビットも動かさないと約束するか」そのものなので、
   * **他の主張の副作用ではなく、独立した 1 行で留める。**
   */
  it('COMPRESS_KNEE は 0.8（独立した柵。他の歯の副作用にしない）', () => {
    expect(COMPRESS_KNEE).toBe(0.8);
  });

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

  it('MEASURED_PEAK_ENVELOPE は表の最大である（データとしての整合）', () => {
    expect(MEASURED_PEAK_ENVELOPE).toBe(Math.max(...MEASURED_HDR_PEAKS.map((p) => p.peak)));
  });

  /**
   * **却下した設計が、なぜ却下されたかを機械で示す。**
   *
   * `sup y = knee + 1/s` であり、`s = strengthForPeak(V)` は `V → ∞` で
   * `1/(1−knee)` へ**単調増加するが達しない**。よってどんな有限の V を選んでも
   * `sup y > 1` ── クリップは余裕を何倍にしても消えない。
   * 2b の `PEAK_MARGIN = 1.25` はこの上限を 1.02628 にしていただけだった。
   */
  it('有限の設計峰では上限が必ず 1 を超える（余裕では消せない）', () => {
    for (const V of [1.5, 2.01758, 2.5219750000000003, 10, 1e3, 1e6]) {
      const s = strengthForPeak(V);
      const sup = COMPRESS_KNEE + 1 / s;
      expect(sup, `V=${V}`).toBeGreaterThan(1);
      expect(s, `V=${V}`).toBeLessThan(COMPRESS_MAX_STRENGTH);
    }
  });

  /**
   * **出荷の強度は極限そのもの。** `[knee, ∞) → [knee, 1)` の全単射になるので、
   * 峰がいくつであってもクリップしない ── 包絡の測定に依存しない。
   */
  it('COMPRESS_MAX_STRENGTH は 1/(1−knee)（峰を参照しない）', () => {
    expect(COMPRESS_MAX_STRENGTH).toBe(1 / (1 - COMPRESS_KNEE));
    expect(COMPRESS_KNEE + 1 / COMPRESS_MAX_STRENGTH).toBe(1);
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
   *
   * ## **予算を刻みの関数にしてはいけない**（Phase 2c-vii で直した）
   *
   * 2c-vi まで、ここは「刻み 0.005 での最大隣接差 < 0.12」だった。
   * **予算 0.12 は刻み 0.005 の性質であって、関数の性質ではない。** 実測:
   *
   * | 刻み h | 最大隣接差 | 予算 0.12 比 | `差 / h` |
   * |---|---|---|---|
   * | 0.02（4 倍粗い） | 0.42775510 | **356.5% ❌ 赤** | 21.387755 |
   * | **0.005（2c-vi）** | 0.10711370 | **89.3%（余裕 12%）** | 21.422741 |
   * | 0.00125（4 倍細かい） | 0.02678526 | 22.3% | 21.428207 |
   * | 0.000078125（64 倍） | 0.00167411 | 1.4% | 21.428570 |
   *
   * → **掃引を細かくすると検査が自動的に緩む。** 型 2 の機構（掃引の密度を上げる）を
   * 入れた瞬間に、この 1 本だけは**逆向きに働いて 4 倍緩くなる**。
   * しかも 2c-vi の時点で予算まで 11% しか余裕が無く、刻みを 4 倍粗くするだけで赤だった。
   *
   * **刻み非依存な形は代数で厳密に出る。** `f(d) = A(d)·S` で `A = smoothstep(beyond/RAMP)`、
   * `sup|smoothstep'| = 3/2` なので
   *
   * ```
   * sup|f'| = COMPRESS_MAX_STRENGTH · (3/2) / GATE_RAMP = 5 × 1.5 / 0.35 = 21.428571…
   * ```
   *
   * 実測の `差/h` はこの値へ**上から**収束する（21.428570 @ h = 1/12800）。
   * → **差ではなく `差/h` に柵を置く。** これなら刻みを変えても意味が変わらない。
   */
  it('窓の縁から連続に立ち上がる（傾きの上限。刻みに依らない）', () => {
    /** 代数の上限。`GATE_RAMP` か `COMPRESS_MAX_STRENGTH` を動かせばここが動く */
    const SUP_SLOPE = (COMPRESS_MAX_STRENGTH * 1.5) / GATE_RAMP;
    expect(SUP_SLOPE).toBeCloseTo(21.428571428571427, 12);

    // 刻みを 3 桁ぶん変えても、`差/h` は上限を超えず、上限へ収束する
    let coarsest = 0;
    for (const h of [0.02, 0.005, 0.00125, 0.0003125]) {
      let worst = 0;
      for (let d = 0; d <= 5; d += h) {
        worst = Math.max(worst, Math.abs(compressStrengthFor(d + h) - compressStrengthFor(d)));
      }
      const slope = worst / h;
      // 平均変化率は sup|f'| を超えない（平均値の定理）
      expect(slope, `h=${h} で 差/h=${slope}`).toBeLessThanOrEqual(SUP_SLOPE);
      // そして上限から 0.2% 以内 ── 「なめらか」が刻みの粗さで作られていないこと
      expect(slope, `h=${h} で 差/h=${slope}`).toBeGreaterThan(SUP_SLOPE * 0.998);
      if (h === 0.02) coarsest = slope;
    }
    // 4 倍粗い刻みでも同じ傾きが出る（＝ この柵は掃引の密度に依存しない）
    expect(coarsest).toBeCloseTo(21.387755102040817, 9);
  });

  it('有限でない dimLevel では 0（NaN を強度に流さない）', () => {
    expect(compressStrengthFor(Number.NaN)).toBe(0);
    expect(compressStrengthFor(Number.POSITIVE_INFINITY)).toBe(0);
  });

  /**
   * **実測データに対する検算。** 表の 21 点すべてで、その `dimLevel` の門を通した
   * 強度が峰を 1.0 以下へ入れる。
   *
   * **アンカー窓だけは「未満」ではなく「以下」である** ── そこは強度が厳密に 0 で
   * 圧縮が恒等なので、実測の峰 1.0 はそのまま 1.0 で通る。これはクリップではない
   * （1.0 は `OutputPass` で切られない）。門が開いている点では全単射なので厳密に 1 未満になる。
   */
  it('実測した峰が全部、その dimLevel の強度で 1.0 以下へ入る', () => {
    const clipped: string[] = [];
    for (const { d, peak } of MEASURED_HDR_PEAKS) {
      const s = compressStrengthFor(d);
      const y = compressChannel(peak, s);
      // 門が開いていれば厳密に 1 未満、閉じていれば恒等なので 1.0 ちょうどまで許す
      if (s > 0 ? y >= 1 : y > 1) clipped.push(`d=${d} peak=${peak} -> ${y.toFixed(5)}`);
    }
    expect(clipped, `クリップする点: ${clipped.join(' / ')}`).toEqual([]);
  });

  /**
   * **位相を流したときの実測（Phase 2c）。** 2b の表は位相 0 でしか測っていなかったので、
   * `MEASURED_HDR_PEAKS` に対する検算だけでは「クリップしない」を主張できない。
   * 実際に流して測った生の峰をここへ写し、同じ検算を通す。
   *
   * 出典は `SPEC.md` §4.20 と `core/compress.ts` の `MEASURED_PEAK_ENVELOPE` の表
   * （ANGLE Metal / M1 Max・988×778・標本 No.0・位相 120 秒）。
   */
  it('位相を流して実測した生の峰（101 / 266.75）でもクリップしない', () => {
    for (const [d, peak] of [[3, 101.0], [4.25, 266.75]] as const) {
      const y = compressChannel(peak, compressStrengthFor(d));
      expect(y, `d=${d} peak=${peak}`).toBeLessThan(1);
    }
  });

  /**
   * **half-float の全域でクリップしない。** 合成バッファは HalfFloat なので、
   * どんな絵でも入力は `65504` を超えない ── そこまで掃いて 1.0 未満を確かめる。
   * これが「包絡を測らなくてよい」の根拠そのものである。
   */
  it('half-float の最大 65504 まで掃いても 1.0 未満（全単射）', () => {
    for (let x = COMPRESS_KNEE; x < 65504; x *= 1.05) {
      expect(compressChannel(x, COMPRESS_MAX_STRENGTH), `x=${x}`).toBeLessThan(1);
    }
    expect(compressChannel(65504, COMPRESS_MAX_STRENGTH)).toBeLessThan(1);
  });

  /**
   * **代償を数字で残す。** 門が全開のところでは、リニア 1.0（標本の白）が
   * **厳密に 0.9** へ落ちる（sRGB でおよそ 243.45）。2b の 0.90617 から 0.73 コード下がった。
   *
   * ここは**算出値の書き写しではなく、許す下限**を書く ── 監査の指摘に従い、
   * 「白の沈みはここまで許す」を基準として置く。これを割る変更は判断の変更であって
   * 実装の詳細ではない。
   */
  it('門が全開のとき、リニア 1.0 は厳密に 0.9（圧縮の代償・許す下限）', () => {
    expect(compressChannel(1, COMPRESS_MAX_STRENGTH)).toBe(0.9);
    expect(compressChannel(1, COMPRESS_MAX_STRENGTH)).toBeGreaterThanOrEqual(0.9);
  });
});
