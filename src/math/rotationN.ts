/**
 * SO(n) 回転の行列合成と、「extent 畳み込み → 回転 → 透視カスケード」を
 * 1 パスに融合したホットパスカーネル。
 *
 * ── なぜ rotateBatch を毎フレーム呼ばないのか
 *
 * `rotateBatch` は**回転平面ごとにバッファ全体をストリーミングする**。160,000 点 ×
 * 5 座標を f32 で持つと 3.2 MB で、平面が 4 枚なら read+write が 4 往復して
 * 25 MB/frame。60fps なら 1.5 GB/s の帯域を回転だけに使うことになる。
 *
 * 平面回転の列は先に 1 枚の n×n 行列へ合成できる(n=5 で 25 乗算 × 平面数、
 * **1 フレームに 1 回**)。合成してしまえばバッファは 1 パスで済む。
 *
 * ── なぜ extent を行列に畳むのか
 *
 * `extent[k] = clamp01(dimLevel − k)` の対角行列 E による縮小は、回転 R の**前**に
 * 掛かる(先に軸を縮めてから回す)。つまり適用したいのは R·E で、これは合成時に
 * **列をスケールするだけ**でできる ── 中間バッファも、そのための 1 パスも消える。
 *
 * ── なぜ投影も同じループに入れるのか
 *
 * 投影を別関数にすると n 座標を書いて読み直すことになる。融合すれば 5 要素を
 * レジスタに読んで 3 要素だけ書く。合計トラフィックは約 4.6 MB/frame ──
 * 素直に 3 パスで書いた場合の 1/7。
 *
 * ── f64 ではなく f32 でよい理由
 *
 * `rotation.ts` の契約どおり角度は毎フレーム絶対値で再計算するので誤差が蓄積しない。
 * 座標は [−1,1] に住み、元データは 8bit の画素値。f64 の stride 40 バイトは
 * 全点が 64B キャッシュラインを跨ぐという実害もある。
 *
 * 正しさの根拠は一点だけ: **`projection.ts` の素直な実装と 1e-6 で一致すること**。
 * それを rotationN.test.ts が固定している。
 */

import type { PlaneRotation } from './rotation';
import { MAX_N } from './projection';

/**
 * 透視除算係数の暴走ガード。**`projection.ts` の F_CLAMP と同じ値でなければならない**
 * (あちらは非公開なので複製している)。ずれた場合は等価性テストが落ちる。
 */
export const F_CLAMP = 50;

const IN = new Float64Array(MAX_N);
const OUT = new Float64Array(MAX_N);

/**
 * 平面回転の列を n×n 行列(row-major, 長さ n²)へ合成する。
 *
 * `rotateBatch` と同じ適用順序になるよう、各 Givens を**左から**掛ける ──
 * rotateBatch は v ← G_r v を r=0.. の順に行うので、最終的な写像は
 * G_{R−1}·…·G_1·G_0 である。単位行列から始めて左乗算を重ねると、この積が得られる。
 *
 * 左乗算 G(i,j)·M は M の**行** i, j だけを混ぜる(右乗算なら列)。
 * ここを取り違えると順序が逆の行列ができ、しかも見た目には動いてしまう ──
 * 等価性テストが存在する理由がこれ。
 *
 * target を書き換えて返す(アロケーションなし)。
 */
export function composeRotN(
  rots: readonly PlaneRotation[],
  n: number,
  target: Float64Array,
): Float64Array {
  target.fill(0, 0, n * n);
  for (let k = 0; k < n; k++) target[k * n + k] = 1;
  for (let r = 0; r < rots.length; r++) {
    const rot = rots[r];
    const c = Math.cos(rot.angle);
    const s = Math.sin(rot.angle);
    const oi = rot.i * n;
    const oj = rot.j * n;
    for (let col = 0; col < n; col++) {
      const a = target[oi + col];
      const b = target[oj + col];
      target[oi + col] = a * c - b * s;
      target[oj + col] = a * s + b * c;
    }
  }
  return target;
}

