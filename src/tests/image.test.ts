import { describe, expect, it } from 'vitest';
import { SRGB_TO_LINEAR_LUT } from '../color/srgb';
import { linearToOklab, SRGB } from '../color/oklab';
import { fitGrid, imageHalfExtents, MAX_CANONICAL_EDGE, TIER_BUDGET } from '../image/grid';
import { linearizeRgba } from '../image/linearize';
import { C_MIN_P95, computeScales, computeStats } from '../image/stats';
import { lift } from '../image/lift';
import {
  makeGrayscaleRamp,
  makeMonochrome,
  makeSpecimen0,
  RAMP_CODES,
  REGIONS,
  SPECIMEN_H,
  SPECIMEN_W,
} from '../image/fixture';
import { safeDist } from '../math/rotationN';

const N = 5;

function buffersFor(count: number) {
  return { base: new Float32Array(count * N), colors: new Float32Array(count * 3) };
}

describe('grid', () => {
  it('imageHalfExtents はアスペクトを厳密に保つ', () => {
    expect(imageHalfExtents(1024, 640)).toEqual({ aX: 1, aY: 0.625 });
    expect(imageHalfExtents(640, 1024)).toEqual({ aX: 0.625, aY: 1 });
    expect(imageHalfExtents(512, 512)).toEqual({ aX: 1, aY: 1 });
  });

  it('fitGrid は予算を超えず、アスペクト誤差 0.5% 以内', () => {
    for (const [w, h] of [[1024, 640], [640, 1024], [4000, 3000], [1, 100], [100, 1]]) {
      for (const budget of Object.values(TIER_BUDGET)) {
        const g = fitGrid(w, h, budget);
        expect(g.cols).toBeGreaterThanOrEqual(1);
        expect(g.rows).toBeGreaterThanOrEqual(1);
        expect(g.cols * g.rows).toBeLessThanOrEqual(budget);
        // 極端なアスペクトでは丸めが効くので、通常比の画像でだけ厳しく見る
        if (w / h > 0.2 && w / h < 5) {
          const err = Math.abs(g.cols / g.rows - w / h) / (w / h);
          expect(err).toBeLessThan(0.005);
        }
      }
    }
  });

  it('予算に対して単調(大きい予算で点数が減らない)', () => {
    let prev = 0;
    for (const b of [1000, 10000, 39528, 89304, 159414]) {
      const g = fitGrid(1024, 640, b);
      expect(g.cols * g.rows).toBeGreaterThanOrEqual(prev);
      prev = g.cols * g.rows;
    }
  });

  it('ティア予算は bench が測った点数と一致する(§4.3 の A 水準が適用される数)', () => {
    expect(TIER_BUDGET.BALANCED).toBe(39528);
    expect(TIER_BUDGET.HIGH).toBe(89304);
    expect(TIER_BUDGET.ULTRA).toBe(159414);
    expect(MAX_CANONICAL_EDGE).toBe(2048);
  });
});

