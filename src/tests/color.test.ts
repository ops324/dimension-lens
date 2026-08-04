import { describe, expect, it } from 'vitest';
import {
  SRGB_TO_LINEAR_LUT,
  linearToCode,
  linearToSrgb,
  srgbToLinear,
} from '../color/srgb';
import { P3, SRGB, linearToOklab, oklabToLinear, primariesFor } from '../color/oklab';
import { deltaE2000, linearToLab, xyzToLab } from '../color/deltaE';
import { wrapPi } from '../math/angle';

describe('srgb', () => {
  it('区分関数の折れ点を両側で正しく扱う', () => {
    /**
     * **sRGB 規格そのものが折れ点で厳密には連続していない。** 12.92 と
     * (0.055, 1.055, 2.4) は独立に丸められた値なので、0.0031308 の両側で
     * **実測 2.85e-8** の段差が残る ── 規格の性質であって実装の誤りではない。
     * ここを 1e-9 で締めると正しい実装が落ちる(最初そう書いて落ちた)。
     * 上界は実測値のすぐ上に置く: これより大きければ丸めではなく実装の誤り。
     */
    const eps = 1e-12;
    expect(srgbToLinear(0.04045 - eps)).toBeCloseTo(srgbToLinear(0.04045 + eps), 7);
    const gap = Math.abs(
      linearToSrgb(0.0031308 + eps) - linearToSrgb(0.0031308 - eps),
    );
    expect(gap).toBeGreaterThan(1e-9);
    expect(gap).toBeLessThan(5e-8);
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 15);
  });

  it('2.2 乗の近似ではない', () => {
    // 中間調でずれることが本質。近似だと 0.2176 になる
    expect(srgbToLinear(0.5)).toBeCloseTo(0.21404114, 8);
    expect(Math.pow(0.5, 2.2)).not.toBeCloseTo(0.21404114, 4);
  });

  it('全 256 コード値がビット厳密に往復する', () => {
    for (let v = 0; v < 256; v++) {
      expect(linearToCode(SRGB_TO_LINEAR_LUT[v])).toBe(v);
    }
  });

  it('LUT は解析関数と一致する', () => {
    for (let v = 0; v < 256; v++) {
      expect(SRGB_TO_LINEAR_LUT[v]).toBe(srgbToLinear(v / 255));
    }
  });

  it('sRGB 128 のリニア値(二重適用の検出基準)', () => {
    expect(SRGB_TO_LINEAR_LUT[128]).toBeCloseTo(0.21586, 5);
    // 二重適用したときの値。5.6 倍ずれるので見逃せない
    expect(SRGB_TO_LINEAR_LUT[55]).toBeCloseTo(0.0382, 4);
  });
});

describe('oklab', () => {
  /**
   * **設計は「導出行列が Ottosson の公表係数と 1e-9 で一致する」ことを
   * パラメータ化の全正当化としていた。これは偽である。**
   *
   * 実測: M1 に標準的な sRGB→XYZ 行列を掛けても公表係数には一致しない ──
   * IEC 丸め 3.0e-4 / Lindbloom 1.5e-4 / 規格4桁 2.9e-4。彼は行列を丸めた形で
   * 公表しているので、そもそも合成では再現できない。
   *
   * よって主張を**一致から、実測した上界**へ書き換える。パラメータ化の正当化は
   * 「白が両原色で厳密に中性へ写ること」のほうが担う(下のテスト)。
   */
  it('導出した sRGB→LMS 行列は Ottosson の公表係数と 2e-4 以内(一致ではない)', () => {
    const published = [
      0.4122214708, 0.5363325363, 0.0514459929,
      0.2119034982, 0.6806995451, 0.1073969566,
      0.0883024619, 0.2817188376, 0.6299787005,
    ];
    let max = 0;
    for (let i = 0; i < 9; i++) max = Math.max(max, Math.abs(SRGB.toLMS[i] - published[i]));
    expect(max).toBeLessThan(2e-4);
    // かつ、1e-9 では**一致しない**ことも固定する(設計の主張が偽だった証拠)
    expect(max).toBeGreaterThan(1e-9);
  });

  it('白は L=1, a は厳密に 0 —— 両方の原色で(行の白色正規化の帰結)', () => {
    const out = new Float64Array(3);
    for (const p of [SRGB, P3]) {
      linearToOklab(p, 1, 1, 1, out);
      expect(out[0]).toBeCloseTo(1, 7);
      // 正規化により LMS=(1,1,1) → cbrt=(1,1,1) → a は M2 行の和。
      // 残るのは**機械イプシロン**だけ(実測 1.7e-16)。正規化前は 1.0e-5 で、
      // 11 桁改善している ── これが「定義が要求する性質へ戻す」ことの効果。
      expect(Math.abs(out[1])).toBeLessThan(1e-15);
      // b は M2 の丸め残差のみ(3.7e-8)
      expect(Math.abs(out[2])).toBeLessThan(1e-7);
    }
  });

  it('グレーは彩度をほぼ持たない —— 退化判定のしきい値より 2 桁小さい', () => {
    const out = new Float64Array(3);
    for (const v of [0.05, 0.2, 0.5, 0.9]) {
      linearToOklab(SRGB, v, v, v, out);
      expect(Math.hypot(out[1], out[2])).toBeLessThan(2e-5);
    }
  });

  it('公表参照値: #FF0000 → (0.6279, 0.2249, 0.1258) を 1e-3 で再現', () => {
    // 行列の丸めと白色正規化のぶん、公表値からは 1e-4 台ずれる。
    // 「4 桁一致」ではなく「1e-3 以内」が言える範囲。
    const out = new Float64Array(3);
    linearToOklab(SRGB, 1, 0, 0, out);
    expect(out[0]).toBeCloseTo(0.6279, 3);
    expect(out[1]).toBeCloseTo(0.2249, 3);
    expect(out[2]).toBeCloseTo(0.1258, 3);
  });

  it('リニア→OKLab→リニアが往復する(1e-9)', () => {
    const lab = new Float64Array(3);
    const back = new Float64Array(3);
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (const p of [SRGB, P3]) {
      for (let k = 0; k < 2000; k++) {
        const r = rnd();
        const g = rnd();
        const b = rnd();
        linearToOklab(p, r, g, b, lab);
        oklabToLinear(p, lab[0], lab[1], lab[2], back);
        expect(back[0]).toBeCloseTo(r, 10);
        expect(back[1]).toBeCloseTo(g, 10);
        expect(back[2]).toBeCloseTo(b, 10);
      }
    }
  });

  it('sRGB の最大彩度は約 0.3225、P3 は約 0.3685 —— どちらも RMAX=0.40 の内側', () => {
    const out = new Float64Array(3);
    let maxS = 0;
    let maxP = 0;
    const corners = [
      [1, 0, 0], [0, 1, 0], [0, 0, 1],
      [1, 1, 0], [1, 0, 1], [0, 1, 1],
    ];
    for (const [r, g, b] of corners) {
      linearToOklab(SRGB, r, g, b, out);
      maxS = Math.max(maxS, Math.hypot(out[1], out[2]));
      linearToOklab(P3, r, g, b, out);
      maxP = Math.max(maxP, Math.hypot(out[1], out[2]));
    }
    expect(maxS).toBeCloseTo(0.3225, 3);
    expect(maxP).toBeLessThan(0.4);
    expect(maxP).toBeGreaterThan(maxS);
  });

  it('primariesFor は名前で引ける', () => {
    expect(primariesFor('srgb')).toBe(SRGB);
    expect(primariesFor('display-p3')).toBe(P3);
  });
});