/**
 * 合成済み行列 M へ extent の対角を畳み込んで M·E にする(列のスケール)。
 * composeRotN の直後に 1 回だけ呼ぶ。
 */
export function foldExtent(
  target: Float64Array,
  n: number,
  extent: ArrayLike<number>,
): Float64Array {
  for (let row = 0; row < n; row++) {
    const o = row * n;
    for (let col = 0; col < n; col++) target[o + col] *= extent[col];
  }
  return target;
}

/**
 * n×n 行列を f64 のインターリーブ点列へ適用する。**参照実装** ──
 * `rotateBatch` との等価性を示すためだけに存在し、実行経路では使わない。
 */
export function applyMatrixBatch(
  src: Float64Array,
  dst: Float64Array,
  n: number,
  count: number,
  m: Float64Array,
): void {
  for (let v = 0; v < count; v++) {
    const o = v * n;
    for (let k = 0; k < n; k++) IN[k] = src[o + k];
    for (let row = 0; row < n; row++) {
      const mo = row * n;
      let acc = 0;
      for (let col = 0; col < n; col++) acc += m[mo + col] * IN[col];
      OUT[row] = acc;
    }
    for (let k = 0; k < n; k++) dst[o + k] = OUT[k];
  }
}

/**
 * 融合カーネル(任意 n)。base(f32・インターリーブ n)へ M を適用し、
 * そのまま透視カスケード nD→3D を通して out(f32・3 要素/点)へ書く。
 *
 * `m` には **extent を畳み込み済みの** 行列を渡すこと(foldExtent)。
 */
export function liftProject(
  base: Float32Array,
  count: number,
  n: number,
  m: Float64Array,
  dist: number,
  out: Float32Array,
): void {
  for (let v = 0; v < count; v++) {
    const o = v * n;
    for (let k = 0; k < n; k++) IN[k] = base[o + k];
    for (let row = 0; row < n; row++) {
      const mo = row * n;
      let acc = 0;
      for (let col = 0; col < n; col++) acc += m[mo + col] * IN[col];
      OUT[row] = acc;
    }
    for (let d = n - 1; d >= 3; d--) {
      let f = dist / (dist - OUT[d]);
      if (f > F_CLAMP) f = F_CLAMP;
      else if (f < -F_CLAMP) f = -F_CLAMP;
      for (let k = 0; k < d; k++) OUT[k] *= f;
    }
    const w = v * 3;
    out[w] = OUT[0];
    out[w + 1] = OUT[1];
    out[w + 2] = OUT[2];
  }
}

/**
 * 融合カーネルの n=5 展開版。中間配列に一切触れず、5 要素をローカルへ読んで
 * 3 要素だけ書く。モードA の実行経路はこちら。
 *
 * 展開する価値があるかは**測って決める**(bench/kernel.bench.ts)。
 * 差が出なければ liftProject 一本にしてこれを消すこと ── コードは短いほうがよい。
 */
export function liftProject5(
  base: Float32Array,
  count: number,
  m: Float64Array,
  dist: number,
  out: Float32Array,
): void {
  const m00 = m[0], m01 = m[1], m02 = m[2], m03 = m[3], m04 = m[4];
  const m10 = m[5], m11 = m[6], m12 = m[7], m13 = m[8], m14 = m[9];
  const m20 = m[10], m21 = m[11], m22 = m[12], m23 = m[13], m24 = m[14];
  const m30 = m[15], m31 = m[16], m32 = m[17], m33 = m[18], m34 = m[19];
  const m40 = m[20], m41 = m[21], m42 = m[22], m43 = m[23], m44 = m[24];

  for (let v = 0; v < count; v++) {
    const o = v * 5;
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

    // d=4
    let f = dist / (dist - p4);
    if (f > F_CLAMP) f = F_CLAMP;
    else if (f < -F_CLAMP) f = -F_CLAMP;
    p0 *= f;
    p1 *= f;
    p2 *= f;
    p3 *= f;

    // d=3
    f = dist / (dist - p3);
    if (f > F_CLAMP) f = F_CLAMP;
    else if (f < -F_CLAMP) f = -F_CLAMP;
    p0 *= f;
    p1 *= f;
    p2 *= f;

    const w = v * 3;
    out[w] = p0;
    out[w + 1] = p1;
    out[w + 2] = p2;
  }
}

