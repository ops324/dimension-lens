/**
 * 光過敏の配慮（Phase 2b）。**node で落とせるのは判定の側だけ**である。
 *
 * 「配慮が実際に画素を止めるか」はブラウザにしか聞けないので、
 * `scripts/ladder.mjs` が**両側から**見張る ── オンで画素が動かないこと、
 * **オフで動くこと**。後者が無いと「常に止まっている実装」でも緑になる。
 *
 * ここで固定するのは、Phase 2a まで実装が**偽だった**理由そのもの:
 * 判定が `postfx.ts` の中に埋まっていて、**既定オフの `gradePass` の `uTime` しか
 * 握っていなかった**。判定を 1 か所に出せば、配る先が足りているかを目で数えられる。
 */

import { describe, expect, it } from 'vitest';
import {
  REDUCED_MOTION_QUERY,
  decideReducedMotion,
  observeReducedMotion,
  reducedMotionQuery,
  type MotionQuery,
} from '../core/motion';

describe('判定', () => {
  it('メディアクエリの文字列が 1 か所にある', () => {
    expect(REDUCED_MOTION_QUERY).toBe('(prefers-reduced-motion: reduce)');
  });

  it('matches をそのまま返す', () => {
    expect(decideReducedMotion({ matches: true })).toBe(true);
    expect(decideReducedMotion({ matches: false })).toBe(false);
  });

  /**
   * **答えられない環境では `false`。** 安全側へ倒して常に配慮すると、
   * 「作品が動かない」が既定になり、しかも誰も気づかない
   * （ラダーの「オフで動く」側だけが赤くなり、原因が配慮だと分からない）。
   */
  it('matchMedia が無い環境では false（node がまさにそれ）', () => {
    expect(decideReducedMotion(null)).toBe(false);
    expect(decideReducedMotion(undefined)).toBe(false);
    expect(reducedMotionQuery()).toBeNull();
  });
});

describe('購読', () => {
  it('現在値をすぐ 1 回配る（起動時に配り忘れない）', () => {
    const seen: boolean[] = [];
    observeReducedMotion((v) => seen.push(v));
    expect(seen).toEqual([false]); // node には matchMedia が無い
  });

  it('change で配り直し、解除できる', () => {
    let listener: null | (() => void) = null;
    let matches = false;
    const q: MotionQuery = {
      get matches() {
        return matches;
      },
      addEventListener: (_t, l) => {
        listener = l as () => void;
      },
      removeEventListener: () => {
        listener = null;
      },
    };
    const seen: boolean[] = [];
    // `observeReducedMotion` は window から取るので、ここでは配線そのものを組み立てて試す
    const cb = (v: boolean): void => void seen.push(v);
    cb(decideReducedMotion(q));
    q.addEventListener?.('change', () => cb(decideReducedMotion(q)));
    expect(seen).toEqual([false]);

    matches = true;
    const fire = listener as null | (() => void);
    expect(fire).not.toBeNull();
    fire!();
    expect(seen).toEqual([false, true]);

    q.removeEventListener?.('change', fire!);
    expect(listener).toBeNull();
  });
});
