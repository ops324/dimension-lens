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
 * ## なぜ「ノルム上位 K 点」を掃くのか —— そして**この論法は上界を与えない**
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
 * → `|E·x|` の大きい上位 K 点は、**上界の大きい K 点**である。
 *
 * ## **2c-ii はここで論理を 1 段飛ばしていた**（Phase 2c-iv・独立監査が実測）
 *
 * 上の命題が言うのは「ノルム r の点が**出しうる**半径の上界」であって、
 * **「ノルム最大の点がその位相で最大を取る」ではない。** 2c-ii のこの位置には
 * 「極値を取るのはつねにノルム最大の一握りの点である」と書いてあったが、**それは偽**である。
 *
 * 実測（標本 No.0・M = 512 位相・上位 32 と全 89,208 点の argmax を突き合わせ）:
 *
 * | d | `aX` の argmax を外した位相 | 外したときの最悪比 |
 * |---|---|---|
 * | 0.5 / 1.5 | 0 / 512 | 100.00% |
 * | 2.5 | 276 / 512 | 37.48% |
 * | 3.0 | 278 / 512 | 26.91% |
 * | 3.5 / 5.0 | 324〜378 / 512 | **0.00%**（32 点全部が原点付近へ潰れる） |
 *
 * `d ≥ 2.5` では**位相の 54〜74% で上位 32 が真の極値点を外している**。
 * No.0 で最終的な包絡が全点と一致するのは、4096 位相を掃くうちに上位ノルム点が
 * いずれ他を追い越す位相へ来るという**その標本の経験的性質**であって、代数の帰結ではない。
 *
 * → **これは見積もりであって上界ではない。** 上界の役は `framingHold` ではなく
 * **毎フレームの実測 `spread`** が持つ（`lensScene.updateCamera` の `unionSpread(spread, target)`。
 * 下の `framingEnvelope` の項に代数を書いた）。
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
 *
 * ## **上の表は「彩度軸が一度も効かない点」の上で測られていた**（Phase 2c-iv）
 *
 * 標本 No.0 の `|E·x|` 上位 32 は**全部が黒枠の点**である（添字 379, 380, 381, 752, …）。
 * 黒枠は彩度 0 なので `a' = b' = 0`、つまり `extent[3]` / `extent[4]` が立っても寄与しない。
 * 帰結として **No.0 の包絡は `d = 3` と `d = 5` で 8 桁目までしか違わない**
 * （1.95054454365150 対 1.95054459373394）。上の収束表も、下の「32 と 128 が同値」も、
 * **`d` を変えても候補が動かない点の上での確認**だった。
 *
 * ## それでも 4096 は足りている（他の標本でも実測した・Phase 2c-iv）
 *
 * 収束基準を M = 262144 に取り直し、標本を 4 種に増やして測った。M = 4096 の収束比は
 * **最悪 99.649%**（1 行画像・`d = 3`）、99.83% を下回る `dimLevel` は 52 組中 13 組。
 * 不足は最大 0.35% で、候補選抜の不足（下記・最大 8.9%）より 1 桁小さい。
 * **ここに予算を足す優先度は低い**（16384 にすれば全域 99.973% 以上・費用 32 ms/スロット）。
 */
export const ENVELOPE_PHASES = 4096;

