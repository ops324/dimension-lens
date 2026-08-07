/**
 * 検証用 DEV フック `window.__LENS__`。
 *
 * ── なぜこれが Phase 0 の成果物なのか
 *
 * この作品の検証は 8 項目すべてが**キャンバスの読み戻しに対する数値アサーション**である。
 * ところが素直に書くと、その 8 項目は 1 つも実行できない:
 *
 *  1. `preserveDrawingBuffer` を立てていないと、rAF コールバックの外から readPixels /
 *     toDataURL してもバックバッファは仕様上すでに破棄されている。返るのは黒か透明。
 *     つまり**「隅を読んで #000000 を確認する」テストは常に緑になる** ── 壊れていても
 *     緑になる、最悪の失敗モード。
 *  2. ブラウザペインが非表示だと rAF が絞られ、フレームが進まない。
 *     姉妹作 dimension はこのために `window.__DIMENSION__.renderOnce(steps)` を持っている。
 *  3. 「回転を凍結して」「bloom を切って」測る、という制御 API がなければ、
 *     忠実性の測定は後処理の混入と区別できない。
 *
 * だから測る道具は、測られる対象より先に用意する。Phase 0 でこの形だけ確定させ、
 * Phase 1a 以降が中身を埋める。
 *
 * 本番ビルドには載せない(`import.meta.env.DEV` で握り潰す)。
 */

import type { CapabilityReport } from '../ingest/capabilities';
import type { FailureDetail, IngestFailureCode, IngestMeta } from '../ingest/protocol';

/**
 * 取り込みの結果のうち、**ブラウザから測りたい分だけ**。
 * 正準バッファも点群バッファもここには出さない(worker に常駐しているし、
 * 32MB をコンソールへ引き出すのは測定ではない)。
 */
export interface LensIngestReport {
  /** worker 経路か、メインスレッド・フォールバックか */
  mode: 'worker' | 'main';
  meta: IngestMeta;
  gridW: number;
  gridH: number;
  pointCount: number;
  meanHex: string;
  maxNorm: number;
  /** §4.9。`2 · maxNorm` を超えていること */
  safeDist: number;
  degenerate: { lightness: boolean; chroma: boolean };
}

export interface LensDevHook {
  /** rAF が絞られていても合成フレームを steps 回進めて描画する */
  renderOnce(steps?: number): void;
  /** dimLevel を即座に設定する(スムージングを迂回する) */
  setDimLevel(d: number): void;
  /** 全回転平面の角速度と現在角を 0 に固定/解除する */
  freezeRotation(frozen: boolean): void;
  /**
   * 位相を厳密に 0 へ戻す（Phase 1b）。**「凍結したから再現可能」は偽である。**
   *
   * `freezeRotation` は位相を保持するので、**どの位相で凍結したかが結果を決める**。
   * しかも測定の手順そのもの（`setDimLevel` も `setPath` も `renderOnce(1)` を打つ）が
   * 位相を進める ── 門の飽和域では 1 フレームで平面 (0,2) が 0.105° 回る。
   * フレーミングの保持（`framingHold`）もここで落ちる。
   */
  resetRotation(): void;
  /** UnrealBloomPass の有効/無効 */
  setBloom(enabled: boolean): void;
  /** GradePass(色収差・ビネット・グレイン)の有効/無効 */
  setGrade(enabled: boolean): void;
  /**
   * CompressPass(dimLevel 駆動のソフトニー圧縮)の**測定用の上書き**。
   *
   * `null` で出荷時の配線（`compressStrengthFor(dimLevel) > 0` で入る）へ戻す。
   * **上書きの口が要る理由**: Phase 2b で配線したので、毎フレーム
   * `setCompressEnabled` が走る ── 測定器が `true` を撃っても次のフレームで戻され、
   * G6 の「強度 0 で画素まで恒等」が**両方とも圧縮オフの絵の比較**（＝ `x/x`）になる。
   */
  setCompress(enabled: boolean | null): void;
  /**
   * 矩形を読み戻す。**必ず rAF コールバック内で readPixels する**こと ──
   * 外から読むとバックバッファが破棄済みで黒が返る(上の 1.)。
   * 返す値は sRGB エンコード後の 8bit RGBA。
   */
  readback(x: number, y: number, w: number, h: number): Promise<Uint8Array>;
  /**
   * **合成バッファ（HalfFloat）を HDR のまま読む**（Phase 2）。
   *
   * `readback()` は鎖の最後の 8bit capture RT を読むので、**1.0 を超えた値と
   * 1.0 ちょうどを区別できない**。CompressPass が管理する量はまさにそれなので、
   * あの口だけで圧縮の証拠を出すと「クリップが消えた」ことしか言えない
   * （正しい強度と 10 倍間違えた強度が同じ見出しを出す）。
   *
   * §4.17 の警告どおり **`Uint16Array` で読む** ── `Uint8Array` は例外を投げずに
   * `INVALID_OPERATION` と全 0 を返す。返すのは half-float をデコードした `Float32Array`。
   */
  readbackHDR(x: number, y: number, w: number, h: number): Promise<Float32Array>;
  /**
   * ラスタライザの素性（Phase 2）。**すべての数値の隣に出すためにある。**
   *
   * 監査サブエージェントが同じページ・同じアンカーで `dimLevel = 0` の峰を
   * **133**（SwiftShader）と **129**（ANGLE Metal）の 2 通り測った。
   * `data-lens-render` は `"ok"`、コンソールエラー 0、アンカーは厳密一致 ──
   * **どこにも「別のラスタライザだ」とは出ていなかった**。
   * 出力にこれが無い測定は、他人の機体で再現しなかったときに理由を言えない。
   */
  glInfo(): { renderer: string; vendor: string; version: string; maxSamples: number };
  /** 現在の測定値一式(平均色・グリッド寸法・実効 gain・点数・ティア) */
  stats(): LensStats;