/**
 * 透視カスケードが安全になる視点距離を返す。
 *
 * 段 d の増幅は `f = dist/(dist − p[d])` で、入力ノルム `r` に対し出力は
 * `r · dist/(dist − r)`。n=5 は 2 段(d=4, d=3)なので、第 2 段の入力が dist を割るには
 *
 *     r · dist/(dist − r) < dist   ⟺   **dist > 2r**
 *
 * が必要十分。`lift()` が返す `maxNorm` は 1 を超えうる ── `sC` が p95 なので
 * 上位 5% の画素は a', b' が 1 を超える。**測ってから dist を決める**のが
 * 「‖x‖ ≤ 1 に正規化してあるから安全」という恒真の思い込みへの対処である(SPEC §4.8)。
 *
 * `margin` は余裕。2.2 なら「dist = 2.2·maxNorm」で、必要条件 2.0 に 10% の余裕。
 */
export function safeDist(maxNorm: number, base = 2.4, margin = 2.2): number {
  const need = margin * (maxNorm > 0 ? maxNorm : 0);
  return need > base ? need : base;
}

export interface CascadeSafety {
  /** 全点・全段を通じた max(|p[d]| / dist)。1 以上なら分母が符号反転している */
  maxRatio: number;
  /** F_CLAMP が一度でも発動したか */
  clamped: boolean;
}

/**
 * 透視カスケードの**真の**前提条件を測る。
 *
 * よくある誤解: 「‖x‖ ≤ 1 に正規化してあるから安全」。これが保証するのは
 * **第 1 段だけ**である。各段は座標を f = dist/(dist−p[d]) 倍に増幅するので、
 * 第 2 段の入力ノルムは 1 ではなく dist/(dist−1) になり、段ごとに累積する。
 *
 * 正しい不変条件は「どの段でも |p[d]| < dist」。n=5・dist=2.4 なら
 * r₁ = 2.4/1.4 = 1.714 で分母は 0.686 以上 ── 安全だが余裕は 29% しかなく、
 * しかも F_CLAMP のせいで破れても NaN にならず**無音で壊れる**。
 *
 * Phase 4(n ≤ 10)では実際に破綻する: r₁ = 1.714 → r₂ = 5.997 > 2.4。
 * そのときは dimension 側の polytopeExhibit が持つ auto-dist ループを
 * 純関数として持ち込むこと。
 */
export function cascadeSafety(
  base: Float32Array,
  count: number,
  n: number,
  m: Float64Array,
  dist: number,
): CascadeSafety {
  let maxRatio = 0;
  let clamped = false;
  for (let v = 0; v < count; v++) {
    const o = v * n;
    for (let k = 0; k < n; k++) IN[k] = base[o + k];
    for (let row = 0; row < n; row++) {
      const mo = row * n;
      let acc = 0;
      for (let col = 0; col < n; col++) acc += m[mo + col] * IN[col];
      OUT[row] = acc;
    }
    for (let d = n - 1; d >= 3; d--) {
      const ratio = Math.abs(OUT[d]) / dist;
      if (ratio > maxRatio) maxRatio = ratio;
      let f = dist / (dist - OUT[d]);
      if (f > F_CLAMP) {
        f = F_CLAMP;
        clamped = true;
      } else if (f < -F_CLAMP) {
        f = -F_CLAMP;
        clamped = true;
      }
      for (let k = 0; k < d; k++) OUT[k] *= f;
    }
  }
  return { maxRatio, clamped };
}
