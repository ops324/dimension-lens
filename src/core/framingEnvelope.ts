/**
 * フレーミングの**位相包絡**（Phase 2c-ii）。**純関数** ── GPU も rAF も要らない。
 *
 * ## 何を直しているか
 *
 * `framingHold`（`core/fit.ts`）はピークホールドなので、**同じ `dimLevel` に留まると
 * 新しい極値が見つかるたびに図が単調に小さくなる**。実測（`d = 3`・ANGLE Metal / M1 Max・
 * 988×778・標本 No.0）:
 *
 * | 経過（gate 時間） | カメラ距離 |
 * |---|---|
 * | 0 s | 2.9682 |
 * | 20 s | 4.8245 |
 * | 140 s | **6.0446** |
 * | 300 s | 6.0446（以降 160 秒 1 度も動かない） |
 *
 * **2.04 倍**＝ 見かけの大きさが約半分になる。しかもこれは時間の関数なので、
 * **`d ≠ 2` の測定値が「そこに何秒いたか」で変わる** ── 2c-i が
 * 「`MEASURED_PEAK_ENVELOPE` は位相 0 の値だった」で刺さったのと同じ型の穴である。
 *
 * → **到達しうる最大を先に計算して、最初からそこに置く。**
 * ホールドは残す（この見積もりが外れても図が帯を出ないための保証）。
 *
 * ## なぜ「ノルム上位 K 点」で足りるのか —— 単調性（代数）
 *
 * `safeDist` の導出がそのまま使える。カスケード 1 段の増幅は `f = dist/(dist − p[d])` で、
 * 入力ノルム `r` の点が出しうる最大の出力半径は
 *
 * ```
 * r · dist/(dist − r)
 * ```
 *
 * これは **r について単調増加**である。回転は 5 次元のノルムを保つので、
 * 点 `x` が投影後に到達しうる半径は `|E·x|` だけで押さえられる
 * （`E` は `extent` の対角。`foldExtent` が列へ畳んでいるもの）。
 *
 * → **`|E·x|` の大きい上位 K 点だけを掃けば、包絡はほぼ捕まる。**
 * 「ほぼ」なのは、上位 K 点が実際に極値を取る位相へ来るとは限らないためで、
 * だから**これは見積もりであって上界ではない**。上界の役はホールドが引き続き持つ。
 *
 * ## なぜ位相を 1 周ぶん掃けるのか
 *
 * 位相は**閉軌道**である（SPEC §4.20）。`advancePhases` は `φ_k += gate·ω_k·dt` なので
 * `φ_k = ω_k·Φ`、`readAngles` は `θ_k = gate·φ_k = ω_k·s`。つまり 5 本の角度は
 * **1 個のスカラ `s` の像**であって、トーラス全体ではない。
 * `ω × 1000 = (110, 70, 50, 30, 23)` の gcd が 1 なので、軌道は `s = 2000π` で閉じる。
 *
 * **`gate` は `s` を定数倍するだけなので、到達する角度の集合は `dimLevel` に依らない。**
 * だから包絡は `s ∈ [0, 2000π)` を掃けばよく、門の開き具合を掛ける必要はない。
 */

import { PLANES, type RotationPhases } from '../render/rotationSchedule';
import { composeRotN, foldExtent, F_CLAMP } from '../math/rotationN';
import type { PlaneRotation } from '../math/rotation';
import type { Spread } from './fit';

/**
 * 位相の閉軌道の周期（`s` の単位）。`ω × 1000` の gcd が 1 なので `2π / 0.001`。
 * **平面ごとの回転数は 110 / 70 / 50 / 30 / 23。**
 */
export const ORBIT_PERIOD = 2000 * Math.PI;

/**
 * 掃く位相の点数。**最速の平面（ω = 0.11）は 1 周で 110 回転する**ので、
 * `M` 点は 1 回転あたり `M / 110` 標本にしかならない。
 * **軌道をなぞるのではなく、トーラス上に散らす**読み方である
 * （5 本の周波数が互いに素なので、等間隔の `s` は角度空間へよく散る）。
 *
 * **実測で決めた**（標本 No.0・HIGH 格子 378×236・`d = 3`・`needDistance` に直した値）:
 *
 * | M | need | 収束値との比 | 費用 |
 * |---|---|---|---|
 * | 256 | 6.3548 | 92.3% | 1.2 ms |
 * | 1024 | 6.6645 | 96.9% | 2.5 ms |
 * | **4096** | **6.8693** | **99.83%** | **8.0 ms** |
 * | 16384 | 6.8804 | 99.99% | 30.5 ms |
 * | 65536 | 6.8813 | ―（収束） | 115.9 ms |
 *
 * 4096 を取る。**参考: ブラウザで実時間 300 秒（軌道の 4.8%）掃いて到達したのは 6.0446** ──
 * つまりこの見積もりは、5 分間眺めても見つからない極値まで先に押さえている。
 */
