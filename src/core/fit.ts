/**
 * 構図のフィット。**この式はこの作品に 1 つしか存在してはならない**
 * (親 SPEC の portraitDolly に付いていた単一情報源の規律を継ぐ)。
 *
 * 承認済みの到達判定は「ΔE00 ≤ 2.0 **かつ**アスペクト比が正しく、非遮蔽帯に収まる」で、
 * 後半はここが担う。監査で「承認済み判定の半分にテストが 1 本も無い」と指摘されたので
 * 純関数として切り出し、`fit.test.ts` が図が帯の**どちらか一辺に接する**ことまで見る
 * (接しないなら式が静かに保守的で、写真が小さく出ている)。
 */

/**
 * `camera.setViewOffset(W, H, 0, dy, W, H)` は錐台を**平行移動するだけ**で、
 * 拡大縮小はしない(three の `PerspectiveCamera.updateProjectionMatrix` は
 * `view.width/fullWidth` と `view.height/fullHeight` を掛けるが、この使い方では両方 1)。
 *
 * つまり**視野角は viewport 全体のまま**で、非遮蔽帯はその部分矩形にすぎない。
 * 帯の中に収めたければ、距離を `H/h_band` 倍しなければならない ──
 * ここを落とすと、下シートが 30% を覆う画面で写真が帯を 43% はみ出す。
 */
export interface FitInput {
  /** 画像の世界半径(imageHalfExtents から) */
  readonly aX: number;
  readonly aY: number;
  /** viewport のアスペクト比 W/H */
  readonly viewportAspect: number;
  /** 非遮蔽帯の高さ / viewport 高さ。1 なら遮蔽なし */
  readonly bandFrac: number;
  readonly fovDeg: number;
  /** 帯に対する充填率。1 未満で余白を残す */
  readonly fill?: number;
}

export const DEFAULT_FILL = 0.86;

/** 画像が非遮蔽帯にちょうど収まるカメラ距離 */
export function fitDistance(input: FitInput): number {
  const { aX, aY, viewportAspect, bandFrac, fovDeg } = input;
  const fill = input.fill ?? DEFAULT_FILL;
  const t = Math.tan((fovDeg * Math.PI) / 360);
  const band = bandFrac > 0 ? bandFrac : 1;
  // 距離 D での可視半径: 縦 = D·t·band、横 = D·t·viewportAspect
  const needV = aY / band;
  const needH = aX / viewportAspect;
  return Math.max(needV, needH) / (fill * t);
}

/** その距離で画像が帯をどれだけ埋めるか。max がちょうど `fill` になるのが正しい */
export function fillRatios(
  input: FitInput,
  distance: number,
): { x: number; y: number } {
  const { aX, aY, viewportAspect, bandFrac, fovDeg } = input;
  const t = Math.tan((fovDeg * Math.PI) / 360);
  const band = bandFrac > 0 ? bandFrac : 1;
  return {
    x: aX / (distance * t * viewportAspect),
    y: aY / (distance * t * band),
  };
}

/**
 * 図の投影後の広がり。**`imageHalfExtents` は `dimLevel = 2` でしかこれと一致しない。**
 *
 * `zHi` は**カメラに一番近い z**（`max z`）であって `max|z|` ではない ──
 * 遠い側は画面上で小さくなるだけなので、フレーミングを決めない。
 */
export interface Spread {
  readonly aX: number;
  readonly aY: number;
  readonly zHi: number;
}

/**
 * `fillRatios` は `fitDistance` の**逆関数である**（Phase 1b で判明）。
 *
 * `fillRatios(i, fitDistance(i))` は `fill` に恒等に潰れるので、`fovDeg` も
 * `DEFAULT_FILL` も検査できない ── 監査が実際に壊して確認した:
 *
 * | 壊し方 | 既存 222 件 |
 * |---|---|
 * | `fitDistance` を 1.05 倍 | ❌ 36 件失敗 |
 * | **半角変換 `/360` を `/180` へ（両関数とも）** | ✅ **緑（穴）** |
 * | **`DEFAULT_FILL` 0.86 → 0.95** | ✅ **緑（穴）** |
 *
 * `d = max(a)/(fill·t)` を `a/(d·t)` に代入すると `t` も `fill` も約分されるためで、
 * **39 件のフレーミングテストが画角の半角変換を一度も検証していなかった。**
 *
 * → 判定は `fillRatios` を通さず、**画角から独立に作った実座標**を NDC へ落として見る
 * （`framing.test.ts` は three の投影行列を採点者にしている）。
 * 深度 `D − z` での可視半径は `(D − z)·t`（縦）/ `(D − z)·t·aspect`（横）である。
 */
