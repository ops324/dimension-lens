#!/usr/bin/env node
/**
 * **歯の確認を、規律から仕組みへ。** `npm run teeth`
 *
 * ## なぜ要るのか
 *
 * SPEC §8 は「テストには歯を付ける ──『実際に壊して落ちることを確かめた』項目を
 * PR に書く」を要求しているが、**その確認は毎フェーズ手で書き捨てられていた**
 * （監査が「`MessageChannel` の計測器がリポジトリに無い」と指摘したのと同じ型。
 * 測定器も検査手順も、書き捨てると次のフェーズで再現できない）。
 *
 * そして手作業には**片側にしか効かない**という欠陥がある:
 *
 * - 予算を**厳しすぎる**方に外すと、テストが落ちて気づく（Phase 1c で 2 回踏んだ）
 * - 予算を**緩すぎる**方に外すと、**永久に緑のまま**気づかない
 *
 * 緩い方こそ危険なのに、そちらは人間には見えない。見える形にする唯一の方法は
 * 「守っているはずのものを壊して、本当に落ちるか」を機械が毎回試すことである。
 * §7.1 の `reconstructMean`（分子と分母が同時に動いて落ちない）も、
 * §7.7 の `fillRatios`（`fitDistance` の逆関数で恒等に潰れる）も、
 * **この 1 本があれば発見が何フェーズも早かった。**
 *
 * ## 何を主張するか
 *
 * 各変異について「**少なくとも 1 件のテストが落ちる**」ことと、
 * **落ちた件数が台帳の `observed` を下回らない**ことを hard gate にする。
 *
 * ## 「減ったら警告だけ」は Phase 2c-viii で撤回した（実測で決めた）
 *
 * 2b からここは「件数が減るのはテストが恒等に潰れ始めた早期兆候だが、リファクタで
 * 正当に減ることもあるので**落とさずに出す**」と書いていた。**その設計に穴が在る。**
 *
 * 実演（2c-viii・独立監査が発見し、こちらでも再現した）── `survival.test.ts` の
 * `CASES` から 2 枚目の標本を消す。あの行に付いているコメントは
 * 「**2c-iv の教訓: 標本を 1 枚しか通さない測定は「測った」と書けない**」である:
 *
 * ```
 * 削除前: npm test 431 緑 / teeth『2c-iv』→ 4 件・噛んだ 1     EXIT=0
 * 削除後: npm test 430 緑 / teeth『2c-iv』→ 3 件・弱った 1     EXIT=0  ← CI は緑
 * ```
 *
 * **教訓そのものを撤回しても、7 点の品質ゲートが 1 つも赤くならない。**
 * 警告は CI のログに 1 行出るだけで、終了コードは 0 だった。
 *
 * → `failed < observed` を**落ちる**ようにした。正当なリファクタで減った場合の道は
 * 塞いでいない ── **その PR の中で `observed` を下げる**（差分に出るので査読で見える）。
 * 「ログの 1 行」と「台帳の差分」の違いがこの変更の全部である。
 * **人が数字を下げれば通る形なのは認める**（§7.10 の型 1 と同じ弱点）。
 * 変えたのは通りやすさではなく、**通った跡が残るかどうか**である。
 *
 * ## この道具が**止められないもの**（Phase 2c-ix・独立監査が 13 経路を実演した）
 *
 * **7 本が通った。** どれも「台帳か門そのものを編集する」形である:
 *
 * | 経路 | 何が通るか |
 * |---|---|
 * | 総和を保ったまま片方を下げる | 実測へ「締めた」ぶんを別の歯から抜く（**上の締めで原資は消した**） |
 * | 名前を残して中身を入れ替える | 同じファイル内なら本数・総和・id・ハッシュが全部動かない |
 * | `0.2` を `0.21` にした近似複製 | 内容が違うので別の変異になる（`KNEE` の 0.2 と 0.9 は実際に別の歯） |
 * | ラチェットを `MUTATIONS.length` から導出する | 恒真になる |
 * | `process.exit(1)` を `0` にする | **メッセージを表示したまま** EXIT=0 |
 * | 3 つの数を素直に下げる | 作者が認めている道（差分に出る） |
 * | 台帳の外の掃引を狭める | `EXPECTED_POINT_SET_SIZES` に無い名前は 1 ビットも見ていない |
 *
 * **同じコミットの中では閉じない。** 門の `exit(1)` 自体が編集対象である以上、
 * repo 内のどんな数字も、その数字を読むコードごと書き換えられる。
 *
 * **閉じる形は在る ── 権威をコミットの外へ出すこと。** 監査が実演した:
 * 同じ木を **その PR 自身の台帳**で回すと EXIT=0、**前の版の台帳**で回すと
 * `弱った 1 / EXIT=1`。これ 1 つで上の 7 本のうち 5 本が同時に閉じる。
 * **2c-ix では実装していない**（CI の走行が 2 倍になり、squash した履歴で
 * 「前の版」が一意でない）。SPEC §8 の終端条件に、選ばなかった理由ごと書いた。
 *
 * ## 復元は git ではなく**メモリから**行う
 *
 * 手作業では `git checkout -- <file>` で戻していたが、**未コミットの変更があると
 * それは復元ではなく破壊になる**（実際に作業を消した）。ここでは元の中身を
 * メモリに持ってから書き換え、`finally` で書き戻す。git を一切使わないので、
 * 作業ツリーが汚れていても**壊すものが無い**。
 * 最後に全ファイルが元と 1 バイト違わないことを検査してから終了する。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 変異一覧。**「この行を壊したら、どのテストが落ちるべきか」の台帳である。**
 *
 * `observed` は Phase 1c 時点で実際に落ちた件数（すべて手で確認した）。
 * 新しい歯を足したら、ここに 1 行足す ── **PR 本文に「壊して確かめた」と書く代わりに、
 * ここへ書く。** そうすると次のフェーズが同じ確認を無料で再実行できる。
 */
