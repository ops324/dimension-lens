/**
 * 加算合成のモデル（Phase 2b）。**node で落とせる分だけ**を引き受ける。
 *
 * ## この 1 ファイルが引き受けている主張
 *
 *   1. `f16` / `f16TruncateToZero` が **fp16 の格子と丸めを正しく実装している**
 *   2. **どの 2 モデルも、少なくとも 1 つのケースで分かれる**（＝ 投票が成立する）
 *   3. `classifyBlend` は「いちばん近いモデル」を返さない（**0 個も返す**）
 *
 * 実際にどのモデルが当たるかは GPU にしか聞けないので、
 * それは `scripts/ladder.mjs` の G14 行が実 GPU で見る。ここで守るのは**投票の可能性**だけ ──
 * 分けられないモデルを 4 つ並べて「一致した」と言うのは `x/x` である（§7.7）。
 */

import { describe, expect, it } from 'vitest';
import {
  BLEND_MODELS,
  F16_MAX,
  F16_MIN_NORMAL,
  F16_MIN_SUBNORMAL,
  OBSERVED_BLEND_MODEL,
  binaryContribution,
  blendCases,
  classifyBlend,
  f16,
  f16TruncateToZero,
  type BlendModelKey,
} from '../image/blendModel';
import { halfToFloat } from '../core/capture';
import {
  f16AccumulateTruncate,
  f16RelativeError,
  f16RelativeErrorTruncate,
} from '../image/halfFloat';

