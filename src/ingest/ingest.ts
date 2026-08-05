/**
 * メインスレッド側の窓口。worker があれば worker、無ければ**同じ `IngestSession` を
 * その場で**回す。
 *
 * 分岐はこのファイルにしか無い ── `session.ts` から下は 1 本道である。
 * 「フォールバックのときだけ挙動が違う」は、実機でしか踏まないうえに
 * 再現条件が環境依存になるので、構造で起こらないようにしておく。
 *
 * ## worker が要る理由は「デコードが重いから」ではない
 *
 * 実測(Chrome 148・24MP の JPEG、イベントループを setTimeout(0) で監視):
 *
 * | 区間 | wall | メインスレッドの最長遮断 |
 * |---|---|---|
 * | `createImageBitmap`(resize 込み) | 547 ms | **0.3 ms** ── 既にオフスレッド |
 * | `getImageData` + `linearizeRgba` | 240 ms | **1 tick も通らない** |
 *
 * デコードは元からメインを止めない。止めるのは**読み戻しと linearize**、そして
 * その後ろに続く `computeStats` / `lift`(§`session.ts`)である。
 */

import { MAX_CANONICAL_EDGE, TIER_BUDGET } from '../image/grid';
import type { CapabilityReport } from './capabilities';
import { IngestSession, type IngestPayload, type LiftPayload } from './session';
import {
  IngestError,
  type IngestClientMessage,
  type IngestWorkerMessage,
} from './protocol';

export interface IngestOptions {
  readonly maxEdge?: number;
  readonly budget?: number;
  readonly wantPlate?: boolean;
}

export interface IngestClient {
  /** どちらの経路で動いているか。**DEV フックと PR がこれを読む** */
  readonly mode: 'worker' | 'main';
  capabilities(): Promise<CapabilityReport>;
  ingest(source: Blob, opts?: IngestOptions): Promise<IngestPayload>;
  relift(budget: number): Promise<LiftPayload>;
  release(): Promise<void>;
  dispose(): void;
}

/**
 * union を**分配して** id を落とす。素直な `Omit<IngestClientMessage, 'id'>` は
 * union を 1 つのオブジェクト型に潰してしまい、`source` も `budget` も消える。
 */
type RequestWithoutId = IngestClientMessage extends infer T
  ? T extends { id: number }
    ? Omit<T, 'id'>
    : never
  : never;

/** ティアの決定は Phase 1a-iii(`quality.ts`)。1a-ii は最も軽い予算を既定にする */
const DEFAULT_BUDGET = TIER_BUDGET.BALANCED;

function withDefaults(opts?: IngestOptions) {
  return {
    maxEdge: opts?.maxEdge ?? MAX_CANONICAL_EDGE,
    budget: opts?.budget ?? DEFAULT_BUDGET,
    wantPlate: opts?.wantPlate ?? true,
  };
}

class WorkerIngestClient implements IngestClient {
  readonly mode = 'worker' as const;
  private readonly worker: Worker;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: IngestWorkerMessage) => void; reject: (e: unknown) => void }
  >();

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<IngestWorkerMessage>) => {
      const res = e.data;
      const slot = this.pending.get(res.id);
      if (!slot) return;
      this.pending.delete(res.id);
      if (res.kind === 'failed') slot.reject(new IngestError(res.code, res.detail));
      else slot.resolve(res);
    };
    // worker 自体が落ちたときに、待っている Promise が永遠に解決しない状態を作らない。
    // **文言は載せない** ── `ErrorEvent.message` はブラウザが作る英文で、
    // 利用者に見せるものではないし、`copy.ts` の外にある文字列でもある。
    this.worker.onerror = () => this.failAll();
    this.worker.onmessageerror = () => this.failAll();
  }

  private failAll(): void {
    const err = new IngestError('internal');
    for (const [, slot] of this.pending) slot.reject(err);
    this.pending.clear();
  }

  private send<T extends IngestWorkerMessage>(req: RequestWithoutId): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: IngestWorkerMessage) => void, reject });
      this.worker.postMessage({ ...req, id } as IngestClientMessage);
    });
  }

  async capabilities(): Promise<CapabilityReport> {
    const res = await this.send<Extract<IngestWorkerMessage, { kind: 'capabilities' }>>({
      kind: 'capabilities',
    });
    return res.report;
  }

  async ingest(source: Blob, opts?: IngestOptions): Promise<IngestPayload> {
    const res = await this.send<Extract<IngestWorkerMessage, { kind: 'ingested' }>>({
      kind: 'ingest',
      source,
      ...withDefaults(opts),
    });
    return res;
  }

  async relift(budget: number): Promise<LiftPayload> {
    return await this.send<Extract<IngestWorkerMessage, { kind: 'lifted' }>>({
      kind: 'relift',
      budget,
    });
  }

  async release(): Promise<void> {
    await this.send({ kind: 'release' });
  }

  dispose(): void {
    this.failAll();
    this.worker.terminate();
  }
}

/** worker が使えない環境。**同じ `IngestSession` を使う**（別実装を作らない） */
class LocalIngestClient implements IngestClient {
  readonly mode = 'main' as const;
  private readonly session = new IngestSession();

  capabilities(): Promise<CapabilityReport> {
    return this.session.capabilities();
  }

  ingest(source: Blob, opts?: IngestOptions): Promise<IngestPayload> {
    return this.session.ingest({ source, ...withDefaults(opts) });
  }

  async relift(budget: number): Promise<LiftPayload> {
    return this.session.relift(budget);
  }

  async release(): Promise<void> {
    this.session.release();
  }

  dispose(): void {
    this.session.release();
  }
}

/**
 * 経路を選ぶ。**`OffscreenCanvas` の有無をメインスレッドで見てよい** ──
 * worker 側にだけ存在する API ではないので、ここでの判定と worker 内の実態が食い違わない。
 */
export function createIngestClient(): IngestClient {
  if (typeof Worker === 'function' && typeof OffscreenCanvas === 'function') {
    try {
      return new WorkerIngestClient();
    } catch {
      // worker のロードに失敗したら黙って落ちるのではなく、メイン経路で続ける
    }
  }
  return new LocalIngestClient();
}