describe('fixture 標本 No.0', () => {
  it('決定的(2 回呼んでバイト一致)', () => {
    const a = makeSpecimen0();
    const b = makeSpecimen0();
    expect(a.rgba.length).toBe(b.rgba.length);
    // 260 万回の expect は vitest が持たない。差分の個数を数えて 1 回で見る
    let diff = 0;
    for (let i = 0; i < a.rgba.length; i++) if (a.rgba[i] !== b.rgba[i]) diff++;
    expect(diff).toBe(0);
  });

  it('ランプはちょうど宣言した 8 コード値', () => {
    const s = makeSpecimen0();
    const R = REGIONS.ramp;
    for (let i = 0; i < 8; i++) {
      const x = R.x + i * 128 + 64;
      const y = R.y + 40;
      const o = (y * s.width + x) * 4;
      expect(s.rgba[o]).toBe(RAMP_CODES[i]);
      expect(s.rgba[o + 1]).toBe(RAMP_CODES[i]);
      expect(s.rgba[o + 2]).toBe(RAMP_CODES[i]);
    }
  });

  it('マーカーは 8 つの二面体変換すべてで非対称', () => {
    const s = makeSpecimen0();
    const W = s.width;
    const H = s.height;
    const lum = (x: number, y: number) => s.rgba[(y * W + x) * 4];
    // マーカー配置(0,0),(32,0),(0,32) は L 字。どの変換でも自分自身に写らない
    // x に 3 個・y に 2 個の L 字なので、対角転置でも一致しない
    const probes: Array<[number, number]> = [
      [16, 16], [48, 16], [80, 16], [16, 48], [48, 48], [80, 48],
    ];
    const orig = probes.map(([x, y]) => lum(x, y));
    const transforms: Array<(x: number, y: number) => [number, number]> = [
      (x, y) => [W - 1 - x, y],
      (x, y) => [x, H - 1 - y],
      (x, y) => [W - 1 - x, H - 1 - y],
      (x, y) => [y, x],
      (x, y) => [H - 1 - y, x],
      (x, y) => [y, W - 1 - x],
      (x, y) => [H - 1 - y, W - 1 - x],
    ];
    for (const t of transforms) {
      const mapped = probes.map(([x, y]) => {
        const [nx, ny] = t(x, y);
        return nx >= 0 && nx < W && ny >= 0 && ny < H ? lum(nx, ny) : -1;
      });
      expect(mapped).not.toEqual(orig);
    }
  });

  it('平坦パッチは sRGB 128、チェッカーは黒白 2px', () => {
    const s = makeSpecimen0();
    const F = REGIONS.flat;
    const o = ((F.y + 100) * s.width + F.x + 100) * 4;
    expect(s.rgba[o]).toBe(128);
    const CH = REGIONS.checker;
    const at = (x: number, y: number) => s.rgba[((CH.y + y) * s.width + CH.x + x) * 4];
    expect(at(0, 0)).toBe(255);
    expect(at(2, 0)).toBe(0);
    expect(at(0, 2)).toBe(0);
    expect(at(2, 2)).toBe(255);
  });

  it('ホイールのパッチは sRGB でクリップしない', () => {
    const s = makeSpecimen0();
    const W2 = REGIONS.wheel;
    const pw = Math.floor(W2.w / 12);
    const ph = Math.floor(W2.h / 2);
    for (let row = 0; row < 2; row++) {
      for (let k = 0; k < 12; k++) {
        const x = W2.x + k * pw + (pw >> 1);
        const y = W2.y + row * ph + (ph >> 1);
        const o = (y * s.width + x) * 4;
        for (let c = 0; c < 3; c++) {
          expect(s.rgba[o + c]).toBeGreaterThan(0);
          expect(s.rgba[o + c]).toBeLessThan(255);
        }
      }
    }
  });
});

