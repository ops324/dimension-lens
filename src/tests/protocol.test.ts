/**
 * worker のメッセージ契約。
 *
 * ── なぜ node でテストできるのか、そして何をテストしていないのか
 *
 * `protocol.ts` は DOM も `postMessage` も呼ばない純粋な型と関数なので、
 * node の `structuredClone(msg, { transfer })` が **`postMessage` と同じ
 * 構造化複製アルゴリズム**を走らせてくれる。だからここで落とせるのは:
 *
 *   - 転送リストを渡したときに送信側が本当に detach されること
 *   - **渡さなかったときに黙って複製されること**(＝症状が例外ではなく「重い」であること)
 *   - 複製できない値が混ざったら `DataCloneError` になること
 *
 * 落とせないのは worker の起動・`ImageBitmap`・`OffscreenCanvas` で、
 * それらは node に存在しない。**存在しないものを stub して緑にすると、
 * このファイルは「常に緑」の飾りになる** ので、境界のほうを機械で見張る
 * (`ingest.test.ts` の「node にはこれらが無い」節)。
 */

import { describe, expect, it } from 'vitest';
import {
  failure,
  IngestError,
  INGEST_PROTOCOL_VERSION,
  isFailure,
  RESPONSE_KINDS,
  transferablesOf,
  type IngestWorkerMessage,
  type IngestedResponse,
} from '../ingest/protocol';
import { linearizeRgba } from '../image/linearize';
import { computeScales, computeStats } from '../image/stats';
import { makeSpecimen0 } from '../image/fixture';

/**
 * 板の代役。node に `ImageBitmap` は無いので、**転送リストに載るかどうか**だけを見る
 * センチネルを置く（`transferablesOf` は `res.plate` を真偽で見て push するだけ）。
 *
 * これが無かったために、`if (res.plate) list.push(res.plate)` を**丸ごと削除しても
 * 276 件が緑のまま**だった（Phase 1c で実測）── §4.14 の
 * 「板も同じ経路で返す。入れておかないと 1a-iii が同じ画像をもう一度デコードする」が、
 * 板を一度も通さないテストに守られていた。
 */
function plateSentinel(): ImageBitmap {
  return { width: 4, height: 4, close() {} } as unknown as ImageBitmap;
}

function sampleIngested(plate: ImageBitmap | null = null): IngestedResponse {
  const s = makeSpecimen0();
  const canonical = linearizeRgba(s.rgba, s.width, s.height);
  const stats = computeStats(canonical);
  const scales = computeScales(stats);
  const grid = { cols: 8, rows: 5 };
  const count = grid.cols * grid.rows;
  return {
    kind: 'ingested',
    id: 7,
    meta: {
      protocolVersion: INGEST_PROTOCOL_VERSION,
      decodedWidth: s.width,
      decodedHeight: s.height,
      width: s.width,
      height: s.height,
      plan: { width: s.width, height: s.height, resized: false },
      gamut: 'srgb',
      orientation: 'applied',
      resizePath: 'none',
      timings: {
        decodeMs: 1,
        resizeMs: 0,
        readbackMs: 1,
        linearizeMs: 1,
        statsMs: 1,
        liftMs: 1,
        totalMs: 5,
      },
    },
    stats,
    scales,
    grid,
    base: new Float32Array(count * 5).fill(0.5),
    colors: new Float32Array(count * 3).fill(0.25),
    maxNorm: 1.5074,
    safeDist: 3.316,
    plate,
  };
}

