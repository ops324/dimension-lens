/**
 * **配線の生存の行列**（Phase 2c-vi）。
 *
 * ## なぜ要るのか —— 「配線されている」と「配線が生き続ける」は別の主張だった
 *
 * この作品はこの型を 4 回踏んでいる:
 *
 * | フェーズ | 何が起きたか |
 * |---|---|
 * | 2a まで | `CompressPass` の `setCompressStrength` を誰も呼んでいなかった |
 * | 2a まで | 光過敏の配慮が `gradePass`（既定オフ）の `uTime` を握るだけだった |
 * | 2c-iii | ティアの `dpr` / `samples` が未配線（`Engine.setQuality` の呼び出し元がゼロ） |
 * | **2c-ii → 2c-iv** | **包絡は配線されていたが、`layout()` を 1 回通ると消えて戻らなかった** |
 *
 * 最後のものが厄介だった ── 既存のテスト「600 フレーム回してもカメラ距離が動かない」は
 * **配線されていることを確かめていた**が、`setDimLevel` のあとに `layout()` を一度も
 * 呼ばないので、**配線が生き続けることは確かめていなかった**。
 *
 * ## この検査が問うこと（**こちらが答えを決めない**）
 *
 * ```
 * ある設定で観測 → 生存イベントを起こす → 同じ設定へ戻す → もう一度観測
 * ```
 *
 * **「同じ設定に戻したのだから同じ値が出るはず」だけを問う。** 何がいくつになるべきかを
 * こちらが書かないのが要点である ── 期待値を書けば、それは採点者にモデルが入るということで、
 * この repo が `fillRatios` / `reconstructMean` / G10 で繰り返し踏んできた `x/x` になる。
 *
 * ## この検査に歯が在ることの確認（実測）
 *
 * 2c-iv が直した変異（包絡の引き直しに `if (dimChanged)` の門を戻す）を入れると、
 * **戻らないセルが 5 → 92 に増える** ── `cameraDistance` / `needDistance` / `fill` /
 * `s0` / `spritePx` / `gain` / `sampleWeight` まで芋づるで検出する。
 * `scripts/teeth.mjs` の台帳がこの変異を持っているので、確認は毎回自動で走る。
 *
 * ## この検査が見張らないもの（正直に）
 *
 * - **観測できない状態は見えない。** `stats()` に出ていない内部状態が壊れても分からない
 * - **位相は毎回 `resetRotation()` で揃えている。** 位相に依存する壊れ方は別の検査の仕事
 * - **GPU を通していない。** シェーダのユニフォームやテクスチャの生存は見ていない
 * - **イベントは 9 種類しか列挙していない。** 台帳なので、増やせる
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LensScene } from '../scene/lensScene';
import { CAMERA_FOV } from '../core/engine';
import { makeSpecimen0, makeGrayscaleRamp, type Specimen } from '../image/fixture';
import { linearizeRgba } from '../image/linearize';
import { computeScales, computeStats } from '../image/stats';
import { fitGrid, TIER_BUDGET, type TierName } from '../image/grid';
import { makeLiftPayload } from '../ingest/session';

function sourceOf(spec: Specimen, tier: TierName) {
  const canonical = linearizeRgba(spec.rgba, spec.width, spec.height, 'srgb');
  const stats = computeStats(canonical);
  const scales = computeScales(stats);
  const grid = fitGrid(canonical.width, canonical.height, TIER_BUDGET[tier]);
  const lifted = makeLiftPayload(canonical, grid, scales);
  return {
    grid, base: lifted.base, colors: lifted.colors, columnMeans: stats.columnMeans,
    scales, width: canonical.width, height: canonical.height, gamut: canonical.gamut,
    maxNorm: lifted.maxNorm, plate: null,
  };
}

const DT = 1 / 60;
/** §7.7 の測定 viewport */
const VIEW = { w: 988, h: 778 };

function layoutOf(scene: LensScene, w: number, h: number): void {
  scene.layout({
    camera: new THREE.PerspectiveCamera(CAMERA_FOV, w / h, 0.1, 100),
    viewportAspect: w / h,
    bandFrac: 1,
    pxPerWorld: h / (2 * Math.tan((CAMERA_FOV * Math.PI) / 360)),
    maxPointSize: 1024,
  });
}

