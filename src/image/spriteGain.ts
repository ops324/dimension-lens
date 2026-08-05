/**
 * スプライトの正規化ゲイン。「平坦な面が、点数にも DPR にも依らず本来の値で出る」ための係数。
 *
 * スプライトは `w(r) = exp(−F·r²)`、`r = |gl_PointCoord − 0.5|`、`r² > 0.25` で `discard`。
 * 光る円の直径は `S = gl_PointSize` device px。
 *
 * ── 定数の由来(実測)
 *
 * 設計当初の `F = 6, kSprite = 1.7` は**平坦場リップル 44.7%** だった。原因は幾何で、
 * 光る半径が `kSprite/2 = 0.85` セルしかなく、**軸方向の隣接点(距離 1.0 セル)が
 * `discard` で丸ごと消える**。格子点の上では自分 1 個、セル中心では 4 個が寄与し、
 * 被覆数が 1→2→4 と振れる。親の `F = 17` は線のグローの芯を締めるための値で、
 * 写真の格子には再構成のための重なりが要る。
 *
 * (F, kSprite) を探索して **F = 21, kSprite = 3.85 → リップル 0.68%** を採用した。
 * 代償は fill が `kSprite²` に比例して 2.89 → **14.8 倍**、
 * オーバードローは常時 `π/4·kSprite² ≈ 11.6 × フレームバッファ`。
 * **これは Phase 2 のフィルレート測定の対象として記録する**(隠さない)。
 */

/** ガウシアンの減衰。実測で決めた値。単独で動かさないこと(kSprite と組) */
export const F = 21;
/** スプライト直径 / セル間隔。同上 */
export const K_SPRITE = 3.85;

/** 連続近似のエネルギー `∫∫ exp(−F r²) [r²≤1/4] = (π/F)(1 − e^{−F/4})`(S² で割った値) */
export function analyticK(f = F): number {
  return (Math.PI / f) * (1 - Math.exp(-f / 4));
}

/**
 * 離散化されたスプライトのエネルギー。
 *
 * **なぜ解析式ではなく数値表か。** GPU は連続円ではなく離散グリッドをラスタライズするので、
 * `Ksum(F,S)/S² → K(F)` は `S → ∞` でしか成り立たない。小さい `S` では
 * `discard` 境界が取り込む画素数が S ごとに変わるため、比が**振動する**。
 * これは較正であって公式ではないので、データとして持つ。
 *
 * ただし「駆動側の `gl_PointCoord` 規約やドライバの丸めを吸収する」とは**言えない** ──
 * CPU で作る表は我々の規約を*符号化*するだけで、食い違うドライバは吸収できない。
 * それは G2 が実測で当てる(実効 Ksum をフィットして表と 2% 以内か見る)。
 */
export function ksum(f: number, s: number): number {
  const n = Math.max(1, Math.ceil(s));
  let acc = 0;
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      const dx = (px + 0.5) / s - 0.5;
      const dy = (py + 0.5) / s - 0.5;
      const r2 = dx * dx + dy * dy;
      if (r2 <= 0.25) acc += Math.exp(-f * r2);
    }
  }
  return acc;
}

/** 表の刻み: S ∈ [1, 16]、0.125 刻みで 121 点 */
export const KSUM_S_MIN = 1;
export const KSUM_S_MAX = 16;
export const KSUM_STEP = 0.125;

export const KSUM_TABLE: Float64Array = (() => {
  const n = Math.round((KSUM_S_MAX - KSUM_S_MIN) / KSUM_STEP) + 1;
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = ksum(F, KSUM_S_MIN + i * KSUM_STEP);
  return t;
})();

/** 表を線形補間して `Ksum(F, s)` を返す。範囲外は解析式 `K·s²` に落とす */
export function ksumLookup(s: number): number {
  if (s <= KSUM_S_MIN) return ksum(F, Math.max(0.25, s));
  if (s >= KSUM_S_MAX) return analyticK() * s * s;
  const t = (s - KSUM_S_MIN) / KSUM_STEP;
  const i = Math.floor(t);
  const frac = t - i;
  return KSUM_TABLE[i] * (1 - frac) + KSUM_TABLE[i + 1] * frac;
}

