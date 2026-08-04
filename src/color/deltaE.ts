/**
 * CIEDE2000 色差(ΔE00)と、そのための CIELAB 変換。
 *
 * 忠実性ラダーの単位はこれである。**新しい依存を足さない** ── SPEC §6 のプライバシーの話は
 * 依存が 1 パッケージに留まっていることの上に立っており、色ライブラリを 1 本足すと
 * その監査からやり直しになる。Sharma–Wu–Dalal (2005) の定式で 60 行。
 *
 * 白色点は **D65 2° 視野** を明示する ── 光源の選択は結果をずらすので、
 * 書かれていない白色点は静かな乖離になる。
 */

import type { RgbPrimaries } from './oklab';
import { linearToXyz } from './oklab';

/** D65 2°。X, Y, Z */
export const D65: readonly [number, number, number] = [0.95047, 1.0, 1.08883];

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const EPS = 216 / 24389; // (6/29)³
const KAP = 24389 / 27; // (29/3)³

function labF(t: number): number {
  return t > EPS ? Math.cbrt(t) : (KAP * t + 16) / 116;
}

/** CIE XYZ(D65) → CIELAB */
export function xyzToLab(
  x: number,
  y: number,
  z: number,
  out: Float64Array,
): Float64Array {
  const fx = labF(x / D65[0]);
  const fy = labF(y / D65[1]);
  const fz = labF(z / D65[2]);
  out[0] = 116 * fy - 16;
  out[1] = 500 * (fx - fy);
  out[2] = 200 * (fy - fz);
  return out;
}

const XYZ_SCRATCH = new Float64Array(3);

/** リニア RGB → CIELAB(D65) */
export function linearToLab(
  p: RgbPrimaries,
  r: number,
  g: number,
  b: number,
  out: Float64Array,
): Float64Array {
  linearToXyz(p, r, g, b, XYZ_SCRATCH);
  return xyzToLab(XYZ_SCRATCH[0], XYZ_SCRATCH[1], XYZ_SCRATCH[2], out);
}

const POW25_7 = 6103515625; // 25⁷

/**
 * CIEDE2000。入力は CIELAB。kL = kC = kH = 1。
 *
 * Sharma–Wu–Dalal の定式に忠実に書く ── 特に「C'₁·C'₂ = 0 のとき Δh' = 0、
 * h̄' = h'₁ + h'₂」という縮退分岐は、無彩色ペアで結果が変わるので省略できない。
 */
export function deltaE2000(lab1: ArrayLike<number>, lab2: ArrayLike<number>): number {
  const [L1, a1, b1] = [lab1[0], lab1[1], lab1[2]];
  const [L2, a2, b2] = [lab2[0], lab2[1], lab2[2]];

  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + POW25_7)));

  const ap1 = (1 + G) * a1;
  const ap2 = (1 + G) * a2;
  const Cp1 = Math.sqrt(ap1 * ap1 + b1 * b1);
  const Cp2 = Math.sqrt(ap2 * ap2 + b2 * b2);

  const hp = (b: number, a: number): number => {
    if (a === 0 && b === 0) return 0;
    const h = Math.atan2(b, a) * DEG;
    return h >= 0 ? h : h + 360;
  };
  const hp1 = hp(b1, ap1);
  const hp2 = hp(b2, ap2);

  const dL = L2 - L1;
  const dC = Cp2 - Cp1;

  const CpProd = Cp1 * Cp2;
  let dh: number;
  if (CpProd === 0) dh = 0;
  else {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(CpProd) * Math.sin((dh * RAD) / 2);

  const Lbar = (L1 + L2) / 2;
  const Cpbar = (Cp1 + Cp2) / 2;

  let hbar: number;
  if (CpProd === 0) hbar = hp1 + hp2;
  else {
    const sum = hp1 + hp2;
    const diff = Math.abs(hp1 - hp2);
    if (diff <= 180) hbar = sum / 2;
    else hbar = sum < 360 ? (sum + 360) / 2 : (sum - 360) / 2;
  }

  const T =
    1 -
    0.17 * Math.cos((hbar - 30) * RAD) +
    0.24 * Math.cos(2 * hbar * RAD) +
    0.32 * Math.cos((3 * hbar + 6) * RAD) -
    0.2 * Math.cos((4 * hbar - 63) * RAD);

  const dTheta = 30 * Math.exp(-Math.pow((hbar - 275) / 25, 2));
  const Cpbar7 = Math.pow(Cpbar, 7);
  const RC = 2 * Math.sqrt(Cpbar7 / (Cpbar7 + POW25_7));
  const dL50 = Lbar - 50;
  const SL = 1 + (0.015 * dL50 * dL50) / Math.sqrt(20 + dL50 * dL50);
  const SC = 1 + 0.045 * Cpbar;
  const SH = 1 + 0.015 * Cpbar * T;
  const RT = -Math.sin(2 * dTheta * RAD) * RC;

  const tL = dL / SL;
  const tC = dC / SC;
  const tH = dH / SH;
  return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH);
}

const LAB_A = new Float64Array(3);
const LAB_B = new Float64Array(3);

/** リニア RGB 同士の ΔE00。ラダーが使う入口 */
export function deltaE2000Linear(
  p: RgbPrimaries,
  c1: ArrayLike<number>,
  c2: ArrayLike<number>,
): number {
  linearToLab(p, c1[0], c1[1], c1[2], LAB_A);
  linearToLab(p, c2[0], c2[1], c2[2], LAB_B);
  return deltaE2000(LAB_A, LAB_B);
}