/** `stats()` を平らな比較可能の表にする。**何を見るかを列挙するだけで、期待値は書かない** */
function observe(scene: LensScene): Record<string, number | string> {
  const s = scene.stats();
  return {
    cameraDistance: s.cameraDistance,
    needDistance: s.needDistance,
    'fill.x': s.fill.x,
    'fill.y': s.fill.y,
    'spread.aX': s.spread.aX,
    'spread.aY': s.spread.aY,
    'spread.zHi': s.spread.zHi,
    s0: s.s0,
    spritePx: s.spritePx,
    gain: s.gain,
    calibrated: String(s.calibrated),
    sampleWeight: s.sampleWeight,
    modelledAdditionDepth: s.modelledAdditionDepth,
    pointCount: s.pointCount,
    linePoints: s.linePoints,
    plateWeight: s.plateWeight,
    cloudWeight: s.cloudWeight,
    buffer: s.buffer,
    cascadeDist: s.cascadeDist,
    extent: s.extent.join(','),
    axisPresent: s.axisPresent.join(','),
    meanColor: s.meanColor.join(','),
  };
}

/**
 * **生存イベントの台帳。** どれも「起こしてから元の設定へ戻す」形でなければならない ──
 * 戻さないイベントを入れると、この検査は「値が変わったこと」を検出してしまい意味を失う。
 */
const EVENTS: Array<[string, (s: LensScene) => void]> = [
  // **これが 2c-iv のバグを捕まえる経路。** `relayout()` は `engine.onResize` に配線されている
  ['layout（同じ寸法 ＝ リサイズ 1 回）', (s) => { layoutOf(s, VIEW.w, VIEW.h); }],
  ['layout（別寸法 → 元の寸法）', (s) => { layoutOf(s, 640, 480); layoutOf(s, VIEW.w, VIEW.h); }],
  ['setPathOverride cloud → auto', (s) => { s.setPathOverride('cloud'); s.update(DT); s.setPathOverride('auto'); }],
  ['setPathOverride plate → auto', (s) => { s.setPathOverride('plate'); s.update(DT); s.setPathOverride('auto'); }],
  ['setColorField mean → image', (s) => { s.setColorField('mean'); s.update(DT); s.setColorField('image'); }],
  ['setDimLevel 往復（0 を経由）', (s) => { const d = s.getDimLevel(); s.setDimLevel(0); s.update(DT); s.setDimLevel(d); }],
  ['setDimLevel 往復（5 を経由）', (s) => { const d = s.getDimLevel(); s.setDimLevel(5); s.update(DT); s.setDimLevel(d); }],
  ['setDimLevel 往復（1 を経由・バッファが切り替わる）',
    (s) => { const d = s.getDimLevel(); s.setDimLevel(1); s.update(DT); s.setDimLevel(d); }],
  ['freezeRotation 往復', (s) => { s.freezeRotation(true); s.update(DT); s.freezeRotation(false); }],
  ['setReducedMotion 往復', (s) => { s.setReducedMotion(true); s.update(DT); s.setReducedMotion(false); }],
];

const DIMS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4.25, 5];

const CASES: Array<[string, Specimen, TierName]> = [
  ['標本 No.0 / HIGH', makeSpecimen0(), 'HIGH'],
  // **退化した画像も通す**（2c-iv の教訓: 標本を 1 枚しか通さない測定は「測った」と書けない）
  ['グレースケール / BALANCED', makeGrayscaleRamp(), 'BALANCED'],
];

describe('配線の生存（同じ設定へ戻したら同じ値が出るか）', () => {
  for (const [label, spec, tier] of CASES) {
    /**
     * **CI の runner はこの Mac より遅い**ので timeout を明示する（§7.9.4 の教訓）。
     * ローカル実測は 2 標本あわせて約 1 秒。
     */
    it(`${label}: すべての観測量が往復する`, () => {
      const src = sourceOf(spec, tier);
      const failures: string[] = [];
      let cells = 0;

      for (const d of DIMS) {
        for (const [name, ev] of EVENTS) {
          const scene = new LensScene(src);
          layoutOf(scene, VIEW.w, VIEW.h);
          const settle = (): void => {
            scene.freezeRotation(true);
            scene.resetRotation();
            scene.setDimLevel(d);
            scene.update(DT);
            scene.update(DT);
          };
          settle();
          const before = observe(scene);
          ev(scene);
          // 位相と門を必ず同じところへ戻す（位相差を配線の話と混ぜない）
          settle();
          const after = observe(scene);

          for (const k of Object.keys(before)) {
            cells++;
            if (!Object.is(before[k], after[k])) {
              failures.push(`d=${d} / ${name} / ${k}: ${before[k]} → ${after[k]}`);
            }
          }
        }
      }
      expect(
        failures,
        `${cells} セル中 ${failures.length} セルが往復しなかった:\n${failures.slice(0, 20).join('\n')}`,
      ).toEqual([]);
    }, 60_000);
  }
});
