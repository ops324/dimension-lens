/**
 * Phase 1c が塞いだ穴。**すべて「壊しても 276 件が緑だった」ことを実測してから書いた。**
 *
 * 監査が変異 50 件を通し、うち 24 件が緑のまま通った。宣言済みの境界
 * （node に `createImageBitmap` が無いので測れない領域）を差し引いても、
 * **node で落とせるのに落ちていなかった**ものが残った。ここはその側である。
 *
 * | 穴 | 変異 | 1b の 276 件 |
 * |---|---|---|
 * | `safeDist` の配線 | `safeDist(maxNorm)` → リテラル `2.4` | ✅ **緑** |
 * | Display P3 の配線（4 点すべて） | `primariesFor(gamut)` → `primariesFor('srgb')` ほか | ✅ **緑** |
 * | 退化の表明がシーンへ届くか | —— | （そもそも配線が無かった） |
 * | しきい値の値 | `C_MIN_P95` を **10 倍**、`L_MIN_SPAN` を 10〜30 倍 | ✅ **緑** |
 *
 * **参照実装は独立に書く**（§7.1）── `safeDist` の採点者はその定義を書き戻さず、
 * §4.8 が代数で確定させた必要条件 `dist > 2·maxNorm` そのものを見る。
 */

import { describe, expect, it } from 'vitest';
import { makeLiftPayload } from '../ingest/session';
import { sniffUnsupportedFormat, SNIFF_BYTES } from '../ingest/format';
import { normalizeGamut } from '../ingest/decode';
import { linearizeRgba } from '../image/linearize';
import {
  axisPresence,
  computeScales,
  computeStats,
  degeneracyKind,
  C_MIN_P95,
  L_MIN_SPAN,
  type Canonical,
} from '../image/stats';
import { buildColumnLine } from '../image/columnLine';
import { fitGrid } from '../image/grid';
import { makeSpecimen0 } from '../image/fixture';
import { linearToOklab, primariesFor } from '../color/oklab';
import { LensScene } from '../scene/lensScene';

// ---------------------------------------------------------------- safeDist の配線

/** 標本 No.0 を正準リニアバッファへ（デコードを通さない ── node にデコーダは無い） */
function specimenCanonical(gamut: 'srgb' | 'display-p3' = 'srgb'): Canonical {
  const s = makeSpecimen0();
  return linearizeRgba(s.rgba, s.width, s.height, gamut);
}

describe('safeDist が実際に配線されている(§4.9)', () => {
  /**
   * §0 の表は「`safeDist` が実際に配線されている｜**A**」と主張し、
   * §4.9 は「呼び忘れようのない位置へ移した」と書いていた。
   * **押さえているテストは 1 本も無かった** ── 実測で、`session.ts` の
   * `safeDist: safeDist(maxNorm)` を**リテラル `2.4`** に置き換えても 276 件が緑だった。
   * 構造の主張が、構造だけで支えられていた（＝ 主張に判定が付いていなかった）。
   */
  it('返る dist が §4.8 の必要条件 dist > 2·maxNorm を満たす', () => {
    const canonical = specimenCanonical();
    const scales = computeScales(computeStats(canonical));
    // 格子を変えると maxNorm も変わる（§4.9: 細かい格子ほど外れ値が残る）
    for (const budget of [4000, 40_000, 160_000]) {
      const grid = fitGrid(canonical.width, canonical.height, budget);
      const p = makeLiftPayload(canonical, grid, scales);
      expect(p.maxNorm).toBeGreaterThan(0);
      expect(
        p.safeDist,
        `budget ${budget}: maxNorm ${p.maxNorm} に対し dist ${p.safeDist}`,
      ).toBeGreaterThan(2 * p.maxNorm);
    }
  });

  /**
   * **リテラル 2.4 では足りないことを、同じテストの中で示す。**
   * これが無いと「たまたま 2.4 でも通る標本」で緑になりうる。
   */
  it('固定値 2.4 は標本 No.0 では必要条件を満たさない(だから配線が要る)', () => {
    const canonical = specimenCanonical();
    const scales = computeScales(computeStats(canonical));
    const p = makeLiftPayload(canonical, fitGrid(canonical.width, canonical.height, 40_000), scales);
    expect(2 * p.maxNorm).toBeGreaterThan(2.4);
    expect(p.safeDist).not.toBe(2.4);
  });

  it('maxNorm は格子に依存する(だから relift も同じ関数を通らねばならない)', () => {
    const canonical = specimenCanonical();
    const scales = computeScales(computeStats(canonical));
    const coarse = makeLiftPayload(canonical, fitGrid(canonical.width, canonical.height, 4000), scales);
    const fine = makeLiftPayload(canonical, fitGrid(canonical.width, canonical.height, 160_000), scales);
    expect(fine.maxNorm).not.toBe(coarse.maxNorm);
    expect(fine.safeDist).toBeGreaterThan(2 * fine.maxNorm);
    expect(coarse.safeDist).toBeGreaterThan(2 * coarse.maxNorm);
  });
});

