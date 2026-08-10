/**
 * DIMENSION-LENS 起動点。
 *
 * Phase 1a-iii で初めて**絵が出る**。順序には意味がある:
 *
 *   1. 取り込み（1a-ii）→ 正準バッファ・点群バッファ・板の ImageBitmap
 *   2. engine（renderer / camera / composer / capture）
 *   3. **測定器の自己検査** —— ここが通らなければ以降のどの数値も信用しない
 *   4. シーン（板 + 点群）を組んで最初のフレームを描く
 *
 * 3 を 4 より先に置くのは形式ではない。読み戻しが壊れていると、忠実性テストは
 * 「壊れていても緑」になる（SPEC §7.2）。測定器が動いていること自体に判定を付ける。
 */

import './style.css';

import { installDevHook, type LensIngestReport, type LensStats } from './dev/hook';
import { createIngestClient } from './ingest/ingest';
import { specimenBlob } from './ingest/specimenSource';
import { IngestError, type FailureDetail, type IngestFailureCode } from './ingest/protocol';
import type { IngestPayload } from './ingest/session';
import { degeneracyKind } from './image/stats';
import { clearEmptyState, showDegenerate, showFailure } from './ui/emptyState';
import { Engine } from './core/engine';
import { bootTier, tierFor } from './core/quality';
import { compressStrengthFor } from './core/compress';
import { observeReducedMotion } from './core/motion';
import { LensScene, type LensSceneSource } from './scene/lensScene';
import { BlendProbe } from './render/blendProbe';

document.documentElement.dataset.lens = 'booted';

const client = createIngestClient();
const tier = tierFor(bootTier());

let engine: Engine | null = null;
let scene: LensScene | null = null;
let payload: IngestPayload | null = null;
let report: LensIngestReport | null = null;
/** 加算合成の器具（Phase 2b）。**DEV でしか作らない** ── 作品には要らない */
let blendProbe: BlendProbe | null = null;

/**
 * `CompressPass` の**測定用の上書き**（Phase 2b）。`null` が出荷時の配線
 * （`compressStrengthFor(dimLevel) > 0` で入る）。
 *
 * 上書きの口が要る理由: 配線を入れた瞬間、毎フレーム `setCompressEnabled` が
 * 走るので、測定器が `setCompress(true)` を撃っても**次のフレームで戻される**。
 * そうなると G6 の「強度 0 で画素まで恒等」は**両方とも圧縮オフの絵を比べる** ──
 * `x/x` になり、壊れていても緑になる。配線を足すことで既存の歯を抜くところだった。
 */
let compressOverride: boolean | null = null;

/**
 * 光過敏の配慮の**現在値**。判定は `core/motion.ts` が 1 か所で行い、
 * ここは配る側 ── **回転（`lensScene`）とグレイン（`postfx`）の両方**へ届かないと
 * 「配慮している」は嘘になる（Phase 2a まで実際に嘘だった）。
 */
let reducedMotion = false;

function applyReducedMotion(on: boolean): void {
  reducedMotion = on;
  scene?.setReducedMotion(on);
  engine?.postfx.setReducedMotion(on);
}

function toReport(p: IngestPayload, mode: 'worker' | 'main'): LensIngestReport {
  return {
    mode,
    meta: p.meta,
    gridW: p.grid.cols,
    gridH: p.grid.rows,
    pointCount: p.grid.cols * p.grid.rows,
    meanHex: p.stats.meanHex,
    maxNorm: p.maxNorm,
    safeDist: p.safeDist,
    degenerate: {
      lightness: p.scales.degenerate.lightness,
      chroma: p.scales.degenerate.chroma,
    },
  };
}

function sourceFrom(p: IngestPayload): LensSceneSource {
  return {
    grid: p.grid,
    base: p.base,
    colors: p.colors,
    // 列平均バッファ（Phase 1b）は**正準バッファ**の列平均から作る（SPEC §4.7）
    columnMeans: p.stats.columnMeans,
    scales: p.scales,
    width: p.meta.width,
    height: p.meta.height,
    gamut: p.meta.gamut,
    maxNorm: p.maxNorm,
    plate: p.plate,
  };
}

