/**
 * 取り込み worker のメッセージ契約。**純粋な型と純関数だけ。**
 *
 * ここに DOM も worker も呼ばない ── そうしておくと `protocol.test.ts` が node で
 * `structuredClone(msg, { transfer })` を実際に走らせて、
 * 「転送し忘れ」と「複製できない値の混入」を**本当に落とせる**。
 *
 * ## 転送リストを型から外に出さない理由
 *
 * `postMessage(msg)` は転送リストを忘れても**動いてしまう**。動いたうえで
 * 32MB の構造化複製が走るだけなので、症状は「なんとなく重い」であって例外ではない
 * (実測: 32MB の往復が転送 11.4ms に対し複製 53.6ms)。
 * だから転送リストは呼び出し側の注意力に置かず、`transferablesOf()` という
 * **応答の形から決まる関数**にする。kind を足して書き忘れると
 * `_AllResponseKindsListed` が tsc を落とす。
 */

import type { GridSpec } from '../image/grid';
import type { BlockScales, ImageStats } from '../image/stats';
import type { CapabilityReport } from './capabilities';
import type { ResizePlan } from './plan';

/** 契約を壊す変更をしたら上げる。worker とメインでズレたら `failed/protocol` を返す */
export const INGEST_PROTOCOL_VERSION = 2;

/**
 * 入力の色域。**4 箇所（csc / canvas / getImageData / Canonical）に散っていた
 * リテラルを、この 1 つの型へ集約する**（Phase 1c）。§4.13 を参照。
 */
export type Gamut = 'srgb' | 'display-p3';

// ---------------------------------------------------------------- 要求

export interface CapabilitiesRequest {
  readonly kind: 'capabilities';
  readonly id: number;
}

export interface IngestRequest {
  readonly kind: 'ingest';
  readonly id: number;
  /** ユーザーのファイル、または標本 No.0 をエンコードしたもの */
  readonly source: Blob;
  /** 正準バッファの長辺上限(`MAX_CANONICAL_EDGE`)。**上限であって目標ではない** */
  readonly maxEdge: number;
  /** 格子の点数予算(`TIER_BUDGET`) */
  readonly budget: number;
  /** 板(Phase 1a-iii のテクスチャ源)を一緒に返すか */
  readonly wantPlate: boolean;
}

/**
 * 正準バッファは worker に**残したまま**、格子だけ引き直す。
 *
 * ティア変更のたびに再デコードしないためにあるのではない ── 再デコードしないのは当然で、
 * 本題は**正準バッファをメインへ渡さない**ことのほう。渡してしまうと
 * `lift`(実測 14.7ms) と `computeStats`(35.5ms) がメインスレッドに固定される。
 */
export interface ReliftRequest {
  readonly kind: 'relift';
  readonly id: number;
  readonly budget: number;
}

export interface ReleaseRequest {
  readonly kind: 'release';
  readonly id: number;
}

export type IngestClientMessage =
  | CapabilitiesRequest
  | IngestRequest
  | ReliftRequest
  | ReleaseRequest;

// ---------------------------------------------------------------- 応答

/** 取り込みの出自と寸法。**読み出し欄(Phase 3)がそのまま出せる粒度で持つ** */
export interface IngestMeta {
  readonly protocolVersion: number;
  /** デコード直後(＝EXIF の向きが適用された後)の寸法 */
  readonly decodedWidth: number;
  readonly decodedHeight: number;
  /** 正準バッファの寸法 */
  readonly width: number;
  readonly height: number;
  readonly plan: ResizePlan;
  readonly gamut: Gamut;
  /**
   * デコーダが EXIF の向きを適用したか。**この値は推測ではなく probe の実測**
   * (`orientProbe.ts`)。`'not-applied'` のとき、この画像は横倒しで出ている可能性がある。
   */
  readonly orientation: OrientationSupport;
  /** 縮小をデコーダにやらせたか、canvas に落ちたか。Safari 検出の実効側 */
  readonly resizePath: 'decoder' | 'canvas' | 'none';
  readonly timings: IngestTimings;
}

export interface IngestTimings {
  readonly decodeMs: number;
  readonly resizeMs: number;
  readonly readbackMs: number;
  readonly linearizeMs: number;
  readonly statsMs: number;
  readonly liftMs: number;
  readonly totalMs: number;
}

export type OrientationSupport = 'applied' | 'not-applied' | 'unknown';

export interface CapabilitiesResponse {
  readonly kind: 'capabilities';
  readonly id: number;
  readonly report: CapabilityReport;
}

export interface IngestedResponse {
  readonly kind: 'ingested';
  readonly id: number;
  readonly meta: IngestMeta;
  readonly stats: ImageStats;
  readonly scales: BlockScales;
  readonly grid: GridSpec;
  /** 5 f32/点 */
  readonly base: Float32Array;
  /** 3 f32/点、リニア光 */
  readonly colors: Float32Array;
  readonly maxNorm: number;
  /** `safeDist(maxNorm)`。**worker が計算して渡す** ── §4.9 の配線忘れを構造で塞ぐ */
  readonly safeDist: number;
  /**
   * 板のテクスチャ源。`transferToImageBitmap()` の結果を**転送**で渡す(ゼロコピー)。
   * これが無いと Phase 1a-iii が同じ画像をもう一度デコードすることになる。
   */
  readonly plate: ImageBitmap | null;
}

export interface LiftedResponse {
  readonly kind: 'lifted';
  readonly id: number;
  readonly grid: GridSpec;
  readonly base: Float32Array;
  readonly colors: Float32Array;
  readonly maxNorm: number;
  readonly safeDist: number;
  readonly liftMs: number;
}