// ---------------------------------------------------------------- Display P3 の配線

/**
 * **sRGB として読むか P3 として読むかで、実際に色相が変わることを見る。**
 *
 * 1b までは `primariesFor(gamut)` を `primariesFor('srgb')` に固定しても、
 * `linearizeRgba` が `gamut` 引数を無視しても、`computeStats` が `'srgb'` を返しても、
 * `buildColumnLine` が原色を固定しても、**4 つとも 276 件が緑**だった。
 * §0 の表が「Display P3 の入力経路｜**C**」と正直に書いているとおり配線は無いが、
 * **配線を入れる前に「切れていたら落ちるテスト」が 1 本も無い**状態だった ──
 * §7.7 の「画角の半角変換を 222 件が一度も検査していなかった」と同じ形が、
 * より大きな面積で待っていた。
 */
describe('色域が実際に効いている(P3 配線の歯)', () => {
  /** 同じ符号値を sRGB / P3 の原色で解釈したときの OKLab 色相角（度） */
  function hueOf(gamut: 'srgb' | 'display-p3', r: number, g: number, b: number): number {
    const lab = new Float64Array(3);
    linearToOklab(primariesFor(gamut), r, g, b, lab);
    return (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
  }

  /** 同じ符号値を sRGB / P3 の原色で解釈したときの OKLab 彩度半径 */
  function chromaOf(gamut: 'srgb' | 'display-p3', r: number, g: number, b: number): number {
    const lab = new Float64Array(3);
    linearToOklab(primariesFor(gamut), r, g, b, lab);
    return Math.hypot(lab[1], lab[2]);
  }

  /**
   * **実測（Phase 1c）。最初この判定を「色相角が 1° 以上ずれる」と書いて落とした** ──
   * 測らずに予算を置いた（§0.1 規律 4）。実際の隔たりは色によって桁が違う:
   *
   * | 符号値 | Δ色相 | Δ彩度 |
   * |---|---|---|
   * | 赤 (1,0,0) | **−0.274°** | 0.0418 |
   * | 緑 (0,1,0) | **+3.144°** | 0.0737 |
   * | 青 (0,0,1) | **−0.002°** | 0.0099 |
   * | シアン | −1.631° | 0.0511 |
   * | マゼンタ | +3.097° | 0.0377 |
   * | **グレー (0.2,0.2,0.2)** | **1e-16 未満** | **1e-16 未満** |
   *
   * 色相は青でほぼ動かないので**判定に使えない**。彩度は全色で 0.0099 以上ずれるので、
   * こちらを採点者にする。グレーで色域差が消えるのは OKLab の構成が要求する性質
   * （中性軸は色域に依らない。§4.11 の白色順応）であって、たまたまではない。
   *
   * **緑の 3.14° は G4 の予算「平均色相残差 ≤ 0.5°」の 6.3 倍**である ──
   * 色域を取り違えると、看板である色相不変性のゲートを実際に割る。
   */
  it('原色行列そのものが色域で切り替わる(彩度で見る ── 色相は青でほぼ動かない)', () => {
    for (const [name, r, g, b] of [
      ['赤', 1, 0, 0], ['緑', 0, 1, 0], ['青', 0, 0, 1],
      ['シアン', 0, 1, 1], ['マゼンタ', 1, 0, 1], ['黄', 1, 1, 0],
    ] as const) {
      const d = Math.abs(chromaOf('display-p3', r, g, b) - chromaOf('srgb', r, g, b));
      expect(d, `${name} の彩度差`).toBeGreaterThan(0.009);
    }
    // 青の色相はほとんど動かない ── これが「色相を採点者にしてはいけない」の実測
    expect(Math.abs(hueOf('display-p3', 0, 0, 1) - hueOf('srgb', 0, 0, 1))).toBeLessThan(0.01);
    // 緑の色相は G4 の予算(0.5°)を 6 倍超える
    expect(Math.abs(hueOf('display-p3', 0, 1, 0) - hueOf('srgb', 0, 1, 0))).toBeGreaterThan(3);
    // 中性は色域に依らない（OKLab の構成が要求する。§4.11 の白色順応）。
    // **「厳密に 0」ではない** ── 最初そう書いて落ちた。中性のグレー自身の彩度は
    // 両色域とも 2.1813e-8（白正規化の残差）で、**色域間の差**が 1.2e-16 なのである。
    // 「差が 0」と「値が 0」を混ぜないこと。
    const gS = chromaOf('srgb', 0.2, 0.2, 0.2);
    const gP = chromaOf('display-p3', 0.2, 0.2, 0.2);
    expect(gS).toBeLessThan(3e-8);
    expect(Math.abs(gP - gS)).toBeLessThan(1e-15);
  });

  /**
   * §4.13 の 4 箇所のうち、**読み戻した色空間を要求と突き合わせる**側。
   *
   * 1b までは `imageDataColorSpace` を `RawCapabilities` に記録するだけで、
   * **一度も比較していなかった** ──「気づける形で残す」と書いてあったが、
   * 気づく主体がどこにもいなかった。
   *
   * **突き合わせの `throw` 自体は node では測れない**（`decodeToCanonical` は
   * `createImageBitmap` を要求する。§7.1 の宣言済み境界）。実測は
   * `__LENS__.lastFailure()` でブラウザ側から取る。ここで落とせるのは畳み方だけ。
   */
  it('知らない色空間は srgb に倒さず unknown にする', () => {
    expect(normalizeGamut('srgb')).toBe('srgb');
    expect(normalizeGamut('display-p3')).toBe('display-p3');
    // 「知らない = たぶん sRGB」と倒すと、食い違いが黙って通る
    expect(normalizeGamut('rec2020')).toBe('unknown');
    expect(normalizeGamut('')).toBe('unknown');
    expect(normalizeGamut('SRGB')).toBe('unknown');
  });

  it('linearizeRgba が gamut を Canonical へ運ぶ', () => {
    const s = makeSpecimen0();
    expect(linearizeRgba(s.rgba, s.width, s.height, 'srgb').gamut).toBe('srgb');
    expect(linearizeRgba(s.rgba, s.width, s.height, 'display-p3').gamut).toBe('display-p3');
  });

  it('computeStats が gamut を読み、平均色の OKLab が変わる', () => {
    const srgb = computeStats(specimenCanonical('srgb'));
    const p3 = computeStats(specimenCanonical('display-p3'));
    expect(srgb.gamut).toBe('srgb');
    expect(p3.gamut).toBe('display-p3');
    // リニア RGB の平均は同じ（gamut に依らない）
    expect(p3.meanLinear).toEqual(srgb.meanLinear);
    // しかし OKLab へ写した結果は違う ── ここが「黙って色相が誤る」の中身
    expect(p3.meanOklab).not.toEqual(srgb.meanOklab);
    expect(Math.abs(p3.meanOklab[1] - srgb.meanOklab[1])).toBeGreaterThan(1e-4);
  });

  /**
   * **スケールを固定して、色域だけを動かす。**
   *
   * 最初この 2 本を「sRGB 側は sRGB のスケール、P3 側は P3 のスケール」で書き、
   * **`lift` の原色を `'srgb'` 固定に壊しても緑のまま**だった（実測）── スケールも
   * 一緒に動いていたので、出力の差はスケール由来でも説明でき、原色が固定されたことを
   * 隠してしまった。§7.1 が名指しした `reconstructMean`（分子と分母が同時に動いて
   * 落ちない）とまったく同じ病気を、その病気を防ぐために書いたテストで踏んだ。
   *
   * → **`scales` を同一のオブジェクトに固定する。** そうすると出力を動かせるのは
   * `primariesFor(gamut)` だけになる。
   */
  it('lift が gamut を読み、持ち上げた a,b が変わる', () => {
    const cS = specimenCanonical('srgb');
    const cP = specimenCanonical('display-p3');
    // **同じ** scales を両方へ渡す ── 動くのは原色行列だけになる
    const scales = computeScales(computeStats(cS));
    const grid = fitGrid(cS.width, cS.height, 40_000);
    const a = makeLiftPayload(cS, grid, scales).base;
    const b = makeLiftPayload(cP, grid, scales).base;
    let differing = 0;
    for (let k = 0; k < a.length; k += 5) {
      if (a[k + 3] !== b[k + 3] || a[k + 4] !== b[k + 4]) differing++;
    }
    expect(differing, '彩度軸が 1 点も変わらないなら gamut が読まれていない').toBeGreaterThan(0);
  });

  it('buildColumnLine が gamut を読み、列平均線の a,b が変わる', () => {
    const cS = specimenCanonical('srgb');
    const stats = computeStats(cS);
    const scales = computeScales(stats);
    const n = 64;
    // 列平均も scales も**同一**。引数の `gamut` だけを変える
    const mk = (gamut: 'srgb' | 'display-p3') => {
      const base = new Float32Array(n * 5);
      const colors = new Float32Array(n * 3);
      buildColumnLine(stats.columnMeans, cS.width, cS.height, gamut, scales, n, { base, colors });
      return base;
    };
    const a = mk('srgb');
    const b = mk('display-p3');
    let differing = 0;
    for (let k = 0; k < a.length; k += 5) {
      if (a[k + 3] !== b[k + 3] || a[k + 4] !== b[k + 4]) differing++;
    }
    expect(differing, '列平均線が gamut を無視している').toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- 退化（§2.2）

/** 一様な色で正準バッファを作る。退化の境界を node で掃くのに使う */
function uniform(width: number, height: number, rgb: [number, number, number]): Canonical {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = rgb[0];
    rgba[i * 4 + 1] = rgb[1];
    rgba[i * 4 + 2] = rgb[2];
    rgba[i * 4 + 3] = 255;
  }
  return linearizeRgba(rgba, width, height);
}

/** 一部だけ有彩色にしたグレー画像（彩度の退化しきい値を跨がせる） */
function partlyChromatic(width: number, height: number, chromaticFraction: number): Canonical {
  const n = width * height;
  const rgba = new Uint8ClampedArray(n * 4);
  const chromatic = Math.round(n * chromaticFraction);
  for (let i = 0; i < n; i++) {
    const grey = 40 + ((i * 37) % 160);
    const isChromatic = i < chromatic;
    rgba[i * 4] = isChromatic ? 220 : grey;
    rgba[i * 4 + 1] = isChromatic ? 40 : grey;
    rgba[i * 4 + 2] = isChromatic ? 40 : grey;
    rgba[i * 4 + 3] = 255;
  }
  return linearizeRgba(rgba, width, height);
}

describe('退化の表明が実際にシーンへ届く(§2.2)', () => {
  /**
   * §2.2 は 3 つ約束している ── (1) extent を 0 に固定 (2) 読み出しに出す
   * (3) 回転プリセットを無効化。1b 時点で実装されていたのは**どれでもなく**、
   * `computeScales` がスケールを厳密 1 に*置く*ことで NaN を避けていただけだった
   * （それ自体は正しく、実測で `base` / `colors` の全要素が finite）。
   *
   * `axisPresence` は (1) の実装側。**純関数なので、退化の表明が
   * シーンへ届いているかをブラウザ抜きで採点できる。**
   */
  it('グレースケールでは彩度軸 2 本が同時に落ち、空間軸は残る', () => {
    const scales = computeScales(computeStats(uniform(64, 40, [128, 128, 128])));
    expect(scales.degenerate.chroma).toBe(true);
    const present = axisPresence(scales);
    expect(present[0]).toBe(true); // u
    expect(present[1]).toBe(true); // v
    expect(present[3]).toBe(false); // a
    expect(present[4]).toBe(false); // b
    // 彩度は 1 スカラーで正規化されるので、a と b が別々に退化することはない（§2.1）
    expect(present[3]).toBe(present[4]);
  });

  it('単色画像では明度軸も落ちる', () => {
    const scales = computeScales(computeStats(uniform(64, 40, [128, 128, 128])));
    expect(scales.degenerate.lightness).toBe(true);
    expect(axisPresence(scales)[2]).toBe(false);
    expect(degeneracyKind(scales)).toBe('both');
  });

  it('普通の画像では 5 軸すべてが存在する', () => {
    const scales = computeScales(computeStats(specimenCanonical()));
    expect(axisPresence(scales)).toEqual([true, true, true, true, true]);
    expect(degeneracyKind(scales)).toBeNull();
  });

  /**
   * **`'both'` を `'chroma'` に丸めない。** 単色画像に「色の軸がありません」とだけ言うと
   * 「明度の軸は動く」という含意になり、偽になる。
   */
  it('退化の種類が 4 値に分かれる', () => {
    const grey = computeScales(computeStats(uniform(64, 40, [128, 128, 128])));
    expect(degeneracyKind(grey)).toBe('both');
    expect(degeneracyKind(computeScales(computeStats(specimenCanonical())))).toBeNull();
  });

  /**
   * **表明が `LensScene` まで届いていることを見る**（Phase 1c で足した歯）。
   *
   * `axisPresence` を純関数として検査するだけでは足りない ── 実測で、
   * `lensScene` の `this.axisPresent = axisPresence(source.scales)` を
   * **全 true のリテラルに置き換えても 320 件が緑**だった。
   * `safeDist` の配線とまったく同じ形の穴で、「純関数は検査したが、
   * それを呼んでいることは検査していない」である。
   *
   * `LensScene` は three のオブジェクトを組むが **WebGL コンテキストは要らない**ので、
   * node で実際に構築して `stats()` を読める。
   */
  it('退化がシーンまで届き、extent が 0 に固定される', () => {
    const build = (canonical: Canonical) => {
      const stats = computeStats(canonical);
      const scales = computeScales(stats);
      const grid = fitGrid(canonical.width, canonical.height, 40_000);
      const lifted = makeLiftPayload(canonical, grid, scales);
      return new LensScene({
        grid,
        base: lifted.base,
        colors: lifted.colors,
        columnMeans: stats.columnMeans,
        scales,
        width: canonical.width,
        height: canonical.height,
        gamut: canonical.gamut,
        maxNorm: lifted.maxNorm,
        plate: null,
      });
    };

    const grey = build(uniform(128, 80, [128, 128, 128]));
    grey.freezeRotation(true);
    grey.setDimLevel(5); // 全軸を立てようとする
    grey.update(0);
    expect(grey.stats().axisPresent).toEqual([true, true, false, false, false]);
    // **dimLevel = 5 でも、存在しない軸の extent は 0 のまま**
    expect(grey.stats().extent.slice(2)).toEqual([0, 0, 0]);
    expect(grey.stats().extent.slice(0, 2)).toEqual([1, 1]);

    // 普通の画像では 5 軸すべてが立つ（同じ手順で対照を取る）
    const normal = build(specimenCanonical());
    normal.freezeRotation(true);
    normal.setDimLevel(5);
    normal.update(0);
    expect(normal.stats().axisPresent).toEqual([true, true, true, true, true]);
    expect(normal.stats().extent).toEqual([1, 1, 1, 1, 1]);
  });

  /**
   * **しきい値そのものをピン留めする**（Phase 1c で足した歯）。
   *
   * 1b までは順序関係しか見ておらず、`C_MIN_P95` を **10 倍**（0.02）にしても、
   * `L_MIN_SPAN` を 10〜30 倍（0.1 / 0.3）にしても**276 件が緑**だった。
   * §7.7 が `DEFAULT_FILL` にやったのと同じ手で、値に意味を持たせて留める。
   */
  it('退化しきい値が値としてピン留めされている', () => {
    expect(C_MIN_P95).toBe(0.002);
    expect(L_MIN_SPAN).toBe(0.01);
    // §2.2:「bin 0 が r ∈ [0, 0.0125] を覆う。しきい値はその 1/39 で bin に埋もれている」
    // ── ヒストグラム経由では絶対に発火しない、という事実がこの比に掛かっている
    expect(0.0125 / C_MIN_P95).toBeGreaterThan(6);
  });

  /**
   * **退化の境界で `sC` が跳ぶ**（Phase 1c で発見・SPEC に記述が無かった）。
   *
   * 非退化に切り替わった瞬間の `sC` は、ヒストグラム bin 0 の中の補間値なので
   * 量子化の産物である。§2.2 は「ヒストグラムは非退化時の `sC` の値にだけ使う」と
   * 決めたが、**しきい値の近傍では `sC` そのものが解像度不足に汚染される。**
   *
   * ここは予算を置かず**事実として固定する** ── 予算を置くなら
   * `sC` の求め方を変える必要があり、それは Phase 2 の仕事である。
   * 固定しておけば、直したときにこのテストが落ちて気づける。
   */
  it('退化の境界を跨ぐと sC が 17 倍跳ぶ(いまの事実として固定する)', () => {
    const sC = (f: number) => computeScales(computeStats(partlyChromatic(200, 100, f)));

    // 有彩色画素が 4.9% までは退化。sC は「置いた」値なので厳密に 1
    expect(sC(0.049).degenerate.chroma).toBe(true);
    expect(sC(0.049).sC).toBe(1);

    // ちょうど 5.0% で非退化に切り替わる。**そのときの sC は bin 0 の上端そのもの**
    // ── §2.2 が「bin 0 が r ∈ [0, 0.0125] を覆う」と書いた、まさにその値である。
    // つまり切り替わった瞬間の sC は測定値ではなく**ヒストグラムの量子化の産物**。
    const edge = sC(0.05);
    expect(edge.degenerate.chroma).toBe(false);
    expect(edge.sC).toBeCloseTo(0.0125, 6);

    // 0.1 ポイント動かすだけで 17 倍に跳ぶ（0.0125 → 0.2136）
    const past = sC(0.051);
    expect(past.sC).toBeCloseTo(0.2136, 3);
    expect(past.sC / edge.sC).toBeGreaterThan(17);

    // その先は安定している ── 跳びは境界だけの現象で、単調な変化ではない
    expect(sC(0.30).sC / past.sC).toBeLessThan(1.01);
  });
});

// ---------------------------------------------------------------- 病的入力

describe('病的な入力でも NaN / Inf を作らない', () => {
  /**
   * §2.2 の「`0/0 = NaN` を避ける」は、**スパンで割らずスケールを*置く*こと**で
   * 構造的に達成されている（`computeScales`）。それを実際に走らせて確かめる。
   */
  it.each([
    ['1×1 白', 1, 1, [255, 255, 255] as [number, number, number]],
    ['1×1 黒', 1, 1, [0, 0, 0] as [number, number, number]],
    ['2048×1 グレー', 2048, 1, [128, 128, 128] as [number, number, number]],
    ['1×2048 グレー', 1, 2048, [128, 128, 128] as [number, number, number]],
  ])('%s', (_name, w, h, rgb) => {
    const canonical = uniform(w, h, rgb);
    const stats = computeStats(canonical);
    const scales = computeScales(stats);
    const p = makeLiftPayload(canonical, fitGrid(w, h, 4000), scales);

    for (const v of p.base) expect(Number.isFinite(v)).toBe(true);
    for (const v of p.colors) expect(Number.isFinite(v)).toBe(true);
    for (const v of stats.columnMeans) expect(Number.isFinite(v)).toBe(true);
    expect(Number.isFinite(p.maxNorm)).toBe(true);
    expect(Number.isFinite(p.safeDist)).toBe(true);
    // 退化していても、カスケードの必要条件は満たされていなければならない
    expect(p.safeDist).toBeGreaterThan(2 * p.maxNorm);
    expect(scales.sL).toBeGreaterThan(0);
    expect(scales.sC).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- 形式の判定

/** ISO-BMFF の先頭 12 バイトを組む（size / 'ftyp' / major brand） */
function ftyp(brand: string): Uint8Array {
  const b = new Uint8Array(SNIFF_BYTES);
  b.set([0, 0, 0, 0x18], 0);
  b.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
  for (let i = 0; i < 4; i++) b[8 + i] = brand.charCodeAt(i);
  return b;
}

describe('読めない形式の判定(§4.19)', () => {
  /**
   * **例外の中身では分類できない**（実測）。`createImageBitmap` の失敗は、
   * HEIC / type を偽装した HEIC / ランダムバイト / 切断 JPEG / 空 Blob / PDF /
   * SVG / AVIF マジックのみ の **9 種すべてで `name` も `message` も一字一句同じ**
   * （`InvalidStateError` / "The source image could not be decoded."）。
   * だから先頭バイトを見るしかなく、それは**失敗したあとにだけ**やる。
   */
  it('HEIF の brand を当てる', () => {
    for (const brand of ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx']) {
      expect(sniffUnsupportedFormat(ftyp(brand)), brand).toBe('heif');
    }
  });

  /**
   * **AVIF を当ててはいけない。** `ftyp` は AVIF とも共通だが、
   * Chrome は AVIF を読める ── 当てると「読める形式」を読めないと言うことになる。
   */
  it('AVIF は当てない(Chrome は読めるので)', () => {
    expect(sniffUnsupportedFormat(ftyp('avif'))).toBeNull();
    expect(sniffUnsupportedFormat(ftyp('avis'))).toBeNull();
  });

  it('JPEG / PNG / ゴミ / 短すぎる入力は当てない', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    expect(sniffUnsupportedFormat(jpeg)).toBeNull();
    expect(sniffUnsupportedFormat(png)).toBeNull();
    expect(sniffUnsupportedFormat(new Uint8Array(SNIFF_BYTES))).toBeNull();
    expect(sniffUnsupportedFormat(new Uint8Array([0x66, 0x74, 0x79, 0x70]))).toBeNull();
  });

  /**
   * **`ftyp` は必ずオフセット 4 にある。** 先頭 4 バイトは box の大きさなので、
   * `'ftyp'` を 0 から探すような実装にすると、たまたま中身に 'ftyp' を含む
   * JPEG を HEIF と誤判定する。
   */
  it('ftyp をオフセット 4 以外で見ない', () => {
    const shifted = new Uint8Array(SNIFF_BYTES);
    shifted.set([0x66, 0x74, 0x79, 0x70], 0); // オフセット 0 に 'ftyp'
    shifted.set([0x68, 0x65, 0x69, 0x63], 4);
    expect(sniffUnsupportedFormat(shifted)).toBeNull();
  });
});