const MUTATIONS = [
  // ---- Phase 2b で足した歯 ----
  //
  // **`src/render/postfx.ts` は変異させない。** `vendor.test.ts` が sha256 で丸ごと
  // 固定しているので、あのファイルの 1 文字を変えれば必ず何かが落ちる ──
  // つまり「bloom の閾値を守る歯」ではなく「移植ファイルが書き換わったことを検出する歯」に
  // なってしまう（`x/x` の一種）。だから 2b は定数を `core/bloom.ts` /
  // `core/compress.ts` へ出し、そちらを壊す。
  { phase: '2b', name: 'bloom の閾値を d=0 の平均色の下へ下げる（G9 の測定点が bloom の内側へ入る）', observed: 3,
    file: 'src/core/bloom.ts',
    find: 'export const BLOOM_BASE_THRESHOLD = 0.28;',
    replace: 'export const BLOOM_BASE_THRESHOLD = 0.26;' },
  { phase: '2b', name: '輝度の重みを等分に取り違える（別の量に対する柵になる）', observed: 2,
    file: 'src/core/bloom.ts',
    find: 'export const LUMA_WEIGHTS: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];',
    replace: 'export const LUMA_WEIGHTS: readonly [number, number, number] = [1 / 3, 1 / 3, 1 / 3];' },
  { phase: '2b', name: 'ニーを平均色の下へ動かす（錨が後処理で動きうる位置へ）', observed: 6,
    file: 'src/core/compress.ts',
    find: 'export const COMPRESS_KNEE = 0.8;', replace: 'export const COMPRESS_KNEE = 0.2;' },
  { phase: '2b', name: '圧縮の強度から門を外す（アンカー窓で圧縮が立ち上がる）', observed: 2,
    file: 'src/core/compress.ts',
    find: '  return rotationGate(dimLevel) * COMPRESS_MAX_STRENGTH;',
    replace: '  return COMPRESS_MAX_STRENGTH;' },
  // ---- Phase 2c で差し替えた歯 ----
  //
  // 旧: `PEAK_MARGIN = 1.25` を 1.0 にする。定数ごと消えたので置き換える。
  // 2b の設計（実測の包絡に余裕を掛けて強度を逆算する）は、余裕を何倍にしても
  // 上限 `knee + 1/s` が 1 を超えるためクリップを消せない ── その設計へ**戻す**変異を
  // 歯にする。`compress.test.ts` の「1/(1−knee) である」と half-float 全域の 2 本が噛む。
  { phase: '2c', name: '強度を「設計峰からの逆算」へ戻す（有限の峰では上限が 1 を超える）', observed: 6,
    file: 'src/core/compress.ts',
    find: 'export const COMPRESS_MAX_STRENGTH = 1 / (1 - COMPRESS_KNEE);',
    replace: 'export const COMPRESS_MAX_STRENGTH = strengthForPeak(MEASURED_PEAK_ENVELOPE * 1.25);' },
  // ニーの値そのもの。2b までこれを留めるテストが 1 本も無く、「代償を記録する」つもりの
  // テストが副作用で ±0.15% だけ固定していた（監査が逆算）。2c で独立した柵を置いた。
  { phase: '2c', name: 'ニーを 0.9 へ動かす（2b では 11 本すべてが素通しした変異）', observed: 3,
    file: 'src/core/compress.ts',
    find: 'export const COMPRESS_KNEE = 0.8;', replace: 'export const COMPRESS_KNEE = 0.9;' },

  // ---- Phase 2c-ii（フレーミングの位相包絡）----
  //
  // 包絡は「絵を良くする」ためではなく「構図を経過時間の関数でなくする」ために在る。
  // 配線を外しても `framingEnvelope.ts` の単体テストは全部緑のままなので、
  // **配線そのものを見る歯**が要る（`framingEnvelope.test.ts` の「1800 フレーム」）。
  { phase: '2c', name: '包絡を配線から外す（構図がまた経過時間の関数へ戻る）', observed: 5,
    file: 'src/scene/lensScene.ts',
    find: '    const framed = unionSpread(spread, target);',
    replace: '    const framed = unionSpread(spread, spread);' },
  // 門を外すと、板の重み 0.9976 のところでカメラが 2.41 倍跳ぶ ── 写真が突然 41% に縮む
  { phase: '2c', name: '包絡から門を外す（窓の縁で写真が突然縮む）', observed: 3,
    file: 'src/scene/lensScene.ts',
    find: '    const g = cloudW > 1 ? 1 : cloudW;',
    replace: '    const g = 1;' },
  // 掃く位相を減らすと包絡が包絡でなくなる（掃いていない位相が外へ出る）
  { phase: '2c', name: '掃く位相を 4096 → 16 に減らす（包絡が包絡でなくなる）', observed: 5,
    file: 'src/core/framingEnvelope.ts',
    find: 'export const ENVELOPE_PHASES = 4096;',
    replace: 'export const ENVELOPE_PHASES = 16;' },

  // ---- Phase 2c-iv（包絡の引き直しが止まる経路）----
  //
  // 2c-ii は引き直しを `if (dimChanged)` で囲っていた。`layout()` は `positions` 無しで
  // `updateCamera(true)` を呼ぶので `cloudVisible === false` の枝で包絡を 0 にし、
  // 直後の `update()` は `dimLevel` が動いていないので**二度と引き直さない**。
  // `relayout()` は `engine.onResize` に配線されているので、**リサイズ 1 回で必ず踏む**。
  // 実測（`d = 3` / 988×778）: 6.869252 → 直後 2.558621 → 300 秒かけて 6.044646。
  //
  // **既存の「600 フレーム回しても動かない」はこれを捕まえなかった** ── `setDimLevel` の
  // あとに `layout()` を一度も呼ばないからである。噛むのは 2c-iv で足した 1 本だけになる。
  { phase: '2c-iv', name: '包絡の引き直しに `dimChanged` の門を戻す（resize 1 回で包絡が消える）', observed: 4,
    file: 'src/scene/lensScene.ts',
    find: '      this.lastEnvelope = envelopeFor(',
    replace: '      if (dimChanged) this.lastEnvelope = envelopeFor(' },

  // ---- Phase 2c-vii（掃引と標本を広げる機構）----
  //
  // **機構にも歯を付ける。** `widen.test.ts` / `specimen.test.ts` が「広げたから見えた」と
  // 言っているものを、実装側から消してみて、本当にそれを見ているかを確かめる。
  //
  // **`widen.test.ts` の掃引そのもの（刻み・反復数）はここでは変異させない** ──
  // 台帳が書き換えるのは `src/` の実装であって、テストの掃引を狭めて赤くなるのを見ても
  // 「テストがテストを検出した」にしかならない（`vendor.test.ts` の sha256 と同じ型）。
  // 掃引が狭まったことの検出は `EXPECTED_SWEEPS`（国勢調査）が引き受ける。
  // **ホールドの単調性を外す。** 傾斜帯でホールドが育つのは `framingHold` が
  // 単調非減少だからで、そこを外すと帯の後退が消える（＝ 呼吸に戻る）。
  //
  // 当初ここには「`const g = 1;`（包絡を門で入れるのをやめる）」を置いたが、
  // **それは 2c の「包絡から門を外す」と file / find / replace が 1 文字も違わない複製**
  // だった ── 歯の本数を 49 → 53 に見せかけるだけで、新しく守るものが無い。差し替えた。
  //
  // **2c-vii はここに「台帳の本数はラチェットなので」と書いたが、それは偽だった**
  // （Phase 2c-viii・独立監査が全走査で確認）── ラチェットはこの repo のどこにも
  // 無く、台帳から変異を削っても何も赤くならなかった。**確かめずに書いた肯定形**である。
  // いまは下の `EXPECTED_MUTATIONS` が実際にラチェットになっている。
  //
  // そしてこの 1 本は `observed` を持っていなかった ── **`observed` を 22/53 から
  // 補完した当の 2c-vii が、自分で足した変異にだけ付け忘れていた。** 実測して埋めた。
  { phase: '2c-vii', name: 'ホールドの単調性を外す（傾斜帯の後退が消えて呼吸に戻る）', observed: 1,
    file: 'src/core/fit.ts',
    find: '  return need > previous ? need : previous;',
    replace: '  return need;' },
  { phase: '2c-vii', name: '位相の掃きを 1 本にする（包絡が位相 0 の値へ戻る = 2c-i が落とした偽）', observed: 7,
    file: 'src/core/framingEnvelope.ts',
    find: 'export const ENVELOPE_PHASES = 4096;',
    replace: 'export const ENVELOPE_PHASES = 1;' },
  { phase: '2c-vii', name: '門の傾斜幅を潰す（窓の外がいきなり全開になる = 帯が消える）', observed: 5,
    file: 'src/render/rotationSchedule.ts',
    find: 'export const GATE_RAMP = 0.35;',
    replace: 'export const GATE_RAMP = 1e-6;' },
  { phase: '2c-vii', name: '畳みを止めて格子の行数を深度から切り離す（n ≤ 512 の標本依存が消える）', observed: 1,
    file: 'src/image/columnLine.ts',
    find: '  const n = Math.round(extentX * max);\n  return n < 1 ? 1 : n > max ? max : n;',
    replace: '  return max > 512 ? 512 : max;' },

  // ---- Phase 2c-viii（主張の後退を止める）----
  //
  // **台帳で唯一、テストそのものを壊す変異である。** 他の 53 本は `src/` の実装を壊して
  // 「テストが落ちるか」を見るが、この 1 本が守っているのは**テストの幅**のほうで、
  // だから壊す対象がテストになる。
  //
  // 消す 2 行に付いているコメントは「**2c-iv の教訓: 標本を 1 枚しか通さない測定は
  // 「測った」と書けない**」── つまりこの変異は、記録された教訓の撤回そのものである。
  // 2c-vii までは、これが `npm test` 緑・`npm run teeth` EXIT=0 で通った
  // （歯は 4 → 3 に落ちるが `weaker` は警告どまりだった）。いまは 2 か所で止まる:
  // `widen.test.ts` の点集合の台帳と、`teeth.mjs` の `failed < observed`。
  { phase: '2c-viii', name: '標本を 1 枚へ戻す（2c-iv の教訓の撤回・掃引の幅が縮む）', observed: 1,
    file: 'src/tests/survival.test.ts',
    find: "  // **退化した画像も通す**（2c-iv の教訓: 標本を 1 枚しか通さない測定は「測った」と書けない）\n  ['グレースケール / BALANCED', makeGrayscaleRamp(), 'BALANCED'],\n",
    replace: '' },

  // ---- Phase 2c-ix（doc の数を関数で再現する台帳）----
  //
  // **台帳が doc の**テキスト**を読んでいることを、doc を壊して確かめる。**
  // 期待値を台帳の側に書いた瞬間（`expected: fn(args)`）、doc の数を全置換しても緑になる ──
  // 独立監査がその経路を実演した。ここが噛まないなら、台帳は doc を読んでいない。
  { phase: '2c-ix', name: 'doc の表の数を 1 つ書き換える（台帳が doc を読んでいるかの確認）', observed: 1,
    file: 'src/image/halfFloat.ts',
    find: ' * | 512 | 0.205200 | **−4.94%** |',
    replace: ' * | 512 | 0.205300 | **−4.94%** |' },
  // 実装の側。階段の丸めを 1 つ落とすと停止表が再現しなくなる
  { phase: '2c-ix', name: '飽和天井の丸めを切り下げにする（2048·δ 以上でなくなる）', observed: 2,
    file: 'src/image/halfFloat.ts',
    find: '  return Math.pow(2, Math.ceil(Math.log2(2048 * delta)));',
    replace: '  return Math.pow(2, Math.floor(Math.log2(2048 * delta)));' },
  // **被覆検査の歯。** 除外表から 1 行消すと「台帳 ∪ 除外表 ⊇ 全表」が破れる。
  // 台帳の 54 本のうちテストを壊す 2 本目だが、守っているのが**被覆そのもの**なので、
  // 壊す対象がテストになるのは 2c-viii の 1 本と同じ理由である。
  { phase: '2c-ix', name: '除外表から 1 行消す（被覆検査 ── 表を足しても黙って通る形へ戻す）', observed: 1,
    file: 'src/tests/docLedger.test.ts',
    find: "  { file: 'src/copy.ts', table: 1, head: 'code | 実入力から到達するか', kind: 'non-numeric', why: 'エラーコードが実入力から到達するかの ✅/❌。数が無い' },\n",
    replace: '' },

  // ---- Phase 2c-x（格子 y 軸の畳み）----
  //
  // **この 3 本は独立監査 C が実演した経路そのものである。** 2c-x を書く前の状態では、
  // 「畳みを書いたが `rows' ≡ rows`」という**偽の実装**が今日の出荷とビット一致し
  // （位置 0 / 2,677,944 要素・`stats()` 0 / 364 値が相違）、`npm test` 447 件・
  // 台帳 57 本・`ladder --structural` が**全部緑のまま通った**。
  // つまり畳みは、歯を足さないかぎり 1 つも守られない。

  // (1) 畳みそのもの。外すと No.0 系 12 セル（6 標本 × 3 ティアのうち）が 512 超へ戻る
  { phase: '2c-x', name: '格子の y を畳まない（`n ≤ 512` が標本 12/18 セルで破れる）', observed: 3,
    file: 'src/image/grid.ts',
    find: '  const n = Math.round(extentY * max);\n  if (n < 1) return 1;',
    replace: '  const n = max;\n  if (n < 1) return 1;' },

  // (2) `rows/2` の柵。外すと帯が 1 行しか含まない範囲まで畳み、畳みが間引きになる。
  // 実測（実 GPU・標本 No.0・HIGH）: `d ≥ 1.55` で ΔE00 最大 19.449・灯った画素の 1.9% が
  // 予算 3.0 超。**しかも深度はそこでは 28 で、畳む利得はゼロである。**
  { phase: '2c-x', name: '帯が 1 行になっても畳む（畳みが間引きへ変わる範囲を開ける）', observed: 1,
    file: 'src/image/grid.ts',
    find: '  return 2 * n > max ? max : n;',
    replace: '  return n;' },

  // (3) **`spacingY` の入れ忘れ。** 監査 C がいちばん重い穴として実演した経路で、
  // 雲が `1/(d−1)` 倍暗く出る（`d ∈ (1,2]` の 1039 点中 618 点で −50% 超・最悪 −90.12%）。
  // `extentY = 1` では `1 · rows / rows` が厳密 1 なので**アンカーの `x/x` は保たれ**、
  // ラダーの `G7 sampleWeight (d=2)` も `Object.is(…, 1)` で緑のまま通る。
  { phase: '2c-x', name: '潰しの補正に畳んだ間隔を渡さない（雲が最大 9.6 倍暗くなる）', observed: 1,
    file: 'src/scene/lensScene.ts',
    find: '      ? (this.extent[1] * this.source.grid.rows) / Math.max(1, this.gridRows)',
    replace: '      ? this.extent[1]' },

  // (4) **畳みが平均であること。** 帯の上端 1 行だけを採ると畳みは間引きになる。
  // 実測（独立監査 B・標本 No.0・`rows' = 1`）: 間引きは ΔE00 **49.3069**・
  // **378 点すべて**が予算 3.0 超・相対輝度誤差 288.4%。帯平均は 0.0333 / 0.1331%。
  //
  // **「リニア光で平均するか、正規化 Oklab で平均するか」には歯を置けていない。**
  // 実測では 5〜6 桁違う（Oklab 平均は ΔE00 8.2152 / 輝度誤差 30.59%）が、
  // その差を作る変異は `linearToOklab` の呼び出し位置を動かす構造変更になり、
  // `find`/`replace` の 1 対 1 では書けない。**歯が無いことを書いておく**（§7.10 の型 1）。
  { phase: '2c-x', name: '畳みの帯を 1 行にする（平均が間引きへ変わる）', observed: 1,
    file: 'src/scene/lensScene.ts',
    find: '      const y1 = Math.max((((j + 1) * rows) / ny) | 0, y0 + 1);',
    replace: '      const y1 = y0 + 1;' },

  // ---- Phase 2c-vi（配線の生存の行列）----
  //
  // 線を描いていないフレームで線バッファの最後の状態を漏らす。`rebuildLine` は `!grid` の
  // ときしか走らないので、`d = 0` を一度通ってから `d = 3` へ戻ると 1 のまま居座り、
  // 「そのフレームで実際に描いている線の点数」という説明に対して嘘になる。
  // **`survival.test.ts` がこれを 900 セル中 5 セルとして検出した変異そのものである。**
  { phase: '2c-vi', name: '描いていない線の点数を漏らす（キャッシュが観測面へ出る）', observed: 2,
    file: 'src/scene/lensScene.ts',
    find: '      linePoints: grid ? 0 : this.linePoints,',
    replace: '      linePoints: this.linePoints,' },
  { phase: '2b', name: 'fp16 の丸めを最近接に取り違える（監査のモデルへ戻す）', observed: 8,
    file: 'src/image/blendModel.ts',
    find: '  return sign * Math.min(quantize(Math.abs(value), Math.floor), F16_MAX);',
    replace: '  return sign * Math.min(quantize(Math.abs(value), Math.round), F16_MAX);' },
  { phase: '2b', name: '最近接偶数を「常に上へ」にする（ties-to-even を落とす）', observed: 2,
    file: 'src/image/blendModel.ts',
    find: '  return floor % 2 === 0 ? floor : floor + 1;',
    replace: '  return floor + 1;' },
  { phase: '2b', name: '二値ケースの暗い側を正規数にする（非正規域を問わなくなる）', observed: 2,
    file: 'src/image/blendModel.ts',
    find: '  const dark = binaryContribution(30);',
    replace: '  const dark = binaryContribution(130);' },
  { phase: '2b', name: '判定の許容を最小の分離幅より広げる（2 モデルが同時に一致する）', observed: 1,
    file: 'src/image/blendModel.ts',
    find: '  tolerance = 1e-6,', replace: '  tolerance = 1e-2,' },
  { phase: '2b', name: '光過敏の配慮が回転へ届かない（2a まで実際にこうだった）', observed: 2,
    file: 'src/scene/lensScene.ts',
    find: '    if (!this.frozen && !this.reducedMotion) advancePhases(this.phases, d, dt);',
    replace: '    if (!this.frozen) advancePhases(this.phases, d, dt);' },
  { phase: '2b', name: '配慮を測定用の凍結と共用する（測定が終わると配慮が解ける）', observed: 2,
    file: 'src/scene/lensScene.ts',
    find: '  setReducedMotion(on: boolean): void {\n    this.reducedMotion = on;\n  }',
    replace: '  setReducedMotion(on: boolean): void {\n    this.frozen = on;\n  }' },
  { phase: '2b', name: '色場 `image+mean` を恒等にする（G12 が同じ絵を 2 回測る）', observed: 1,
    file: 'src/scene/lensScene.ts',
    find: "        const base = field === 'mean' ? 0 : 1;",
    replace: "        const base = field === 'mean' ? 0 : 1; if (field !== 'mean') { dst[i] = src[i]; dst[i + 1] = src[i + 1]; dst[i + 2] = src[i + 2]; continue; }" },
  { phase: '2b', name: '色場の差し替えが位置も触る（幾何固定という前提を壊す）', observed: 1,
    file: 'src/scene/lensScene.ts',
    find: '  setColorField(mode: ColorField): void {\n    if (mode === this.colorField) return;',
    replace: '  setColorField(mode: ColorField): void {\n    this.points.positions[0] += 1e-3;\n    if (mode === this.colorField) return;' },

  // ---- Phase 2a で足した歯 ----
  //
  // G9 の −17.58% は 2 つの因子の積だった。**node で採点できるのはその「割り方」**で、
  // 実際に読める値は `npm run ladder` が実 GPU で見る。ここで守るのは前者だけである。
  { phase: '2a', name: '中心の位相を常に 0 にする（＝ 図の中心にフラグメントが在ると仮定する）', observed: 2,
    file: 'src/image/spriteGain.ts',
    find: '    return Math.abs(c - (Math.floor(c) + 0.5));',
    replace: '    return 0;' },
  { phase: '2a', name: '位相減衰を恒等にする（1c まで暗黙にそう扱っていた）', observed: 4,
    file: 'src/image/spriteGain.ts',
    find: '  const r2 = (offsetX * offsetX + offsetY * offsetY) / (spritePx * spritePx);\n  return Math.exp(-F * r2);',
    replace: '  void offsetX; void offsetY;\n  return 1;' },
  { phase: '2a', name: '位相の減衰に F を使わない（k を取り違える）', observed: 4,
    file: 'src/image/spriteGain.ts',
    find: '  return Math.exp(-F * r2);', replace: '  return Math.exp(-K_SPRITE * r2);' },
  { phase: '2a', name: '潰れた軸を畳まない（1b の挙動へ戻す = 深度 378）', observed: 1,
    file: 'src/image/columnLine.ts',
    find: '  const n = Math.round(extentX * max);\n  return n < 1 ? 1 : n > max ? max : n;',
    replace: '  return max;' },
  { phase: '2a', name: '畳んだ点数の下限を 0 にする（1 点すら描かなくなる）', observed: 2,
    file: 'src/image/columnLine.ts',
    find: '  if (!(extentX > 0)) return 1;', replace: '  if (!(extentX > 0)) return 0;' },
  { phase: '2a', name: 'half-float の非正規数を 0 に潰す（暗い列が消えたことを観測できなくする）', observed: 1,
    file: 'src/core/capture.ts',
    find: '  if (e === 0) return s * m * 2 ** -24;', replace: '  if (e === 0) return 0;' },
  { phase: '2a', name: '潰しの基準を無限格子へ戻す（アンカーの厳密 1 がティア依存に戻る）', observed: 1,
    file: 'src/image/spriteGain.ts',
    find: '    axisCoverage(c.s0x, c.refNx ?? AXIS_UNBOUNDED, c.spritePx)\n    * axisCoverage(c.s0y, c.refNy ?? AXIS_UNBOUNDED, c.spritePx);',
    replace: '    axisCoverage(c.s0x, AXIS_UNBOUNDED, c.spritePx)\n    * axisCoverage(c.s0y, AXIS_UNBOUNDED, c.spritePx);' },
  { phase: '2a', name: 'HDR 自己検査の値を 1.0 以下にする（1.0 超を区別する口の意味が消える）', observed: 1,
    file: 'src/core/capture.ts',
    find: 'export const HDR_SELFTEST_VALUE: readonly [number, number, number] = [2.5, 0.25, 0.0625];',
    replace: 'export const HDR_SELFTEST_VALUE: readonly [number, number, number] = [0.5, 0.25, 0.0625];' },

  // ---- Phase 1c で足した歯 ----
  { phase: '1c', name: 'safeDist をリテラル 2.4 に', observed: 6,
    file: 'src/ingest/session.ts',
    find: 'safeDist: safeDist(maxNorm),', replace: 'safeDist: 2.4,' },
  { phase: '1c', name: '板を転送リストから外す', observed: 1,
    file: 'src/ingest/protocol.ts',
    find: 'if (res.plate) list.push(res.plate);', replace: '' },
  { phase: '1c', name: 'probe のバイト列を 1 バイト削る', observed: 1,
    file: 'src/ingest/orientProbe.ts',
    find: 'for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);',
    replace: 'for (let i = 0; i < bin.length - 1; i++) out[i] = bin.charCodeAt(i);' },
  { phase: '1c', name: 'planResize の丸めを切り捨てに', observed: 1,
    file: 'src/ingest/plan.ts',
    find: 'Math.round(h * s)', replace: 'Math.floor(h * s)' },
  { phase: '1c', name: 'MAX_CANONICAL_PIXELS を 4 倍', observed: 1,
    file: 'src/ingest/plan.ts',
    find: 'export const MAX_CANONICAL_PIXELS = 2048 * 2048;',
    replace: 'export const MAX_CANONICAL_PIXELS = 4096 * 4096;' },
  { phase: '1c', name: 'MAX_SOURCE_PIXELS を半分に', observed: 1,
    file: 'src/ingest/plan.ts',
    find: 'export const MAX_SOURCE_PIXELS = 80_000_000;',
    replace: 'export const MAX_SOURCE_PIXELS = 41_000_000;' },
  { phase: '1c', name: 'lift の原色を srgb 固定に', observed: 1,
    file: 'src/image/lift.ts',
    find: 'const p = primariesFor(gamut);', replace: "const p = primariesFor('srgb');" },
  { phase: '1c', name: 'columnLine の原色を srgb 固定に', observed: 1,
    file: 'src/image/columnLine.ts',
    find: 'const p = primariesFor(gamut);', replace: "const p = primariesFor('srgb');" },
  { phase: '1c', name: 'computeStats の原色を srgb 固定に', observed: 1,
    file: 'src/image/stats.ts',
    find: 'const p: RgbPrimaries = primariesFor(gamut);',
    replace: "const p: RgbPrimaries = primariesFor('srgb');" },
  { phase: '1c', name: 'linearizeRgba が gamut を捨てる', observed: 3,
    file: 'src/image/linearize.ts',
    find: 'return { linear, width, height, gamut };',
    replace: "return { linear, width, height, gamut: 'srgb' };" },
  { phase: '1c', name: 'C_MIN_P95 を 10 倍', observed: 1,
    file: 'src/image/stats.ts',
    find: 'export const C_MIN_P95 = 0.002;', replace: 'export const C_MIN_P95 = 0.02;' },
  { phase: '1c', name: 'L_MIN_SPAN を 10 倍', observed: 1,
    file: 'src/image/stats.ts',
    find: 'export const L_MIN_SPAN = 0.01;', replace: 'export const L_MIN_SPAN = 0.1;' },
  { phase: '1c', name: 'axisPresence が常に全 true', observed: 3,
    file: 'src/image/stats.ts',
    find: 'return [true, true, !lightness, !chroma, !chroma];',
    replace: 'return [true, true, true, true, true];' },
  { phase: '1c', name: 'lensScene が退化を読まない', observed: 1,
    file: 'src/scene/lensScene.ts',
    find: 'this.axisPresent = axisPresence(source.scales);',
    replace: 'this.axisPresent = [true, true, true, true, true];' },
  // **Phase 2c-ii で移した。** `extent` の式は `core/framingEnvelope.ts` の `extentFor` が
  // 唯一の源になった（包絡が `lensScene` と違う図を測らないため）。台帳もそちらへ移す ──
  // 移し忘れたまま 2c-ii を走らせたら `npm run teeth` が
  // 「対象の行が見つからない」で正しく赤くなった（台帳が実装からずれることを、台帳自身が検出した）。
  { phase: '1c', name: 'extent の 0 固定を外す（退化軸が dimLevel で開く）', observed: 2,
    file: 'src/core/framingEnvelope.ts',
    find: '    if (!axisPresent[k]) { out[k] = 0; continue; }',
    replace: '    if (false) { out[k] = 0; continue; }' },
  { phase: '1c', name: 'HEIF の brand 判定を殺す', observed: 1,
    file: 'src/ingest/format.ts',
    find: "if (b0 === 0x68 && b1 === 0x65) return 'heif';", replace: 'if (false) return null;' },
  { phase: '1c', name: 'decode.ts に日本語の文言を戻す', observed: 1,
    file: 'src/ingest/decode.ts',
    find: "throw new IngestError('empty-source');",
    replace: "throw new IngestError('empty-source'); const _leak = 'ファイルが空です。'; void _leak;" },

  // ---- Phase 1b が「壊して確かめた」と PR に書いた分（台帳へ移した）----
  { phase: '1b', name: 'DEFAULT_FILL を 0.86 → 0.95', observed: 8,
    file: 'src/core/fit.ts',
    find: 'export const DEFAULT_FILL = 0.86;', replace: 'export const DEFAULT_FILL = 0.95;' },
  { phase: '1b', name: '画角の半角変換を /360 → /180', observed: 7,
    file: 'src/core/fit.ts', all: true,
    find: 'Math.PI) / 360', replace: 'Math.PI) / 180' },
  { phase: '1b', name: 'gainFor のクランプを外す', observed: 2,
    file: 'src/image/spriteGain.ts',
    find: 'const s = s0 > MIN_CALIBRATED_S0 ? s0 : MIN_CALIBRATED_S0;', replace: 'const s = s0;' },
  { phase: '1b', name: 'LINE_MAX_POINTS を 2048 に', observed: 2,
    file: 'src/image/columnLine.ts',
    find: 'export const LINE_MAX_POINTS = 512;',
    replace: 'export const LINE_MAX_POINTS = 2048;' },

  // ---- Phase 1a-iii ----
  { phase: '1a-iii', name: 'instanceCount = 1 の明示を消す', observed: 2,
    file: 'src/render/colorPointBatch.ts',
    find: 'geometry.instanceCount = 1;', replace: 'geometry.instanceCount = Infinity;' },
];