export interface ReleasedResponse {
  readonly kind: 'released';
  readonly id: number;
}

/**
 * 失敗の分類。**文言は `copy.ts` のもので、分岐は `code` のもの。**
 *
 * Phase 1b までは `FailedResponse` が自由文字列の `message` を運んでいた。
 * それは規律であって保証ではない ──「画像の中身を入れない」がコメントにしか無く、
 * 呼び出し側が任意の文字列を組める限り、いつ破れても誰も気づかない。
 * **Phase 1c で `message` を廃止し、`code` + 構造化 `detail` にした**ので、
 * 文字列を組む場所は `copy.ts` ただ 1 つになった（`copyGuard.test.ts` が機械で見張る）。
 */
export type IngestFailureCode =
  | 'empty-source'
  | 'decode-failed'
  /** デコーダが読めない既知の形式（HEIC ほか）。`decode-failed` から分けた（§4.19） */
  | 'unsupported-format'
  | 'too-many-pixels'
  | 'no-2d-context'
  /** 機能検出が「このブラウザでは取り込めない」と言った。1b までは `decode-failed` だった */
  | 'unsupported-browser'
  /** 要求した色域と `getImageData` が返した色域が食い違った（§4.13 の 4 箇所の突き合わせ） */
  | 'gamut-mismatch'
  | 'no-session'
  | 'protocol'
  | 'internal';

/**
 * 失敗に添える構造化された詳細。
 *
 * **葉は数値か、この protocol が宣言した閉じた union だけ**である。
 * 自由文字列を置かないことが「画像の中身が文言へ流れ込む経路が構造的に無い」の中身で、
 * これは規律ではなく型で守られている（`copy.ts` は `FailureDetail` しか受け取れない）。
 */
export type FailureDetail =
  | { readonly kind: 'pixels'; readonly width: number; readonly height: number }
  | { readonly kind: 'format'; readonly format: UnsupportedFormatId }
  | { readonly kind: 'gamut'; readonly requested: Gamut; readonly actual: Gamut | 'unknown' };

/**
 * デコードできなかった既知の形式。**4 バイトの box brand を、そのまま運ばずに
 * この閉じた集合へ畳んでから渡す** ── ファイル由来のバイト列を文言側へ渡さないため。
 */
export type UnsupportedFormatId = 'heif';

export interface FailedResponse {
  readonly kind: 'failed';
  readonly id: number;
  readonly code: IngestFailureCode;
  /** 数値と閉じた union だけ。文言は `copy.ts` が `code` と合わせて作る */
  readonly detail?: FailureDetail;
}

export type IngestWorkerMessage =
  | CapabilitiesResponse
  | IngestedResponse
  | LiftedResponse
  | ReleasedResponse
  | FailedResponse;

export type ResponseKind = IngestWorkerMessage['kind'];

/** 実行時に列挙したい場面(テスト・網羅チェック)のための一覧 */
export const RESPONSE_KINDS = [
  'capabilities',
  'ingested',
  'lifted',
  'released',
  'failed',
] as const;

type AssertNever<T extends never> = T;
/**
 * `RESPONSE_KINDS` が応答の union を覆っていることを **tsc に見せる**。
 * kind を足して一覧に書き忘れると `npm run build` が落ちる ──
 * 「転送リストを書き忘れても動いてしまう」を型で塞ぐ側の半分。
 */
export type _AllResponseKindsListed = AssertNever<
  Exclude<ResponseKind, (typeof RESPONSE_KINDS)[number]>
>;

/**
 * 応答から転送リストを**導出する**。呼び出し側は書かない。
 *
 * `ArrayBuffer` を渡した時点で送信側は detach される(byteLength が 0 になる)。
 * これは事故ではなく仕様で、`protocol.test.ts` がその detach を実際に観測している。
 */
export function transferablesOf(res: IngestWorkerMessage): Transferable[] {
  switch (res.kind) {
    case 'ingested': {
      const list: Transferable[] = [
        res.stats.columnMeans.buffer as ArrayBuffer,
        res.base.buffer as ArrayBuffer,
        res.colors.buffer as ArrayBuffer,
      ];
      if (res.plate) list.push(res.plate);
      return list;
    }
    case 'lifted':
      return [res.base.buffer as ArrayBuffer, res.colors.buffer as ArrayBuffer];
    case 'capabilities':
    case 'released':
    case 'failed':
      return [];
  }
}

/**
 * 分類つきの失敗。**`throw new Error()` を使わない** ── worker 境界を越えると
 * スタックも型も落ちるので、越える前に `code` へ畳んでおく。
 *
 * `Error.message` は**開発者がコンソールで読むための ASCII の技術文**であって、
 * 利用者に見せる文ではない（利用者向けは `copy.ts`）。ここに日本語を書くと、
 * 「文言が 2 か所にある」状態が復活する ── `copyGuard.test.ts` が落とす。
 */
export class IngestError extends Error {
  readonly code: IngestFailureCode;
  readonly detail?: FailureDetail;
  constructor(code: IngestFailureCode, detail?: FailureDetail) {
    super(`ingest failed: ${code}${detail ? ` ${JSON.stringify(detail)}` : ''}`);
    this.name = 'IngestError';
    this.code = code;
    this.detail = detail;
  }
}

export function isFailure(res: IngestWorkerMessage): res is FailedResponse {
  return res.kind === 'failed';
}

/** 失敗応答を作る唯一の入口。例外オブジェクトの中身をそのまま流さない */
export function failure(
  id: number,
  code: IngestFailureCode,
  detail?: FailureDetail,
): FailedResponse {
  return detail ? { kind: 'failed', id, code, detail } : { kind: 'failed', id, code };
}
