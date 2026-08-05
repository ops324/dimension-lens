/**
 * **文言が `copy.ts` の外へ漏れていないことを、機械で見張る。**
 *
 * Phase 1b までの文言は 5 ファイル・25 か所以上に散っていた。散っていること自体より
 * 悪かったのは、`ingest.test.ts` の 5 件が `notes.join()` の**部分一致**で採点していた
 * ことである ── `protocol.ts` が「`message` を読んで分岐してはいけない。文言は UI の
 * もので、分岐は `code` のもの」と書いたその規律を、製品コードではなくテストが破っていた。
 *
 * 1c で `message` を廃し、`notes` を `noteIds` にし、文言を `copy.ts` へ集めた。
 * **集めただけでは元に戻る**ので、戻れないようにする。
 *
 * ## なぜ grep ではなく TypeScript の scanner なのか
 *
 * 正規表現で日本語を探すと**コメントが全部引っかかる**。この作品はコメントが
 * 実装より長いので、それでは道具にならない。`ts.createSourceFile` で構文木にすると
 * **コメントはトークンに含まれない**ので、文字列リテラルだけを正確に取れる。
 * `typescript` は既に devDependency にあり、新しい依存は増えない。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  CAPABILITY_NOTE_COPY,
  DEGENERATE_COPY,
  FAILURE_COPY,
  failureDetailLine,
  type EmptyState,
} from '../copy';
import { RESPONSE_KINDS } from '../ingest/protocol';

const SRC = join(__dirname, '..');
const JAPANESE = /[぀-ゟ゠-ヿ一-龯]/;

/**
 * 規律が掛かる範囲。**全 `src/` ではない。**
 *
 * `main.ts` の `console.info` や `capture.ts` の自己検査メッセージは**開発者向け**で、
 * 利用者に見せる文ではない。そこまで `copy.ts` に集めると、
 * 「利用者に見せる文言」という `copy.ts` の意味がぼやける。
 * だから**利用者へ到達しうる層だけ**を対象にする ── 取り込み（失敗が空状態になる）と
 * UI（そのまま画面に出る）。範囲を明示していることが、この検査の主張の一部である。
 */
const GUARDED_DIRS = ['ingest', 'ui'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 文字列リテラル（テンプレートを含む）だけを集める。**コメントは入らない** */
function japaneseStringLiterals(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node)
      || ts.isTemplateTail(node)
    ) {
      if (JAPANESE.test(node.text)) found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('文言が copy.ts の外に無い', () => {
  /**
   * 歯の確認: `decode.ts` に日本語の文字列リテラルを 1 本戻すと、この 1 件が落ちる
   * （Phase 1c で実際に戻して確認した）。
   *
   * **初回実行で 5 件を捕まえた**（`vendor.test.ts` や `privacy.test.ts` と同じで、
   * この種の検査は最初に走らせた瞬間に元が取れる）:
   * `plan.ts` の `RangeError` が 2 本、`specimenSource.ts` の内部エラーが 3 本。
   * どれも**開発者向けの例外**で、利用者に見せる文ではないので ASCII に直した ──
   * `IngestError` の `message` に掛けたのと同じ規律である。
   */
  it.each(GUARDED_DIRS)('src/%s/ に日本語の文字列リテラルが無い', (dir) => {
    const offenders: string[] = [];
    for (const file of walk(join(SRC, dir))) {
      for (const s of japaneseStringLiterals(file)) {
        offenders.push(`${file.slice(SRC.length + 1)}: ${JSON.stringify(s)}`);
      }
    }
    expect(
      offenders,
      `文言は src/copy.ts にだけ置く。見つかった箇所:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  /** 逆向き ── `copy.ts` に**日本語が実在する**こと。空にして緑になっては意味がない */
  it('copy.ts には日本語がある(空の器で緑にならない)', () => {
    const found = japaneseStringLiterals(join(SRC, 'copy.ts'));
    expect(found.length).toBeGreaterThan(20);
  });
});

describe('copy.ts の網羅と形', () => {
  /**
   * 全射は `satisfies Record<IngestFailureCode, EmptyState>` が **tsc に**見せている
   * （欠落 TS1360 / 余剰 TS2353 の**両方向**。`AssertNever` は欠落しか見ない）。
   * ここが見るのは実行時の形のほう。
   */
  const entries: [string, EmptyState][] = Object.entries(FAILURE_COPY);

  it('失敗コードごとに title / body / action の 3 つが揃っている', () => {
    expect(entries.length).toBe(10);
    for (const [code, state] of entries) {
      for (const key of ['title', 'body', 'action'] as const) {
        expect(typeof state[key], `${code}.${key}`).toBe('string');
        expect(state[key].length, `${code}.${key} が空`).toBeGreaterThan(0);
      }
    }
  });

  /**
   * **葉はすべて `string` 定数**である ── 関数リーフを禁じることで、
   * 実行時の補間そのものが存在しえなくなる。画像由来の値が文言へ流れ込む経路が、
   * `failureDetailLine` ただ 1 本に絞られる。
   */
  it('葉に関数が無い(実行時補間の入口を 1 本に絞る)', () => {
    for (const table of [FAILURE_COPY, DEGENERATE_COPY]) {
      for (const state of Object.values(table)) {
        for (const v of Object.values(state)) expect(typeof v).toBe('string');
      }
    }
    for (const v of Object.values(CAPABILITY_NOTE_COPY)) expect(typeof v).toBe('string');
  });

  /**
   * 空状態は「何が起きたか」だけでなく「**次に何ができるか**」を言う。
   * `action` を必須にしてあるのはそのためで、実際に空でないことを見る。
   */
  it('すべての空状態が、利用者の取れる行動を書いている', () => {
    for (const [code, state] of entries) {
      expect(state.action.length, `${code} の action が短すぎる`).toBeGreaterThan(8);
    }
    for (const [kind, state] of Object.entries(DEGENERATE_COPY)) {
      expect(state.action.length, `${kind} の action が短すぎる`).toBeGreaterThan(8);
    }
  });

  /**
   * `failureDetailLine` は **`FailureDetail` しか受け取れない**（葉は数値と閉じた union）。
   * ここでは全 `kind` が文を返すことだけを見る ── 網羅は `switch` の `never` が tsc に見せる。
   */
  it('detail の全 kind が文になる', () => {
    expect(failureDetailLine({ kind: 'pixels', width: 10000, height: 9000 })).toContain('10000');
    expect(failureDetailLine({ kind: 'format', format: 'heif' }).length).toBeGreaterThan(0);
    expect(
      failureDetailLine({ kind: 'gamut', requested: 'srgb', actual: 'display-p3' }),
    ).toContain('display-p3');
  });

  /** HEIC の案内は「変換ツールを探せ」ではなく、iPhone 利用者が実際に取れる行動である */
  it('HEIC の案内が Safari と iPhone の設定に触れている', () => {
    const heic = FAILURE_COPY['unsupported-format'];
    expect(heic.action).toContain('Safari');
    expect(heic.action).toContain('互換性優先');
  });

  /** 応答 kind の一覧は protocol 側の関心。ここでは copy と混ざっていないことだけ見る */
  it('copy は応答 kind に依存していない', () => {
    for (const kind of RESPONSE_KINDS) {
      expect(Object.keys(FAILURE_COPY)).not.toContain(kind);
    }
  });
});