/** 色を消す。**CI は ANSI を出す** ── 下記 `failCount` の事故の原因だった */
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
function stripAnsi(s) {
  return s.replace(ANSI, '');
}

function run(cmd, args) {
  // 色は明示的に切る。出力の形が環境で変わると、それを読む側が静かに壊れる
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
  try {
    const out = execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', env });
    return { code: 0, out: stripAnsi(out) };
  } catch (e) {
    return { code: e.status ?? 1, out: stripAnsi(`${e.stdout ?? ''}${e.stderr ?? ''}`) };
  }
}

/**
 * 落ちた件数。**判定には使わない ── 報告のためだけ。**
 *
 * 初版はこれを hard gate にしていて、**CI で 22 本すべてを「抜けた」と誤報した**。
 * ローカルはパイプ越しで色が消えていたが、GitHub Actions では ANSI が付き、
 * 正規表現が一致せず件数が 0 になったためである。
 * **「壊したのに落ちなかった」と「出力を読めなかった」を、同じ 0 で表していたのが誤り。**
 * §7.2 の「測定器そのものが壊れている場合」そのもので、この道具は
 * 自分の失敗モードを 1 度踏んでから直っている。
 *
 * → **判定は vitest の終了コード**（環境に依らない）。件数は色を消してから読み、
 *   読めなければ `null` を返して「読めなかった」と表示する。
 */
