/**
 * DIMENSION-LENS 起動点。
 *
 * Phase 0 の時点では three もキャンバスも登場しない ── ここにあるのは
 * 「CI のゲートと、測る道具と、公開経路が揃っている」ことの確認だけである。
 * 空ページが Pages に出ているのは失敗ではなく、Phase 1a の最初のコミットから
 * 品質ゲートが効いている状態を先に作った、ということ。
 */

import { installDevHook } from './dev/hook';

// Phase 1a でシーンが実装を渡すまで、各メソッドは呼ばれたら投げる。
// 「まだ測れない」を黙って通さないための空実装。
installDevHook({});

/**
 * 起動印。**本番ビルドでも消えない副作用**であることに意味がある。
 *
 * これを置かないと Phase 0 のエントリは丸ごと tree-shake され、vite は
 * <script type="module"> ごと出力から落とす ── つまり
 * 「自前の JS が `script-src 'self'` の下で実際に読めるか」を一度も検証しないまま
 * 「公開経路が揃った」と言うことになる。Phase 0 の到達判定はまさにそこなので、
 * 検証可能な最小の痕跡を残す。
 *
 * Phase 1a で実際の起動処理が入ったら、この行は消してよい。
 */
document.documentElement.dataset.lens = 'booted';

if (import.meta.env.DEV) {
  console.info('[LENS] Phase 0 — 骨組みのみ。window.__LENS__ は形だけ用意されている。');
}