describe('stats', () => {
  const spec = makeSpecimen0();
  const canonical = linearizeRgba(spec.rgba, spec.width, spec.height);
  const stats = computeStats(canonical);

  it('平均は正準バッファから来る(格子からではない)', () => {
    // 直接計算した平均と一致すること
    let r = 0;
    for (let i = 0; i < canonical.linear.length; i += 3) r += canonical.linear[i];
    r /= spec.width * spec.height;
    expect(stats.meanLinear[0]).toBeCloseTo(r, 6);
  });

  it('columnMeans が正準バッファの列平均と一致する', () => {
    // 監査で「1a で計算して出荷するのに、テストが 1 本も無い」と指摘された箇所
    expect(stats.columnMeans.length).toBe(spec.width * 3);
    for (const x of [0, 1, 127, 512, spec.width - 1]) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let y = 0; y < spec.height; y++) {
          acc += canonical.linear[(y * spec.width + x) * 3 + c];
        }
        expect(stats.columnMeans[x * 3 + c]).toBeCloseTo(acc / spec.height, 6);
      }
    }
  });

  it('列平均の平均は全体平均に一致する', () => {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let x = 0; x < spec.width; x++) acc += stats.columnMeans[x * 3 + c];
      expect(acc / spec.width).toBeCloseTo(stats.meanLinear[c], 6);
    }
  });

  it('標本 No.0 は退化しない', () => {
    expect(stats.chroma.degenerate).toBe(false);
    expect(stats.lightness.degenerate).toBe(false);
    expect(stats.chroma.p95).toBeGreaterThan(C_MIN_P95);
  });

  it('p95 ヒストグラムが総当たりソートと 1% 以内で一致する', () => {
    const lab = new Float64Array(3);
    const rs: number[] = [];
    const stride = Math.max(1, Math.floor((spec.width * spec.height) / 262144));
    for (let i = 0; i < spec.width * spec.height; i += stride) {
      const o = i * 3;
      linearToOklab(SRGB, canonical.linear[o], canonical.linear[o + 1], canonical.linear[o + 2], lab);
      rs.push(Math.hypot(lab[1], lab[2]));
    }
    rs.sort((a, b) => a - b);
    const brute = rs[Math.floor(0.95 * rs.length)];
    expect(Math.abs(stats.chroma.p95 - brute) / Math.max(brute, 1e-6)).toBeLessThan(0.01);
  });

  /**
   * 退化判定はヒストグラムから取っていないこと ──
   * bin 0 は r ∈ [0, 0.0125] を覆い、しきい値 0.002 はその 1/39 なので、
   * 補間 p95 では純グレースケールでも 0.0122 と出て**絶対に発火しない**。
   */
  it('グレースケールは彩度軸が無いと表明される', () => {
    const g = makeGrayscaleRamp();
    const c = linearizeRgba(g.rgba, g.width, g.height);
    const s = computeStats(c);
    expect(s.chroma.degenerate).toBe(true);
    expect(s.lightness.degenerate).toBe(false);
    const sc = computeScales(s);
    expect(sc.sC).toBe(1);
    expect(sc.degenerate.chroma).toBe(true);
  });

  it('単色は明度軸も彩度軸も無いと表明される', () => {
    const m = makeMonochrome();
    const c = linearizeRgba(m.rgba, m.width, m.height);
    const s = computeStats(c);
    expect(s.chroma.degenerate).toBe(true);
    expect(s.lightness.degenerate).toBe(true);
    const sc = computeScales(s);
    expect(sc.sC).toBe(1);
    expect(sc.sL).toBe(1);
  });
});