export const ENVELOPE_PHASES = 4096;

/**
 * 掃く点数。`|E·x|` の上位からこれだけ取る。
 *
 * **実測: 32 と 128 が全 M で完全に同値**（`aX` / `aY` / `zHi` の 4 桁すべて一致）。
 * 単調性の議論（上）が実際に効いていることの確認でもある ── 極値を取るのは
 * つねにノルム最大の一握りの点である。32 で足りる。
 */
export const ENVELOPE_CANDIDATES = 32;

/**
 * 見積もりを刻む `dimLevel` の幅。**費用を有界にするためにある。**
 *
 * 包絡は `extent`（＝ `dimLevel`）の関数なので、遷移中に毎フレーム測り直すと
 * 8 ms がフレーム予算に乗り続ける。`[0, 5]` を 0.25 刻みで持ち、
 * **各スロットは 1 セッションに 1 度しか計算しない** ── 全域を舐めても 21 × 8 ms で頭打ちになる。
 * 刻みは `MEASURED_HDR_PEAKS` と同じ粒度に合わせた。
 */
export const ENVELOPE_DIM_STEP = 0.25;
export const ENVELOPE_MAX_DIM = 5;
export const ENVELOPE_SLOTS = Math.round(ENVELOPE_MAX_DIM / ENVELOPE_DIM_STEP) + 1;

/** 掃くための作業領域。**毎フレーム確保しない**（`dimChanged` は遷移中ずっと真になる） */
export interface EnvelopeScratch {
  readonly angles: PlaneRotation[];
  readonly matrix: Float64Array;
  readonly phases: RotationPhases;
  /** 候補の添字（`|E·x|` 降順ではない ── 集合として使うだけ） */
  readonly candidates: Int32Array;
  /** 候補のノルム。選抜の閾値管理に使う */
  readonly norms: Float64Array;
}

export function createEnvelopeScratch(candidates = ENVELOPE_CANDIDATES): EnvelopeScratch {
  return {
    angles: PLANES.map((p) => ({ i: p.i, j: p.j, angle: 0 })),
    matrix: new Float64Array(25),
    phases: new Float64Array(PLANES.length),
    candidates: new Int32Array(candidates),
    norms: new Float64Array(candidates),
  };
}

/**
 * `|E·x|` の大きい点を上位 `k` 個選ぶ。**返すのは実際に埋めた個数。**
 *
 * 閾値つきの挿入で、走査は 1 回。`count` が `k` 以下ならそのまま全部入る。
 */
export function selectCandidates(
  base: Float32Array,
  count: number,
  extent: ArrayLike<number>,
  scratch: EnvelopeScratch,
): number {
  const k = scratch.candidates.length;
  const e0 = extent[0], e1 = extent[1], e2 = extent[2], e3 = extent[3], e4 = extent[4];
  let filled = 0;
  // 埋まったあとは「現在の最小」を超えるものだけを入れ替える
  let minAt = 0;
  let minVal = Number.POSITIVE_INFINITY;
  for (let v = 0; v < count; v++) {
    const o = v * 5;
    const a0 = base[o] * e0;
    const a1 = base[o + 1] * e1;
    const a2 = base[o + 2] * e2;
    const a3 = base[o + 3] * e3;
    const a4 = base[o + 4] * e4;
    const n2 = a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3 + a4 * a4;
    if (filled < k) {
      scratch.candidates[filled] = v;
      scratch.norms[filled] = n2;
      filled++;
      if (filled === k) {
        minVal = Number.POSITIVE_INFINITY;
        for (let i = 0; i < k; i++) {
          if (scratch.norms[i] < minVal) { minVal = scratch.norms[i]; minAt = i; }
        }
      }
      continue;
    }
    if (n2 <= minVal) continue;
    scratch.candidates[minAt] = v;
    scratch.norms[minAt] = n2;
    minVal = Number.POSITIVE_INFINITY;
    for (let i = 0; i < k; i++) {
      if (scratch.norms[i] < minVal) { minVal = scratch.norms[i]; minAt = i; }
    }
  }
  return filled;
}

