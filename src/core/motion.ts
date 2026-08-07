/**
 * 光過敏の配慮（`prefers-reduced-motion: reduce`）の**唯一の源**（Phase 2b）。
 *
 * ## Phase 2a までの実装は 1 画素も変えていなかった
 *
 * 実装は `render/postfx.ts` に 1 行あるだけだった:
 *
 * ```ts
 * const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
 * setTime(t) { if (reduceMotion) return; gradeTime.value = t; }
 * ```
 *
 * これが握っていたのは `gradePass` の `uTime`（グレインのアニメーション）だけで、
 * **`gradePass` は出荷時 `enabled = false`** である（1a-iii の忠実性ラダーは後処理ゼロが基準）。
 * つまり配慮を有効にしても**フレームバッファは 1 ビットも変わらなかった**。
 *
 * この作品で自動的に動いているのは `advancePhases` による位相の漂流だけで、
 * **そこには門が無かった**。「未計測」ではなく **偽の主張**である ──
 * 未計測は「まだ測っていない」だが、これは「実装したつもりで実装していない」で、
 * 前者は正直な空白、後者は嘘になる。
 *
 * → 判定をここへ 1 つだけ置き、`lensScene`（回転）と `postfx`（グレイン）の
 * **両方**へ配る。そして `scripts/ladder.mjs` が**両側から**見張る ──
 * オンで画素が動かないこと、**オフで動くこと**。後者が無いと
 * 「常に止まっている実装」でも緑になる。
 */

/** メディアクエリ。**文字列をここ以外に書かない** */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** `matchMedia` の返す物のうち、この作品が使う分だけ */
export interface MotionQuery {
  readonly matches: boolean;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
}

/**
 * 判定の**純関数側**。`null` / `undefined`（`matchMedia` が無い環境）は `false`。
 *
 * **`false` を返すのは「配慮しない」ではなく「配慮を要求されていない」である。**
 * 環境が答えられないときに安全側へ倒して常に配慮すると、
 * 作品が動かない状態が既定になり、しかも誰も気づかない（ラダーの片側だけが緑になる）。
 */
export function decideReducedMotion(query: MotionQuery | null | undefined): boolean {
  return query?.matches ?? false;
}

/** 実行時に問い合わせる。node では `matchMedia` が無いので常に `false` */
export function reducedMotionQuery(): MotionQuery | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(REDUCED_MOTION_QUERY);
}

/**
 * 現在値を返し、変化を購読する。返り値は購読解除。
 *
 * **設定は途中で変わる**（macOS の「視差効果を減らす」は再読み込みを要求しない）。
 * 起動時に 1 回だけ読む実装は、設定を変えた人にとっては何も起きないのと同じである。
 */
export function observeReducedMotion(onChange: (reduced: boolean) => void): () => void {
  const q = reducedMotionQuery();
  onChange(decideReducedMotion(q));
  if (!q?.addEventListener) return () => undefined;
  const listener = (): void => onChange(decideReducedMotion(q));
  q.addEventListener('change', listener);
  return () => q.removeEventListener?.('change', listener);
}
