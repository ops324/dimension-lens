/**
 * **bloom の閾値の柵**（Phase 2b）。定数を触る**前**に置く。
 *
 * ## なぜ強度ではなく閾値が危険なのか
 *
 * `UnrealBloomPass` は `luma < threshold` の画素を完全に落とし、
 * `[threshold, threshold + smoothWidth]` で滑らかに通す。つまり:
 *
 *   - **強度**を動かしても、閾値の下にある画素は 1 ビットも動かない
 *   - **閾値**を下げると、平坦部そのものが光り始める
 *
 * そして `d = 0` の目標リニア輝度（標本 No.0 の平均色の Rec.709 輝度）は **0.265546**、
 * 現在の閾値は **0.28** ── **1.0544 倍しかない**。
 * 閾値を 5% 下げただけで **G9 の測定点が bloom の内側へ入り**、
 * 忠実性の測定と後処理の混入が区別できなくなる。
 * （SPEC §8 の **0.26665** は `srgbToLinear(141/255)` ＝ G9 が報告する**符号値の戻し**で、
 * 平均色の輝度そのものではなかった。下の 1 本目が訂正している。）
 *
 * §8 は「1 つの PR に入れると bloom を触った PR の中で G9 も動く」ので
 * Phase 2 を割った、と書いている。**柵はその判断を仕組みにしたものである** ──
 * 順序（柵 → 定数）が保証になっているので、柵の側を先に書く。
 *
 * ## 一般の画像について（隠さない）
 *
 * 標本 No.0 で足りていることは、**ユーザーの写真で足りていることを意味しない**。
 * 閾値 0.28 は「平均リニア輝度が 0.28 を超える画像では、`d = 0` の点が bloom の内側に入る」
 * ということでもある（明るい写真では実際に起きる）。出荷時 `bloomPass.enabled = false` なので
 * いまは誰も踏まないが、**bloom を出荷で入れる PR は、この柵を一般化してから**でなければならない。
 */

import { describe, expect, it } from 'vitest';
import {
  BLOOM_BASE_RADIUS,
  BLOOM_BASE_STRENGTH,
  BLOOM_BASE_THRESHOLD,
  BLOOM_SMOOTH_WIDTH,
  LUMA_WEIGHTS,
  luma709,
} from '../core/bloom';
import { makeSpecimen0 } from '../image/fixture';
import { SRGB_TO_LINEAR_LUT, srgbToLinear } from '../color/srgb';

/** `core/bloom.ts` の `luma709` をそのまま使う（同じ式を 2 か所に書かない） */
const luma = luma709;

/**
 * 標本 No.0 の**リニア光の全体平均**。`d = 0` で 1 点へ潰したときに出るべき色で、
 * G9 / G9z が採点している目標そのものである（`scripts/ladder.mjs` の `centreTarget`）。
 */
function specimenMeanLinear(): [number, number, number] {
  const s = makeSpecimen0();
  const n = s.width * s.height;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    r += SRGB_TO_LINEAR_LUT[s.rgba[i * 4]];
    g += SRGB_TO_LINEAR_LUT[s.rgba[i * 4 + 1]];
    b += SRGB_TO_LINEAR_LUT[s.rgba[i * 4 + 2]];
  }
  return [r / n, g / n, b / n];
}

/**
 * 閾値が目標輝度を上回っていなければならない**最小の比**。
 *
 * 1.00 にすると「0.26666 でも通る」ので柵にならない ── 予算が緩すぎる方に外れると
 * **永久に緑のまま気づかない**（`scripts/teeth.mjs` の冒頭）。
 * 実測の比は 1.0544 なので、**現状のちょうど下**へ置いて、下げたら落ちるようにする。
 */
const MIN_THRESHOLD_RATIO = 1.04;