/**
 * 較正が生きている最小の `s0`(device px)。**Phase 1b で実測して足した。**
 *
 * `ksumLookup` の下端分岐 `ksum(F, max(0.25, s))` は `ceil(s) = 1` のとき
 * **中心 1 画素しか数えない**。その 1 画素が `r² > 0.25` に落ちると `ksum = 0` になる ──
 * つまり `gainFor(s0) = Infinity` が返る。`uGain` に Infinity が入ると
 * `vColor * (uGain * uWeight * w)` が全画面 Inf になり、**GL エラーは出ない**。
 *
 * 実測（漸近値 `1/(K·kSprite²) = 0.453349` に対する誤差）:
 *
 * | s0 | S = k·s0 | gainFor | 誤差 |
 * |---|---|---|---|
 * | 0.15 | 0.578 | **Infinity** | —— |
 * | 0.25 | 0.963 | 0.063504 | −85.99% |
 * | 0.4149 | 1.597 | 0.687648 | **+51.68%** |
 * | 0.5 | 1.925 | 1.006661 | +122.05% |
 * | 0.8298 | 3.195 | 0.439287 | −3.10% |
 * | **0.86** | **3.311** | —— | **ここから ±2% 以内** |
 * | 2.2478（1a-iii の実機値） | 8.654 | 0.453073 | −0.06% |
 *
 * → `gainFor` は入力を**この値でクランプする**。2.2478 ≫ 0.86 なので
 * **アンカーの `gain` は 1 ビットも動かない**（G2b の実測がそのまま生きる）。
 * クランプが発火する構成そのものを作らないのが本筋なので、
 * `LINE_MAX_POINTS`（`columnLine.ts`）は格子の間隔以上を保つように決めてある。
 */
export const MIN_CALIBRATED_S0 = 0.86;

/** その `s0` が較正域の内側か。`sceneStats` が出して、外れたら PR に書く */
export function isCalibratedS0(s0: number): boolean {
  return s0 >= MIN_CALIBRATED_S0;
}

/**
 * 平坦場を本来の値で再構成するための、1 スプライトあたりの輝度係数。
 *
 * `s0` = セル 1 個あたりの device px。`S = K_SPRITE · s0`。
 * `g = s0² / Ksum(F, S)` ── 連続近似では `1/(K·kSprite²)` に潰れ、
 * **点数にも DPR にも依らない定数**になる(s0 と S が同じ比で動くため)。
 *
 * `MIN_CALIBRATED_S0` でクランプする理由は上記。**戻り値は常に有限**である。
 */
export function gainFor(s0: number): number {
  const s = s0 > MIN_CALIBRATED_S0 ? s0 : MIN_CALIBRATED_S0;
  return (s * s) / ksumLookup(K_SPRITE * s);
}

// ---------------------------------------------------------------- 潰しの較正

/**
 * 1 軸ぶんの被覆和。**`gainFor` の 2 次元較正を、潰れた格子へ延長する唯一の道具。**
 *
 * ## なぜこれが要るのか（Phase 1b で実測）
 *
 * `gainFor` は **2 次元格子**の較正である ── 「単位面積あたり `1/s0²` 個の点が
 * 一様に敷き詰められている」ことを前提に、`g = s0²/Ksum` としている。
 * `extent` が空間軸を潰すと、この前提が消える:
 *
 * | 構成 | `gain · Σw`（1.0 なら較正どおり） |
 * |---|---|
 * | 2 次元格子（`dimLevel = 2`） | **0.9974** |
 * | 1 本の線に潰した中心（1 列 1 点） | **0.6743** ← **32.6% 暗い** |
 * | 1 本の線に潰した中心（1 列 236 点を重ねる） | **159.0** ← **列合計** |
 * | 1 点へ完全に潰す（89,208 点） | **39,187** |
 *
 * つまり **`extent` だけで潰すと、`dimLevel = 1` は「列平均」ではなく「列合計」を描く。**
 * SPEC §0 の表にあった「加算ブレンドが列平均そのものである」は**偽**で、
 * 加算ブレンドが再現するのは 2 次元格子の平坦場だけである。
 *
 * ## 定義
 *
 * 間隔 `delta`(device px)で `n` 個の点が並ぶ軸について、
 * **中心セル内を平均した被覆和**を返す。`delta = 0`（完全に重なる）なら `n`、
 * `n = 1` なら 1（線や点は断面の**中心**で読む ── 面積が無いので平均する先が無い）。
 *
 * shader の `if (r2 > 0.25) discard` と同じ打ち切り（`|x| ≤ S/2`）を掛ける。
 * 軸ごとに掛けるので円ではなく正方の近似だが、`collapseWeight` が**比**を取るので
 * その系統誤差は約分される。
 */
