/**
 * アンカー窓 —— この作品が乗っている唯一の錨のテスト。
 *
 * `dimLevel = 2` が「あなたの写真そのもの」であるためには、窓の中で
 * **回転角が厳密に 0** でなければならない。「ほぼ 0」では、写真がわずかに回っている。
 *
 * ここで落とせるのは全部 node で落とせる ── GPU も rAF も要らない。
 * だから 1a-iii の中でいちばん先に書いた。
 */

import { describe, expect, it } from 'vitest';
import {
  ANCHOR_MAX,
  ANCHOR_MIN,
  advancePhases,
  cloudWeight,
  createAngleBuffer,
  createPhases,
  isAnchored,
  PLANES,
  plateWeight,
  readAngles,
  rotationGate,
} from '../render/rotationSchedule';

describe('アンカー窓', () => {
  /**
   * **窓の判定を減算で書いてはいけない。**
   *
   * `2.1 - 2 = 0.10000000000000008882` なので `Math.abs(d - 2) <= 0.1` は
   * d = 1.9 でも d = 2.1 でも **false** になる ── 窓の縁ちょうどで写真が回り出す、
   * という最も気づきにくい壊れ方をする。
   */
  it('端点が窓の中にある（減算で書くと落ちる）', () => {
    // 前提の確認: 素朴な書き方は本当に端点を落とす
    expect(Math.abs(ANCHOR_MAX - 2) <= 0.1).toBe(false);
    expect(Math.abs(ANCHOR_MIN - 2) <= 0.1).toBe(false);
    // 実装は端点を含む
    expect(isAnchored(ANCHOR_MIN)).toBe(true);
    expect(isAnchored(ANCHOR_MAX)).toBe(true);
  });

  it('窓の中では門が厳密に 0（Object.is で見る）', () => {
    for (const d of [1.9, 1.93, 1.95, 2.0, 2.05, 2.1]) {
      expect(Object.is(rotationGate(d), 0), `dimLevel=${d}`).toBe(true);
    }
  });

  it('窓の外では門が 0 より大きく、単調に増える', () => {
    expect(rotationGate(1.89)).toBeGreaterThan(0);
    expect(rotationGate(2.11)).toBeGreaterThan(0);
    let prev = 0;
    for (const d of [2.1, 2.15, 2.2, 2.3, 2.4, 2.45, 3, 5]) {
      const g = rotationGate(d);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
    expect(rotationGate(0)).toBe(1);
    expect(rotationGate(5)).toBe(1);
  });

  it('門は窓の縁で連続（跳ばない）', () => {
    const eps = 1e-7;
    expect(rotationGate(ANCHOR_MIN - eps)).toBeLessThan(1e-12);
    expect(rotationGate(ANCHOR_MAX + eps)).toBeLessThan(1e-12);
  });

  it('NaN は 0 に倒す（写真を回さない側へ）', () => {
    expect(rotationGate(Number.NaN)).toBe(0);
    expect(isAnchored(Number.NaN)).toBe(false);
  });
});

describe('位相の門つき積分', () => {
  it('窓の中では位相が 1 ビットも動かない', () => {
    const phases = createPhases();
    const before = Array.from(phases);
    for (let i = 0; i < 600; i++) advancePhases(phases, 2.0, 1 / 60);
    expect(Array.from(phases)).toEqual(before);
  });

  it('窓の中では角度が全平面で厳密に 0', () => {
    const phases = createPhases();
    // わざと窓の外で位相を溜めてから窓へ入る
    for (let i = 0; i < 600; i++) advancePhases(phases, 3.0, 1 / 60);
    expect(phases[0]).toBeGreaterThan(0);

    const out = createAngleBuffer();
    readAngles(phases, 2.0, out);
    for (const r of out) {
      expect(Object.is(r.angle, 0), `平面 (${r.i},${r.j})`).toBe(true);
    }
  });

  /**
   * `θ = gate(d)·ω·t`（絶対時刻を掛ける形）だと、窓を通過して戻ったときに
   * `ω·t` が飛んでいるので**絵が跳ねる**。位相を門つきで積分していれば跳ばない。
   */
  it('窓を通過して戻っても位相が保存される（再入で跳ねない）', () => {
    const phases = createPhases();
    for (let i = 0; i < 120; i++) advancePhases(phases, 3.0, 1 / 60);
    const atEntry = Array.from(phases);

    // 窓の中に 10 秒いる
    for (let i = 0; i < 600; i++) advancePhases(phases, 2.0, 1 / 60);
    expect(Array.from(phases)).toEqual(atEntry);

    // 出た直後の 1 ステップ分しか進んでいない
    advancePhases(phases, 3.0, 1 / 60);
    expect(phases[0] - atEntry[0]).toBeCloseTo(PLANES[0].omega / 60, 12);
  });

  it('dt が 0 以下なら何も進めない', () => {
    const phases = createPhases();
    advancePhases(phases, 3.0, 0);
    advancePhases(phases, 3.0, -1);
    expect(Array.from(phases)).toEqual([0, 0, 0, 0, 0]);
  });

  it('角度は平面の定義（i, j）をそのまま書き出す', () => {
    const out = createAngleBuffer();
    readAngles(createPhases(), 3.0, out);
    expect(out.map((r) => [r.i, r.j])).toEqual(PLANES.map((p) => [p.i, p.j]));
  });

  it('(3,4) が最も遅い —— 色相回転を一番ゆっくり見せる', () => {
    const hue = PLANES.find((p) => p.i === 3 && p.j === 4);
    expect(hue).toBeDefined();
    const faster = PLANES.filter((p) => !(p.i === 3 && p.j === 4) && p.omega > hue!.omega);
    // (0,2) と (1,2) の 2 つだけが (3,4) より速い
    expect(faster.map((p) => [p.i, p.j])).toEqual([[0, 2], [1, 2]]);
  });

  it('剛体回転 (0,1) は入れない（次元を上ることを何も語らないため）', () => {
    expect(PLANES.some((p) => p.i === 0 && p.j === 1)).toBe(false);
  });
});

describe('板と点群のクロスフェード', () => {
  /**
   * **和が 1 を外れると平坦部の値がずれる。** 加算合成なので、2 つを別々に
   * 補間して合計 1.02 になったら、その 2% がそのまま ΔE00 の予算を食う。
   */
  it('板 + 点群 = 厳密に 1（どの dimLevel でも）', () => {
    for (let d = 0; d <= 5; d += 0.01) {
      expect(plateWeight(d) + cloudWeight(d), `dimLevel=${d}`).toBe(1);
    }
  });

  it('アンカー窓では板が 1、点群が厳密に 0', () => {
    for (const d of [1.9, 1.95, 2.0, 2.05, 2.1]) {
      expect(plateWeight(d)).toBe(1);
      expect(Object.is(cloudWeight(d), 0), `dimLevel=${d}`).toBe(true);
    }
  });

  it('両端（MEAN / GRAPH）では点群が 1、板が 0', () => {
    for (const d of [0, 1, 5]) {
      expect(cloudWeight(d)).toBe(1);
      expect(plateWeight(d)).toBe(0);
    }
  });

  it('回転と同じ門から出ている（別々に調律されない）', () => {
    for (const d of [0.5, 1.7, 2.2, 3.4]) {
      expect(cloudWeight(d)).toBe(rotationGate(d));
    }
  });
});
