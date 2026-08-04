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
