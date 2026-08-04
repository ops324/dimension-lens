/**
 * 構図のフィット。
 *
 * 承認済みの到達判定は「ΔE00 ≤ 2.0 **かつ**アスペクト比が正しく、非遮蔽帯に収まる」で、
 * 監査は「後半にテストが 1 本も無い」と指摘した。ここがその 1 本。
 *
 * 要点は「収まる」だけでは足りないこと ── **どちらか一辺にちょうど接する**ことまで
 * 見ないと、式が静かに保守的で写真が小さく出ていても通ってしまう。
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_FILL, fillRatios, fitDistance } from '../core/fit';
import { imageHalfExtents } from '../image/grid';

const FOV = 50;

describe('fitDistance', () => {
  const cases: Array<[number, number, string]> = [
    [1024, 640, '3:2 横'],
    [640, 1024, '2:3 縦'],
    [512, 512, '正方'],
    [4000, 1000, '極端な横長'],
  ];

  for (const [w, h, name] of cases) {
    for (const viewportAspect of [16 / 9, 1, 9 / 16]) {
      for (const bandFrac of [1, 0.7, 0.45]) {
        it(`${name} / viewport ${viewportAspect.toFixed(2)} / 帯 ${bandFrac}: 帯に収まり、一辺に接する`, () => {
          const { aX, aY } = imageHalfExtents(w, h);
          const input = { aX, aY, viewportAspect, bandFrac, fovDeg: FOV };
          const d = fitDistance(input);
          const f = fillRatios(input, d);

          // 収まっている
          expect(f.x).toBeLessThanOrEqual(DEFAULT_FILL + 1e-9);
          expect(f.y).toBeLessThanOrEqual(DEFAULT_FILL + 1e-9);
          // かつ、どちらか一辺にちょうど接する(保守的すぎない)
          expect(Math.max(f.x, f.y)).toBeCloseTo(DEFAULT_FILL, 9);
        });
      }
    }
  }

  /**
   * `setViewOffset` は錐台を平行移動するだけで拡大縮小しない ──
   * だから帯が狭くなれば距離は `1/bandFrac` に比例して伸びなければならない。
   * ここを落とすと、下シートが 30% を覆う画面で写真が帯を 43% はみ出す。
   */
  it('帯が狭くなると距離が 1/bandFrac に比例して伸びる', () => {
    // 縦が支配的になるアスペクトを選ぶ。横が支配的だと距離は帯に依らず、
    // この比例関係は現れない(最初 0.6 を選んで落ちた ── テスト側の誤り)。
    const { aX, aY } = imageHalfExtents(1024, 640);
    const base = { aX, aY, viewportAspect: 2.0, fovDeg: FOV };
    const d1 = fitDistance({ ...base, bandFrac: 1 });
    const d07 = fitDistance({ ...base, bandFrac: 0.7 });
    // このアスペクトでは縦が効くので、比は厳密に 1/0.7
    expect(d07 / d1).toBeCloseTo(1 / 0.7, 9);
  });

  it('横長 viewport では横が効き、帯の高さを変えても距離が変わらない領域がある', () => {
    const { aX, aY } = imageHalfExtents(4000, 1000);
    const base = { aX, aY, viewportAspect: 0.5, fovDeg: FOV };
    // 極端な横長画像 × 縦長 viewport では横が支配的
    const d1 = fitDistance({ ...base, bandFrac: 1 });
    const d09 = fitDistance({ ...base, bandFrac: 0.9 });
    expect(d09).toBeCloseTo(d1, 9);
  });

  it('fill を下げると距離が伸びる', () => {
    const { aX, aY } = imageHalfExtents(1024, 640);
    const input = { aX, aY, viewportAspect: 1.5, bandFrac: 0.8, fovDeg: FOV };
    expect(fitDistance({ ...input, fill: 0.7 })).toBeGreaterThan(fitDistance(input));
  });
});