describe('bloom の閾値', () => {
  /**
   * **SPEC §8 の 0.26665 を訂正する。** 標本 No.0 のリニア平均は
   * `R 0.267656 / G 0.264427 / B 0.270423`、その Rec.709 輝度は **0.265546** である。
   * 0.26665 に近いのは `srgbToLinear(141/255) = 0.26636` ── G9 が報告する
   * **符号値 141 を戻したもの**で、平均色の輝度そのものではない。
   * 比は 1.0500 ではなく **1.0544** になる（結論は変わらないが、数字は直す）。
   */
  it('d = 0 の目標リニア輝度は 0.265546（SPEC の 0.26665 は符号値 141 の戻しだった）', () => {
    const [r, g, b] = specimenMeanLinear();
    expect(r).toBeCloseTo(0.267656, 6);
    expect(g).toBeCloseTo(0.264427, 6);
    expect(b).toBeCloseTo(0.270423, 6);
    expect(luma(r, g, b)).toBeCloseTo(0.265546, 6);
  });

  /**
   * bloom の高域通過が見ているのは輝度だが、**最大チャンネル**も閾値の下に置いておく。
   * 輝度だけを見て通した設計は、青が強い画像で「輝度は低いのに 1 チャンネルが光る」を許す。
   */
  it('平均色の最大チャンネルも閾値の下にある', () => {
    const [r, g, b] = specimenMeanLinear();
    expect(Math.max(r, g, b)).toBeLessThan(BLOOM_BASE_THRESHOLD);
  });

  /**
   * **この 1 本が Phase 2b の柵である。**
   * 閾値を目標輝度へ近づける変更は、ここで落ちる。
   */
  it('閾値が d = 0 の平均色の輝度より十分上にある', () => {
    const [r, g, b] = specimenMeanLinear();
    const target = luma(r, g, b);
    expect(
      BLOOM_BASE_THRESHOLD / target,
      `閾値 ${BLOOM_BASE_THRESHOLD} は目標輝度 ${target.toFixed(5)} の`
        + ` ${(BLOOM_BASE_THRESHOLD / target).toFixed(4)} 倍しかない。`
        + ' 下げると G9 の測定点が bloom の内側へ入り、忠実性の測定が後処理の混入と'
        + ' 区別できなくなる（SPEC §8）。',
    ).toBeGreaterThanOrEqual(MIN_THRESHOLD_RATIO);
  });

  it('閾値がアンカーの平坦部（sRGB 128）の輝度より上にある', () => {
    const flat = srgbToLinear(128 / 255);
    expect(flat).toBeCloseTo(0.21586, 5);
    // グレー軸なので輝度は成分と等しい
    expect(luma(flat, flat, flat)).toBeCloseTo(flat, 12);
    expect(BLOOM_BASE_THRESHOLD).toBeGreaterThan(flat);
  });

  /**
   * 立ち上がりは閾値の**上**にあるので、「目標 < 閾値」だけで完全に落ちる。
   * ここが逆（下へ広がる）だと、上の 2 本の柵は 1 段甘くなる。
   */
  it('立ち上がりが閾値の上側にあるので、柵は「目標 < 閾値」で足りる', () => {
    expect(BLOOM_SMOOTH_WIDTH).toBeGreaterThan(0);
    const [r, g, b] = specimenMeanLinear();
    expect(luma(r, g, b)).toBeLessThan(BLOOM_BASE_THRESHOLD);
  });

  it('輝度の重みが Rec.709 で、和が 1（別の量に対する柵になっていない）', () => {
    expect(LUMA_WEIGHTS).toEqual([0.2126, 0.7152, 0.0722]);
    expect(LUMA_WEIGHTS[0] + LUMA_WEIGHTS[1] + LUMA_WEIGHTS[2]).toBeCloseTo(1, 12);
  });

  /** 親の Phase 11 の値。**2b では触らない**（触ったら差分に出る） */
  it('強度と半径は親から継いだ値のまま', () => {
    expect(BLOOM_BASE_STRENGTH).toBe(0.4);
    expect(BLOOM_BASE_RADIUS).toBe(0.25);
  });
});