/** カメラとスプライトを現在の viewport に合わせる。resize と画像差し替えの両方から呼ぶ */
function relayout(): void {
  if (!engine || !scene) return;
  scene.layout({
    camera: engine.camera,
    viewportAspect: engine.camera.aspect,
    bandFrac: engine.bandFrac(),
    pxPerWorld: engine.pxPerWorld(),
    maxPointSize: engine.maxPointSize(),
  });
}

/**
 * 直近の失敗。**`ingestReport()` では観測できない**（あれは前の画像の報告をそのまま返す）。
 *
 * Phase 1b までは失敗を機械が観測する口が 1 本も無かった ── `data-lens-ingest` は
 * 起動時に `"ok"` が立ったきり更新されず、その後 `ingestBlob` が何度失敗しても
 * `"ok"` のままだった。**空状態のテストを書いても「壊れていても緑」になる**という、
 * §7.2 が名指ししている失敗モードそのもの。
 */
let lastFailure: { code: IngestFailureCode; detail?: FailureDetail } | null = null;

async function ingestBlob(source: Blob): Promise<LensIngestReport> {
  try {
    const next = await client.ingest(source, { budget: tier.budget });
    payload = next;
    report = toReport(next, client.mode);
    lastFailure = null;
    document.documentElement.dataset.lensIngest = 'ok';
    if (scene) {
      scene.setSource(sourceFrom(next));
      relayout();
    }
    // 取り込めた。前の空状態を消し、退化していれば**そのことを表明する**（SPEC §2.2）
    clearEmptyState();
    showDegenerate(degeneracyKind(next.scales));
    return report;
  } catch (e) {
    const code = e instanceof IngestError ? e.code : 'internal';
    const detail = e instanceof IngestError ? e.detail : undefined;
    lastFailure = { code, detail };
    // **`??=` にしない。** 1b はここが `??=` だったので、起動が成功したあとの失敗は
    // 1 つも痕跡を残さなかった。失敗はいつでも最新の観測で上書きする。
    document.documentElement.dataset.lensIngest = `failed:${code}`;
    showFailure(code, detail);
    throw e;
  }
}

function stats(): LensStats {
  const s = scene?.stats();
  return {
    dimLevel: s?.dimLevel ?? 2,
    meanHex: report?.meanHex ?? '#000000',
    gridW: s?.gridW ?? 0,
    gridH: s?.gridH ?? 0,
    pointCount: s?.pointCount ?? 0,
    // Phase 1b で実装が入った。**リテラルを返さない** ── シーンが実際に
    // 使っているバッファと補正をそのまま出す（測定器が自分の未実装を隠さない）
    buffer: s?.buffer ?? 'grid',
    sampleWeight: s?.sampleWeight ?? 1,
    tier: tier.name,
    dpr: engine ? engine.renderer.getPixelRatio() : 0,
    gamut: payload?.meta.gamut ?? 'srgb',
    anchored: s?.anchored ?? false,
  };
}