  /**
   * 機能検出の**実測結果**(Phase 1a-ii)。
   * `imageOrientation` や `resizeWidth` が「実装されているか」と「効いたか」を分けて持つ。
   */
  capabilities(): Promise<CapabilityReport>;
  /** 起動時に標本 No.0 を通した結果。まだなら null */
  ingestReport(): LensIngestReport | null;
  /** 任意の画像を取り込み経路へ通す(忠実性測定と EXIF の実機確認に使う) */
  ingestBlob(source: Blob): Promise<LensIngestReport>;
  /**
   * **直近の失敗**（Phase 1c）。成功すると `null` に戻る。
   *
   * これが無いあいだ、空状態は**機械から観測できなかった** ── `ingestReport()` は
   * 失敗しても前の画像の報告をそのまま返し、`data-lens-ingest` は起動時の `"ok"` が
   * 立ったままだった。「空状態のテストを書いたが、壊れていても緑」という
   * §7.2 の失敗モードが、1c のフェーズそのものの中で待っていた。
   */
  lastFailure(): { code: IngestFailureCode; detail?: FailureDetail } | null;
  /**
   * 描画バッファの寸法を**測定器の側から**確定させる（Phase 1c）。
   *
   * ブラウザペインの `resize_window` は**ページの `resize` イベントを発火しない**ので、
   * canvas が古い寸法のまま「自己整合した嘘の値」を返す（1b で踏んだ）。
   * `dispatchEvent(new Event('resize'))` を撃つ回避策もあるが、それは
   * **測定手順が測定器の外にある**ということで、手順書どおりにやっても値が一致しない。
   *
   * 実測（Phase 1c）: ペイン既定（CSS 889×859 / buffer 1778×1718）では
   * `s0 = 4.045` / カメラ距離 `2.409` になり、§7.7 のアンカー
   * （`s0 = 2.2478…` / `1.9635…`）と**一致しない**。アンカーの再実行は
   * drawingBuffer を **988×778** に合わせて初めて意味を持つ。
   *
   * 返り値は実際に確定した `drawingBuffer` の寸法。**要求値ではなく実測値を返す**
   * ── 一致しなかったことを呼び出し側が見られなければ、また「自己整合した嘘」になる。
   */
  setViewport(cssWidth: number, cssHeight: number): { width: number; height: number };
  /**
   * 板経路 / 雲経路のどちらか一方だけを描かせる（Phase 1a-iii）。
   *
   * SPEC §7.2 は「板経路と雲経路で別のゲートを持たない」── 両方が ΔE00 ≤ 2.0 を
   * 通らなければならない。ところが出荷時のクロスフェードはアンカー窓で点群を
   * 厳密に 0 にするので、**そのままでは雲経路を dimLevel=2 で測れない**。
   * `'auto'` が出荷時の挙動で、他の 2 つは測定器のための口である。
   */
  setPath(mode: 'auto' | 'plate' | 'cloud'): void;
  /** シーン側の測定値（スプライト寸法・ゲイン・カメラ距離・カスケード dist） */
  sceneStats(): LensSceneReport;
  /**
   * 板のテクスチャを**画像画素座標**で 1 点サンプルする（G5）。
   *
   * 整数 + 0.5 がテクセル中心、整数ちょうどが隣り合うテクセルの**中点**
   * （＝ 補間がリニア光かガンマ空間かを問う位置）。画面の読み戻しでは
   * 板の倍率と位相が viewport 次第で、中点を一度もサンプルしないことがある。
   */
  sampleTexel(imgX: number, imgY: number): {
    rgb: [number, number, number];
    glError: number;
    uv: [number, number];
  } | null;
  /**
   * **加算合成そのもの**を、作品を通さずに測る（Phase 2b・`render/blendProbe.ts`）。
   *
   * 規定した `values` を**その順序で** 1 個ずつ HDR の RT へ加算し、読み返す。
   * 光学も幾何も較正も乗らないので、返る値の残差は
   * **GPU のブレンドユニットの丸めだけ**である ── §4.6 訂正 4 の
   * 「実測 −5.2% と監査の fp16 シミュレーション 1% 未満が矛盾したまま」を、
   * `image/blendModel.ts` の 3 モデルのどれと一致するかで切り分ける。
   */
  blendProbe(values: number[]): {
    rgb: [number, number, number];
    count: number;
    glError: number;
  };
  /**
   * 点群の**色場だけ**を差し替える（Phase 2b・G12）。**幾何は 1 ビットも動かさない。**
   *
   * `d ≥ 3` では点が奥行きへ散り、1 フラグメントに 16〜64 個のスプライトが重なる。
   * そこに §4.6 の残差機構が残っているかを問いたいが、**素直に画像を差し替えると
   * `base`（＝ 位置）も変わる**（L 軸が座標だから）。それでは幾何と色の効果が分離できない。
   *
   * → 位置バッファを固定したまま、色属性だけを `image` / `mean` / `image+mean` へ
   * 切り替える。加算が線形なら `I(image+mean) = I(image) + I(mean)` が**厳密に**成り立つ ──
   * この重ね合わせは**幾何のモデルを 1 つも要求しない**。
   */
  setColorField(mode: 'image' | 'mean' | 'image+mean'): void;
  /**
   * 光過敏の配慮（`prefers-reduced-motion`）を測定器から on/off する（Phase 2b）。
   *
   * Phase 2a までこの配慮は **1 画素も変えていなかった** ── `postfx.ts` が
   * `gradeTime` を握るだけで、その `gradePass` は出荷時 `enabled = false`、
   * 回転そのもの（`advancePhases`）は門を通っていなかった。
   * **未計測ではなく偽の主張**だったので、ラダーが両側から見張る
   * （オンで画素が動かない／オフで動く）。
   */
  setReducedMotion(on: boolean): void;
  /** いま有効な光過敏の配慮（メディアクエリの実測値か、`setReducedMotion` の上書き） */
  reducedMotion(): boolean;
}

