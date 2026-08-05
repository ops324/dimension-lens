/**
 * 空状態の**表示面**。Phase 1c はこれ 1 枚だけ持つ。
 *
 * ## なぜ UI が Phase 3 なのに、いま面を持つのか
 *
 * `copy.ts` を書いても表示する場所が無ければ、**一度も画面に出たことのない日本語が
 * 25 本、テストは緑**という状態になる ── SPEC §8 が自前回転について
 * 「必要が確認されないまま書くと、テストは緑・実機は未検証の死にコードになる」と
 * 書いたのと、まったく同じ形である。文言も同じ規律に掛ける。
 *
 * だから最小の面を持たせる。**書体も配置も Phase 3** で、ここが約束するのは
 * 「文字列が DOM に到達すること」までである（`data-lens-empty` が機械の観測点）。
 *
 * 文字列は**すべて `copy.ts` から来る**。このファイルに日本語のリテラルは無く、
 * `copyGuard.test.ts` がそれを見張っている。
 */

import { DEGENERATE_COPY, FAILURE_COPY, failureDetailLine, type EmptyState } from '../copy';
import type { FailureDetail, IngestFailureCode } from '../ingest/protocol';

/** 表示先。無ければ何もしない（テストや headless で落とさない） */
function mount(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById('ui');
}

/**
 * `textContent` だけを使う。**`innerHTML` を使わない** ──
 * `copy.ts` の文字列は自分たちが書いたものだが、`innerHTML` を 1 か所でも許すと
 * 「文言だから安全」という判断が経路に入り込む。CSP の `style-src 'unsafe-inline'` を
 * 唯一の妥協点として数えている作品で、2 つ目を作らない。
 */
function render(host: HTMLElement, state: EmptyState, detail?: string): void {
  host.replaceChildren();
  const box = document.createElement('div');
  box.className = 'lens-empty';
  for (const [cls, text] of [
    ['lens-empty__title', state.title],
    ['lens-empty__body', state.body],
    ['lens-empty__action', state.action],
    ...(detail ? [['lens-empty__detail', detail] as const] : []),
  ] as const) {
    if (!text) continue;
    const el = document.createElement('p');
    el.className = cls;
    el.textContent = text;
    box.appendChild(el);
  }
  host.appendChild(box);
}

/**
 * 取り込みの失敗を出す。
 *
 * `data-lens-empty` は**本番ビルドでも消えない痕跡**である（`__LENS__` は DEV にしか
 * 載らないので、公開ページで空状態を観測する手段が他に無い。§7.3 の
 * `data-lens-ingest` / `data-lens-capture` / `data-lens-render` と同じ役割）。
 */
export function showFailure(code: IngestFailureCode, detail?: FailureDetail): void {
  const host = mount();
  if (!host) return;
  document.documentElement.dataset.lensEmpty = code;
  render(host, FAILURE_COPY[code], detail ? failureDetailLine(detail) : undefined);
}

/**
 * 退化の表明（SPEC §2.2）。**失敗ではない** ── 画像は正しく読めていて、
 * 動かせない軸があることを言っている。だから `data-lens-empty` ではなく別の属性にする。
 */
export function showDegenerate(kind: 'chroma' | 'lightness' | 'both' | null): void {
  const host = mount();
  if (!host) return;
  if (!kind) {
    delete document.documentElement.dataset.lensDegenerate;
    host.replaceChildren();
    return;
  }
  document.documentElement.dataset.lensDegenerate = kind;
  render(host, DEGENERATE_COPY[kind]);
}

/** 取り込みが成功したときに前の空状態を消す。**消し忘れると前の失敗が残り続ける** */
export function clearEmptyState(): void {
  const host = mount();
  if (!host) return;
  delete document.documentElement.dataset.lensEmpty;
  delete document.documentElement.dataset.lensDegenerate;
  host.replaceChildren();
}