async function boot(): Promise<void> {
  // ---- 1. 取り込み ----（`data-lens-ingest` は `ingestBlob` が両方向へ立てる）
  const r = await ingestBlob(await specimenBlob());

  // ---- 2. engine ----
  const canvas = document.getElementById('gl');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('#gl が見つかりません。');
  engine = new Engine(canvas);

  // ---- 3. 測定器の自己検査（絵より先に）----
  const selfTest = engine.capture.selfTest(engine.renderer);
  document.documentElement.dataset.lensCapture = selfTest.ok ? 'ok' : 'broken';
  if (!selfTest.ok) {
    console.error(
      `[LENS] 読み戻しの自己検査に失敗: ${selfTest.message}`
        + `（読めた値 ${JSON.stringify(selfTest.actual)}, glError ${selfTest.glError}）`,
    );
  }
  // HDR 側も同じ規律で検査する（Phase 2）。**1.0 を超える値を置く** ──
  // この口の存在理由が「1.0 超を区別すること」なので、1.0 以下だけで通しても意味がない。
  const hdrSelfTest = engine.hdrCapture.selfTest(engine.renderer);
  document.documentElement.dataset.lensCaptureHdr = hdrSelfTest.ok ? 'ok' : 'broken';
  if (!hdrSelfTest.ok) {
    console.error(
      `[LENS] HDR 読み戻しの自己検査に失敗: ${hdrSelfTest.message}`
        + `（読めた値 ${JSON.stringify(hdrSelfTest.actual)}, glError ${hdrSelfTest.glError}）`,
    );
  }

  // ---- 4. シーン ----
  scene = new LensScene(sourceFrom(payload!));
  engine.setScene(scene.scene);
  relayout();
  engine.onResize(relayout);
  engine.onFrame((dt) => {
    scene?.update(dt);
    /**
     * **`CompressPass` の配線**（Phase 2b）。2a まで `setCompressStrength` を
     * 呼ぶ者はどこにも無く、パスは出荷経路で `enabled = false` のままだった ──
     * 「1.0 を超えた加算を圧縮する」は**書いてあるだけで動いていなかった**。
     *
     * 強度が 0 のときはパスごと外す。シェーダ側にも早期 return は在るが、
     * **「アンカー窓では圧縮パスが 1 フラグメントも走らない」を観測可能にする**
     * ほうが強い（`colorPointBatch.setWeight(0)` と同じ規律）。
     */
    const strength = compressStrengthFor(scene?.getDimLevel() ?? 2);
    engine?.postfx.setCompressStrength(strength);
    engine?.postfx.setCompressEnabled(compressOverride ?? strength > 0);
  });

  // 光過敏の配慮。**設定は途中で変わる**ので購読する（`core/motion.ts`）
  observeReducedMotion(applyReducedMotion);

  /**
   * 加算合成の器具の自己検査（Phase 2b）。**DEV だけ** ── 作品には要らない道具なので
   * 出荷ビルドには載せない（`installDevHook` と同じ規律）。
   * `1 + 0.5 + 0.25` はどの中間和も fp16 で厳密なので、**1.75 でなければならない**。
   */
  if (import.meta.env.DEV) {
    blendProbe ??= new BlendProbe();
    const t = blendProbe.selfTest(engine.renderer);
    document.documentElement.dataset.lensBlend = t.ok ? 'ok' : 'broken';
    if (!t.ok) console.error(`[LENS] 加算合成の器具の自己検査に失敗: ${t.message}`);
  }

  // 最初の 1 枚は rAF に依存せず描く（非表示タブでも痕跡が残る）
  engine.renderOnce(1);
  document.documentElement.dataset.lensRender = 'ok';
  engine.start();

  if (import.meta.env.DEV) {
    const s = scene.stats();
    console.info(
      `[LENS] Phase 1a-iii — ${r.meta.width}×${r.meta.height} / 格子 ${s.gridW}×${s.gridH}`
        + ` = ${s.pointCount} 点 / ティア ${tier.name} / DPR ${engine.renderer.getPixelRatio()}`
        + ` / s0 ${s.s0.toFixed(2)}px / スプライト ${s.spritePx.toFixed(1)}px / gain ${s.gain.toFixed(4)}`
        + ` / カメラ距離 ${s.cameraDistance.toFixed(3)} / カスケード dist ${s.cascadeDist.toFixed(3)}`
        + ` / アンカー ${s.anchored} / バッファ ${s.buffer} / 線 ${s.lineCount} 点`
        + ` / sampleWeight ${s.sampleWeight} / 加算深度(モデル) ${s.modelledAdditionDepth}`,
    );
    console.info('[LENS] window.__LENS__ で測定できる。');
  }
}