function failCount(out) {
  const m = out.match(/Tests\s+(\d+)\s+failed/);
  return m ? Number(m[1]) : null;
}

/** vitest が本当にテストを走らせたか（クラッシュを「落ちた」と読み違えないため） */
function ranTests(out) {
  return /Test Files\s+\d+/.test(out) || /Tests\s+\d+/.test(out);
}

/**
 * **台帳のラチェット**（Phase 2c-viii）。
 *
 * 2c-vii は「台帳の本数はラチェットなので、複製は型 1 の再演そのものである」と
 * 書いたが、**そのラチェットは存在しなかった** ── 独立監査が repo を全走査して
 * 期待本数のリテラルが 0 件であることを確認し、台帳から変異を削っても何も
 * 赤くならないことを実演した。**確かめずに書いた肯定形**だった。
 *
 * これは**人が数字を下げれば通る**形である（§7.10 の型 1 の弱点そのもの）。
 * それでも置く理由は、いまが「**削除の検出が皆無**」だからで、
 * 0 から 1 への差は、1 から 2 への差より大きい。
 *
 * **この数を上げるときは、複製でないことを確かめること** ── file / find / replace の
 * 3 つ組が既存と一致する変異は、本数だけ増やして守るものを増やさない。
 * 下の重複検査が機械で見る。
 */