export function ndcExtents(
  input: FitInput,
  spread: Spread,
  distance: number,
): { x: number; y: number } {
  const { viewportAspect, bandFrac, fovDeg } = input;
  const t = Math.tan((fovDeg * Math.PI) / 360);
  const band = bandFrac > 0 ? bandFrac : 1;
  const depth = distance - spread.zHi;
  if (!(depth > 0)) return { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY };
  return {
    x: spread.aX / (depth * t * viewportAspect),
    y: spread.aY / (depth * t * band),
  };
}

/** 板（z ≡ 0 の矩形）の広がり */
export function plateSpread(aX: number, aY: number): Spread {
  return { aX, aY, zHi: 0 };
}

/** 2 つの広がりの和集合。**板と点群の両方を見る**（片方だけだとアンカーの充填がずれる） */
export function unionSpread(a: Spread | null, b: Spread | null): Spread {
  if (!a) return b ?? { aX: 0, aY: 0, zHi: 0 };
  if (!b) return a;
  return {
    aX: Math.max(a.aX, b.aX),
    aY: Math.max(a.aY, b.aY),
    zHi: Math.max(a.zHi, b.zHi),
  };
}

/**
 * 図が帯に収まるカメラ距離。**`fitDistance` の後方互換な一般化**（Phase 1b）。
 *
 * ## なぜ `fitDistance` だけでは足りないのか（実測）
 *
 * `fitDistance` は図が **z = 0 の平面にある**ことを仮定している。`dimLevel > 2` では
 * 透視カスケードを通った点が z 方向へ広がり、`z > 0` の点はカメラに近いので
 * 画面上で拡大される。標本 No.0（HIGH 格子・位相を 1200 秒回した全域）:
 *
 * | | 実測 | `imageHalfExtents` 比 |
 * |---|---|---|
 * | `max|x|` | 1.9315 | **1.93 倍** |
 * | `max|y|` | 1.8503 | **2.96 倍** |
 * | `max z` | 1.8710 | —— |
 *
 * アンカーの距離 1.9636（viewport 1.27）に対し `max z = 1.8710` は余裕 **0.0926**、
 * viewport アスペクト 1.6 以上なら距離が 1.5585 まで縮むので **点がカメラを越える**。
 * `gl_PointSize` の分母 `max(-mv.z, 1e-3)` が潰れて巨大なスプライトになるが、
 * **GL エラーは出ない**（`F_CLAMP` も不発火 ── 全域 `maxRatio = 0.4965`）。
 *
 * ## 式
 *
 * カメラは +z にあり、深度 `D − z` での可視半径は `(D − z)·t·(aspect | band)`。
 * よって `D ≥ z + a/(fill·t·…)`。**`zHi = 0` のとき `fitDistance` と厳密に一致する**
 * ので（`0 + d === d`）、アンカーの構図は 1 ビットも動かない ──
 * `framing.test.ts` が `Object.is` でこれを固定する。
 *
 * 分離した上界（`max z` と `max|x|` を別々に取る）なので、両者が別の点で起きるときは
 * わずかに保守的である。`dimLevel = 2` では `z ≡ 0` なので**厳密**。
 */
export function needDistance(input: FitInput, spread: Spread): number {
  const base = fitDistance({ ...input, aX: spread.aX, aY: spread.aY });
  return spread.zHi > 0 ? spread.zHi + base : base;
}