describe('lift', () => {
  const spec = makeSpecimen0();
  const canonical = linearizeRgba(spec.rgba, spec.width, spec.height);
  const stats = computeStats(canonical);
  const scales = computeScales(stats);

  it('LUT はちょうど 1 回だけ適用される(平坦パッチ sRGB 128 → 0.21586)', () => {
    const grid = { cols: SPECIMEN_W / 8, rows: SPECIMEN_H / 8 };
    const out = buffersFor(grid.cols * grid.rows);
    lift(canonical, grid, scales, out);
    // 平坦パッチの中心にあたるセル
    const F = REGIONS.flat;
    const i = Math.floor(((F.x + F.w / 2) / SPECIMEN_W) * grid.cols);
    const j = Math.floor(((F.y + F.h / 2) / SPECIMEN_H) * grid.rows);
    const o = (j * grid.cols + i) * 3;
    expect(out.colors[o]).toBeCloseTo(SRGB_TO_LINEAR_LUT[128], 5);
    // 二重適用ならこの値になる。5.6 倍ずれる
    expect(out.colors[o]).not.toBeCloseTo(SRGB_TO_LINEAR_LUT[55], 3);
  });

  it('y 反転: 画像の上端が v > 0 に来る', () => {
    // 上半分が白、下半分が黒の画像
    const w = 16;
    const h = 16;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const c = y < h / 2 ? 255 : 0;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = c;
        rgba[o + 3] = 255;
      }
    }
    const c = linearizeRgba(rgba, w, h);
    const s = computeStats(c);
    const sc = computeScales(s);
    const grid = { cols: 4, rows: 4 };
    const out = buffersFor(16);
    lift(c, grid, sc, out);
    // 明るいセルの v はすべて正
    for (let k = 0; k < 16; k++) {
      const bright = out.colors[k * 3] > 0.5;
      const v = out.base[k * 5 + 1];
      if (bright) expect(v).toBeGreaterThan(0);
      else expect(v).toBeLessThan(0);
    }
  });

  it('軸の順序は [u, v, L, a, b]、セルは中心に置かれる', () => {
    const grid = { cols: 4, rows: 2 };
    const out = buffersFor(8);
    lift(canonical, grid, scales, out);
    const { aX, aY } = imageHalfExtents(SPECIMEN_W, SPECIMEN_H);
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 4; i++) {
        const o = (j * 4 + i) * 5;
        expect(out.base[o]).toBeCloseTo(((2 * (i + 0.5)) / 4 - 1) * aX, 6);
        expect(out.base[o + 1]).toBeCloseTo(-(((2 * (j + 0.5)) / 2 - 1) * aY), 6);
      }
    }
  });

  it('セル境界は厳密な分割 —— セル平均の加重和が全体平均に一致する', () => {
    const grid = fitGrid(SPECIMEN_W, SPECIMEN_H, 4000);
    const out = buffersFor(grid.cols * grid.rows);
    const { count } = lift(canonical, grid, scales, out);
    // 各セルの画素数を再計算して加重平均を取る
    let acc = 0;
    let px = 0;
    for (let j = 0; j < grid.rows; j++) {
      const y0 = ((j * SPECIMEN_H) / grid.rows) | 0;
      const y1 = (((j + 1) * SPECIMEN_H) / grid.rows) | 0;
      for (let i = 0; i < grid.cols; i++) {
        const x0 = ((i * SPECIMEN_W) / grid.cols) | 0;
        const x1 = (((i + 1) * SPECIMEN_W) / grid.cols) | 0;
        const n = (y1 - y0) * (x1 - x0);
        acc += out.colors[(j * grid.cols + i) * 3] * n;
        px += n;
      }
    }
    expect(px).toBe(SPECIMEN_W * SPECIMEN_H);
    expect(acc / px).toBeCloseTo(stats.meanLinear[0], 6);
    expect(count).toBe(grid.cols * grid.rows);
  });

  it('退化入力でも NaN を出さず、色軸が潰れる', () => {
    for (const spec2 of [makeGrayscaleRamp(), makeMonochrome()]) {
      const c = linearizeRgba(spec2.rgba, spec2.width, spec2.height);
      const s = computeStats(c);
      const sc = computeScales(s);
      const grid = fitGrid(spec2.width, spec2.height, 400);
      const out = buffersFor(grid.cols * grid.rows);
      lift(c, grid, sc, out);
      for (const v of out.base) expect(Number.isFinite(v)).toBe(true);
      // グレースケールなら a', b' はほぼ 0
      for (let k = 0; k < grid.cols * grid.rows; k++) {
        expect(Math.abs(out.base[k * 5 + 3])).toBeLessThan(1e-4);
        expect(Math.abs(out.base[k * 5 + 4])).toBeLessThan(1e-4);
      }
    }
  });

  it('maxNorm を返し、そこから安全な dist が決まる', () => {
    const grid = fitGrid(SPECIMEN_W, SPECIMEN_H, 4000);
    const out = buffersFor(grid.cols * grid.rows);
    const { maxNorm } = lift(canonical, grid, scales, out);
    expect(maxNorm).toBeGreaterThan(0);
    // n=5 の必要条件は dist > 2·maxNorm
    const d = safeDist(maxNorm);
    expect(d).toBeGreaterThan(2 * maxNorm);
    expect(d).toBeGreaterThanOrEqual(2.4);
  });
});