const EXPECTED_MUTATIONS = 61;

if (MUTATIONS.length < EXPECTED_MUTATIONS) {
  console.error(
    `台帳の変異が ${MUTATIONS.length} 本しかない（${EXPECTED_MUTATIONS} 本あったはず）。`
      + '\n歯を消すのは主張の撤回である。消すなら EXPECTED_MUTATIONS も同じ PR で下げること。',
  );
  process.exit(1);
}

/** 変異の安定した鍵。**新しいフィールドを足さない** ── 台帳の行そのものから作る */
const idOf = (m) => `${m.phase} / ${m.name} → ${m.file}`;

/**
 * **歯の名簿**（Phase 2c-ix）。`EXPECTED_MUTATIONS` は**本数**しか見ない。
 *
 * 実演（2c-ix・独立監査が後退経路を mirror で走らせて見つけた 2 つのうちの 1 つ）──
 * **変異を 1 本消して、別の 1 本を足せば本数は 54 のまま**である。消したのが
 * 2c-vi が実バグ（`linePoints` のキャッシュ漏れ）を捕まえた歯で、足したのが
 * `find` を既存の部分文字列にした近似複製だと、**下の複製検査も本数のラチェットも
 * 何も言わない**。全走行 EXIT=0 のまま歯が 1 本消える。
 *
 * → **消えたことが名前で差分に出る**ようにする。`- '2c-vi / 描いていない線の…'` は
 * 「54 が 54 のまま」より読める。**人が名前を消せば通るのは変わらない**（§7.10 の型 1）。
 * 変えたのは通りやすさではなく、**通った跡が査読に出るかどうか**である。
 *
 * **id に `file` を含めるのは、名前だけ残して中身を入れ替える経路のため**（2c-ix・監査が実演）。
 * `phase` と `name` を据え置いたまま `find`/`replace` を別の行へ差し替えると、
 * 本数も総和も id も内容ハッシュも動かないのに、**名前が嘘になる**。
 * `file` を含めればファイルを跨ぐ差し替えは差分に出る ──
 * **同じファイルの中での差し替えは、いまも止まらない。**
 * 「その名前がその変異を表しているか」は機械の判定できることではない。
 */
