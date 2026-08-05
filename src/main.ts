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
import { IngestError } from './ingest/protocol';
import type { IngestPayload } from './ingest/session';
import { Engine } from './core/engine';
import { bootTier, tierFor } from './core/quality';
import { LensScene, type LensSceneSource } from './scene/lensScene';

document.documentElement.dataset.lens = 'booted';

const client = createIngestClient();
const tier = tierFor(bootTier());

let engine: Engine | null = null;
let scene: LensScene | null = null;
let payload: IngestPayload | null = null;
let report: LensIngestReport | null = null;

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
    width: p.meta.width,
    height: p.meta.height,
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

async function ingestBlob(source: Blob): Promise<LensIngestReport> {
  const next = await client.ingest(source, { budget: tier.budget });
  payload = next;
  report = toReport(next, client.mode);
  if (scene) {
    scene.setSource(sourceFrom(next));
    relayout();
  }
  return report;
}

function stats(): LensStats {
  const s = scene?.stats();
  return {
    dimLevel: s?.dimLevel ?? 2,
    meanHex: report?.meanHex ?? '#000000',
    gridW: s?.gridW ?? 0,
    gridH: s?.gridH ?? 0,
    pointCount: s?.pointCount ?? 0,
    // 列平均バッファは Phase 1b。ここで 'columnMeans' を返す経路はまだ無い
    buffer: 'grid',
    // sampleWeight も Phase 1b。実装が無いのに数値を返さない
    sampleWeight: 1,
    tier: tier.name,
    dpr: engine ? engine.renderer.getPixelRatio() : 0,
    gamut: payload?.meta.gamut ?? 'srgb',
    anchored: s?.anchored ?? false,
  };
}

async function boot(): Promise<void> {
  // ---- 1. 取り込み ----
  const r = await ingestBlob(await specimenBlob());
  document.documentElement.dataset.lensIngest = 'ok';

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

  // ---- 4. シーン ----
  scene = new LensScene(sourceFrom(payload!));
  engine.setScene(scene.scene);
  relayout();
  engine.onResize(relayout);
  engine.onFrame((dt) => scene?.update(dt));

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
        + ` / アンカー ${s.anchored}`,
    );
    console.info('[LENS] window.__LENS__ で測定できる。');
  }
}

installDevHook({
  capabilities: () => client.capabilities(),
  ingestReport: () => report,
  ingestBlob,
  renderOnce: (steps = 1) => engine?.renderOnce(steps),
  setDimLevel: (d: number) => {
    scene?.setDimLevel(d);
    engine?.renderOnce(1);
  },
  freezeRotation: (frozen: boolean) => scene?.freezeRotation(frozen),
  setBloom: (on: boolean) => engine?.postfx.setBloomEnabled(on),
  setGrade: (on: boolean) => engine?.postfx.setGradeEnabled(on),
  setCompress: (on: boolean) => engine?.postfx.setCompressEnabled(on),
  setPath: (mode) => {
    scene?.setPathOverride(mode);
    engine?.renderOnce(1);
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
  stats,
});

void boot().catch((e: unknown) => {
  document.documentElement.dataset.lensIngest ??=
    e instanceof IngestError ? `failed:${e.code}` : 'failed:internal';
  document.documentElement.dataset.lensRender = 'failed';
  console.error('[LENS] 起動に失敗しました。', e);
});