/** `LensStats` は Phase 0 で形を決めた分。1a-iii と 1b が増やした分はこちら */
export interface LensSceneReport {
  dimLevel: number;
  anchored: boolean;
  plateWeight: number;
  cloudWeight: number;
  /** 描画中のバッファ（Phase 1b） */
  buffer: 'grid' | 'columnMeans';
  gridW: number;
  gridH: number;
  pointCount: number;
  /** 列平均バッファの点数（Phase 1b） */
  lineCount: number;
  s0: number;
  spritePx: number;
  gain: number;
  /** `gainFor` の較正域の内側か（Phase 1b）。外れたら数値は信用しない */
  calibrated: boolean;
  /** 潰しの補正（Phase 1b）。`dimLevel = 2` で厳密に 1 */
  sampleWeight: number;
  /** half-float に積まれる加算回数の見積もり（Phase 1b）。**点数ではない** */
  additionDepth: number;
  /**
   * 5 軸 `[u, v, L, a, b]` が**この画像に存在するか**（Phase 1c・SPEC §2.2）。
   * 退化した軸は `extent` が 0 に固定される。
   */
  axisPresent: boolean[];
  /** そのフレームの `extent`。退化軸は `dimLevel` に依らず 0 */
  extent: number[];
  cameraDistance: number;
  /** ホールド前の、その位相での厳密な必要距離（Phase 1b） */
  needDistance: number;
  /** 投影後の図の広がり（Phase 1b）。`zHi` は max z であって max|z| ではない */
  spread: { aX: number; aY: number; zHi: number };
  /** 帯に対する充填。**1 を超えたらはみ出している**（Phase 1b） */
  fill: { x: number; y: number };
  cascadeDist: number;
  frozen: boolean;
  pathOverride: 'auto' | 'plate' | 'cloud';
  /** 測定用の色場（Phase 2b・G12）。出荷時は常に `'image'` */
  colorField: 'image' | 'mean' | 'image+mean';
  /** 光過敏の配慮で回転を止めているか（Phase 2b） */
  reducedMotion: boolean;
  /** 画像のリニア光の全体平均 */
  meanColor: [number, number, number];
}