describe('deltaE2000', () => {
  /**
   * Sharma–Wu–Dalal (2005) の公表テストペアのうち、縮退分岐と大差ケースを含む部分集合。
   * **全 34 対ではない** —— 記憶からの転記を避け、確度の高いものだけを置く。
   * 残りは公表表を参照して追加すること(その PR で水準が上がる)。
   */
  const PAIRS: Array<[number[], number[], number]> = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[50, -1.1848, -84.8006], [50, 0, -82.7485], 1.0],
    [[50, -0.9009, -85.5211], [50, 0, -82.7485], 1.0],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, -1, 2], [50, 0, 0], 2.3669],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [61, -5, 29], 22.8977],
    [[50, 2.5, 0], [56, -27, -3], 31.903],
    [[50, 2.5, 0], [58, 24, 15], 19.4535],
  ];

  it('公表テストペアと 1e-4 で一致する', () => {
    for (const [a, b, want] of PAIRS) {
      expect(deltaE2000(a, b)).toBeCloseTo(want, 4);
    }
  });

  it('自分自身との差は 0、そして対称である', () => {
    for (const [a, b] of PAIRS) {
      expect(deltaE2000(a, a)).toBeCloseTo(0, 12);
      expect(deltaE2000(a, b)).toBeCloseTo(deltaE2000(b, a), 12);
    }
  });

  it('XYZ→Lab: D65 白色点で L=100, a=b=0', () => {
    const out = new Float64Array(3);
    xyzToLab(0.95047, 1.0, 1.08883, out);
    expect(out[0]).toBeCloseTo(100, 9);
    expect(out[1]).toBeCloseTo(0, 9);
    expect(out[2]).toBeCloseTo(0, 9);
  });

  it('リニア RGB からの ΔE00: 1 コード値の差は中間調で約 0.15', () => {
    const a = new Float64Array(3);
    const b = new Float64Array(3);
    linearToLab(SRGB, SRGB_TO_LINEAR_LUT[128], SRGB_TO_LINEAR_LUT[128], SRGB_TO_LINEAR_LUT[128], a);
    linearToLab(SRGB, SRGB_TO_LINEAR_LUT[129], SRGB_TO_LINEAR_LUT[129], SRGB_TO_LINEAR_LUT[129], b);
    const d = deltaE2000(a, b);
    // 予算表の「OutputPass encode + 8bit 量子化 0.35」の根拠になる数
    expect(d).toBeGreaterThan(0.15);
    expect(d).toBeLessThan(0.45);
  });
});

describe('wrapPi', () => {
  it('区間は (−π, π] —— 端点の扱いを確定させる', () => {
    expect(wrapPi(Math.PI)).toBeCloseTo(Math.PI, 15);
    expect(wrapPi(-Math.PI)).toBeCloseTo(Math.PI, 15);
    expect(wrapPi(0)).toBe(0);
    expect(wrapPi(Math.PI * 2)).toBeCloseTo(0, 12);
    expect(wrapPi(Math.PI * 3)).toBeCloseTo(Math.PI, 12);
    expect(wrapPi(-Math.PI * 3)).toBeCloseTo(Math.PI, 12);
  });

  it('大きな入力でも範囲内に収まる', () => {
    for (let k = -50; k <= 50; k++) {
      const v = wrapPi(k * 1.7);
      expect(v).toBeGreaterThan(-Math.PI - 1e-12);
      expect(v).toBeLessThanOrEqual(Math.PI + 1e-12);
    }
  });
});
