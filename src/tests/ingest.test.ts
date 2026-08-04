/**
 * 取り込みのうち、**node で本当に落とせる部分**。
 *
 * 落とせるのは (1) 寸法決定の純関数 (2) probe 用 JPEG のバイト列
 * (3) 機能検出の判定ロジック の 3 つだけである。
 * `createImageBitmap` / `OffscreenCanvas` / `Worker` は node に無く、
 * **stub して緑にすると「常に緑」になる**ので、無いことのほうを機械で見張る(末尾)。
 */

import { describe, expect, it } from 'vitest';
import {
  exceedsSourceLimit,
  MAX_CANONICAL_PIXELS,
  MAX_SOURCE_PIXELS,
  planResize,
} from '../ingest/plan';
import {
  decideOrientationSupport,
  orientProbeBytes,
  PROBE_ORIENTATION_TAG,
  PROBE_ORIENTED,
  PROBE_UNORIENTED,
} from '../ingest/orientProbe';
import { summarizeCapabilities, type RawCapabilities } from '../ingest/capabilities';
import { MAX_CANONICAL_EDGE } from '../image/grid';

// ---------------------------------------------------------------- 寸法

describe('planResize', () => {
  /**
   * この 1 本がこのファイルの存在理由。
   *
   * 素直な `createImageBitmap(blob, { resizeWidth: 2048 })` は、64×32 の
   * **772 バイト**の JPEG を **2048×1024** にする(Chrome 148 で実測)。
   * 正準バッファは 24 MB ── 元画像の 3 万倍。しかも例外は出ない。
   */
  it('小さい画像を拡大しない', () => {
    const p = planResize(64, 32, 2048);
    expect(p).toEqual({ width: 64, height: 32, resized: false });
    expect(p.width).not.toBe(2048);
    // 正準バッファの大きさで言うと 24MB と 0.023MB の差
    expect((p.width * p.height * 3 * 4) / 1048576).toBeLessThan(0.03);
  });

  it('ちょうど上限のときも縮小しない', () => {
    expect(planResize(2048, 1365, 2048)).toEqual({
      width: 2048,
      height: 1365,
      resized: false,
    });
  });

  it('長辺が厳密に maxEdge になる(横長・縦長の両方)', () => {
    const land = planResize(6000, 4000, 2048);
    expect(land.width).toBe(2048);
    expect(land.height).toBe(1365);
    expect(Math.max(land.width, land.height)).toBe(2048);

    const port = planResize(4000, 6000, 2048);
    expect(port.height).toBe(2048);
    expect(port.width).toBe(1365);
    expect(Math.max(port.width, port.height)).toBe(2048);
  });

  it('アスペクト比が 0.1% 以内で保たれる', () => {
    for (const [w, h] of [
      [6000, 4000], [4000, 6000], [8000, 1000], [1000, 8000],
      [4032, 3024], [7728, 5152], [2049, 2048],
    ] as const) {
      const p = planResize(w, h, MAX_CANONICAL_EDGE);
      const err = Math.abs(p.width / p.height - w / h) / (w / h);
      expect(err, `${w}×${h} → ${p.width}×${p.height}`).toBeLessThan(0.001);
    }
  });

  it('正方形は両辺が maxEdge', () => {
    expect(planResize(5000, 5000, 2048)).toEqual({
      width: 2048,
      height: 2048,
      resized: true,
    });
  });

  it('極端なアスペクトでも短辺が 0 にならない', () => {
    // 0 を返すと new Float32Array(0) が「空の画像」として静かに通ってしまう
    const p = planResize(100000, 1, 2048);
    expect(p.width).toBe(2048);
    expect(p.height).toBe(1);
    expect(p.width * p.height).toBeGreaterThan(0);
  });

  it('どんな入力でも正準の画素数上限を超えない', () => {
    for (const [w, h] of [
      [40000, 40000], [7728, 5152], [10000, 3], [3, 10000], [2048, 2048],
    ] as const) {
      const p = planResize(w, h, MAX_CANONICAL_EDGE);
      expect(p.width * p.height).toBeLessThanOrEqual(MAX_CANONICAL_PIXELS);
    }
  });

  it('不正な寸法は静かに通さず投げる', () => {
    expect(() => planResize(0, 10, 2048)).toThrow(RangeError);
    expect(() => planResize(10, 0, 2048)).toThrow(RangeError);
    expect(() => planResize(Number.NaN, 10, 2048)).toThrow(RangeError);
    expect(() => planResize(10, 10, 0)).toThrow(RangeError);
  });

  it('原寸の門は 40MP を通し、桁違いを止める', () => {
    expect(exceedsSourceLimit(7728, 5152)).toBe(false); // 39.8MP は通る
    expect(exceedsSourceLimit(20000, 20000)).toBe(true);
    expect(MAX_SOURCE_PIXELS).toBeGreaterThan(40_000_000);
  });
});