describe('fp16 のエンコード', () => {
  /**
   * **`Float16Array` と突き合わせる。** 自前で書いた理由は独立性だが、
   * 独立に書いたものが正しいかは別の実装と比べるしかない。
   * `halfToFloat`（デコード側・`core/capture.ts`）は自前実装どうしなので、
   * ここは**処理系の実装**を第 3 の証人にする。
   */
  it('最近接偶数丸めが Float16Array と 1 ビットも違わない（20 万点）', () => {
    const ref = new Float16Array(1);
    let mismatches = 0;
    // 決定的な擬似乱数（LCG）── 落ちたときに再現できないテストは歯にならない
    let seed = 0x2b1d;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 200_000; i++) {
      const x = (rnd() - 0.5) * 10 ** (rnd() * 10 - 6);
      ref[0] = x;
      if (!Object.is(ref[0], f16(x))) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  /**
   * **`npm run teeth` が抜けた歯として教えてくれた**（Phase 2b）。
   *
   * `roundTiesToEven` を「常に上へ」に変えても 391 件が緑だった ── 乱数は
   * ちょうど中点を踏まないし、`f16(65520) → Infinity` の境界は
   * 偶数側へ丸めても切り上げても同じ答えになる。**中点を明示的に置く。**
   */
  it('ちょうど中点で偶数側へ丸める（ties-to-even）', () => {
    // ulp(1) = 2⁻¹⁰。1 + 0.5 ulp は仮数 1024（偶数）へ戻る
    expect(f16(1 + 2 ** -11)).toBe(1);
    // 1 + 1.5 ulp は仮数 1025（奇数）なので 1026 側 = 1 + 2 ulp へ上がる
    expect(f16(1 + 3 * 2 ** -11)).toBe(1 + 2 * 2 ** -10);
    expect(f16(-(1 + 2 ** -11))).toBe(-1);
    // 非正規域の中点も同じ規則（ulp = 2⁻²⁴）
    expect(f16(2 ** -24 * 2.5)).toBe(2 ** -24 * 2);
    expect(f16(2 ** -24 * 3.5)).toBe(2 ** -24 * 4);
  });

  /**
   * **中点だけを狙って `Float16Array` と突き合わせる。** 上の 20 万点は
   * 一様乱数なので中点を 1 度も踏まない ── 丸め規則を問うなら、問える点を作る。
   */
  it('fp16 格子の全中点で Float16Array と一致する（正規域を網羅）', () => {
    const ref = new Float16Array(1);
    let mismatches = 0;
    for (let e = -14; e <= 14; e++) {
      const ulp = 2 ** (e - 10);
      for (let m = 0; m < 1024; m++) {
        const mid = 2 ** e + (m + 0.5) * ulp;
        ref[0] = mid;
        if (!Object.is(ref[0], f16(mid))) mismatches++;
        ref[0] = -mid;
        if (!Object.is(ref[0], f16(-mid))) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  });

  it('非正規域・境界・飽和', () => {
    expect(f16(0)).toBe(0);
    expect(f16(F16_MIN_SUBNORMAL)).toBe(F16_MIN_SUBNORMAL);
    expect(f16(F16_MIN_SUBNORMAL / 4)).toBe(0);
    expect(f16(F16_MIN_NORMAL)).toBe(F16_MIN_NORMAL);
    expect(f16(F16_MAX)).toBe(F16_MAX);
    // 65520 は 65504 と 65536 の中点。**偶数側（65536）へ行く → Infinity**
    expect(f16(65519)).toBe(F16_MAX);
    expect(f16(65520)).toBe(Infinity);
    expect(f16(-65520)).toBe(-Infinity);
  });

  /**
   * **切り捨てと最近接が実際に違うことを確かめる。** 同じ値になる実装を 2 つ持っていても
   * モデルは分かれない ── ここが緑でなければ G14 の判定は意味を失う。
   */
  it('0 方向への切り捨ては最近接と別物で、常に 0 側へ寄る', () => {
    // ulp(1) = 2⁻¹⁰。1 + 0.9 ulp は最近接なら繰り上がり、切り捨てなら 1 のまま
    const x = 1 + 0.9 * 2 ** -10;
    expect(f16(x)).toBe(1 + 2 ** -10);
    expect(f16TruncateToZero(x)).toBe(1);
    // 符号があっても「0 方向」であること（−1.9 ulp → −1 ulp 側）
    expect(f16TruncateToZero(-x)).toBe(-1);
    // 切り捨ては Infinity へ行かない
    expect(f16TruncateToZero(70000)).toBe(F16_MAX);
  });

  it('デコード側（halfToFloat）と往復する', () => {
    for (const bits of [0x3c00, 0x4000, 0x0001, 0x0400, 0x4100, 0x3400]) {
      const v = halfToFloat(bits);
      expect(f16(v)).toBe(v);
      expect(f16TruncateToZero(v)).toBe(v);
    }
  });
});

describe('規定した値の並びが、どのモデルの組も分ける', () => {
  const cases = blendCases();

  it('自己検査のケースは 4 モデルとも 1.75（器具の判定に使えること）', () => {
    const c = cases.find((x) => x.key === 'selftest-exact');
    expect(c).toBeDefined();
    for (const m of BLEND_MODELS) expect(m.run(c!.values)).toBe(1.75);
    expect(c!.separates).toEqual([]);
  });

  /**
   * **これが主張の本体。** 4 つのモデルの総当たり 6 組すべてについて、
   * 「少なくとも 1 つのケースで、判定の許容（1e−6）より広くずれる」ことを要求する。
   * 分けられない組が 1 つでも残っていたら、その 2 つは投票で区別できない。
   */
  it('総当たりの全組が、少なくとも 1 ケースで判定の許容より広く分かれる', () => {
    const unresolved: string[] = [];
    for (let i = 0; i < BLEND_MODELS.length; i++) {
      for (let j = i + 1; j < BLEND_MODELS.length; j++) {
        const a = BLEND_MODELS[i];
        const b = BLEND_MODELS[j];
        const split = cases.some((c) => {
          const pa = a.run(c.values);
          const pb = b.run(c.values);
          return Math.abs(pa - pb) / Math.max(Math.abs(pa), Math.abs(pb), F16_MIN_NORMAL) > 1e-5;
        });
        if (!split) unresolved.push(`${a.key} / ${b.key}`);
      }
    }
    expect(unresolved, `分けられないモデルの組: ${unresolved.join(', ')}`).toEqual([]);
  });

  it('各ケースが宣言した組を実際に分けている（台帳が実装からずれていない）', () => {
    for (const c of cases) {
      for (const [ka, kb] of c.separates) {
        const a = BLEND_MODELS.find((m) => m.key === ka)!;
        const b = BLEND_MODELS.find((m) => m.key === kb)!;
        const pa = a.run(c.values);
        const pb = b.run(c.values);
        const rel = Math.abs(pa - pb) / Math.max(Math.abs(pa), Math.abs(pb), F16_MIN_NORMAL);
        expect(rel, `${c.key}: ${ka} と ${kb} が分かれていない`).toBeGreaterThan(1e-5);
      }
    }
  });

  /**
   * §4.6 が記録した「暗い列の 1 点あたりの寄与は 3.0e−5 で、fp16 の最小正規数を下回る」を、
   * ケースの構成がいまも満たしていることを見張る。ここが崩れると
   * `subnormal-tail` と `binary-dark-first` が非正規数モデルを問わなくなる。
   */
  it('二値ケースの暗い側が fp16 の非正規域に落ちている（§4.6 の条件）', () => {
    expect(binaryContribution(30)).toBeLessThan(F16_MIN_NORMAL);
    expect(binaryContribution(199)).toBeGreaterThan(F16_MIN_NORMAL);
  });

  it('積む順序が結果を変える（順序依存そのものが判別器である）', () => {
    const bright = cases.find((c) => c.key === 'binary-bright-first')!;
    const dark = cases.find((c) => c.key === 'binary-dark-first')!;
    // 同じ多重集合であること（並べ替えただけ）
    expect([...bright.values].sort().join()).toBe([...dark.values].sort().join());
    // それでも最近接モデルの結果は違う
    const f16Model = BLEND_MODELS.find((m) => m.key === 'f16')!;
    expect(f16Model.run(bright.values)).not.toBe(f16Model.run(dark.values));
  });
});

describe('判定', () => {
  it('どのモデルからも遠ければ matches は空になる（最近傍で答えを作らない）', () => {
    const v = classifyBlend('x', [1, 0.5, 0.25], 42);
    expect(v.matches).toEqual([]);
  });

  /**
   * **許容は最小の分離幅より小さくなければならない。** そうでないと
   * `f16-vs-f32`（差 9.76e−4）で f32 と f16 が同時に「一致」して、投票が成立しない。
   */
  it('既定の許容が、どの 2 モデルの最小の分離幅よりも小さい', () => {
    let minSplit = Infinity;
    for (const c of blendCases()) {
      for (let i = 0; i < BLEND_MODELS.length; i++) {
        for (let j = i + 1; j < BLEND_MODELS.length; j++) {
          const pa = BLEND_MODELS[i].run(c.values);
          const pb = BLEND_MODELS[j].run(c.values);
          const rel = Math.abs(pa - pb) / Math.max(Math.abs(pa), Math.abs(pb), F16_MIN_NORMAL);
          if (rel > 0) minSplit = Math.min(minSplit, rel);
        }
      }
    }
    // 既定の許容は 1e−6。最小の分離は `f16-vs-f32` の 9.76e−4
    expect(minSplit).toBeGreaterThan(1e-5);
    const v = classifyBlend('probe', blendCases()[1].values, 1);
    expect(v.matches).toEqual(['f16', 'f16-flush', 'f16-rtz']);
  });

  it('厳密に一致したモデルだけを返す', () => {
    const values = blendCases().find((c) => c.key === 'uniform-378')!.values;
    for (const m of BLEND_MODELS) {
      const v = classifyBlend('uniform-378', values, m.run(values));
      expect(v.matches).toContain(m.key);
    }
  });

  /**
   * **Phase 2b の実測結果を、コメントではなく機械が読める形で固定する。**
   * ここを書き換えずにモデルの名前を変えると落ちる。
   */
  it('実測が選んだモデルの ID が実在する', () => {
    const keys = BLEND_MODELS.map((m) => m.key) as BlendModelKey[];
    expect(keys).toContain(OBSERVED_BLEND_MODEL);
    expect(OBSERVED_BLEND_MODEL).toBe('f16-rtz');
  });
});

/**
 * **実機の丸めモードで作り直した予算**（Phase 2b・SPEC §4.6 の表）。
 *
 * 旧表は `Float16Array`（最近接）で作られていた。切り捨てでは誤差が打ち消し合わないので、
 * 同じ深度でも ΔE00 は 1.8 倍ほど悪い ── **`LINE_MAX_POINTS = 512` の余裕は
 * 1.364 ではなく 2.439 だった**（予算 3.0 の内側ではある）。
 */
describe('加算深度の予算（実機の丸めモード）', () => {
  const TARGET = 0.21586050011389923; // sRGB 128

  it('切り捨ての誤差は構成上つねに 0 以下（片側にしか外れない）', () => {
    for (const n of [1, 2, 4, 16, 64, 128, 256, 378, 512, 1024, 2048]) {
      expect(f16RelativeErrorTruncate(TARGET, n), `n=${n}`).toBeLessThanOrEqual(0);
    }
  });

  it('深さが増えるほど暗くなる（単調・最近接ではこうならない）', () => {
    const depths = [16, 64, 128, 256, 512, 1024, 2048];
    for (let i = 1; i < depths.length; i++) {
      expect(
        f16AccumulateTruncate(TARGET, depths[i]),
        `n=${depths[i]} が n=${depths[i - 1]} より明るい`,
      ).toBeLessThan(f16AccumulateTruncate(TARGET, depths[i - 1]));
    }
  });

  it('SPEC §4.6 の表を作り直した値と一致する', () => {
    expect(f16RelativeErrorTruncate(TARGET, 512) * 100).toBeCloseTo(-10.311, 2);
    expect(f16RelativeErrorTruncate(TARGET, 378) * 100).toBeCloseTo(-7.709, 2);
    expect(f16RelativeErrorTruncate(TARGET, 16) * 100).toBeCloseTo(-0.188, 2);
    // Phase 2a が深度を 378 → 1 にした効果
    expect(Math.abs(f16RelativeErrorTruncate(TARGET, 1))).toBeLessThan(0.0005);
  });

  /**
   * **最近接では気づけなかったことを、機械の形で残す。**
   * 旧モデルは n=512 で「−4.939%」を出しており、実機の −10.311% の半分以下だった。
   */
  it('最近接のモデルは実機より一貫して楽観的である', () => {
    for (const n of [128, 256, 512, 1024, 2048]) {
      expect(f16RelativeError(TARGET, n), `n=${n}`).toBeGreaterThan(
        f16RelativeErrorTruncate(TARGET, n),
      );
    }
  });
});
