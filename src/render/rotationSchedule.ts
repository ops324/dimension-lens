/**
 * 回転の進行を dimLevel で門する、**純関数と小さな状態**。
 *
 * ## アンカー窓 —— この作品が乗っている唯一の錨
 *
 * `dimLevel = 2` は「あなたの写真そのもの」でなければならない。写真が少しでも
 * 回っていたら、それは写真ではない。だから窓 `[1.9, 2.1]` の中では
 * **回転角が厳密に 0** である必要がある ── 「ほぼ 0」ではない。
 *
 * ### 罠 1: 窓の判定を減算で書くと端点が落ちる（実測）
 *
 * ```
 * 2.1 - 2 = 0.10000000000000008882      1.9 - 2 = -0.10000000000000008882
 * ```
 * つまり `Math.abs(d - 2) <= 0.1` は **d = 1.9 でも d = 2.1 でも false** になる。
 * 窓の縁ちょうどで写真が回り出す、という最も気づきにくい壊れ方をする。
 * → 窓は**端点との直接比較**で書く。中心からの距離を計算しない。
 *
 * ### 罠 2: 角度を指数平滑すると厳密 0 に到達しない（実測）
 *
 * `expSmooth(x, 0, 6, 1/60)` は 600 フレーム後でも 8.76e-27 で、**有限時間で 0 にならない**。
 * `ease.ts` の `smoothstep` は `smoothstep(0) === 0` が `Object.is` で厳密なので、
 * **門は smoothstep で作り、角度そのものは平滑しない**。
 *
 * ### 罠 3: `θ = gate(d) · ω · t` は窓を出た瞬間に跳ねる
 *
 * `t` は増え続ける絶対時刻なので、窓に入って出ると `ω·t` が飛んでいる。
 * 厳密 0・連続・跳ねない、を同時に満たすには**位相を門つきで積分する**:
 *
 * ```
 * τ ← τ + gate(d)·ω·dt      窓の中では τ が進まない
 * θ = gate(d)·τ             窓の中では厳密に 0
 * ```
 *
 * `gate` が 0 のとき `θ` は τ の値によらず厳密 0 になり、窓を出るときは
 * τ が入る前の値から連続に再開する。これは `(state, dimLevel, dt) → state'` の
 * 純関数なので node でテストできる ── GPU も rAF も要らない。
 */

import { smoothstep } from '../math/ease';
import type { PlaneRotation } from '../math/rotation';

/** アンカー窓。**端点を含む**（含まないと縁で写真が回る） */
export const ANCHOR_MIN = 1.9;
export const ANCHOR_MAX = 2.1;

/** 門が 0 から 1 へ立ち上がる幅（dimLevel 単位） */
export const GATE_RAMP = 0.35;

/** dimLevel がアンカー窓の中か。**減算しない** */
export function isAnchored(dimLevel: number): boolean {
  return dimLevel >= ANCHOR_MIN && dimLevel <= ANCHOR_MAX;
}

/**
 * 回転の門 `A(d) ∈ [0, 1]`。窓の中で**厳密に 0**、窓の外で連続に立ち上がる。
 *
 * `smoothstep` は C¹ なので、窓の縁で速度も 0 から始まる ──
 * 窓を出た瞬間に回り始めるのではなく、滑り出す。
 */
export function rotationGate(dimLevel: number): number {
  if (!Number.isFinite(dimLevel)) return 0;
  if (isAnchored(dimLevel)) return 0;
  const beyond = dimLevel < ANCHOR_MIN ? ANCHOR_MIN - dimLevel : dimLevel - ANCHOR_MAX;
  return smoothstep(beyond / GATE_RAMP);
}

