/**
 * 角度ユーティリティ。
 *
 * `rotation.ts` に置かないのは SPEC §5 の契約による ── あちらは VERBATIM を保つ限り
 * 親の 35 テストがそのまま回帰ロックとして効き、1 行足せばその継承が切れる。
 * `vendor.test.ts` が機械で見ている。
 */

const TAU = Math.PI * 2;

/**
 * 角度を **(−π, π]** へ畳む。区間の開閉はここで確定させる ──
 * θ = π を含み θ = −π を含まない。`wrapPi(-Math.PI) === Math.PI`。
 *
 * 色相不変性テスト(A2)が `|wrapPi(Δ − θ)| ≤ 1e-12` を主張するので、
 * 端点の扱いは許容誤差より内側の問題になる。曖昧なままにしない。
 */
export function wrapPi(a: number): number {
  if (!Number.isFinite(a)) return a;
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  else if (x <= -Math.PI) x += TAU;
  return x;
}

/** hypot の 2 引数版(Math.hypot は可変長のため遅い実装がある) */
export function hypot2(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}
