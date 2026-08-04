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
import type { IngestMeta } from '../ingest/protocol';

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
  /** UnrealBloomPass の有効/無効 */
  setBloom(enabled: boolean): void;
  /** GradePass(色収差・ビネット・グレイン)の有効/無効 */
  setGrade(enabled: boolean): void;
  /** CompressPass(dimLevel 駆動のソフトニー圧縮)の有効/無効 */
  setCompress(enabled: boolean): void;
  /**
   * 矩形を読み戻す。**必ず rAF コールバック内で readPixels する**こと ──
   * 外から読むとバックバッファが破棄済みで黒が返る(上の 1.)。
   * 返す値は sRGB エンコード後の 8bit RGBA。
   */
  readback(x: number, y: number, w: number, h: number): Promise<Uint8Array>;
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
    setBloom: hook.setBloom ?? notReady('setBloom'),
    setGrade: hook.setGrade ?? notReady('setGrade'),
    setCompress: hook.setCompress ?? notReady('setCompress'),
    readback: hook.readback ?? notReady('readback'),
    stats: hook.stats ?? notReady('stats'),
    capabilities: hook.capabilities ?? notReady('capabilities'),
    ingestReport: hook.ingestReport ?? notReady('ingestReport'),
    ingestBlob: hook.ingestBlob ?? notReady('ingestBlob'),
  };
}