const EXPECTED_IDS = [
  '2b / bloom の閾値を d=0 の平均色の下へ下げる（G9 の測定点が bloom の内側へ入る） → src/core/bloom.ts',
  '2b / 輝度の重みを等分に取り違える（別の量に対する柵になる） → src/core/bloom.ts',
  '2b / ニーを平均色の下へ動かす（錨が後処理で動きうる位置へ） → src/core/compress.ts',
  '2b / 圧縮の強度から門を外す（アンカー窓で圧縮が立ち上がる） → src/core/compress.ts',
  '2c / 強度を「設計峰からの逆算」へ戻す（有限の峰では上限が 1 を超える） → src/core/compress.ts',
  '2c / ニーを 0.9 へ動かす（2b では 11 本すべてが素通しした変異） → src/core/compress.ts',
  '2c / 包絡を配線から外す（構図がまた経過時間の関数へ戻る） → src/scene/lensScene.ts',
  '2c / 包絡から門を外す（窓の縁で写真が突然縮む） → src/scene/lensScene.ts',
  '2c / 掃く位相を 4096 → 16 に減らす（包絡が包絡でなくなる） → src/core/framingEnvelope.ts',
  '2c-iv / 包絡の引き直しに `dimChanged` の門を戻す（resize 1 回で包絡が消える） → src/scene/lensScene.ts',
  '2c-vii / ホールドの単調性を外す（傾斜帯の後退が消えて呼吸に戻る） → src/core/fit.ts',
  '2c-vii / 位相の掃きを 1 本にする（包絡が位相 0 の値へ戻る = 2c-i が落とした偽） → src/core/framingEnvelope.ts',
  '2c-vii / 門の傾斜幅を潰す（窓の外がいきなり全開になる = 帯が消える） → src/render/rotationSchedule.ts',
  '2c-vii / 畳みを止めて格子の行数を深度から切り離す（n ≤ 512 の標本依存が消える） → src/image/columnLine.ts',
  '2c-viii / 標本を 1 枚へ戻す（2c-iv の教訓の撤回・掃引の幅が縮む） → src/tests/survival.test.ts',
  '2c-ix / doc の表の数を 1 つ書き換える（台帳が doc を読んでいるかの確認） → src/image/halfFloat.ts',
  '2c-ix / 飽和天井の丸めを切り下げにする（2048·δ 以上でなくなる） → src/image/halfFloat.ts',
  '2c-ix / 除外表から 1 行消す（被覆検査 ── 表を足しても黙って通る形へ戻す） → src/tests/docLedger.test.ts',
  '2c-x / 格子の y を畳まない（`n ≤ 512` が標本 12/18 セルで破れる） → src/image/grid.ts',
  '2c-x / 帯が 1 行になっても畳む（畳みが間引きへ変わる範囲を開ける） → src/image/grid.ts',
  '2c-x / 潰しの補正に畳んだ間隔を渡さない（雲が最大 9.6 倍暗くなる） → src/scene/lensScene.ts',
  '2c-x / 畳みの帯を 1 行にする（平均が間引きへ変わる） → src/scene/lensScene.ts',
  '2c-vi / 描いていない線の点数を漏らす（キャッシュが観測面へ出る） → src/scene/lensScene.ts',
  '2b / fp16 の丸めを最近接に取り違える（監査のモデルへ戻す） → src/image/blendModel.ts',
  '2b / 最近接偶数を「常に上へ」にする（ties-to-even を落とす） → src/image/blendModel.ts',
  '2b / 二値ケースの暗い側を正規数にする（非正規域を問わなくなる） → src/image/blendModel.ts',
  '2b / 判定の許容を最小の分離幅より広げる（2 モデルが同時に一致する） → src/image/blendModel.ts',
  '2b / 光過敏の配慮が回転へ届かない（2a まで実際にこうだった） → src/scene/lensScene.ts',
  '2b / 配慮を測定用の凍結と共用する（測定が終わると配慮が解ける） → src/scene/lensScene.ts',
  '2b / 色場 `image+mean` を恒等にする（G12 が同じ絵を 2 回測る） → src/scene/lensScene.ts',
  '2b / 色場の差し替えが位置も触る（幾何固定という前提を壊す） → src/scene/lensScene.ts',
  '2a / 中心の位相を常に 0 にする（＝ 図の中心にフラグメントが在ると仮定する） → src/image/spriteGain.ts',
  '2a / 位相減衰を恒等にする（1c まで暗黙にそう扱っていた） → src/image/spriteGain.ts',
  '2a / 位相の減衰に F を使わない（k を取り違える） → src/image/spriteGain.ts',
  '2a / 潰れた軸を畳まない（1b の挙動へ戻す = 深度 378） → src/image/columnLine.ts',
  '2a / 畳んだ点数の下限を 0 にする（1 点すら描かなくなる） → src/image/columnLine.ts',
  '2a / half-float の非正規数を 0 に潰す（暗い列が消えたことを観測できなくする） → src/core/capture.ts',
  '2a / 潰しの基準を無限格子へ戻す（アンカーの厳密 1 がティア依存に戻る） → src/image/spriteGain.ts',
  '2a / HDR 自己検査の値を 1.0 以下にする（1.0 超を区別する口の意味が消える） → src/core/capture.ts',
  '1c / safeDist をリテラル 2.4 に → src/ingest/session.ts',
  '1c / 板を転送リストから外す → src/ingest/protocol.ts',
  '1c / probe のバイト列を 1 バイト削る → src/ingest/orientProbe.ts',
  '1c / planResize の丸めを切り捨てに → src/ingest/plan.ts',
  '1c / MAX_CANONICAL_PIXELS を 4 倍 → src/ingest/plan.ts',
  '1c / MAX_SOURCE_PIXELS を半分に → src/ingest/plan.ts',
  '1c / lift の原色を srgb 固定に → src/image/lift.ts',
  '1c / columnLine の原色を srgb 固定に → src/image/columnLine.ts',
  '1c / computeStats の原色を srgb 固定に → src/image/stats.ts',
  '1c / linearizeRgba が gamut を捨てる → src/image/linearize.ts',
  '1c / C_MIN_P95 を 10 倍 → src/image/stats.ts',
  '1c / L_MIN_SPAN を 10 倍 → src/image/stats.ts',
  '1c / axisPresence が常に全 true → src/image/stats.ts',
  '1c / lensScene が退化を読まない → src/scene/lensScene.ts',
  '1c / extent の 0 固定を外す（退化軸が dimLevel で開く） → src/core/framingEnvelope.ts',
  '1c / HEIF の brand 判定を殺す → src/ingest/format.ts',
  '1c / decode.ts に日本語の文言を戻す → src/ingest/decode.ts',
  '1b / DEFAULT_FILL を 0.86 → 0.95 → src/core/fit.ts',
  '1b / 画角の半角変換を /360 → /180 → src/core/fit.ts',
  '1b / gainFor のクランプを外す → src/image/spriteGain.ts',
  '1b / LINE_MAX_POINTS を 2048 に → src/image/columnLine.ts',
  '1a-iii / instanceCount = 1 の明示を消す → src/render/colorPointBatch.ts',
];