/**
 * 掃く点数。`|E·x|` の上位からこれだけ取る。
 *
 * 標本 No.0 では 32 で足りる。**2c-ii の主張より強いことが言えた**（Phase 2c-iv）──
 * K = 32 / 64 / 128 / 256 / 1024 / 4096 / **全 89,208 点**が、
 * `d = 0.5〜5` の 10 点すべてで `aX` / `aY` / `zHi` の 6 桁まで一致する。
 * BALANCED / ULTRA 格子でも、グレースケールでも、単色でも、乱数画像でも同じ。
 *
 * ## **しかし一般には足りない。そして K を上げても直らない**（Phase 2c-iv・実測）
 *
 * 割れる標本が在る（M = 4096・基準は全点）:
 *
 * | 標本 | d | `need` の比 |
 * |---|---|---|
 * | 1024×64（横長） | 5.0 | **91.572%** |
 * | 1024×1（1 行） | 5.0 | **91.119%** |
 * | 1024×640 色相スイープ（**普通のアスペクト**） | 5.0 | 98.465% |
 *
 * つまりカメラ距離の見積もりが**最大 8.9% 足りない**。図は帯を出ない
 * （`framingEnvelope` の項の代数を見よ）が、**その標本では「構図が経過時間の関数で
 * なくなった」が成り立たない** ── ホールドが後から育つ。
 *
 * 割れる条件はアスペクトではなく「**ノルム分布の上が平ら**」であること。
 * `|{n ≥ 0.99·max}|` が予測子になる（No.0 は 69、色相スイープ 242、横長 **4252**）。
 * 上位が同値に近いと、上位 32 は事実上任意の部分集合になり、しかも空間的に固まる。
 *
 * **定数を上げる修正では解けない**（M = 4096・1 スロットの費用）:
 *
 * | K | 横長 `d=5` の `need` 比 | 1 スロット | 21 スロット |
 * |---|---|---|---|
 * | **32（現行）** | 91.572% | **8.1 ms** | **170 ms** |
 * | 128 / 512 / 2048 | 91.66 / 91.66 / 91.79% | 27 / 102 / 412 ms | 0.56 / 2.1 / 8.7 s |
 * | **8192** | **100.000%** | **1 634 ms** | **34 s** |
 *
 * 2048 → 8192 に崖があり、それ以下は何倍にしても効かない。8192 は現行の **202 倍**で、
 * `ENVELOPE_DIM_STEP` の存在理由（費用の有界化）を壊す。
 * → **順位づけの規則そのものを見直さないと直らない。** 別フェーズの仕事として記録する。
 *
 * 参考（同じ 32 点で規則だけ替えた実測・M = 256・全点基準）: 「上位 16 ＋ 全点の等間隔 16」は
 * 12 セル中 9 セルで 100.000%、最悪 97.619%（現行の最悪は 93.525%）。
 * **費用は同じで最悪が良くなるが、依然として上界ではない。**
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
 *
 * ## 「外すと図が帯を出る」は偽だった（Phase 2c-iv・代数と実測）
 *
 * 2c-ii はここに「呼ぶ側は `framingHold` を外さないこと ── 外すと、外した見積もりのぶん
 * 図が帯を出る」と書いていた。**どちらの節も偽**である。図が帯を出ないことを担っているのは
 * 包絡でもホールドでもなく、**毎フレームの実測 `spread`** である。
 *
 * `lensScene.updateCamera` は `liftProject5` が**これから描くフレームの**位置を書いた直後に
 * 呼ばれ（`engine` の `frameCallbacks` は `composer.render()` の前に走る）、
 * `framed = unionSpread(spread, target)` は成分ごとの `max` なので `framed ≥ spread`。
 * `needDistance` は `aX` / `aY` / `zHi` のいずれについても単調非減少、
 * `framingHold` は `need` を下回る値を返さない。ゆえに
 *
 * ```
 * D − S.zHi ≥ max(S.aY/band, S.aX/aspect) / (fill·t)
 * ndc.x = S.aX / ((D − S.zHi)·t·aspect) ≤ fill = DEFAULT_FILL
 * ```
 *
 * **等号成立で 0.86 が上限**である。実測でも、遷移・定常・無作為跳躍・退化画像・3 ティア・
 * `setPath('cloud')` を合わせて約 39 万フレーム掃いて、`stats().fill` の最大は
 * **どの掃きでも厳密に 0.86000000**、1.0 に近づく経路すら無かった
 * （スプライト半径を足しても最悪 0.874 ── 余白 14% に対し半径 1.4%）。
 *
 * → **包絡が外れても、図は帯を出ない。**`framingHold` を外して起きるのは呼吸であって
 * 逸脱ではない。包絡とホールドが守っているのは「**大きさが時間で変わらないこと**」で、
 * 「収まり」ではない。2 つを混ぜて書くと、外れた見積もりが安全性の問題に見える。
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
 * その `dimLevel` で使う包絡。**挟む 2 スロットの大きいほう**を返す。
 *
 * ## 「max だから安全側」は**単調性の仮定であって、それは成り立たない**（Phase 2c-iv）
 *
 * 2c-ii はここに「刻みの間で見積もりが実際の必要量を下回らないように、安全側へ倒す」と
 * 書いていた。これは**包絡が `dimLevel` について単調であること**を仮定しているが、
 * 確かめられていなかった。**反例が在る。**
 *
 * 0.005 刻みで `[0, 5]` を 1001 点掃き、下降が標本化の雑音か本物かを M = 65536 で
 * 再測して分けた結果（Phase 2c-iv・独立監査）:
 *
 * | 標本 | d | 成分 | M=4096 | M=65536 | 本物か |
 * |---|---|---|---|---|---|
 * | No.0 | 2.090→2.095 | zHi | 1.335091→1.334939 | 1.338518→**1.338610** | **いいえ**（推定器の雑音） |
 * | グレースケール勾配 | 2.365→2.370 | aY | 1.387787→1.374063 | 1.389061→1.375490 | **はい（−0.977%）** |
 * | 1 行画像 | 4.910→4.915 | zHi | 1.812108→1.266844 | 1.812740→1.266906 | **はい（−30.1%）** |
 *
 * そして `envelopeFor` の返り値が、その `dimLevel` の厳密値を実際に下回る:
 *
 * | 標本 | 下回った点 | 最悪 | 不足 |
 * |---|---|---|---|
 * | No.0 / グレースケール / 単色 | 0 / 1001 | ── | なし |
 * | **1 行画像** | **46 / 1001** | `zHi` @ d=4.910 | **4.49%** |
 * | **1024×64 横長** | **48 / 1001** | `zHi` @ d=4.915 | **4.60%** |
 *
 * 代数でも単調性は言えない。理由は 4 つ、どれも独立である:
 *
 *   1. `d` が δ 増えると `e_k` は 1 本だけが δ 増えるので `p = R·E(d)·x` は δ の**アフィン関数**。
 *      `|p0|` / `|p1|` はアフィンの絶対値＝ V 字で、単調ではない
 *   2. カスケードの係数 `f = dist/(dist − p3)` は `p3` が負へ動くと 1 未満へ縮む ──
 *      extent が増えて `p3` が負方向へ動く点では、出力は extent の増加とともに**縮む**
 *   3. `selectCandidates` は `extent` 込みで順位づけるので、**候補集合そのものが
 *      `d` について不連続に変わる**。連続性すら保証が無い
 *   4. 包絡は有限個の位相の max なので、そもそも連続量の max ではない
 *
 * **`needDistance` 換算では一度も下回らなかった** ── `zHi` の不足を `aX`/`aY` 側の余裕が
 * 吸収したためである。だがそれは偶然の相殺で、`zHi` は「点がカメラを越えないこと」を
 * 担う量である（`fit.ts` が `needDistance` の項で記録している当の壊れ方）。
 *
 * **これは見積もりであって上界ではない**（候補を 32 点に絞り、位相も有限個しか掃かず、
 * 刻みの間は単調性の成り立たない `max` で埋める）。図が帯を出ないことは
 * `framingEnvelope` の項の代数が別途保証している ── **ここが外れて壊れるのは
 * 「大きさが時間で変わらないこと」だけ**である。
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