/**
 * 位相 `i / m` における角度を作る。`θ_k = ω_k · s`、`s = ORBIT_PERIOD · i / m`。
 *
 * **`gate` を掛けない** ── 上の説明のとおり、`gate` は `s` を定数倍するだけで、
 * 到達する角度の集合を変えない。
 */
export function probePhases(i: number, m: number, out: RotationPhases): RotationPhases {
  const s = (ORBIT_PERIOD * i) / m;
  for (let k = 0; k < PLANES.length; k++) out[k] = PLANES[k].omega * s;
  return out;
}

/** 候補点を 1 つの位相で投影し、広がりへ畳む。`liftProject5` と**同じ式**でなければならない */
function accumulateSpread(
  base: Float32Array,
  candidates: Int32Array,
  used: number,
  m: Float64Array,
  dist: number,
  acc: { aX: number; aY: number; zHi: number },
): void {
  const m00 = m[0], m01 = m[1], m02 = m[2], m03 = m[3], m04 = m[4];
  const m10 = m[5], m11 = m[6], m12 = m[7], m13 = m[8], m14 = m[9];
  const m20 = m[10], m21 = m[11], m22 = m[12], m23 = m[13], m24 = m[14];
  const m30 = m[15], m31 = m[16], m32 = m[17], m33 = m[18], m34 = m[19];
  const m40 = m[20], m41 = m[21], m42 = m[22], m43 = m[23], m44 = m[24];

  for (let c = 0; c < used; c++) {
    const o = candidates[c] * 5;
    const x0 = base[o];
    const x1 = base[o + 1];
    const x2 = base[o + 2];
    const x3 = base[o + 3];
    const x4 = base[o + 4];

    let p0 = m00 * x0 + m01 * x1 + m02 * x2 + m03 * x3 + m04 * x4;
    let p1 = m10 * x0 + m11 * x1 + m12 * x2 + m13 * x3 + m14 * x4;
    let p2 = m20 * x0 + m21 * x1 + m22 * x2 + m23 * x3 + m24 * x4;
    let p3 = m30 * x0 + m31 * x1 + m32 * x2 + m33 * x3 + m34 * x4;
    const p4 = m40 * x0 + m41 * x1 + m42 * x2 + m43 * x3 + m44 * x4;

    let f = dist / (dist - p4);
    if (f > F_CLAMP) f = F_CLAMP;
    else if (f < -F_CLAMP) f = -F_CLAMP;
    p0 *= f; p1 *= f; p2 *= f; p3 *= f;

    f = dist / (dist - p3);
    if (f > F_CLAMP) f = F_CLAMP;
    else if (f < -F_CLAMP) f = -F_CLAMP;
    p0 *= f; p1 *= f; p2 *= f;

    const ax = p0 < 0 ? -p0 : p0;
    const ay = p1 < 0 ? -p1 : p1;
    if (ax > acc.aX) acc.aX = ax;
    if (ay > acc.aY) acc.aY = ay;
    if (p2 > acc.zHi) acc.zHi = p2;
  }
}

/**
 * その `extent`（＝ その `dimLevel`）で、**位相を 1 周ぶん掃いたときの広がりの包絡**。
 *
 * **見積もりであって上界ではない**（上のとおり候補を絞っているため）。
 * 呼ぶ側は `framingHold` を外さないこと ── 外すと、外した見積もりのぶん図が帯を出る。
 */
export function framingEnvelope(
  base: Float32Array,
  count: number,
  extent: ArrayLike<number>,
  cascadeDist: number,
  scratch: EnvelopeScratch,
  phaseCount = ENVELOPE_PHASES,
): Spread {
  const acc = { aX: 0, aY: 0, zHi: 0 };
  if (!(count > 0) || !(phaseCount > 0)) return acc;
  const used = selectCandidates(base, count, extent, scratch);
  const n = PLANES.length;
  for (let i = 0; i < phaseCount; i++) {
    probePhases(i, phaseCount, scratch.phases);
    for (let k = 0; k < n; k++) scratch.angles[k].angle = scratch.phases[k];
    composeRotN(scratch.angles, 5, scratch.matrix);
    foldExtent(scratch.matrix, 5, extent);
    accumulateSpread(base, scratch.candidates, used, scratch.matrix, cascadeDist, acc);
  }
  return { aX: acc.aX, aY: acc.aY, zHi: acc.zHi > 0 ? acc.zHi : 0 };
}