// ---------------------------------------------------------------- probe 定数

/** probe 用 JPEG を読む最小の実装。**製品コードには入れない**(1a-ii は EXIF を解釈しない) */
function parseProbe(bytes: Uint8Array) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('SOI がない');
  let i = 2;
  let orientation: number | null = null;
  let sof: { width: number; height: number } | null = null;
  const markers: number[] = [];
  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xff) throw new Error(`マーカー境界がずれている @${i}`);
    const m = bytes[i + 1];
    markers.push(m);
    if (m === 0xd9) break;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    const body = i + 4;
    if (m === 0xe1) {
      const tag = String.fromCharCode(...bytes.slice(body, body + 6));
      if (tag !== 'Exif\0\0') throw new Error(`APP1 が Exif ではない: ${JSON.stringify(tag)}`);
      const tiff = body + 6;
      const le = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
      if (!le) throw new Error('TIFF が little-endian ではない');
      const u16 = (o: number) => bytes[o] | (bytes[o + 1] << 8);
      const u32 = (o: number) =>
        bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
      if (u16(tiff + 2) !== 42) throw new Error('TIFF マジックが 42 でない');
      const ifd = tiff + u32(tiff + 4);
      const count = u16(ifd);
      for (let e = 0; e < count; e++) {
        const off = ifd + 2 + e * 12;
        if (u16(off) === 0x0112) {
          if (u16(off + 2) !== 3) throw new Error('Orientation の型が SHORT でない');
          if (u32(off + 4) !== 1) throw new Error('Orientation の個数が 1 でない');
          orientation = u16(off + 8);
        }
      }
    }
    if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
      sof = { height: (bytes[body + 1] << 8) | bytes[body + 2], width: (bytes[body + 3] << 8) | bytes[body + 4] };
    }
    i = i + 2 + len;
    if (m === 0xda) break;
  }
  return { orientation, sof, markers };
}

describe('EXIF 向き probe', () => {
  /**
   * この定数が壊れると probe は黙って `'unknown'` を返す ──
   * つまり「向きの検証を諦めた」ことに誰も気づかない。だからバイト列を固定する。
   */
  it('probe 用 JPEG が Orientation=6 と 2×1 を宣言している', () => {
    const bytes = orientProbeBytes();
    expect(bytes.length).toBe(317);
    const { orientation, sof } = parseProbe(bytes);
    expect(orientation).toBe(PROBE_ORIENTATION_TAG);
    expect(orientation).toBe(6); // 90°CW
    expect(sof).toEqual({ width: 2, height: 1 });
  });

  it('画素の寸法と、向きを適用したときの寸法が転置の関係にある', () => {
    // ここが等しくなると probe は何も判定できない(正方形の probe を作る事故)
    expect(PROBE_ORIENTED.width).toBe(PROBE_UNORIENTED.height);
    expect(PROBE_ORIENTED.height).toBe(PROBE_UNORIENTED.width);
    expect(PROBE_ORIENTED.width).not.toBe(PROBE_ORIENTED.height);
  });

  it('判定は 3 値で、知らない寸法は unknown へ倒す', () => {
    expect(decideOrientationSupport({ width: 1, height: 2 })).toBe('applied');
    expect(decideOrientationSupport({ width: 2, height: 1 })).toBe('not-applied');
    expect(decideOrientationSupport(null)).toBe('unknown');
    // 「2×1 でなければ適用された」と書くと、probe が壊れたときに嘘をつく
    expect(decideOrientationSupport({ width: 4, height: 4 })).toBe('unknown');
    expect(decideOrientationSupport({ width: 0, height: 0 })).toBe('unknown');
  });
});

// ---------------------------------------------------------------- 機能検出の判定

const RAW_OK: RawCapabilities = {
  hasCreateImageBitmap: true,
  hasOffscreenCanvas: true,
  hasWorker: true,
  has2dContext: true,
  optionMembers: {
    imageOrientation: true,
    resizeQuality: true,
    colorSpaceConversion: true,
    premultiplyAlpha: true,
  },
  resizeEffective: true,
  orientation: 'applied',
  imageDataColorSpace: 'srgb',
  hardwareConcurrency: 10,
};