describe('取り込みプロトコル', () => {
  it('応答の kind 一覧が重複なく揃っている', () => {
    expect(new Set(RESPONSE_KINDS).size).toBe(RESPONSE_KINDS.length);
    // union の網羅は `_AllResponseKindsListed` が tsc に見せている(npm run build)。
    // ここでは実行時に列挙したい側だけを固定する。
    expect([...RESPONSE_KINDS].sort()).toEqual(
      ['capabilities', 'failed', 'ingested', 'lifted', 'released'],
    );
  });

  it('transferablesOf は応答の形から転送リストを導出する', () => {
    const res = sampleIngested();
    const list = transferablesOf(res);
    expect(list).toHaveLength(3);
    expect(list).toContain(res.stats.columnMeans.buffer);
    expect(list).toContain(res.base.buffer);
    expect(list).toContain(res.colors.buffer);

    expect(transferablesOf(failure(1, 'internal'))).toHaveLength(0);
    expect(transferablesOf({ kind: 'released', id: 1 })).toHaveLength(0);
    expect(
      transferablesOf({
        kind: 'lifted',
        id: 1,
        grid: { cols: 2, rows: 2 },
        base: new Float32Array(20),
        colors: new Float32Array(12),
        maxNorm: 1,
        safeDist: 2.4,
        liftMs: 0,
      }),
    ).toHaveLength(2);
  });

  /**
   * **板は転送リストに載らなければならない。**（Phase 1c で足した歯）
   *
   * 載せ忘れると 3.0MB の `ImageBitmap` が構造化複製になる ── 症状は例外ではなく
   * 「なんとなく重い」で、`base` / `colors` を忘れたときとまったく同じ形である。
   */
  it('板があれば転送リストに載り、無ければ載らない', () => {
    const withPlate = sampleIngested(plateSentinel());
    const list = transferablesOf(withPlate);
    expect(list).toHaveLength(4);
    expect(list).toContain(withPlate.plate);

    expect(transferablesOf(sampleIngested(null))).toHaveLength(3);
  });

  it('転送すると送信側のバッファが detach される(所有権が移る)', () => {
    const res = sampleIngested();
    const bytesBefore = res.base.byteLength;
    expect(bytesBefore).toBeGreaterThan(0);

    const clone = structuredClone(res, { transfer: transferablesOf(res) });

    // 受け取り側には中身がある
    expect(clone.base.byteLength).toBe(bytesBefore);
    expect(clone.base[0]).toBeCloseTo(0.5, 6);
    expect(clone.stats.columnMeans.length).toBe(res.meta.width * 3);
    // 送信側は空になっている ── これが「所有権が移った」の観測可能な形
    expect(res.base.buffer.byteLength).toBe(0);
    expect(res.colors.buffer.byteLength).toBe(0);
  });

  /**
   * **転送リストを忘れても動いてしまう**ことを、テストとして固定しておく。
   *
   * 忘れたときの症状は例外ではなく「なんとなく重い」である(実測: 32MB の往復が
   * 転送 11.4ms に対し複製 53.6ms)。だから注意力ではなく `transferablesOf` に置いた。
   */
  it('転送リストを渡さないと黙って複製される(落ちない)', () => {
    const res = sampleIngested();
    const before = res.base.buffer.byteLength;
    const clone = structuredClone(res);
    expect(clone.base[0]).toBeCloseTo(0.5, 6);
    expect(res.base.buffer.byteLength).toBe(before); // detach されない = 複製された
  });

  it('複製できない値が混ざると DataCloneError で落ちる', () => {
    const bad = { ...failure(1, 'internal'), onDone: () => 0 };
    expect(() => structuredClone(bad)).toThrow(/DataCloneError|could not be cloned/i);
  });

  it('失敗は code で分岐でき、応答に自由文字列を持たない', () => {
    const f = failure(3, 'too-many-pixels', { kind: 'pixels', width: 99999, height: 99999 });
    expect(isFailure(f)).toBe(true);
    expect(f.code).toBe('too-many-pixels');
    const ok: IngestWorkerMessage = { kind: 'released', id: 3 };
    expect(isFailure(ok)).toBe(false);
  });

  /**
   * **Phase 1c で `message` を廃止した。**「画像の中身を文言に入れない」は
   * 1b までコメントにしか無く、呼び出し側が任意の文字列を組める限り保証ではなかった。
   * いま応答が運べるのは `code` と、葉が数値・閉じた union だけの `detail` である。
   */
  it('失敗応答は文字列の葉を 1 つも持たない（code と detail のほかに）', () => {
    const cases = [
      failure(1, 'internal'),
      failure(2, 'too-many-pixels', { kind: 'pixels', width: 10000, height: 9000 }),
      failure(3, 'unsupported-format', { kind: 'format', format: 'heif' }),
      failure(4, 'gamut-mismatch', { kind: 'gamut', requested: 'srgb', actual: 'display-p3' }),
    ];
    for (const f of cases) {
      expect(f).not.toHaveProperty('message');
      for (const [k, v] of Object.entries(f)) {
        if (k === 'kind' || k === 'code') continue;
        if (k === 'detail') {
          // detail の葉は数値か、protocol が宣言した閉じた union の値だけ
          for (const [dk, dv] of Object.entries(v as Record<string, unknown>)) {
            if (dk === 'kind') continue;
            const ok = typeof dv === 'number'
              || dv === 'heif' || dv === 'srgb' || dv === 'display-p3' || dv === 'unknown';
            expect(ok, `detail.${dk} = ${String(dv)}`).toBe(true);
          }
          continue;
        }
        expect(typeof v, `${k} は文字列であってはならない`).not.toBe('string');
      }
    }
  });

  it('IngestError は worker 境界の手前で code へ畳まれている', () => {
    const e = new IngestError('decode-failed');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('IngestError');
    expect(e.code).toBe('decode-failed');
    // 境界を越えると Error のままでは型もスタックも落ちるので、応答へ写す
    const f = failure(9, e.code, e.detail);
    expect(structuredClone(f)).toEqual(f);
  });

  it('detail は例外から応答まで往復しても値が変わらない', () => {
    const e = new IngestError('unsupported-format', { kind: 'format', format: 'heif' });
    const f = failure(1, e.code, e.detail);
    expect(structuredClone(f)).toEqual(f);
    expect(f.detail).toEqual({ kind: 'format', format: 'heif' });
  });

  /**
   * **Phase 1c で 1 → 2 に上げた。** 契約を 2 か所壊しているため:
   * (1) `FailedResponse.message` を廃止し `detail` にした、
   * (2) `IngestFailureCode` に 3 つ（`unsupported-format` / `unsupported-browser` /
   * `gamut-mismatch`）足した。worker とメインでズレたら `failed/protocol` が返る。
   */
  it('プロトコル版が固定されている', () => {
    expect(INGEST_PROTOCOL_VERSION).toBe(2);
  });
});