/**
 * フレーミング距離の保持則。**回転で呼吸させないための唯一の仕掛け。**
 *
 * ## なぜ毎フレームそのまま使えないのか（実測）
 *
 * 回転位相を 120 秒ぶん掃くと、投影後の広がりは `dimLevel = 3` で
 * **max|x| が 0.0367 〜 1.8965（50 倍）** の幅で動く。図が本当に一点へ潰れる位相が
 * あるためで（法線が p3/p4 の側を向くと、投影で落ちる）、毎フレーム厳密に合わせると
 * カメラが 3.6 倍の幅で寄り引きする ── 絵が脈打つ。
 *
 * ## なぜ「dimLevel だけの包絡」も採れないのか（代数で確定）
 *
 * 角度は `gate·τ`、`τ̇ = gate·ω` なので、**`gate > 0` なら τ は上限なく増え、
 * 到達可能な角度集合は全トーラスになる**。つまり「その dimLevel で到達しうる最大」は
 * アンカー窓の縁で不連続に跳ぶ（実測: `d = 2.1` の 1.958 → `d = 2.2` の 3.454）。
 * しかも `d = 2.2` では π/2 に達するまで **6.1 分**かかるので、
 * 「gate で補間する」も 6 分後に包絡を割る。
 *
 * ## 採った規則
 *
 * **ピークホールド（減衰なし）＋ dimLevel が動いたら現在値へリセット。**
 *
 * - 呼吸は**厳密にゼロ**（単調非減少なので縮む向きに動かない）
 * - `dimLevel` を動かした瞬間に厳密な必要距離へ戻る ── だから
 *   **アンカーへ戻れば構図は 1a-iii と画素まで同じ**になる
 *
 * ## **「図は絶対に帯から出ない」はこの関数の手柄ではない**（Phase 2c-iv で訂正）
 *
 * 1b からここには「図は絶対に帯から出ない（`D ≥ need` が常に成り立つ）」と書いてあったが、
 * **それはホールドが無くても成り立つ**。`lensScene.updateCamera` は `liftProject5` が
 * **これから描くフレームの**位置を書いた直後に呼ばれ、`need` はその実測 `spread` を
 * 必ず含む（`unionSpread(spread, target)`）。`needDistance` は各成分について単調なので
 * `D = need` でも `ndc ≤ DEFAULT_FILL` が等号成立で成り立つ。
 *
 * 実測（約 39 万フレーム・遷移／定常／無作為跳躍／退化画像／3 ティア）でも
 * `ndcExtents` の最大は**どの掃きでも厳密に 0.86000000** だった。
 *
 * → **ホールドが守っているのは「呼吸しないこと」だけ**である。収まりは毎フレームの
 * 実測が単独で担っている。2 つを 1 つの箇条書きに混ぜると、見積もりが外れたときに
 * 安全性の問題に見えてしまう（`core/framingEnvelope.ts` が同じ誤りを 2 か所に持っていた）。
 *
 * ## 代償（Phase 2c-ii で門が全開の領域だけ消え、傾斜帯には残っている）
 *
 * 同じ `dimLevel` に長く留まると、新しい極値が見つかるたびに図が単調に小さくなる。
 * 2c-ii の位相包絡はこれを**門が全開の領域では厳密に消した**が、門の傾斜帯には残る
 * （実測・18000 フレーム＝ 5 分・標本 No.0）:
 *
 * | d | 門 | 1F 目 | 初めて動く | 300 秒後 | 倍率 |
 * |---|---|---|---|---|---|
 * | **2.20** | 0.1983 | 2.926651 | 679F（11.3 秒） | 3.961599 | **×1.354** |
 * | 1.80 | 0.1983 | 2.897488 | 2773F（46.2 秒） | 3.667927 | ×1.266 |
 * | 2.30 | 0.6064 | 4.116488 | 696F（11.6 秒） | 4.513837 | ×1.097 |
 * | 1.65 | 0.8017 | 3.881480 | 3893F（64.9 秒） | 4.077004 | ×1.050 |
 * | 2.0 / 2.5 / 3 / 4 / 4.25 / 5 | ── | | **動かない** | | ×1.000000 |
 *
 * §4.22 は上側の帯 `(2.1, 2.45)` を代償として書いていたが、**下側 `(1.55, 1.9)` も同じ**で、
 * そちらは書かれていなかった。量も発現時間も、ここに置くのが正しい
 * （「留まっていると絵が引いていく」は Phase 3 が見直す対象として残す）。
 */
export function framingHold(previous: number, need: number, reset: boolean): number {
  if (reset || !(previous > 0) || !Number.isFinite(previous)) return need;
  return need > previous ? need : previous;
}