describe('機能検出の判定(純関数)', () => {
  it('全部揃っていれば worker 経路・デコーダ縮小・向きリスク無し', () => {
    const r = summarizeCapabilities(RAW_OK);
    expect(r.canIngest).toBe(true);
    expect(r.canUseWorker).toBe(true);
    expect(r.canResizeInDecoder).toBe(true);
    expect(r.orientationRisk).toBe('none');
    expect(r.notes).toHaveLength(0);
  });

  /**
   * SPEC §4.7 の核心 ── **メンバが実装されていても効くとは限らない。**
   * `resizeQuality` が実装済みでも `resizeEffective` が false なら canvas へ落とす。
   */
  it('メンバが実装されていても効かなければデコーダ縮小を使わない', () => {
    const r = summarizeCapabilities({ ...RAW_OK, resizeEffective: false });
    expect(r.optionMembers.resizeQuality).toBe(true);
    expect(r.canResizeInDecoder).toBe(false);
    expect(r.canIngest).toBe(true);
    expect(r.notes.join()).toContain('無視されました');
  });

  it('未実施(null)は「効く」に倒さない', () => {
    expect(summarizeCapabilities({ ...RAW_OK, resizeEffective: null }).canResizeInDecoder)
      .toBe(false);
  });

  it('OffscreenCanvas が無ければメインスレッド経路になる', () => {
    const r = summarizeCapabilities({ ...RAW_OK, hasOffscreenCanvas: false });
    expect(r.canUseWorker).toBe(false);
    expect(r.canIngest).toBe(true); // 取り込み自体はできる
    expect(r.notes.join()).toContain('メインスレッド');
  });

  it('createImageBitmap が無ければ取り込めないと表明する', () => {
    const r = summarizeCapabilities({ ...RAW_OK, hasCreateImageBitmap: false });
    expect(r.canIngest).toBe(false);
    expect(r.notes.join()).toContain('createImageBitmap');
  });

  it('向きが適用されない環境は risk を立てて理由を出す', () => {
    const r = summarizeCapabilities({ ...RAW_OK, orientation: 'not-applied' });
    expect(r.orientationRisk).toBe('must-orient-manually');
    expect(r.notes.join()).toContain('横倒し');
  });

  it('probe が失敗したときは「適用済み」に倒さない', () => {
    const r = summarizeCapabilities({ ...RAW_OK, orientation: 'unknown' });
    expect(r.orientationRisk).toBe('unknown');
    expect(r.orientationRisk).not.toBe('none');
  });

  /**
   * Display P3 を「通ったつもり」にしない。4 箇所(csc / canvas の colorSpace /
   * getImageData の colorSpace / Canonical.gamut)が同時に揃わないと色相が黙って誤るので、
   * 1a-ii は srgb 固定にして、観測した値が違うときは注記で残す。
   */
  it('1a-ii は gamut を srgb に固定し、違う観測は注記に出す', () => {
    expect(summarizeCapabilities(RAW_OK).gamut).toBe('srgb');
    const p3 = summarizeCapabilities({ ...RAW_OK, imageDataColorSpace: 'display-p3' });
    expect(p3.gamut).toBe('srgb');
    expect(p3.notes.join()).toContain('display-p3');
  });
});

// ---------------------------------------------------------------- 境界

/**
 * **node には無いものの一覧。**
 *
 * ここが緑であることは「これらを node でテストしていない」という宣言である。
 * 将来だれかが `vi.stubGlobal('createImageBitmap', ...)` で decode 経路のテストを
 * 書こうとすると、この節が落ちて理由が読める ── SPEC が最も嫌う「常に緑」を
 * この境界に作らないための歯止め。
 */
describe('node で測れないものの境界', () => {
  it('createImageBitmap / OffscreenCanvas / Worker は node に存在しない', () => {
    expect(typeof (globalThis as Record<string, unknown>).createImageBitmap).toBe('undefined');
    expect(typeof (globalThis as Record<string, unknown>).OffscreenCanvas).toBe('undefined');
    expect(typeof (globalThis as Record<string, unknown>).Worker).toBe('undefined');
  });

  it('structuredClone と atob は存在する(だから protocol と probe は測れる)', () => {
    expect(typeof structuredClone).toBe('function');
    expect(typeof atob).toBe('function');
  });
});