/**
 * `extent` を書き出す。**`lensScene` と同じ式でなければならない**ので、ここが唯一の源。
 *
 * 退化した軸は `dimLevel` に依らず 0（SPEC §2.2）。
 */
export function extentFor(
  dimLevel: number,
  axisPresent: ArrayLike<boolean>,
  out: Float64Array,
): Float64Array {
  for (let k = 0; k < out.length; k++) {
    if (!axisPresent[k]) { out[k] = 0; continue; }
    const v = dimLevel - k;
    out[k] = v <= 0 ? 0 : v >= 1 ? 1 : v;
  }
  return out;
}

/**
 * `dimLevel` で刻んだ包絡の表。**各スロットは 1 度しか計算しない。**
 *
 * `spreads` は `[aX, aY, zHi]` の 3 つ組を `ENVELOPE_SLOTS` 本。
 */
export interface EnvelopeCache {
  readonly spreads: Float64Array;
  readonly filled: Uint8Array;
  readonly scratch: EnvelopeScratch;
  readonly extent: Float64Array;
}

export function createEnvelopeCache(): EnvelopeCache {
  return {
    spreads: new Float64Array(ENVELOPE_SLOTS * 3),
    filled: new Uint8Array(ENVELOPE_SLOTS),
    scratch: createEnvelopeScratch(ENVELOPE_CANDIDATES),
    extent: new Float64Array(5),
  };
}

/** `dimLevel` をスロット番号へ。`[0, ENVELOPE_MAX_DIM]` の外は端へ寄せる */
export function slotFor(dimLevel: number): number {
  if (!Number.isFinite(dimLevel)) return 0;
  const q = Math.round(dimLevel / ENVELOPE_DIM_STEP);
  return q < 0 ? 0 : q >= ENVELOPE_SLOTS ? ENVELOPE_SLOTS - 1 : q;
}

function slotSpread(
  cache: EnvelopeCache,
  slot: number,
  base: Float32Array,
  count: number,
  axisPresent: ArrayLike<boolean>,
  cascadeDist: number,
): Spread {
  const o = slot * 3;
  if (!cache.filled[slot]) {
    extentFor(slot * ENVELOPE_DIM_STEP, axisPresent, cache.extent);
    const s = framingEnvelope(base, count, cache.extent, cascadeDist, cache.scratch);
    cache.spreads[o] = s.aX;
    cache.spreads[o + 1] = s.aY;
    cache.spreads[o + 2] = s.zHi;
    cache.filled[slot] = 1;
  }
  return { aX: cache.spreads[o], aY: cache.spreads[o + 1], zHi: cache.spreads[o + 2] };
}

/**
 * その `dimLevel` で使う包絡。**挟む 2 スロットの大きいほう**を返す ──
 * 刻みの間で見積もりが実際の必要量を下回らないように、安全側へ倒す。
 *
 * **これは見積もりであって上界ではない**（候補を 32 点に絞り、位相も有限個しか掃かない）。
 * `framingHold` を外さないこと。
 */
export function envelopeFor(
  cache: EnvelopeCache,
  base: Float32Array,
  count: number,
  axisPresent: ArrayLike<boolean>,
  dimLevel: number,
  cascadeDist: number,
): Spread {
  const q = dimLevel / ENVELOPE_DIM_STEP;
  const lo = slotFor(Math.floor(q) * ENVELOPE_DIM_STEP);
  const hi = slotFor(Math.ceil(q) * ENVELOPE_DIM_STEP);
  const a = slotSpread(cache, lo, base, count, axisPresent, cascadeDist);
  if (hi === lo) return a;
  const b = slotSpread(cache, hi, base, count, axisPresent, cascadeDist);
  return {
    aX: a.aX > b.aX ? a.aX : b.aX,
    aY: a.aY > b.aY ? a.aY : b.aY,
    zHi: a.zHi > b.zHi ? a.zHi : b.zHi,
  };
}
