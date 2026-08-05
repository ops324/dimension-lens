/**
 * **利用者に見せる文言の全文。** この作品で日本語の文字列リテラルを持ってよい唯一の場所。
 *
 * ## なぜ UI（Phase 3）より先に置くのか
 *
 * 1b までの文言は **5 ファイル・25 か所以上**に散っていた ── `decode.ts` の
 * `IngestError` に 6 本、`session.ts` に 3 本、`capabilities.ts` の `notes.push` に 6 本、
 * `main.ts` に 5 本、`index.html` に 4 本。そして `ingest.test.ts` の 5 件は
 * **`notes.join()` の部分一致**で採点していた ── つまり純関数テストが「判断」ではなく
 * **「文言」を検査していた**。`protocol.ts` が「`message` を読んで分岐してはいけない」と
 * 書いたその規律を、製品コードではなくテストのほうが破っていた。
 *
 * だから 1c が確定させるのは**散文ではなく器**である:
 *
 *  - `satisfies Record<IngestFailureCode, EmptyState>` —— コードを 1 つ足すと `tsc` が落ちる
 *    （欠落は TS1360、余剰は TS2353。`AssertNever` と違って**両方向**を見る）
 *  - `notes: string[]` → `noteIds: CapabilityNoteId[]` —— 判断と文言を分ける。
 *    テストは `toContain('exif-not-applied')` を見るようになり、文言を書き換えても落ちない
 *  - **葉はすべて `string` 定数**。実行時の文字列補間は `failureDetailLine` ただ 1 本で、
 *    その入力は `FailureDetail`（葉が数値と閉じた union だけ）である ──
 *    **画像の中身が文言へ流れ込む経路が、型として存在しない**
 *
 * `copyGuard.test.ts` が「このファイルと `src/tests/` 以外に日本語の**文字列リテラル**が
 * 無い」ことを TypeScript の scanner で見張る（コメントはトークンに含まれないので誤検出しない）。
 *
 * ## 散文そのものはまだ C
 *
 * 器は A（`tsc` と `copyGuard` が採点する）だが、**文面が読みやすいかは未検証**である。
 * 表示面は 1c では `#ui` の 1 段落だけで、書体も配置も Phase 3。
 * 「一度も画面に出たことのない日本語が 25 本、テストは緑」を避けるために最小の面は持たせた。
 */

import type { CapabilityNoteId } from './ingest/capabilities';
import type { FailureDetail, IngestFailureCode } from './ingest/protocol';

/**
 * 空状態の 1 枚。**3 つとも必須**にしてある ──
 * `action` を省略可能にすると「何が起きたか」だけ書いて
 * 「次に何ができるか」を書かない空状態が量産される。
 */
export interface EmptyState {
  /** 見出し。何が起きたか */
  readonly title: string;
  /** 説明。なぜ起きたか */
  readonly body: string;
  /** **利用者が実際に取れる行動。** 取れない行動を書かない */
  readonly action: string;
}

/**
 * 失敗コード → 空状態。**`satisfies` なので過不足があると `npm run build` が落ちる。**
 *
 * 到達可能性は一様ではない（Phase 1c の実測。Chromium 148 / :5173）:
 *
 * | code | 実入力から到達するか |
 * |---|---|
 * | `empty-source` | ✅ 0 バイトの Blob |
 * | `decode-failed` | ✅ ゴミ / テキスト / 切断 JPEG / SVG |
 * | `unsupported-format` | ✅ 本物の HEIC（Chrome のみ。Safari では成功する） |
 * | `too-many-pixels` | ✅ 10000×9000 |
 * | `no-2d-context` / `unsupported-browser` / `gamut-mismatch` / `no-session` / `protocol` / `internal` | ❌ この環境では到達しない |
 *
 * **到達しないコードにも文言を置く。** 置かないと、到達した日に空白が出る。
 */