{
  const have = new Set(MUTATIONS.map(idOf));
  const gone = EXPECTED_IDS.filter((id) => !have.has(id));
  if (gone.length > 0) {
    console.error(`名簿にある歯が ${gone.length} 本、台帳から消えている（本数は ${MUTATIONS.length} のまま）:`);
    for (const id of gone) console.error(`  ${id}`);
    console.error('消す・改名するなら、同じ PR で EXPECTED_IDS からも消すこと。');
    process.exit(1);
  }
}

/**
 * **複製の検出** ── 本数だけ増える歯を機械で止める（2c-vii が手で見つけた型）。
 *
 * **鍵を「規則のテキスト」から「変異後のファイルの中身」へ変えた**（Phase 2c-ix）。
 * 2c-viii は `file + find + replace` の 3 つ組で照合していたが、**`find` を既存の
 * 部分文字列に取り替えるだけで、同じ変異が別物に見える**（独立監査が実演）。
 * 同じ結果のファイルを作る 2 本は、書き方が何であれ同じ 1 本の歯である。
 *
 * **これでも `0.2` を `0.21` にした近似複製は通る** ── 中身が違うので別の変異になる。
 * そこは機械では決まらない（`COMPRESS_KNEE` の 0.2 と 0.9 は実際に別の歯である）。
 */
{
  const seen = new Map();
  const dupes = [];
  const cache = new Map();
  for (const m of MUTATIONS) {
    const p = join(ROOT, m.file);
    if (!cache.has(p)) cache.set(p, readFileSync(p, 'utf8'));
    const src = cache.get(p);
    // 対象行が無い変異は下の走行が `stale` で赤にする。ここでは規則のテキストで照合しておく
    const effect = src.includes(m.find)
      ? (m.all ? src.split(m.find).join(m.replace) : src.replace(m.find, m.replace))
      : `<未適用>\0${m.find}\0${m.replace}`;
    const key = `${m.file}\0${createHash('sha256').update(effect).digest('hex')}`;
    if (seen.has(key)) dupes.push(`${idOf(m)}\n    ← ${seen.get(key)} と**変異後のファイルが 1 バイト違わない**`);
    else seen.set(key, idOf(m));
  }
  if (dupes.length > 0) {
    console.error(`台帳に複製が ${dupes.length} 本ある（本数だけ増えて守るものが増えない）:\n  ${dupes.join('\n  ')}`);
    process.exit(1);
  }
}

/**
 * **`observed` の完全性。** 2c-vii は `observed` を 22/53 から補完したが、
 * **自分で足した 1 本にだけ付け忘れていた**（2c-viii で実測して埋めた）。
 * `failed < undefined` は常に false なので、欠けた行では弱りの検出が静かに効かない。
 *
 * **`typeof === 'number'` では足りなかった**（Phase 2c-ix）── 独立監査が実演した
 * いちばん重い後退経路は「**全 54 本の `observed` を 0 に一括置換する**」である。
 * 0 は数なのでこの検査を通り、`failed < 0` は常に false なので
 * **弱りの検出が 54 本ぶん丸ごと無効になる**。1 行の置換で、EXIT=0 のまま。
 *
 * → 1 本ずつは **1 以上の整数**であることを要求し、**総和にラチェットを置く**。
 * 総和にするのは、1 本だけ下がる正当なリファクタ（実際に `failed` が減った）を
 * 妨げずに、**一括して薄めることだけ**を赤にするためである。
 *
 * **総和のラチェットは「余白」があると効かない**（2c-ix・独立監査が実演）── 台帳の
 * `observed` が実測より小さいと、**1 本を実測へ「締める」ぶんだけ別の 1 本を下げられる**。
 * 監査は現物で **3 点の無償の余白**（`DEFAULT_FILL` を 6 → 3 にしても全検査が通る）と、
 * 締めれば原資になる **5 本の緩み**を数えた。
 * → **全 57 本を全走行の実測値へ締めた**（9 本を上げ、総和 133 → 143）。
 * これで「締めて下げる」の原資が無くなる。**ただし塞いだのは原資であって経路ではない**
 * ── 実測が本当に増えた PR では、また同じことができる。
 */
const EXPECTED_OBSERVED_TOTAL = 149;

{
  const bad = MUTATIONS.filter((m) => !Number.isInteger(m.observed) || m.observed < 1);
  if (bad.length > 0) {
    console.error(`\`observed\` が 1 以上の整数でない変異が ${bad.length} 本ある ── そこでは弱りの検出が効かない:`);
    for (const m of bad) console.error(`  ${idOf(m)} → ${m.observed}`);
    process.exit(1);
  }
  const total = MUTATIONS.reduce((a, m) => a + m.observed, 0);
  if (total < EXPECTED_OBSERVED_TOTAL) {
    console.error(
      `台帳の \`observed\` の総和が ${total}（${EXPECTED_OBSERVED_TOTAL} あったはず）。`
        + '\n一括で薄めると弱りの検出が効かなくなる。正当に減ったのなら、'
        + '\nこの PR の中で EXPECTED_OBSERVED_TOTAL も下げること（差分に出る）。',
    );
    process.exit(1);
  }
}

/**
 * **`--shard i/n`**（Phase 2c-ix の続き）。台帳を n 等分して i 番目だけを回す。
 *
 * ## なぜ足したか —— 費用は本数 × フルスイートで、線形に伸びる
 *
 * 判定は 1 本ごとに**テスト一式を丸ごと**走らせるので、費用は本数に比例する。
 * 実測（run 31707649305・CI）: **1290 秒 ＝ 21 分 30 秒**で、`build` ジョブ全体
 * 1341 秒の **96%**。内訳は素の状態 1 回 ＋ 変異 57 回 ＝ **58 回のフルスイート**で、
 * 1 回あたり 22.2 秒（`npm test` 単体の 24 秒と一致）。歯が 53 → 54 → 57 と
 * 増えたぶん、そのまま伸びている。
 *
 * **変異どうしは独立**なので、runner を分ければそのまま短くなる。
 *
 * ## 判定の意味は変えていない
 *
 * 各変異は**今までどおりフルスイートで**判定される。速くしたいからといって
 * 「その変異に関係するテストだけ走らせる」形にはしない ── それは
 * 「*どれか*のテストが捕まえるか」という問いを「*指定した*テストが捕まえるか」に
 * すり替えることであり、`observed` の意味も作り直しになる。
 *
 * ## 台帳のラチェットは分割の影響を受けない
 *
 * `EXPECTED_MUTATIONS`・複製検査・`observed` の完全性と総和は、**すべて
 * `MUTATIONS`（台帳全体）に対して、この絞り込みより前**で走る ──
 * どのシャードも台帳を丸ごと検査する。**分割で薄まるのは実行だけ**である。
 *
 * ## 空のシャードは赤にする
 *
 * matrix を書き間違えて 1 本も当たらないシャードができたとき、黙って緑を返すのは
 * 「常に緑」という最悪の失敗モードそのものである。**0 本なら落とす。**
 * `i > n` も同じ理由で受け付けない（`[1, 3]` のような穴あき matrix を弾く）。
 */
function parseShardSpec(spec) {
  const m = /^(\d+)\/(\d+)$/.exec(spec ?? '');
  if (!m) {
    console.error(`--shard は i/n の形で渡すこと（例: --shard 2/3）。受け取ったのは ${JSON.stringify(spec)}`);
    process.exit(1);
  }
  const i = Number(m[1]);
  const n = Number(m[2]);
  if (n < 1 || i < 1 || i > n) {
    console.error(`--shard ${i}/${n} は範囲の外である（1 ≤ i ≤ n・n ≥ 1）。matrix と分割数がずれている。`);
    process.exit(1);
  }
  return { i, n };
}