export function axisCoverage(delta: number, n: number, spritePx: number): number {
  if (!(n > 1)) return 1;
  if (!(delta > 0)) return n;
  const S = spritePx;
  const half = (n - 1) / 2;
  const reachPx = S / 2;
  const SAMPLES = 16;
  let acc = 0;
  for (let q = 0; q < SAMPLES; q++) {
    // 中心セルの中を掃く（セル平均 ── gainFor のエネルギー較正と同じ流儀）
    const t = ((q + 0.5) / SAMPLES - 0.5) * delta;
    const lo = Math.max(0, Math.ceil(half + (t - reachPx) / delta));
    const hi = Math.min(n - 1, Math.floor(half + (t + reachPx) / delta));
    let s = 0;
    for (let i = lo; i <= hi; i++) {
      const x = t - (i - half) * delta;
      s += Math.exp((-F * x * x) / (S * S));
    }
    acc += s;
  }
  return acc / SAMPLES;
}

/** `axisCoverage` の「無限に伸びた格子」版。`gainFor` が較正された基準構成 */
const AXIS_UNBOUNDED = 1 << 24;

export interface CollapseConfig {
  /** 基準（潰していない）格子の x 間隔・device px */
  readonly s0x: number;
  /** 同 y。セルが正方でないと `s0x` と一致しない */
  readonly s0y: number;
  /** 現在の x 方向 extent（`clamp01(dimLevel)`） */
  readonly extentX: number;
  /** 同 y（`clamp01(dimLevel − 1)`） */
  readonly extentY: number;
  /** その軸に実際に存在する点数 */
  readonly nx: number;
  readonly ny: number;
  /** `gl_PointSize`（device px） */
  readonly spritePx: number;
}

/**
 * 潰しの補正係数 `sampleWeight`。**SPEC には定義が無かったので、ここで定義する。**
 *
 * > `sampleWeight` は、潰しのどの段階でも「図の中心のフラグメントが、
 * > その段階で意図した**縮約値そのもの**を読む」ようにする 1 点あたりの係数である。
 *
 * ```
 * 読める値 = 元の値 · gain · sampleWeight · Σw   を  元の値  に等しくしたい
 * ⟹ sampleWeight = A(基準構成) / A(現在の構成)
 * ```
 *
 * **エネルギー保存（図全体の総光量を dimLevel に対して不変にする）は採らない。**
 * 線は面積 0 なので中心輝度が発散し、ΔE00 で測れる量にならない ──
 * 予算を持てない定義は、この作品では定義として失格である（SPEC §7.2）。
 *
 * ## アンカーが構造的に守られる
 *
 * `extentX = extentY = 1` のとき分子と分母は**同じ引数で同じ関数を呼ぶ**ので、
 * 戻り値は `1` に厳密に等しい（`x/x`）。`dimLevel = 2` の絵は 1 ビットも動かない。
 * `collapse.test.ts` が `Object.is(…, 1)` でこれを見る。
 *
 * ## 実測（`s0 = 2.2478 px` / `S = 8.6548 px` / 格子 378×236）
 *
 * | 構成 | `sampleWeight` | 意味 |
 * |---|---|---|
 * | 格子 `d = 2` | **1**（厳密） | アンカー |
 * | 格子 `d = 1`（v が潰れる） | ≈ 1.486/236 | 列合計 → 列平均 |
 * | 列平均線 `d = 1` | **1.48591** | 失われた y 方向の被覆を戻す |
 * | 列平均線 `d = 0` | **0.0058472** | 全列の和 → 全体平均 |
 */
export function collapseWeight(c: CollapseConfig): number {
  const ref =
    axisCoverage(c.s0x, AXIS_UNBOUNDED, c.spritePx)
    * axisCoverage(c.s0y, AXIS_UNBOUNDED, c.spritePx);
  const cur =
    axisCoverage(c.extentX * c.s0x, c.nx, c.spritePx)
    * axisCoverage(c.extentY * c.s0y, c.ny, c.spritePx);
  if (!(cur > 0) || !Number.isFinite(ref / cur)) return 1;
  return ref / cur;
}

/**
 * その構成で half-float バッファに積まれる**加算回数**。
 *
 * **点数ではない。** 1 フラグメントを覆うスプライトの個数である ──
 * 完全に重なったときだけ両者が一致する。SPEC §4.6 が「n = 489（列平均バッファの点数）」
 * としていたのは取り違えで、489 は ULTRA 格子の `cols` であって、どの dimLevel の
 * 加算深度にも対応しない（Phase 1b で実測。§4.6 の当該行は差し替えた）。
 *
 * 実測: 2 次元格子（`dimLevel = 2`）で **16**、`dimLevel = 1` の列平均線で **4**、
 * `dimLevel = 0` の完全な潰しで **点数そのもの**（378）。
 */
