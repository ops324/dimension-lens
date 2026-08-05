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

/**
 * 格子を引き、`safeDist` を**同じ場所で**決める純関数。
 *
 * ## なぜ private メソッドから出したのか（Phase 1c）
 *
 * §4.9 は「呼び忘れようのない位置へ移した」と書き、§0 の表は
 * 「`safeDist` が実際に配線されている｜**A**」と主張している。**押さえているテストが
 * 1 本も無かった** ── 実測: `safeDist: safeDist(maxNorm)` を**リテラル `2.4`** に
 * 置き換えても **276 件が緑のまま**だった。構造の主張が、構造だけで支えられていた。
 *
 * `IngestSession` は `decodeToCanonical` を通るので node から呼べない。
 * だから配線の**この一点だけ**を DOM に触らない純関数として外へ出し、
 * `ingest.test.ts` が node で採点する。**採点者は `safeDist` の定義を書き戻さず、
 * `2·maxNorm` という §4.8 の必要条件そのものを見る**（`reconstructMean` 型の
 * 恒等な変換にしないため。§7.1）。
 */
export function makeLiftPayload(
  canonical: Canonical,
  grid: GridSpec,
  scales: BlockScales,
): LiftPayload {
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
    // dist を決める側が maxNorm を持っていない、という状態を作らない（§4.9）
    safeDist: safeDist(maxNorm),
    liftMs,
  };
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
    // 1b はこれを `decode-failed` で返していた ── **分類の誤り**である。
    // デコードは 1 バイトも試していないし、失敗しているのは画像ではなくブラウザのほう。
    if (!caps.canIngest) {
      throw new IngestError('unsupported-browser');
    }

    const decoded = await decodeToCanonical(req.source, {
      maxEdge: req.maxEdge > 0 ? req.maxEdge : MAX_CANONICAL_EDGE,
      wantPlate: req.wantPlate,
      canResizeInDecoder: caps.canResizeInDecoder,
      // 色域は機能検出が決めた**唯一の値**を渡す（§4.13 の 4 箇所を 1 か所から導出）
      gamut: caps.gamut,
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
      throw new IngestError('no-session');
    }
    return this.liftInternal(budget);
  }

  /**
   * 正準バッファを手放す。
   *
   * SPEC §6.4 の残留物のうち、**この 2 つだけは 1a-ii で閉じる** ──
   * 後から足すと「どこで持っているか」の一覧が既に長くなっているため。
   *
   * `FileList` / object URL / bfcache / localStorage は **1c でも持たない**
   * （`<input type="file">` は Phase 3）。「持ち始めたその PR で閉じる」という規律は、
   * 「1 フェーズ先回りして閉じる」ではない ── 先回りするには先に**持ち始める**しかなく、
   * それは規律の適用ではなく反転である。`privacy.test.ts` が
   * 「dist に file input も localStorage も現れない」を**宣言として**見張っている。
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
      throw new IngestError('no-session');
    }
    return makeLiftPayload(canonical, fitGrid(canonical.width, canonical.height, budget), scales);
  }

  /** 統計を読み直す(relift 後にメインが持ち直す必要はないが、DEV フックが使う) */
  peekStats(): ImageStats | null {
    return this.stats;
  }
}
