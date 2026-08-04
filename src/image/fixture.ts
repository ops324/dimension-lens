/**
 * 標本 No.0 —— 生成色票。
 *
 * これは「まずはお試し」のダミーではなく**採番された標本**である。読み出しの出自欄には
 * 「このブラウザで生成（写真ではありません）」と出る。役割は 2 つ:
 *   1. 起動時に `dimLevel = 2.0` で表示され、ユーザーが何もしないうちに信頼の錨を踏ませる
 *   2. 忠実性ラダー G1〜G6 の被写体
 *
 * アスペクト 1.6(1 でも 2 でもない)── アスペクトの取り違えが打ち消し合わないように。
 * 全領域の寸法は 8 の倍数。
 *
 * **決定性は要件である。** 2 回呼んでバイト一致しなければ、下流のすべての予算が意味を失う。
 * 乱数は使わない。
 */

import { linearToCode } from '../color/srgb';
import { oklabToLinear, SRGB } from '../color/oklab';

export const SPECIMEN_W = 1024;
export const SPECIMEN_H = 640;

/** グレーランプの 8 段。**コード値で等間隔** ── 試されるのは曲線の形 */
export const RAMP_CODES = [0, 36, 73, 109, 146, 182, 219, 255] as const;

/** 各領域の矩形(CSS ではなく画素座標、行 0 = 上端) */
export const REGIONS = {
  ramp: { x: 0, y: 0, w: 1024, h: 80 },
  wheel: { x: 0, y: 80, w: 1024, h: 160 },
  /** 2px チェッカー。**板の線形補間を測る**ための領域(監査で追加)。1px 枠を避けて内側へ */
  checker: { x: 8, y: 248, w: 256, h: 128 },
  /** 平坦パッチ: sRGB 128(リニア 0.21586) */
  flat: { x: 384, y: 256, w: 256, h: 256 },
  /**
   * 非対称マーカー。x 方向に 3 個・y 方向に 2 個の L 字にする ──
   * **対角転置でも一致しない**ことが要件で、(0,0)(32,0)(0,32) の対称な L では
   * 転置に対して不変になってしまう(最初の版がそれで、テストが落ちて分かった)。
   */
  markers: [
    { x: 0, y: 0, w: 32, h: 32 },
    { x: 32, y: 0, w: 32, h: 32 },
    { x: 64, y: 0, w: 32, h: 32 },
    { x: 0, y: 32, w: 32, h: 32 },
    { x: SPECIMEN_W - 32, y: SPECIMEN_H - 32, w: 32, h: 32 },
  ],
} as const;

/**
 * 彩度ホイールの 2 リング。**L = 0.65 で全 12 色相が sRGB 域内に収まる上限は
 * 0.111**(実測、最も狭いのは色相 210°)なので、その内側に取る。
 * 域外の値を置くとクリップして、標本自体が測定器として壊れる。
 */
export const WHEEL_CHROMA = [0.06, 0.1] as const;

export interface Specimen {
  readonly width: number;
  readonly height: number;
  /** RGBA8、row-major、行 0 = 上端 */
  readonly rgba: Uint8ClampedArray;
}

function fill(
  rgba: Uint8ClampedArray,
  w: number,
  x0: number,
  y0: number,
  bw: number,
  bh: number,
  r: number,
  g: number,
  b: number,
): void {
  for (let y = y0; y < y0 + bh; y++) {
    let o = (y * w + x0) * 4;
    for (let x = 0; x < bw; x++) {
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = 255;
      o += 4;
    }
  }
}

/**
 * 標本 No.0 を生成する。同じ入力に対して常にバイト一致する。
 */
export function makeSpecimen0(): Specimen {
  const w = SPECIMEN_W;
  const h = SPECIMEN_H;
  const rgba = new Uint8ClampedArray(w * h * 4);

  // 背景: 中間グレー(平坦パッチと同値。周囲の影響を最小化する)
  fill(rgba, w, 0, 0, w, h, 128, 128, 128);

  // ① グレーランプ 8列 × 128px
  const R = REGIONS.ramp;
  for (let i = 0; i < 8; i++) {
    const c = RAMP_CODES[i];
    fill(rgba, w, R.x + i * 128, R.y, 128, R.h, c, c, c);
  }

  // ② 彩度ホイール: 12 色相 × 2 彩度、L = 0.65
  const W2 = REGIONS.wheel;
  const lin = new Float64Array(3);
  const patchW = Math.floor(W2.w / 12);
  const patchH = Math.floor(W2.h / 2);
  for (let row = 0; row < 2; row++) {
    const C = WHEEL_CHROMA[row];
    for (let k = 0; k < 12; k++) {
      const hue = (k / 12) * Math.PI * 2;
      oklabToLinear(SRGB, 0.65, C * Math.cos(hue), C * Math.sin(hue), lin);
      fill(
        rgba,
        w,
        W2.x + k * patchW,
        W2.y + row * patchH,
        patchW,
        patchH,
        linearToCode(lin[0]),
        linearToCode(lin[1]),
        linearToCode(lin[2]),
      );
    }
  }

  // ③ 2px チェッカー(黒/白)。板の補間がリニア光で行われるなら中点は 188、
  //    ガンマ空間なら 128 になる ── SPEC §4.7 の実験を GPU 側で再演するための領域。
  const CH = REGIONS.checker;
  for (let y = CH.y; y < CH.y + CH.h; y += 2) {
    for (let x = CH.x; x < CH.x + CH.w; x += 2) {
      const on = (((x - CH.x) >> 1) + ((y - CH.y) >> 1)) % 2 === 0;
      const c = on ? 255 : 0;
      fill(rgba, w, x, y, 2, 2, c, c, c);
    }
  }

  // ④ 平坦パッチ sRGB 128
  const F = REGIONS.flat;
  fill(rgba, w, F.x, F.y, F.w, F.h, 128, 128, 128);

  // ⑤ 非対称マーカー(白)。8 つの二面体変換すべてで区別がつく配置
  for (const m of REGIONS.markers) fill(rgba, w, m.x, m.y, m.w, m.h, 255, 255, 255);

  // ⑥ 1px 黒枠 ── 板の縁の位置合わせを見る
  fill(rgba, w, 0, 0, w, 1, 0, 0, 0);
  fill(rgba, w, 0, h - 1, w, 1, 0, 0, 0);
  fill(rgba, w, 0, 0, 1, h, 0, 0, 0);
  fill(rgba, w, w - 1, 0, 1, h, 0, 0, 0);

  return { width: w, height: h, rgba };
}

/** 単色のテスト用画像(明度も彩度も退化する) */
export function makeMonochrome(w = 64, h = 40, code = 128): Specimen {
  const rgba = new Uint8ClampedArray(w * h * 4);
  fill(rgba, w, 0, 0, w, h, code, code, code);
  return { width: w, height: h, rgba };
}

/** グレースケール勾配(彩度だけが退化する) */
export function makeGrayscaleRamp(w = 64, h = 40): Specimen {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let x = 0; x < w; x++) {
    const c = Math.round((x / (w - 1)) * 255);
    fill(rgba, w, x, 0, 1, h, c, c, c);
  }
  return { width: w, height: h, rgba };
}