export interface LensStats {
  dimLevel: number;
  /** CPU 側で数値的に計算した平均色(リニア光平均 → sRGB) */
  meanHex: string;
  gridW: number;
  gridH: number;
  pointCount: number;
  /** 描画中のバッファ: 全グリッド or 列平均(dimLevel < 1) */
  buffer: 'grid' | 'columnMeans';
  /** sampleWeight の現在値 */
  sampleWeight: number;
  tier: string;
  dpr: number;
  /** 入力画像の色域 */
  gamut: 'srgb' | 'display-p3';
  /** アンカー窓([1.9, 2.1])の中にいるか */
  anchored: boolean;
}

declare global {
  interface Window {
    __LENS__?: LensDevHook;
  }
}

/**
 * DEV ビルドでのみフックを公開する。Phase 1a 以降、シーン側が実装を渡す。
 * 未実装のメソッドを呼んだら**黙って何もしない**のではなく投げること ──
 * 「測ったつもり」が一番高くつく。
 */
export function installDevHook(hook: Partial<LensDevHook>): void {
  if (!import.meta.env.DEV) return;
  const notReady = (name: string) => () => {
    throw new Error(
      `__LENS__.${name}() はまだ実装されていません。この段階では測定できません。`,
    );
  };
  window.__LENS__ = {
    renderOnce: hook.renderOnce ?? notReady('renderOnce'),
    setDimLevel: hook.setDimLevel ?? notReady('setDimLevel'),
    freezeRotation: hook.freezeRotation ?? notReady('freezeRotation'),
    resetRotation: hook.resetRotation ?? notReady('resetRotation'),
    setBloom: hook.setBloom ?? notReady('setBloom'),
    setGrade: hook.setGrade ?? notReady('setGrade'),
    setCompress: hook.setCompress ?? notReady('setCompress'),
    readback: hook.readback ?? notReady('readback'),
    readbackHDR: hook.readbackHDR ?? notReady('readbackHDR'),
    glInfo: hook.glInfo ?? notReady('glInfo'),
    stats: hook.stats ?? notReady('stats'),
    capabilities: hook.capabilities ?? notReady('capabilities'),
    ingestReport: hook.ingestReport ?? notReady('ingestReport'),
    ingestBlob: hook.ingestBlob ?? notReady('ingestBlob'),
    lastFailure: hook.lastFailure ?? notReady('lastFailure'),
    setViewport: hook.setViewport ?? notReady('setViewport'),
    setPath: hook.setPath ?? notReady('setPath'),
    sceneStats: hook.sceneStats ?? notReady('sceneStats'),
    sampleTexel: hook.sampleTexel ?? notReady('sampleTexel'),
    blendProbe: hook.blendProbe ?? notReady('blendProbe'),
    setColorField: hook.setColorField ?? notReady('setColorField'),
    setReducedMotion: hook.setReducedMotion ?? notReady('setReducedMotion'),
    reducedMotion: hook.reducedMotion ?? notReady('reducedMotion'),
  };
}
