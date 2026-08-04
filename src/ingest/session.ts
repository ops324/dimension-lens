/**
 * 取り込みの状態機械。**正準バッファはここに常駐する。**
 *
 * ## なぜ「メインスレッドに常駐」ではないのか
 *
 * 素案は正準バッファをメインへ渡す形だった。これは worker の効き目を
 * `linearizeRgba` の分しか見ていない。実測(Node 24 / M1 Max / 2048×1536):
 *
 * | | median |
 * |---|---|
 * | `linearizeRgba` | 13.7 ms |
 * | `computeStats` | 35.5 ms |
 * | `lift` → ULTRA 格子 | 14.7 ms |
 *
 * 大きいのは `computeStats` と、**ティアが変わるたびに再実行される `lift`** である。
 * 正準バッファをメインに置くと、この合計がメインスレッドに固定される。
 * → 正準は worker に残し、メインへ渡すのは**派生物だけ**にする。
 *   派生物は小さい: ULTRA でも `base` 3.04MB + `colors` 1.82MB、`columnMeans` は 0.02MB。
 *
 * この class は DOM にも `postMessage` にも依存しない ── worker から使うのと同じものを、
 * worker が使えない環境ではメインスレッドから直接使う(`ingest.ts`)。
 * **フォールバック経路が別実装にならないこと**が、この分離の目的である。
 */

import { fitGrid, MAX_CANONICAL_EDGE, type GridSpec } from '../image/grid';
import { lift, type LiftBuffers } from '../image/lift';
import { computeScales, computeStats, type BlockScales, type Canonical, type ImageStats } from '../image/stats';
import { safeDist } from '../math/rotationN';
import { decodeToCanonical } from './decode';
import { detectCapabilities, type CapabilityReport } from './capabilities';
import {
  IngestError,
  type IngestMeta,
  type IngestRequest,
  type IngestedResponse,
  type LiftedResponse,
  INGEST_PROTOCOL_VERSION,
} from './protocol';

/** `id` / `kind` は呼び出し側(worker アダプタ)が付ける */
export type IngestPayload = Omit<IngestedResponse, 'kind' | 'id'>;
export type LiftPayload = Omit<LiftedResponse, 'kind' | 'id'>;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : 0;
}

export class IngestSession {
  private canonical: Canonical | null = null;
  private stats: ImageStats | null = null;
  private scales: BlockScales | null = null;
  private caps: CapabilityReport | null = null;

  async capabilities(): Promise<CapabilityReport> {
    this.caps ??= await detectCapabilities();
    return this.caps;
  }

  async ingest(req: Pick<IngestRequest, 'source' | 'maxEdge' | 'budget' | 'wantPlate'>): Promise<IngestPayload> {
    const t0 = now();
    const caps = await this.capabilities();
    if (!caps.canIngest) {
      throw new IngestError('decode-failed', caps.notes.join(' ') || '取り込みできません。');
    }

    const decoded = await decodeToCanonical(req.source, {
      maxEdge: req.maxEdge > 0 ? req.maxEdge : MAX_CANONICAL_EDGE,
      wantPlate: req.wantPlate,
      canResizeInDecoder: caps.canResizeInDecoder,
    });

    const tStats = now();
    const stats = computeStats(decoded.canonical);
    const scales = computeScales(stats);
    const statsMs = now() - tStats;

    // 前の画像を明示的に手放す（GC 任せにしない ── 48MB の世代が 2 つ並ぶ瞬間を作らない）
    this.canonical = decoded.canonical;
    this.stats = stats;
    this.scales = scales;

    const lifted = this.liftInternal(req.budget);

    const meta: IngestMeta = {
      protocolVersion: INGEST_PROTOCOL_VERSION,
      decodedWidth: decoded.decodedWidth,
      decodedHeight: decoded.decodedHeight,
      width: decoded.canonical.width,
      height: decoded.canonical.height,
      plan: decoded.plan,
      gamut: decoded.canonical.gamut,
      orientation: caps.orientation,
      resizePath: decoded.resizePath,
      timings: {
        decodeMs: decoded.timings.decodeMs,
        resizeMs: decoded.timings.resizeMs,
        readbackMs: decoded.timings.readbackMs,
        linearizeMs: decoded.timings.linearizeMs,
        statsMs,
        liftMs: lifted.liftMs,
        totalMs: now() - t0,
      },
    };

    return {
      meta,
      stats,
      scales,
      grid: lifted.grid,
      base: lifted.base,
      colors: lifted.colors,
      maxNorm: lifted.maxNorm,
      safeDist: lifted.safeDist,
      plate: decoded.plate,
    };
  }

  relift(budget: number): LiftPayload {
    if (!this.canonical) {
      throw new IngestError('no-session', 'まだ画像が取り込まれていません。');
    }
    return this.liftInternal(budget);
  }

  /**
   * 正準バッファを手放す。
   *
   * SPEC §6.4 の残留物のうち、**この 2 つだけは 1a-ii で閉じる** ──
   * 後から足すと「どこで持っているか」の一覧が既に長くなっているため。
   * `FileList` / object URL / bfcache / localStorage は Phase 1c。
   */
  release(): void {
    this.canonical = null;
    this.stats = null;
    this.scales = null;
  }

  private liftInternal(budget: number): LiftPayload {
    const canonical = this.canonical;
    const scales = this.scales;
    if (!canonical || !scales) {
      throw new IngestError('no-session', 'まだ画像が取り込まれていません。');
    }
    const grid: GridSpec = fitGrid(canonical.width, canonical.height, budget);
    const count = grid.cols * grid.rows;
    const buffers: LiftBuffers = {
      base: new Float32Array(count * 5),
      colors: new Float32Array(count * 3),
    };
    const t = now();
    const { maxNorm } = lift(canonical, grid, scales, buffers);
    const liftMs = now() - t;
    return {
      grid,
      base: buffers.base,
      colors: buffers.colors,
      maxNorm,
      // §4.9「Phase 1a-iii は必ずこれを呼ぶこと」を、呼び忘れようのない位置へ移す。
      // dist を決める側が maxNorm を持っていない、という状態を作らない。
      safeDist: safeDist(maxNorm),
      liftMs,
    };
  }

  /** 統計を読み直す(relift 後にメインが持ち直す必要はないが、DEV フックが使う) */
  peekStats(): ImageStats | null {
    return this.stats;
  }
}
