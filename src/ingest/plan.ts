/**
 * 正準バッファの寸法を決める純関数。
 *
 * ## なぜ 20 行の関数に独立したファイルとテストが要るのか
 *
 * 素直な実装は `createImageBitmap(blob, { resizeWidth: 2048 })` である。
 * これは**三重に壊れている**(すべて Chrome 148 で実測):
 *
 *  1. **小さい画像を拡大する。** 64×32 の 772 バイトの JPEG がこれで **2048×1024** になり、
 *     正準バッファは **24 MB** になる。元画像より 3 万倍大きい。
 *  2. **長辺に効くとは限らない。** `resizeWidth` は幅に効くので、縦長画像では
 *     高さが上限を超えたまま通る(8×2 に ori=6 を付けたものに `resizeWidth:4` →
 *     **4×16**)。「長辺 ≤ 2048」は片側指定では**表現できない**。
 *  3. **軸は EXIF 適用後のもの。** ファイルの SOF が言う寸法とは縦横が入れ替わりうる。
 *
 * → だから寸法決定は「デコード後の寸法を見てから」の純関数に切り出し、
 *    node で「拡大しない」を落とせるテストにする。
 */

export interface ResizePlan {
  readonly width: number;
  readonly height: number;
  /** 縮小が要るか。false のときデコーダに resize を頼んではいけない */
  readonly resized: boolean;
}

/**
 * 正準バッファが持てる画素数の上限。
 *
 * 長辺 2048 の最悪(正方形)が 4,194,304 px = f32×3 で **48.00 MB**。
 * これを超える値がここへ来るのは、`planResize` を通さなかったときだけである。
 */
export const MAX_CANONICAL_PIXELS = 2048 * 2048;

/**
 * デコード*前*に弾く画素数の上限。
 *
 * 40MP(7728×5152)の原寸 RGBA8 は 151.88 MB。ここは「実機で生き延びるか」ではなく
 * 「明らかにおかしい入力で無言で死なないか」の門で、**実機の予算は Phase 1c** で測る。
 */
export const MAX_SOURCE_PIXELS = 80_000_000;

/**
 * 長辺を `maxEdge` 以下に収める寸法を返す。**拡大は絶対にしない。**
 *
 * 丸めは短辺だけに掛かる(長辺はちょうど `maxEdge`)。短辺は 1 を下回らない ──
 * 10000×1 のような入力で 0 を返すと、その先の `new Float32Array(0)` が
 * 「空の画像」として静かに通ってしまう。
 */
export function planResize(width: number, height: number, maxEdge: number): ResizePlan {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new RangeError(`planResize: 寸法が不正 (${width}×${height})`);
  }
  if (!Number.isFinite(maxEdge) || maxEdge < 1) {
    throw new RangeError(`planResize: maxEdge が不正 (${maxEdge})`);
  }
  const w = Math.floor(width);
  const h = Math.floor(height);
  const cap = Math.floor(maxEdge);
  const long = Math.max(w, h);
  // 上限以下ならそのまま。**ここが「拡大しない」の一行**
  if (long <= cap) return { width: w, height: h, resized: false };

  const s = cap / long;
  if (w >= h) {
    return { width: cap, height: Math.max(1, Math.round(h * s)), resized: true };
  }
  return { width: Math.max(1, Math.round(w * s)), height: cap, resized: true };
}

/** 原寸が明らかに扱えない大きさか。true なら `too-many-pixels` で断る */
export function exceedsSourceLimit(width: number, height: number): boolean {
  return width * height > MAX_SOURCE_PIXELS;
}