/**
 * **知らない引数は黙って無視しない**（実装中に踏んだ ── Phase 2c-ix の続き）。
 *
 * 綴りを間違えて `--shards 1/3` と書くと、`--shards` が読み飛ばされて **`1/3` が
 * 絞り込み語として拾われ**、名前にも phase にも当たらないので **0 本を回して緑**になる。
 * 引数の綴り違いが「歯を 1 本も確認しない」に化けるのは、`teeth` が存在する理由
 * そのものに反する。→ **`-` で始まる知らない引数は落とす。**
 */
const argv = process.argv.slice(2);
// **「フラグが在る」と「値が在る」を分けて持つ。** 一緒にすると `--shard`（値なし）が
// 「分割なし」に化けて、**全 57 本を黙って回す** ── 安全側ではあるが、CI で分割が
// 効いていないことに気づけない（3 シャードが同じ 57 本を回して 3 倍の時間で緑になる）。
let shardSeen = false;
let shardSpec;
const positional = [];
for (let k = 0; k < argv.length; k += 1) {
  const a = argv[k];
  if (a.startsWith('--shard=')) { shardSeen = true; shardSpec = a.slice('--shard='.length); continue; }
  if (a === '--shard') { shardSeen = true; shardSpec = argv[k + 1]; k += 1; continue; }
  if (a.startsWith('-')) {
    console.error(`知らない引数 ${JSON.stringify(a)} を受け取った（使えるのは \`--shard i/n\` と絞り込み語 1 つ）。`);
    process.exit(1);
  }
  positional.push(a);
}
if (positional.length > 1) {
  console.error(`絞り込み語は 1 つまでである（受け取ったのは ${JSON.stringify(positional)}）。`);
  process.exit(1);
}

const only = positional[0];
const shard = shardSeen ? parseShardSpec(shardSpec) : null;

const selected = only
  ? MUTATIONS.filter((m) => m.name.includes(only) || m.phase === only)
  : MUTATIONS;

// 剰余で配る（連続ブロックにしない）── 台帳の並びは局所的に費用が偏りうるので、
// 交互に取るほうが n で割った各シャードの本数が揃う。
const targets = shard
  ? selected.filter((_, idx) => idx % shard.n === shard.i - 1)
  : selected;

// **0 本で緑を返さない。** 分割の有無に依らず落とす ── `npm run teeth -- 打ち間違い` は
// 2c-viii 以前からこの形で通っていた（`teeth` の本体が 1 度も回らないまま EXIT=0）。
if (targets.length === 0) {
  const how = shard ? `シャード ${shard.i}/${shard.n}` : `絞り込み語 ${JSON.stringify(only)}`;
  console.error(
    `${how} に当たる変異が 1 本も無い（台帳 ${MUTATIONS.length} 本・絞り込み後 ${selected.length} 本）。`
      + '\n1 本も回さずに緑を返すのは「常に緑」である。分割数か絞り込み語を見直すこと。',
  );
  process.exit(1);
}

const shardLabel = shard ? `シャード ${shard.i}/${shard.n} ── ` : '';
console.log(`歯の確認: ${shardLabel}${targets.length} 変異（台帳 ${MUTATIONS.length} 本）\n`);

// ---- 0. まず素の状態が緑であることを確かめる（赤い所から始めたら何も言えない）----
const base = run('npx', ['vitest', 'run']);
if (base.code !== 0) {
  console.error('素の状態でテストが落ちている。歯の確認は意味を持たないので中断する。');
  console.error(base.out.slice(-2000));
  process.exit(1);
}
console.log('素の状態: 緑 ✅\n');

const originals = new Map();
const results = [];
let exitCode = 0;

try {
  for (const m of targets) {
    const path = join(ROOT, m.file);
    if (!originals.has(path)) originals.set(path, readFileSync(path, 'utf8'));
    const src = originals.get(path);

    if (!src.includes(m.find)) {
      console.log(`❌ ${m.name}\n   対象の行が見つからない（${m.file}）── 台帳が実装からずれている`);
      results.push({ ...m, status: 'stale' });
      exitCode = 1;
      continue;
    }

    const mutated = m.all ? src.split(m.find).join(m.replace) : src.replace(m.find, m.replace);
    writeFileSync(path, mutated);
    const r = run('npx', ['vitest', 'run']);
    writeFileSync(path, src);

    const failed = failCount(r.out);
    if (!ranTests(r.out)) {
      // vitest が走らなかった（設定の壊れ・クラッシュ）。**「歯が噛んだ」と読まない**
      console.log(`❌ ${m.name}\n   vitest がテストを走らせていない ── 判定できない（${m.file}）`);
      console.log(r.out.split('\n').slice(-8).join('\n'));
      results.push({ ...m, status: 'stale' });
      exitCode = 1;
    } else if (r.code === 0) {
      console.log(`❌ ${m.name}\n   壊しても緑のまま。**この歯は抜けている**（${m.file}）`);
      results.push({ ...m, status: 'no-bite', failed: 0 });
      exitCode = 1;
    } else if (failed === null) {
      // 落ちてはいる（終了コードが語っている）。件数だけ読めなかった
      console.log(`✅ ${m.name} → 落ちた（件数を読めず）`);
      results.push({ ...m, status: 'ok', failed: null });
    } else if (failed < m.observed) {
      // **Phase 2c-viii で落とすようにした。** 冒頭の実演のとおり、ここが警告どまりだと
      // 「標本を 2 枚から 1 枚へ戻す」＝ 2c-iv の教訓の撤回が、CI 緑のまま通る。
      console.log(
        `❌ ${m.name}\n   → ${failed} 件（${m.phase} 時点は ${m.observed} 件。**減っている**）`
          + `\n   守っていたものが減った。正当なリファクタなら、この PR の中で observed を ${failed} へ下げること`,
      );
      results.push({ ...m, status: 'weaker', failed });
      exitCode = 1;
    } else {
      console.log(`✅ ${m.name} → ${failed} 件`);
      results.push({ ...m, status: 'ok', failed });
    }
  }
} finally {
  // 例外でも Ctrl-C でも、触ったファイルは必ず元へ戻す
  for (const [path, src] of originals) writeFileSync(path, src);
  let dirty = 0;
  for (const [path, src] of originals) {
    if (readFileSync(path, 'utf8') !== src) {
      console.error(`!! ${path} が元に戻っていない`);
      dirty++;
    }
  }
  if (dirty === 0 && originals.size > 0) console.log('\n触ったファイルはすべて元に戻した ✅');
}

const bad = results.filter((r) => r.status === 'no-bite' || r.status === 'stale');
const weak = results.filter((r) => r.status === 'weaker');
console.log(
  `\n合計 ${results.length} / 噛んだ ${results.filter((r) => r.status === 'ok').length}`
    + ` / 弱った ${weak.length} / **抜けた ${bad.length}**`,
);
if (bad.length > 0) {
  console.error(
    '\n抜けた歯がある。守っているはずのものを壊してもテストが落ちない ──'
      + '\nテストが恒等な変換に潰れているか、予算が緩すぎる。'
      + '\n（SPEC §7.1「参照実装は独立に書く」／§7.7「`fillRatios` を採点者にしてはいけない」）',
  );
}
if (weak.length > 0) {
  console.error(
    `\n弱った歯が ${weak.length} 本ある（Phase 2c-viii から**落ちる**）。`
      + '\n件数が減るのは「テストが恒等に潰れ始めた」の早期兆候である。'
      + '\n正当なリファクタで減ったのなら、この PR の中で台帳の observed を下げること ──'
      + '\n**ログの 1 行は誰も読まないが、台帳の差分は査読に出る。**',
  );
}
process.exit(exitCode);