export const FAILURE_COPY = {
  'empty-source': {
    title: 'ファイルが空です',
    body: '中身が 0 バイトでした。転送の途中で切れたか、まだ書き込みが終わっていない可能性があります。',
    action: 'もう一度、別のファイルを選んでみてください。',
  },
  'decode-failed': {
    title: 'この画像を読めませんでした',
    body: '画像として解釈できませんでした。壊れているか、画像ではないファイルかもしれません。',
    action: 'JPEG または PNG のファイルを選んでみてください。',
  },
  /**
   * **「HEIC を JPEG に変換してください」とは書かない。**
   *
   * iOS では HEIC が Safari で読める（実測: Safari 18.6 で 64×48 が返る）。
   * つまり iPhone から直接この作品を開いた人は、そもそもここへ来ない。
   * ここへ来るのは「iPhone で撮った写真を Mac / Windows へ移して、Chrome で開いた」人である。
   * 案内の宛先が違うので、**その人が実際に取れる行動**を 3 つ書く。
   * 「変換ツールを探してください」は取れない行動なので書かない。
   */
  'unsupported-format': {
    title: 'この形式（HEIC）は、いまお使いのブラウザが読めません',
    body: 'HEIC は iPhone の標準的な写真形式ですが、Chrome や Edge はこの形式を読めません。Safari では読めます。',
    action:
      '同じ写真を Safari で開くのが一番早い方法です。'
      + ' これから撮る写真を JPEG にするなら、iPhone の「設定 → カメラ → フォーマット → 互換性優先」。'
      + ' すでにある写真は、「写真」アプリから AirDrop やメールで送ると JPEG になります。',
  },
  'too-many-pixels': {
    title: 'この画像は大きすぎます',
    body: '画素数が上限を超えています。ブラウザが途中で力尽きる前に、こちらでお断りしています。',
    action: '書き出しの解像度を下げるか、別の写真を選んでください。',
  },
  'no-2d-context': {
    title: '画像を読み取る準備ができませんでした',
    body: 'ブラウザが 2D の描画面を用意できませんでした。メモリ不足か、開いているタブが多すぎるときに起きます。',
    action: '他のタブを閉じてから、ページを再読み込みしてください。',
  },
  'unsupported-browser': {
    title: 'このブラウザでは画像を読み込めません',
    body: '画像の取り込みに必要な機能が、このブラウザには見つかりませんでした。',
    action: '最新の Safari・Chrome・Firefox のいずれかでお試しください。',
  },
  /**
   * §4.13 の 4 箇所（`colorSpaceConversion` / canvas / `getImageData` / `Canonical.gamut`）が
   * 食い違ったときにだけ出る。**黙って色相が誤るより、止まって言うほうを選んだ。**
   */
  'gamut-mismatch': {
    title: '色の扱いが想定と違いました',
    body: 'ブラウザが返した色空間が、こちらが要求したものと違っています。このまま進めると、色相が正しく表示できません。',
    action: 'ページを再読み込みしてください。それでも同じなら、別のブラウザでお試しください。',
  },
  'no-session': {
    title: 'まだ画像がありません',
    body: '画像が読み込まれていない状態で、描き直しが要求されました。',
    action: '画像を選び直してください。',
  },
  'protocol': {
    title: '内部の受け渡しで食い違いが起きました',
    body: '画面側と処理側で、やり取りの約束が一致していません。更新の直後に、古い部品が残っていると起きます。',
    action: 'ページを再読み込みしてください。',
  },
  'internal': {
    title: '想定していない問題が起きました',
    body: '取り込みの途中で、こちらが分類できていない失敗が起きました。',
    action: 'ページを再読み込みしてください。同じ写真で必ず起きるようでしたら、その写真の形式と大きさをお知らせください。',
  },
} satisfies Record<IngestFailureCode, EmptyState>;

/**
 * 詳細の 1 行。**唯一の実行時の文字列補間**である。
 *
 * 入力 `FailureDetail` の葉は**数値と閉じた union だけ**なので、
 * ここへ画像の中身が流れ込む経路は型として存在しない（`protocol.ts` を参照）。
 * `switch` は網羅されており、`kind` を足すと `tsc` が `never` で落ちる。
 */
export function failureDetailLine(detail: FailureDetail): string {
  switch (detail.kind) {
    case 'pixels':
      return `この画像は ${detail.width} × ${detail.height} 画素でした。`;
    case 'format':
      return detail.format === 'heif' ? 'ファイルの先頭が HEIF 形式だと言っています。' : '';
    case 'gamut':
      return `要求した色空間は ${detail.requested}、実際に返ってきたのは ${detail.actual} でした。`;
  }
}

/**
 * 機能検出の注記。**`capabilities.ts` は ID だけを返し、文言はここにある。**
 *
 * 1b までは `notes.push('このブラウザは EXIF の向きを…')` と直接書いており、
 * `ingest.test.ts` の 5 件が日本語の部分一致で採点していた。
 */
export const CAPABILITY_NOTE_COPY = {
  'no-create-image-bitmap': 'このブラウザには画像のデコード機能（createImageBitmap）がありません。取り込みできません。',
  'no-2d-context': '2D の描画面を用意できませんでした。取り込みできません。',
  'resize-ignored': 'デコーダの縮小指定が無視されました（例外は出ていません）。縮小はこちら側で行います。',
  'no-offscreen-canvas': 'OffscreenCanvas がないため、取り込みは画面と同じスレッドで行います。',
  'exif-not-applied':
    'このブラウザは EXIF の向きを適用しません。縦向きで撮った写真が横倒しで出ることがあります。',
  'exif-unknown': 'EXIF の向きの扱いを検証できませんでした。',
  'image-data-color-space-unexpected':
    'ブラウザが sRGB 以外の色空間を返しています。この作品は sRGB として扱います。',
} satisfies Record<CapabilityNoteId, string>;

/**
 * 退化入力の表明（SPEC §2.2）。
 *
 * 「幅が閾値未満のブロックは**その軸は存在しないと表明する**」の、表明にあたる部分。
 * これは回避策ではなく、この作品にとって最も正直な出力である。
 *
 * **実測（Phase 1c）**: 完全グレースケール画像では `dimLevel` を 3 → 5 まで動かしても
 * **画素が 1 ビットも変わらない**（65,536 画素中 0 個が相違）。
 * 理由は彩度スケールが退化時に厳密 1 へ置かれ、`a', b'` が 1e-16 のままだから。
 * つまり黙って壊れるのではなく**黙って何も起きない** ── だから言葉で表明する。
 */
export const DEGENERATE_COPY = {
  chroma: {
    title: 'この画像には色の軸がありません',
    body: 'すべての画素がほぼ無彩色（グレー）でした。色相を回す 4 番目・5 番目の軸は、この画像では動かせません。',
    action: '色のある写真を選ぶと、5 つの軸すべてが使えます。',
  },
  lightness: {
    title: 'この画像には明るさの軸がありません',
    body: '画像全体がほぼ同じ明るさでした。明暗を起伏に変える 3 番目の軸は、この画像では動かせません。',
    action: '明暗のある写真を選ぶと、起伏が立ち上がります。',
  },
  both: {
    title: 'この画像には色も明るさの幅もありません',
    body: '単色に近い画像です。持ち上げられる軸は縦と横の 2 つだけで、上の 3 軸は動かせません。',
    action: '別の写真を選んでください。',
  },
} satisfies Record<'chroma' | 'lightness' | 'both', EmptyState>;