/**
 * 板と点群のクロスフェード。**同じ門から出す。**
 *
 * ## なぜ同じ門なのか
 *
 * 板（写真そのもの）と点群（スプライトによる再構成）を**両方フル強度で描くと、
 * 平坦部の値は 2 倍になる** ── 加算合成なので当然だが、素案はこれを規定していなかった。
 * ΔE00 ≤ 2.0 のゲートは 2 倍を絶対に通さないので、合成則は 1a-iii の必須事項である。
 *
 * 規則: **アンカー窓の中では板が 1、点群が厳密に 0。**
 * 「あなたの写真そのもの」は、スプライトで再構成した近似ではなく**実際の画素**である。
 * 窓を出ると回転が始まると同時に点群へ渡る ── 動き始めることと、
 * 写真が点の雲へ解けることが、同じ 1 つの門から出る。
 *
 * `plateWeight + cloudWeight` は**構成上つねに厳密に 1**（引き算 1 回で作る）。
 * 2 つを別々に補間すると、中間で合計が 1 を外れて平坦部の値がずれる。
 */
export function cloudWeight(dimLevel: number): number {
  return rotationGate(dimLevel);
}

export function plateWeight(dimLevel: number): number {
  return 1 - rotationGate(dimLevel);
}

/**
 * 回転平面と角速度（rad/s）。
 *
 * (3,4) が色相回転そのもの（SPEC §2.1）なので**最も遅く**回す ── 一番見せたい平面を
 * 一番ゆっくり見せる。(0,1) は普通の画像の回転なので入れない
 * （剛体回転は「次元を上る」ことを何も語らない）。
 */
export interface RotationPlane {
  readonly i: number;
  readonly j: number;
  /** rad/s */
  readonly omega: number;
}

export const PLANES: readonly RotationPlane[] = [
  { i: 0, j: 2, omega: 0.11 }, // 明暗の起伏が立ち上がる
  { i: 1, j: 2, omega: 0.07 },
  { i: 3, j: 4, omega: 0.05 }, // 色相回転そのもの。最も遅く
  { i: 0, j: 4, omega: 0.03 }, // 位置が色に変わる、名前のない混合
  { i: 1, j: 3, omega: 0.023 },
];

/** 門つきで積分された位相。**平面ごとに 1 つ** */
export type RotationPhases = Float64Array;

export function createPhases(): RotationPhases {
  return new Float64Array(PLANES.length);
}

/**
 * 位相を厳密に 0 へ戻す。**測定の再現性のためだけにある**（Phase 1b で追加）。
 *
 * `freezeRotation(true)` は位相を保持するので、「凍結したから再現可能」は偽である ──
 * **どの位相で凍結したかが結果を決める**。しかも測定の手順そのもの
 * （`setDimLevel` も `setPath` も `renderOnce(1)` を打つ）が位相を進めるので、
 * 門が開いている領域では手順の違いがそのまま数値の違いになる。
 */
export function resetPhases(phases: RotationPhases): RotationPhases {
  phases.fill(0);
  return phases;
}

/**
 * 位相を 1 ステップ進める。**純関数**（`phases` を in-place で更新して返す）。
 *
 * 窓の中では `gate = 0` なので `phases` は 1 ビットも動かない ──
 * 「窓の中で止まっている」ではなく「窓の中では時間が流れていない」。
 */
export function advancePhases(
  phases: RotationPhases,
  dimLevel: number,
  dt: number,
): RotationPhases {
  const gate = rotationGate(dimLevel);
  if (gate === 0 || !(dt > 0)) return phases;
  for (let k = 0; k < PLANES.length; k++) {
    phases[k] += gate * PLANES[k].omega * dt;
  }
  return phases;
}

/**
 * 現在の角度を書き出す。窓の中では**全要素が厳密に 0**。
 *
 * `out` は `composeRotN` へそのまま渡せる形。毎フレームのアロケーションはゼロ。
 */
export function readAngles(
  phases: RotationPhases,
  dimLevel: number,
  out: PlaneRotation[],
): PlaneRotation[] {
  const gate = rotationGate(dimLevel);
  for (let k = 0; k < PLANES.length; k++) {
    const p = PLANES[k];
    const o = out[k];
    o.i = p.i;
    o.j = p.j;
    // gate === 0 のとき phases[k] の値によらず **厳密に 0**
    o.angle = gate === 0 ? 0 : gate * phases[k];
  }
  return out;
}

/** `readAngles` の書き込み先を作る */
export function createAngleBuffer(): PlaneRotation[] {
  return PLANES.map((p) => ({ i: p.i, j: p.j, angle: 0 }));
}
