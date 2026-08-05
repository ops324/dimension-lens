/**
 * 取り込み worker のエントリ。**ここには判断を書かない** ──
 * メッセージを `IngestSession` に渡し、応答に転送リストを付けて返すだけの膜である。
 * 判断が両側(worker とメインスレッド・フォールバック)に散ると、
 * 「フォールバックのときだけ挙動が違う」という最も検証しにくい形の差になる。
 *
 * `lib` に `webworker` を足すと DOM と識別子が衝突するので、
 * worker のグローバルはここで**必要な 2 つだけ**を名乗る。
 */

import { IngestSession } from './session';
import {
  failure,
  IngestError,
  transferablesOf,
  type IngestClientMessage,
  type IngestWorkerMessage,
} from './protocol';

interface WorkerCtx {
  onmessage: ((e: MessageEvent<IngestClientMessage>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const ctx = globalThis as unknown as WorkerCtx;
const session = new IngestSession();

function reply(res: IngestWorkerMessage): void {
  ctx.postMessage(res, transferablesOf(res));
}

/**
 * 例外を分類つきの応答へ畳む。
 *
 * **文字列を 1 本も載せない**（Phase 1c）── 1b は `e.message` をそのまま応答へ写しており、
 * 「画像の中身を入れない」は規律であって保証ではなかった。いまは `code` と、
 * 葉が数値と閉じた union だけの `detail` しか越えない。文言は `copy.ts`。
 */
function toFailure(id: number, e: unknown): IngestWorkerMessage {
  if (e instanceof IngestError) return failure(id, e.code, e.detail);
  return failure(id, 'internal');
}

ctx.onmessage = (event: MessageEvent<IngestClientMessage>) => {
  const req = event.data;
  void (async () => {
    try {
      switch (req.kind) {
        case 'capabilities':
          reply({ kind: 'capabilities', id: req.id, report: await session.capabilities() });
          return;
        case 'ingest':
          reply({ kind: 'ingested', id: req.id, ...(await session.ingest(req)) });
          return;
        case 'relift':
          reply({ kind: 'lifted', id: req.id, ...session.relift(req.budget) });
          return;
        case 'release':
          session.release();
          reply({ kind: 'released', id: req.id });
          return;
        default:
          reply(failure((req as { id?: number }).id ?? -1, 'protocol'));
      }
    } catch (e) {
      reply(toFailure(req?.id ?? -1, e));
    }
  })();
};