installDevHook({
  capabilities: () => client.capabilities(),
  ingestReport: () => report,
  ingestBlob,
  lastFailure: () => lastFailure,
  /**
   * 測定用の viewport を確定させる。**`resize` を撃って待つのではなく、
   * engine のリサイズ経路を同期に通してから、実際の `drawingBuffer` を読んで返す。**
   *
   * ペインの `resize_window` はページの `resize` を発火しないので、
   * 呼び出し側が `dispatchEvent` する回避策では「撃った → 効いた」の確認が要る。
   * ここで実測値を返すことで、その確認を測定器の内側に閉じる。
   */
  setViewport: (cssWidth: number, cssHeight: number) => {
    if (!engine) throw new Error('engine has not booted yet.');
    const el = document.documentElement;
    el.style.setProperty('--lens-measure-w', `${cssWidth}px`);
    el.style.setProperty('--lens-measure-h', `${cssHeight}px`);
    el.dataset.lensMeasure = 'on';
    engine.resize(cssWidth, cssHeight);
    relayout();
    engine.renderOnce(1);
    return engine.drawingBufferSize();
  },
  renderOnce: (steps = 1) => engine?.renderOnce(steps),
  setDimLevel: (d: number) => {
    scene?.setDimLevel(d);
    engine?.renderOnce(1);
  },
  freezeRotation: (frozen: boolean) => scene?.freezeRotation(frozen),
  resetRotation: () => {
    scene?.resetRotation();
    engine?.renderOnce(1);
  },
  setBloom: (on: boolean) => engine?.postfx.setBloomEnabled(on),
  setGrade: (on: boolean) => engine?.postfx.setGradeEnabled(on),
  setCompress: (on: boolean | null) => {
    compressOverride = on;
    if (on !== null) engine?.postfx.setCompressEnabled(on);
    engine?.renderOnce(1);
  },
  setPath: (mode) => {
    scene?.setPathOverride(mode);
    engine?.renderOnce(1);
  },
  setColorField: (mode) => {
    scene?.setColorField(mode);
    engine?.renderOnce(1);
  },
  setReducedMotion: (on: boolean) => {
    applyReducedMotion(on);
    engine?.renderOnce(1);
  },
  reducedMotion: () => reducedMotion,
  /**
   * 加算合成そのものを測る（Phase 2b）。**作品のシーンを一切通さない** ──
   * 通した瞬間、残差にスプライトの被覆と較正と位相が乗る（§4.6 訂正 4）。
   */
  blendProbe: (values: number[]) => {
    if (!engine) throw new Error('engine がまだ起動していません。');
    blendProbe ??= new BlendProbe();
    return blendProbe.accumulate(engine.renderer, values);
  },
  sceneStats: () => {
    if (!scene) throw new Error('シーンがまだ組まれていません。');
    return scene.stats();
  },
  sampleTexel: (imgX: number, imgY: number) => {
    if (!engine || !scene) throw new Error('engine がまだ起動していません。');
    return scene.sampleTexel(engine.renderer, imgX, imgY);
  },
  readback: async (x: number, y: number, w: number, h: number): Promise<Uint8Array> => {
    if (!engine) throw new Error('engine がまだ起動していません。');
    // **capture パスを立てて描いてから読む。** composer を迂回すると加算の演算自体が
    // 変わる（RT へ描くときは出力エンコードが恒等、画面へ描くときは sRGB が
    // ブレンドの前に入る）ので、迂回は「別の絵」を測ることになる。
    engine.renderForCapture(1);
    const { pixels, glError } = engine.capture.read(engine.renderer, x, y, w, h);
    if (glError !== 0) {
      throw new Error(`readback が GL エラー ${glError} を返しました。値は信用できません。`);
    }
    return pixels;
  },
  readbackHDR: async (x: number, y: number, w: number, h: number): Promise<Float32Array> => {
    if (!engine) throw new Error('engine がまだ起動していません。');
    engine.renderForHdrCapture(1);
    const { pixels, glError } = engine.hdrCapture.read(engine.renderer, x, y, w, h);
    if (glError !== 0) {
      throw new Error(`readbackHDR が GL エラー ${glError} を返しました。値は信用できません。`);
    }
    return pixels;
  },
  glInfo: () => {
    if (!engine) throw new Error('engine がまだ起動していません。');
    const gl = engine.renderer.getContext();
    // **UNMASKED を取る。** マスクされた RENDERER は "WebGL" のような無情報の文字列で、
    // ソフトウェア経路と GPU 経路を区別できない ── 監査が同じページで
    // SwiftShader と ANGLE Metal の 2 通りの数値を出したときも、どこにも出ていなかった。
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const str = (v: unknown): string => (typeof v === 'string' ? v : '(unavailable)');
    return {
      renderer: dbg
        ? str(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
        : str(gl.getParameter(gl.RENDERER)),
      vendor: dbg
        ? str(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL))
        : str(gl.getParameter(gl.VENDOR)),
      version: str(gl.getParameter(gl.VERSION)),
      maxSamples: engine.renderer.capabilities.maxSamples,
    };
  },
  stats,
});

void boot().catch((e: unknown) => {
  // 取り込みの失敗は `ingestBlob` が既に痕跡を立てている。ここで拾うのは
  // engine / シーン側の失敗なので、上書きせずに残す（`??=` はこちらでは正しい）。
  if (!(e instanceof IngestError)) {
    document.documentElement.dataset.lensIngest ??= 'ok';
    showFailure('internal');
  }
  document.documentElement.dataset.lensRender = 'failed';
  console.error('[LENS] boot failed.', e);
});