export function additionDepth(c: CollapseConfig): number {
  const dx = c.extentX * c.s0x;
  const dy = c.extentY * c.s0y;
  const nx = dx > 0 ? Math.min(c.nx, Math.floor(c.spritePx / dx) + 1) : c.nx;
  const ny = dy > 0 ? Math.min(c.ny, Math.floor(c.spritePx / dy) + 1) : c.ny;
  return Math.max(1, Math.round(nx * ny));
}

// ------------------------------------------------- 潰れた図の「中心」と画素格子の位相

/**
 * 図の中心から、**最も近いフラグメント中心**までの距離（device px、軸ごと）。
 *
 * ## なぜこれが要るのか（Phase 2 で実測。G9 の −17.58% の大半がこれだった）
 *
 * `collapseWeight` は SPEC §2.3 の
 * 「**図の中心のフラグメント**が、その段階で意図した縮約値そのものを読む」を実装している。
 * ところが `dimLevel = 0` では図が 1 個のスプライトへ潰れ、**その中心にフラグメントは無い**。
 *
 * 図の中心は NDC 原点 ── ウィンドウ座標では `(W/2, H/2)` である。DPR 2 の
 * drawingBuffer は常に偶数×偶数なので、これは常に**画素の角**に落ちる。
 * フラグメント中心は半整数にあるので、最も近い 4 つが**各軸ちょうど 0.5 px** 離れる。
 *
 * 実測（988×778・S = 8.654148・F = 21）: 峰は単一画素ではなく
 * **2×2 の平坦部**（493/494 × 388/389 がすべて sRGB 129）になり、
 * その値は真の中心値の `exp(−F·2·(0.5/S)²) =` **0.8691864** 倍である。
 *
 * これは GPU の欠陥ではなく、**「値が定義されている点に標本が無い」という測定の問題**である。
 * 重みでは直せない ── 直せるのは定義か、図の置き方だけ。
 * G9 は再構成した中心値を採点する（`spritePhaseFactor`）。
 */
export function centreFragmentOffset(bufferWidth: number, bufferHeight: number): {
  x: number;
  y: number;
} {
  const off = (size: number): number => {
    const c = size / 2;
    // 最も近いフラグメント中心は floor(c) + 0.5。角に落ちれば厳密に 0.5
    return Math.abs(c - (Math.floor(c) + 0.5));
  };
  return { x: off(bufferWidth), y: off(bufferHeight) };
}

/**
 * 位相減衰 `w = exp(−F·r²)`、`r = |offset| / S`（`gl_PointCoord` 単位）。
 *
 * **これはモデルであって測定ではない。** だから使う側は、モデルが成り立つ前提
 * （4 つの近傍フラグメントが等しい ── 図が本当に 1 個のスプライトである）を
 * **測ってから**割る。前提が崩れていたら再構成せず落とす（`scripts/ladder.mjs` の G9）。
 *
 * 独立に検証済み（Phase 2・一様グレー 1024×640 を投入し、加算項をすべて等しくした）:
 *
 * | dimLevel | 位相のみの予測 | 実測 |
 * |---|---|---|
 * | 2（2 次元格子・両軸とも位相が平均される） | 141 | 140〜141 |
 * | 1（線・y だけ潰れる） | **136.54** | 136〜137 |
 * | 0（点・両軸潰れる） | **132.20** | **132** |
 */
export function spritePhaseFactor(offsetX: number, offsetY: number, spritePx: number): number {
  if (!(spritePx > 0)) return 1;
  const r2 = (offsetX * offsetX + offsetY * offsetY) / (spritePx * spritePx);
  return Math.exp(-F * r2);
}

/**
 * 平坦場のリップル(peak-to-peak / 平均)。テストと定数探索のための参照実装。
 * セル単位で評価する ── 格子点間隔 1、光る半径 `k/2`。
 */
export function latticeRipple(
  f: number,
  k: number,
  samples = 200,
): { p2p: number; mean: number; min: number; max: number } {
  const rad = k / 2;
  const R = Math.ceil(rad) + 1;
  let mn = Infinity;
  let mx = -Infinity;
  let sum = 0;
  for (let j = 0; j < samples; j++) {
    for (let i = 0; i < samples; i++) {
      const fx = i / samples;
      const fy = j / samples;
      let v = 0;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const d = Math.hypot(fx - dx, fy - dy);
          if (d < rad) v += Math.exp(-f * (d / k) ** 2);
        }
      }
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sum += v;
    }
  }
  const mean = sum / (samples * samples);
  return { p2p: (mx - mn) / mean, mean, min: mn, max: mx };
}
