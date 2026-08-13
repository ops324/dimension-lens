/**
 * **型 5「前提が省かれている」を機構にする**（Phase 2c-ix）。
 *
 * ## 何を止めるのか
 *
 * §7.10 の型 5 は 2c-vi では「数字の出所が自分」と書かれ、2c-viii で**実測に覆された** ──
 * 出所リントは締めるほど捕捉率が 0/20 に落ちる。テキストは「**出所がある**」と
 * 「**その出所で再現する**」を区別しないからである。
 *
 * 実体は「出所が無い」ではなく「**引数が書かれていない**」だった。だから機構は
 * 「数 →（関数, **引数**）」の台帳にする。**引数まで書かせるのが要点**である。
 *
 * この 1 本を書いた時点で、この repo の doc から次が出てきた（どれも「出所」は健全）:
 *
 * | 表 | 書かれていた前提 | 本当の引数 | 印字値で計算すると |
 * |---|---|---|---|
 * | `halfFloat` の停止表 | `δ = 9.537e−7` | **`2⁻²⁰`** | 5 行中 **2 行が外れる**（階段関数の段の上） |
 * | `halfFloat` の誤差表 | 「目標 0.21586」 | **`srgbToLinear(128/255)`** | 24 セル中 **5 セルが外れる** |
 * | `spriteGain` のティア表 | 「S = 8.6548 px」 | **`K_SPRITE · s0`**（= 8.65403） | 6 セル中 **6 セルが外れる** |
 * | `framingEnvelope` の収束表 | 記載なし | **`viewportAspect = 988/778`** | `a = 1` では **5 行とも外れる** |
 *
 * **どれも「出所を注釈して回る機構」では 1 件も捕まらない。**
 *
 * ## 4 つの規律（独立監査が実演で決めた・Phase 2c-ix）
 *
 *   1. **期待値を台帳に書かない。** doc のテキストから機械が読む ──
 *      `expected: fn(args)` と書いた瞬間に、doc の数を 999 に全置換しても緑になる
 *   2. **`includes` 照合を禁じる。** 表のセルを**位置**（行・列）で特定して数値比較する ──
 *      小数 2 桁の `includes` は 400/400 の無関係な値が「一致」する
 *   3. **宣言した引数を 1 つずつ揺らし、doc の表記桁を超えて動くことを要求する。**
 *      動かない引数は `inert` に書かせる（**飾りで書いた引数を差分に出す**）。
 *      `inert` の側も機械が検証する ── 動いてしまう引数を `inert` と書けば赤になる
 * **「比だから約分される」は 3 引数について偽だった**（2c-ix で機械が捕まえた）──
 * `needDistance` は `max(aY/band, aX/aspect)/(fill·t) + zHi` で、**`zHi` の項が
 * `fill` にも `fovDeg` にも `bandFrac` にも掛からない**。比を取っても消えるのは
 * `viewportAspect` だけ（縦側が勝っている領域で、そもそも式に現れないため）である。
 * 私は 5 つとも `inert` と書き、**`inert` の側の検証が 12 セルで赤にした**。
 *
 *   4. **許容は doc の表記桁から機械が決める。** 人が `tol` を置くと、締めれば偽の赤・
 *      緩めれば包含照合になる。ここでは**計算値を doc と同じ桁へ丸めた文字列**が
 *      一致することを要求する（＝ 表記桁ちょうどの許容。同値の丸めも機械の側で決まる）
 *
 * ## 被覆
 *
 * 台帳が触るのは 36 表のうち一部でしかない。だから**「台帳 ∪ 除外表 ⊇ 全表」を要求する** ──
 * 表を 1 つ足したら、採点するか、理由を書いて除外するか、どちらかを**その PR で**選ぶ。
 * 除外表は 1 行で書けるので `EXPECTED_EXCLUDED` のラチェットを置く（増やすなら数も上げる）。
 *
 * **corpus は `src/tests/` も含む。** 2c-viii は「補完がその PR の追加分を舐めなかった」を
 * 踏んでおり、doc 版の同じ穴（**自分の解説をテストに書けば自分の検査に載らない**）を
 * 塞ぐ必要がある。このファイル自身の表も corpus に入り、下の除外表に自分で載っている。
 *
 * ## 載せられない表が在る（費用・実測）
 *
 * | 対象 | `npm test` の増分 | `npm run teeth` 換算（×54） |
 * |---|---|---|
 * | 純関数だけ（`halfFloat` / `blendModel` / `spriteGain`） | +0.02 s | +1.1 s |
 * | ＋ 包絡 `M ≤ 65536`（この台帳が採るところ） | **+1.5 s** | **+81 s** |
 * | ＋ `layout()` を含む反復軸（18000F / 36000F 系） | +464 s | **+6.96 時間** |
 *
 * **反復軸を含む表は載せない。**（`core/fit.ts` の代償表 2 つ・`framingEnvelope` の
 * K 表と標本表・`lensScene` の resize 表）── 下の除外表に `iteration-cost` として並ぶ。
 * **格子を落として安くする道は塞がっている**: 軽い格子（20,000 点）だと 1F 目が
 * `2.919522` になり doc の `2.926651` を再現しない。**格子予算も load-bearing な引数**である。
 *
 * ## この機構自身の弱点（正直に）
 *
 * - **「doc と同じ桁へ丸めて一致」は、doc が粗く書いてあるほど緩い。** `**≈ 0%**` は
 *   0 桁なので ±0.5 を通す。**桁を決めているのは著者**であって機械ではない
 * - **全引数が `inert` のセルでは、規律 3 が空回りする**（下で本数を出す）。
 *   `spriteGain` のティア表は `A` が `S/s0` にしか依らないので構造的にそうなる
 * - **`EXPECTED_*` はどれも「人が数字を下げれば通る」形**である（§7.10 の型 1 と同じ）。
 *   §8 に書いたとおり、**この系列の終端条件は査読**であって機構ではない
 * - **corpus は `src/**\/*.ts` のコメントだけ**を見る。`SPEC.md` の表は対象外である
 *   （単位が違う ── SPEC は主張の集積で、実装 doc は関数の隣にある数である）
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  f16Accumulate,
  f16AccumulateTruncate,
  f16RelativeError,
  f16RelativeErrorTruncate,
  f16SaturationCeiling,
} from '../image/halfFloat';
import { BLEND_MODELS, blendCases } from '../image/blendModel';
import { deltaE2000Linear } from '../color/deltaE';
import { SRGB } from '../color/oklab';
import { srgbToLinear } from '../color/srgb';
import { AXIS_UNBOUNDED, K_SPRITE, axisCoverage, collapseWeight } from '../image/spriteGain';
import {
  ENVELOPE_CANDIDATES,
  createEnvelopeScratch,
  extentFor,
  framingEnvelope,
} from '../core/framingEnvelope';
import { DEFAULT_FILL, needDistance } from '../core/fit';
import { makeSpecimen0 } from '../image/fixture';
import { linearizeRgba } from '../image/linearize';
import { computeScales, computeStats } from '../image/stats';
import { TIER_BUDGET, fitGrid } from '../image/grid';
import { makeLiftPayload } from '../ingest/session';
import { safeDist } from '../math/rotationN';
import { CAMERA_FOV } from '../core/engine';

// ------------------------------------------------------------------ 表の走査器

interface DocTable {
  /** repo からの相対パス */
  readonly file: string;
  /** そのファイルの中で何番目の表か（1 始まり） */
  readonly index: number;
  /** 表が始まる行番号（1 始まり・ヘッダ行） */
  readonly line: number;
  readonly header: readonly string[];
  /** 区切り行より下のデータ行。各行はセルの配列 */
  readonly rows: readonly (readonly string[])[];
  /** 表の直上のコメント 12 行。**doc が関数名を名乗っているか**を見るために持つ */
  readonly preamble: string;
}

/**
 * コメント行だけを取り出す。**ブロックコメントの状態を持つ** ──
 * これが無いと、文字列リテラルの中の `|` を表と読む。
 */
function commentText(src: string): (string | null)[] {
  const out: (string | null)[] = [];
  let inBlock = false;
  for (const raw of src.split('\n')) {
    const t = raw.trim();
    if (!inBlock) {
      if (t.startsWith('/*')) {
        inBlock = !t.includes('*/');
        out.push(t.replace(/^\/\*+/, '').replace(/\*\/$/, '').trim());
      } else if (t.startsWith('//')) {
        out.push(t.replace(/^\/\/+/, '').trim());
      } else {
        out.push(null);
      }
    } else {
      if (t.includes('*/')) inBlock = false;
      out.push(t.replace(/^\*+/, '').replace(/\*\/$/, '').trim());
    }
  }
  return out;
}

const isRowLine = (t: string | null): t is string =>
  t !== null && t.startsWith('|') && t.endsWith('|') && t.length > 2;
const isSepLine = (t: string | null): boolean =>
  isRowLine(t) && /^\|[\s:|-]+\|$/.test(t) && t.includes('-');

/** `| a | b |` を `['a', 'b']` へ。**両端の空セルだけを落とす**（中の空セルは残す） */
function splitCells(t: string): string[] {
  const parts = t.split('|');
  parts.shift();
  parts.pop();
  return parts.map((c) => c.trim());
}

/**
 * **緩い定義**（区切り行を要求しない）。厳しい定義と本数が違ったら赤にするために持つ。
 *
 * 走査器が 1 つだと、**走査器に見えない表を書けば被覆検査を素通りできる** ──
 * 区切り行を `|:::|` にする、`-` を全角にする、といった 1 文字で足りる。
 * 2 つの独立な定義の**本数が一致すること**を要求すると、その道は差分に出る
 * （2c-ix が自分で見つけた穴。監査の指摘ではない）。
 */
function looseTableCount(src: string): number {
  const cl = commentText(src);
  let n = 0;
  for (let k = 0; k < cl.length; k++) {
    if (!isRowLine(cl[k])) continue;
    let e = k;
    while (e + 1 < cl.length && isRowLine(cl[e + 1])) e++;
    if (e - k + 1 >= 2) n++;
    k = e;
  }
  return n;
}

function tablesIn(file: string, src: string): DocTable[] {
  const cl = commentText(src);
  const out: DocTable[] = [];
  for (let k = 0; k < cl.length; k++) {
    if (!isRowLine(cl[k])) continue;
    let e = k;
    while (e + 1 < cl.length && isRowLine(cl[e + 1])) e++;
    if (e - k + 1 >= 3 && isSepLine(cl[k + 1])) {
      out.push({
        file,
        index: out.length + 1,
        line: k + 1,
        header: splitCells(cl[k] as string),
        rows: cl.slice(k + 2, e + 1).map((l) => splitCells(l as string)),
        preamble: cl.slice(Math.max(0, k - 12), k).map((l) => l ?? '').join('\n'),
      });
    }
    k = e;
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const ROOT = process.cwd();
const SRC_FILES = walk(join(ROOT, 'src')).sort();
const CORPUS: DocTable[] = SRC_FILES.flatMap((abs) => {
  const rel = relative(ROOT, abs).split('\\').join('/');
  return tablesIn(rel, readFileSync(abs, 'utf8'));
});
const LOOSE_COUNT = SRC_FILES.reduce((a, abs) => a + looseTableCount(readFileSync(abs, 'utf8')), 0);

// ------------------------------------------------------------ セルの数値化と桁

/** 強調・コード引用・全角記号・桁区切りを外す。**数の取り出しは位置でしか行わない** */
function normalize(cell: string): string {
  return cell
    .split('**').join('')
    .split('`').join('')
    .split('\u2212').join('-') // MINUS SIGN
    .split('\uFF0B').join('+')
    .split('\u2009').join('')
    .split('\u00A0').join('')
    .replace(/(\d),(\d)/g, '$1$2')
    .replace(/(\d)\s(\d{3})\b/g, '$1$2'); // `1 634` のような空白区切り
}

const NUM = /[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

interface DocNumber {
  /** doc に書かれている数 */
  readonly value: number;
  /** 小数点以下の表記桁（指数表記は指数ぶん繰り下げる） */
  readonly decimals: number;
  readonly token: string;
}

function docNumbers(cell: string): DocNumber[] {
  const norm = normalize(cell);
  const toks = norm.match(NUM) ?? [];
  return toks.map((token) => {
    const m = /^([+-]?\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
    const frac = m?.[2]?.length ?? 0;
    const exp = m?.[3] ? Number(m[3]) : 0;
    return { value: Number(token), decimals: frac - exp, token };
  });
}

/**
 * **doc の表記桁ちょうどで比べる。** 計算値を doc と同じ桁へ丸めた文字列が
 * doc の数を同じ桁へ丸めた文字列と一致することを要求する。
 *
 * `tol` を人が置かないのが要点である（規律 4）。桁を決めるのは doc だけで、
 * 丸めの同値（`0.0078125` → `0.007813`）も機械の側で決まる。
 */
function sameAtDocPrecision(got: number, doc: DocNumber): boolean {
  const d = Math.max(0, Math.min(100, doc.decimals));
  const f = (x: number) => {
    const s = x.toFixed(d);
    return s === `-${(0).toFixed(d)}` ? (0).toFixed(d) : s;
  };
  return f(got) === f(doc.value);
}

// ------------------------------------------------------------------ 台帳の型

type Args = Readonly<Record<string, number>>;

interface LedgerCell {
  /** データ行の位置（0 始まり） */
  readonly row: number;
  /** 列の位置（0 始まり） */
  readonly col: number;
  /** セルに数が複数あるときだけ、何番目を採るかを位置で書く */
  readonly pick?: number;
  readonly args: Args;
  readonly compute: (a: Args) => number;
  /** 揺らしても動かない引数。**理由を書かせる**（飾りを差分に出すため） */
  readonly inert?: Readonly<Record<string, string>>;
  /**
   * 連続でない引数（モデルの選択・ケースの選択）の取りうる値。
   * **×1.25 で揺らすと定義域の外へ出る**ので、揺らし先をここから採る。
   */
  readonly discrete?: Readonly<Record<string, readonly number[]>>;
}

interface TableRef {
  readonly file: string;
  /** そのファイルの中で何番目の表か（1 始まり） */
  readonly table: number;
  /**
   * その表のヘッダ行（`|` で割ったものを ' | ' で繋いだもの）。
   *
   * **添字だけだと、表を 1 つ挿しただけで全部の指し先が黙ってずれる**
   * （独立監査が実演した X6）。ヘッダを照合すると、ずれたその場で赤になる。
   */
  readonly head: string;
}

interface LedgerEntry extends TableRef {
  readonly what: string;
  /**
   * **doc の側が名乗っている関数名**（表の直上 12 行または見出しに現れること）。
   *
   * これが無いと、台帳は「どの関数の表か」を**自分の側にしか持たない** ──
   * `halfFloat` の n 表は `Float16Array`（最近接）製で、実機の `f16AccumulateTruncate`
   * では n=512 が 0.193604（doc 0.205200）になる。**doc が RN の表だと言っていない限り、
   * 実機で成り立つかは 1 ミリも問われない**（独立監査の X5）。
   */
  readonly fn: readonly string[];
  readonly cells: readonly LedgerCell[];
  /** 採点しないデータ行（位置 → 理由）。**黙って飛ばさない** */
  readonly skipRows?: Readonly<Record<number, string>>;
  /** 採点しない列（位置 → 理由） */
  readonly skipCols?: Readonly<Record<number, string>>;
}

// ------------------------------------------------------- 標本（包絡の表のため）

/** `framingEnvelope.test.ts` と同じ作り方。**別の図を測らないため写経しない** */
let cached: {
  base: Float32Array;
  count: number;
  cascadeDist: number;
  scratch: ReturnType<typeof createEnvelopeScratch>;
} | null = null;

function specimen() {
  if (cached) return cached;
  const s = makeSpecimen0();
  const canonical = linearizeRgba(s.rgba, s.width, s.height, 'srgb');
  const scales = computeScales(computeStats(canonical));
  const grid = fitGrid(canonical.width, canonical.height, TIER_BUDGET.HIGH);
  const lifted = makeLiftPayload(canonical, grid, scales);
  cached = {
    base: lifted.base,
    count: grid.cols * grid.rows,
    cascadeDist: safeDist(lifted.maxNorm),
    scratch: createEnvelopeScratch(ENVELOPE_CANDIDATES),
  };
  return cached;
}

const ALL_PRESENT = [true, true, true, true, true];
const extentScratch = new Float64Array(5);

/**
 * 包絡そのものを memo する。**純関数なので値は 1 ビットも変わらない**が、
 * 感度検査が同じ `(dimLevel, phaseCount, candidates)` を何度も引くので、
 * ここを覚えないと `viewportAspect` を揺らすたびに 65536 位相を掃き直すことになる。
 */
const envCache = new Map<string, { aX: number; aY: number; zHi: number }>();

function envelopeOf(a: Args) {
  const k = `${a.dimLevel}|${a.phaseCount}|${a.candidates}`;
  const hit = envCache.get(k);
  if (hit) return hit;
  const { base, count, cascadeDist } = specimen();
  const scratch = createEnvelopeScratch(a.candidates);
  extentFor(a.dimLevel, ALL_PRESENT, extentScratch);
  const env = framingEnvelope(base, count, extentScratch, cascadeDist, scratch, a.phaseCount);
  envCache.set(k, env);
  return env;
}

/**
 * `need`（＝ `needDistance ∘ framingEnvelope`）。**引数を 1 つも隠さない。**
 *
 * `bandFrac` / `fovDeg` / `fill` は当初この関数の中に**閉じ込めて**いた。
 * 独立監査が「`fill` を 0.86 → 0.95 にすると `need` が 6.869252 → 6.401687 動くのに、
 * 宣言外なので感度検査の対象にならない」を実演した ──
 * **閉包に隠した引数は、台帳が「引数を書かせる機構」であることを裏切る。**
 */
function envelopeNeed(a: Args): number {
  return needDistance(
    { aX: 0, aY: 0, viewportAspect: a.viewportAspect, bandFrac: a.bandFrac, fovDeg: a.fovDeg, fill: a.fill },
    envelopeOf(a),
  );
}

/** 収束比（%）。基準は `M = 65536` */
function envelopeConvergence(a: Args): number {
  return (envelopeNeed(a) / envelopeNeed({ ...a, phaseCount: 65536 })) * 100;
}

// --------------------------------------------------------------------- 台帳

/** sRGB 128 のリニア値。**doc が「0.21586」と印字している当の引数** */
const TARGET_128 = srgbToLinear(128 / 255);

const HALF_FLOAT_TARGET = { target: TARGET_128 } as const;
/** 包絡の表を測った viewport（`lensScene` の既定 1 ではない）。**これが型 5 の当の前提** */
const ENVELOPE_FRAME = {
  viewportAspect: 988 / 778,
  bandFrac: 1,
  fovDeg: CAMERA_FOV,
  fill: DEFAULT_FILL,
  candidates: ENVELOPE_CANDIDATES,
} as const;

/**
 * 収束「比」の列で、引数が**ほぼ**約分される理由。
 *
 * **「比だから約分される」は偽だった**（2c-ix・機械が 12 セルで赤にした）──
 * `needDistance` は `max(aY/band, aX/aspect)/(fill·t) + zHi` で、
 * **`zHi` の項は `fill` にも `fovDeg` にも `bandFrac` にも掛からない**。
 * 完全に消えるのは `viewportAspect` だけ（縦側が勝つ領域では式に現れない）。
 * 残りは「消える」ではなく「**doc の表記桁の下に隠れる**」であり、
 * **桁が 1 つ増えれば効く側へ移る**。この機構の許容が著者の印字桁で決まることの実例である。
 */
const RATIO_RESIDUE = (measured: string) =>
  '比を取っても `zHi` の項だけは約分されない。残差は doc の表記桁の下に隠れる'
  + `（${measured}）── **桁が 1 つ増えればこの引数は「効く」側へ移る**`;

/** doc の印字桁ではモデルが分かれない `行:モデル` の組（実測して埋めた） */
const MODEL_BLIND_CELLS = new Set(['0:0', '0:1', '0:2', '0:3', '1:1', '1:2', '1:3', '2:2']);

const LEDGER: readonly LedgerEntry[] = [
  {
    file: 'src/image/halfFloat.ts',
    table: 1,
    head: 'δ | 実測停止値 | `2048·δ` | 直上の 2 冪',
    what: '`A + δ` が丸め戻って停止する値（`2048·δ` 以上の最小の 2 冪）',
    fn: ['f16SaturationCeiling'],
    skipCols: {
      0: 'δ そのもの ── **この表の引数**である。ここを採点すると `x/x` になる',
      2: '`2048·δ` は doc が書いた式の再掲で、**`src/` の関数を 1 つも呼ばない** ── '
        + '台帳の側で掛け算を書けば必ず一致する（独立監査の X9）。採点せずに数える',
      3: '「直上の 2 冪か」の ✓ で、数ではない',
    },
    cells: [0, 1, 2, 3, 4].map((row) => {
      const delta = [2 ** -20, 2 ** -16, 1.53e-5, 1e-3, 1][row];
      return { row, col: 1, args: { delta }, compute: (a: Args) => f16SaturationCeiling(a.delta) };
    }),
  },
  {
    file: 'src/image/halfFloat.ts',
    table: 2,
    head: 'n | 合計 | 誤差',
    what: '目標値を n 等分して half-float へ足したときの合計と相対誤差（最近接丸め）',
    fn: ['f16Accumulate', 'f16RelativeError', 'srgbToLinear'],
    skipCols: { 0: 'n そのもの ── **この表の引数**である' },
    cells: [256, 378, 489, 512, 2048, 3537, 89208].flatMap((n, row) => {
      // **最後の行は天井で停止している**（doc がそう書いている）。停止値は
      // 「`2048·δ` 以上の最小の 2 冪」なので、目標も n も 25% 動かすだけでは
      // 同じ 2 冪に留まる ── **この行だけ、両方の引数が印字桁に効かない**
      const saturated = n === 89208
        ? {
            target: '天井（`2048·δ` 以上の最小の 2 冪）で停止しているので、'
              + '目標を 25% 動かしても同じ 2 冪に留まる ── **停止していることの現れ**である',
            n: '同上。天井は n に依らない（この節の初版が「停止点は n に依らない」と'
              + '書いたのは、後半だけは真だった）',
          }
        : undefined;
      return [
        {
          row,
          col: 1,
          args: { ...HALF_FLOAT_TARGET, n },
          inert: saturated,
          compute: (a: Args) => f16Accumulate(a.target, a.n),
        },
        {
          row,
          col: 2,
          args: { ...HALF_FLOAT_TARGET, n },
          inert: n === 89208 ? { n: saturated!.n } : undefined,
          compute: (a: Args) => f16RelativeError(a.target, a.n) * 100,
        },
      ];
    }),
  },
  {
    file: 'src/image/halfFloat.ts',
    table: 3,
    head: '深度 n | RN の誤差（旧） | **RTZ の誤差（実機）** | **RTZ の ΔE00** | 旧 ΔE00',
    what: '深度ごとの丸め誤差（最近接 / 実機の 0 方向切り捨て）と ΔE00',
    fn: ['f16Accumulate', 'f16AccumulateTruncate', 'deltaE2000'],
    skipCols: {
      0: '深度 n そのもの ── **この表の引数**である',
      4: '**旧 ΔE00 は現在の export で再現しない。** Phase 1b の予算表からの転記で、'
        + ' `f16Accumulate` の ΔE00 は 128 で 0.198（doc 0.324）/ 512 で 1.136（doc 1.364）。'
        + ' **出所が失われている列**なので、採点せずに数える（型 3）',
    },
    cells: [16, 64, 128, 256, 378, 512, 1024, 2048].flatMap((n, row) => [
      {
        row,
        col: 1,
        args: { ...HALF_FLOAT_TARGET, n },
        compute: (a: Args) => f16RelativeError(a.target, a.n) * 100,
      },
      {
        row,
        col: 2,
        args: { ...HALF_FLOAT_TARGET, n },
        compute: (a: Args) => f16RelativeErrorTruncate(a.target, a.n) * 100,
      },
      {
        row,
        col: 3,
        args: { ...HALF_FLOAT_TARGET, n },
        compute: (a: Args) => {
          const got = f16AccumulateTruncate(a.target, a.n);
          return deltaE2000Linear(SRGB, [a.target, a.target, a.target], [got, got, got]);
        },
      },
    ]),
  },
  {
    file: 'src/image/blendModel.ts',
    table: 2,
    head: 'ケース | 実測 | f32 | fp16 RN | fp16+切り捨て | **fp16 RTZ**',
    what: '規定した値の並びを 4 つのモデルで積んだ結果',
    fn: ['blendF32', 'blendF16', 'blendF16FlushSource', 'blendF16TruncateToZero'],
    skipCols: {
      0: 'ケース名（数ではない）',
      1: 'GPU の読み値（`blendProbe`）── node では再現できない。'
        + ' どのモデルと一致するかは `blendModel.test.ts` と `OBSERVED_BLEND_MODEL` が見る',
    },
    cells: [0, 1, 2, 3, 4, 5].flatMap((row) =>
      [0, 1, 2, 3].map((mi) => ({
        row,
        col: 2 + mi,
        args: { caseIndex: row, model: mi },
        discrete: { caseIndex: [0, 1, 2, 3, 4, 5], model: [0, 1, 2, 3] },
        // **doc の印字桁でモデルが分かれないセル**を明示する。
        // 行 0（`selftest-exact`）は**全モデルが一致するように作られた自己検査**なので
        // 4 セルとも。行 1（`f16-vs-f32`）は fp16 の 3 モデルが同値で、doc が
        // その列を 1 桁（`1.0`）でしか印字していない。行 2 の `f16-flush` は
        // doc が `0` と 0 桁で印字しているので、0.031 の差が桁の下に隠れる。
        // → **「この表のこのセルはモデルを判別していない」を台帳の側に書く。**
        inert: MODEL_BLIND_CELLS.has(`${row}:${mi}`)
          ? {
              model: 'doc の印字桁ではモデルが分かれないセル（行 0 は全モデル一致の自己検査、'
                + '行 1 の fp16 3 モデルは同値、行 2 の `f16-flush` は 0 桁印字）。'
                + '**このセルは「どのモデルか」を 1 ビットも判別していない**',
            }
          : undefined,
        compute: (a: Args) => BLEND_MODELS[a.model].run(blendCases()[a.caseIndex].values),
      })),
    ),
  },
  {
    file: 'src/image/spriteGain.ts',
    table: 4,
    head: 'ティア | 格子 | `A(unbounded)` | `A(n)` | `sampleWeight`',
    what: '基準を無限格子に取ると、アンカーの厳密 1 がティアで崩れる',
    fn: ['axisCoverage', 'K_SPRITE'],
    skipCols: { 0: 'ティア名', 1: '格子の寸法（引数）' },
    cells: ([
      ['HIGH', 2.2478, 378],
      ['BALANCED', 3.3851792828685254, 251],
    ] as const).flatMap(([, s0, n], row) => {
      // **HIGH の行だけ厳密に動かない。** BALANCED の行では `s0` も `n` も
      // **1〜2 ulp（2.2e−16 / 4.4e−16）動き、doc が 16 桁印字しているので効く側**になる。
      // それがこの表の主張そのものである ──「HIGH で厳密 1 だったのは数値の偶然」。
      const SCALE_FREE = '`axisCoverage` は `spritePx/s0 = K_SPRITE` にしか依らない（尺度不変）── '
        + 'HIGH の行では s0 を 25% 動かしても **Δ = 0（厳密）**。BALANCED の行では '
        + '**1〜2 ulp（2.2e−16 / 4.4e−16）動く**ので効く側になる ── '
        + '**「HIGH で厳密 1 だったのは数値の偶然」というこの表の主張そのもの**である';
      const REACH = 'スプライトは ±2 セルしか届かないので、HIGH では `n` を増やしても Δ = 0';
      const UNBOUNDED_COL = 'この列は `AXIS_UNBOUNDED` を渡すので、**そもそも `n` を読まない**';
      const inert = row === 0 ? { s0: SCALE_FREE, n: REACH } : undefined;
      return [
        {
          row,
          col: 2,
          args: { s0, n },
          inert: { ...inert, n: UNBOUNDED_COL },
          compute: (a: Args) => axisCoverage(a.s0, AXIS_UNBOUNDED, K_SPRITE * a.s0),
        },
        {
          row,
          col: 3,
          args: { s0, n },
          inert,
          compute: (a: Args) => axisCoverage(a.s0, a.n, K_SPRITE * a.s0),
        },
        {
          row,
          col: 4,
          args: { s0, n },
          inert,
          compute: (a: Args) =>
            collapseWeight({
              s0x: a.s0,
              s0y: a.s0,
              spritePx: K_SPRITE * a.s0,
              extentX: 1,
              extentY: 1,
              nx: a.n,
              ny: a.n,
            }),
        },
      ];
    }),
  },
  {
    file: 'src/core/framingEnvelope.ts',
    table: 3,
    head: 'M | need | 収束値との比 | 費用',
    what: '掃く位相 M を増やしたときの `need` の収束',
    fn: ['needDistance', 'framingEnvelope'],
    skipCols: {
      0: 'M そのもの ── **この表の引数**である',
      3: '費用（ms）── 機体で変わる量なので採点しない（§7.9.2.1）',
    },
    cells: [
      ...[256, 1024, 4096, 16384, 65536].map((M, row) => ({
        row,
        col: 1,
        args: { ...ENVELOPE_FRAME, dimLevel: 3, phaseCount: M },
        inert: {
          candidates:
            '候補を 32 から増やしても包絡は 6 桁動かない（この表の直下がそう書いている）── '
            + '**標本 No.0 の性質**であって一般には成り立たない（`ENVELOPE_CANDIDATES` の項）',
          // **この行が独立監査の X12 そのものである。**
          ...(M >= 4096
            ? {
                viewportAspect:
                  `M = ${M} では包絡の \`aX/aY\` が 1.0045 しかないので、`
                  + '`needDistance` の `max(aY/band, aX/aspect)` は縦側で決まり、'
                  + '**アスペクトを 1.0045 より上で動かしても 1 ビットも変わらない**。'
                  + '→ **出荷している `ENVELOPE_PHASES = 4096` を正当化している行では、'
                  + '台帳は `viewportAspect` の欠落を原理的に捕まえられない**（M = 256 の行だけが捕まえる）',
              }
            : {}),
          // **doc がこの行に「―（収束）」と書いている当のこと**
          ...(M === 65536
            ? {
                phaseCount:
                  'この行が「収束」と書いている当のこと ── M を ±25% 動かしても'
                  + '印字桁（4 桁）では 3.1e−5 しか動かない。**収束の主張は、'
                  + 'この引数が効かなくなったことそのもの**である',
              }
            : {}),
        },
        compute: envelopeNeed,
      })),
      ...[256, 1024, 4096, 16384].map((M, row) => ({
        row,
        col: 2,
        args: { ...ENVELOPE_FRAME, dimLevel: 3, phaseCount: M },
        // **「比だから約分される」は行によって真偽が変わる**（実測して埋めた）。
        // 分子（M）と分母（65536）で `needDistance` の max がどちらの辺で決まるかが
        // 違う行では、比を取っても何も消えない ── M が小さいほど残る。
        inert: {
          candidates: '上と同じ（標本 No.0 では K を増やしても動かない）',
          ...(M >= 4096
            ? {
                viewportAspect:
                  '分子と分母で `needDistance` の max が同じ辺（縦）で決まる行なので、'
                  + 'アスペクトが約分で消える ── **比だけを見ていると取り違えが見えない**'
                  + '（1 列目は M = 256 で動く）。M = 256 / 1024 の行では 3.82 / 0.44 動く',
              }
            : {}),
          ...(M >= 16384
            ? {
                bandFrac: RATIO_RESIDUE('この表は 2 桁印字。M=16384 の行だけ 5.4e−3 に収まる'),
                fovDeg: RATIO_RESIDUE('同 2.3e−4'),
                fill: RATIO_RESIDUE('同 1.9e−4'),
              }
            : {}),
        },
        compute: envelopeConvergence,
      })),
    ],
  },
  {
    file: 'src/core/framingEnvelope.ts',
    table: 4,
    head: '`dimLevel` | `need` の収束比（M = 65536 基準）',
    what: '`M = 4096` の収束比が最悪になる `dimLevel`',
    fn: ['needDistance', 'framingEnvelope'],
    skipCols: { 0: '`dimLevel` そのもの ── **この表の引数**である' },
    cells: [1.25, 1.75, 3, 4, 5].map((d, i) => ({
      // 3 行目（位置 2）は「3 〜 5」の 1 セルに 3 つの `dimLevel` が畳まれている。
      // **同じセルを 3 回、別々の引数で採点する**（畳まれていることを台帳の側で開く）
      row: i < 2 ? i : 2,
      col: 1,
      args: { ...ENVELOPE_FRAME, dimLevel: d, phaseCount: 4096 },
      inert: {
        viewportAspect: '収束「比」は `needDistance` の分子分母で約分される（上の表と同じ）',
        candidates: '標本 No.0 では K を 32 から増やしても包絡が 6 桁動かない',
        // **`d = 1.75` の行だけ残差が印字桁の下に隠れる。**（実測: fov の残差は
        // d=1.25 で 1.7e−2 / **d=1.75 で 6.9e−4** / d=3〜5 で 1.3e−2）──
        // **同じ表の中でも、行によって「効く / 効かない」が変わる。**
        // 私は初め `d = 1.25` だと書き、機械が d=1.75 だと訂正した
        ...(d === 1.75
          ? {
              fovDeg: RATIO_RESIDUE('この表は 3 桁印字。d=1.75 では 6.9e−4 しか動かない'),
              fill: RATIO_RESIDUE('同 5.6e−4'),
            }
          : {}),
        // **doc が 3 行目を「3 〜 5」と 1 行に畳んでいる当のこと**
        ...(d >= 4
          ? {
              dimLevel: 'doc がこの行を「3 〜 5」と畳んでいる当のこと ── '
                + '標本 No.0 の上位 32 点は彩度 0 の黒枠なので `extent[3]`/`extent[4]` が'
                + '開いても寄与せず、d = 3/4/5 の比は 1.5e−7 しか違わない（印字は 3 桁）',
            }
          : {}),
      },
      compute: envelopeConvergence,
    })),
  },
];

// ------------------------------------------------------------------- 除外表

type ExcludeKind =
  /** GPU / ブラウザでしか読めない値 */
  | 'gpu-browser'
  /** node で再現できるが反復軸の費用が `npm run teeth` を壊す */
  | 'iteration-cost'
  /** 過去の構成で測った値で、現在の export では出ない（型 3・型 5） */
  | 'historical'
  /** そもそも数の表ではない（✅ / 記号 / 名前） */
  | 'non-numeric'
  /** この台帳自身の解説 */
  | 'self';

interface Excluded extends TableRef {
  readonly kind: ExcludeKind;
  readonly why: string;
}

const EXCLUDED: readonly Excluded[] = [
  { file: 'src/copy.ts', table: 1, head: 'code | 実入力から到達するか', kind: 'non-numeric', why: 'エラーコードが実入力から到達するかの ✅/❌。数が無い' },
  { file: 'src/core/capture.ts', table: 1, head: 'バッファ | 例外 | `gl.getError()` | 読めた値', kind: 'gpu-browser', why: '`gl.getError()` の実測。node に GL が無い' },
  { file: 'src/core/compress.ts', table: 1, head: 'dimLevel | p50 | p99 | p99.9 | 最大 | > 1.0 の画素', kind: 'gpu-browser', why: 'HDR バッファの読み戻し分位数（`readbackHDR`・988×778）' },
  { file: 'src/core/compress.ts', table: 2, head: 'dimLevel | 記録値 | 位相を 120 秒流したときの生の峰 | 比', kind: 'gpu-browser', why: '位相を 120 秒流したときの生の峰。実 GPU の読み戻し' },
  { file: 'src/core/fit.ts', table: 1, head: '壊し方 | 既存 222 件', kind: 'historical', why: 'Phase 1b の「既存 222 件がこの変異を素通しした」の記録。いまの台帳は `scripts/teeth.mjs`' },
  { file: 'src/core/fit.ts', table: 2, head: ' | 実測 | `imageHalfExtents` 比', kind: 'iteration-cost', why: '投影後の実座標の最大。位相を流して取る量で、1 セルあたり数千フレーム' },
  { file: 'src/core/fit.ts', table: 3, head: 'd | 門 | 1F 目 | 初めて動く | 300 秒後 | 倍率', kind: 'iteration-cost', why: '傾斜帯の代償表。18,000F（300 秒）× 5 行 ── teeth 換算で数時間になる' },
  { file: 'src/core/fit.ts', table: 4, head: 'd | 門 | 1F 目 | 300 秒後 | 倍率 | 初めて動く', kind: 'iteration-cost', why: '門が全開の領域の代償表。初めて動くまで 9,253F' },
  { file: 'src/core/framingEnvelope.ts', table: 1, head: '経過（gate 時間） | カメラ距離', kind: 'iteration-cost', why: 'ブラウザで実時間 300 秒掃いたカメラ距離。実測ログ' },
  { file: 'src/core/framingEnvelope.ts', table: 2, head: 'd | `aX` の argmax を外した位相 | 外したときの最悪比', kind: 'iteration-cost', why: '`aX` の argmax を外した位相の比。512 位相 × 6 スロットを全点で取り直す' },
  { file: 'src/core/framingEnvelope.ts', table: 5, head: '標本 | d | `need` の比', kind: 'historical', why: '**引用された 3 標本が repo に無い**（型 3・§7.10）。`SPECIMEN_LEDGER` の同名標本は別物' },
  { file: 'src/core/framingEnvelope.ts', table: 6, head: 'K | 横長 `d=5` の `need` 比 | 1 スロット | 21 スロット', kind: 'iteration-cost', why: 'K を 8192 まで上げる表。1 スロット 1,634 ms × 21 スロット = 34 s' },
  { file: 'src/core/framingEnvelope.ts', table: 7, head: '標本 | d | 成分 | M=4096 | M=65536 | 本物か', kind: 'iteration-cost', why: '`d` を 0.005 刻みで 1001 点掃いた表（M = 65536 込み）' },
  { file: 'src/core/framingEnvelope.ts', table: 8, head: '標本 | 下回った点 | 最悪 | 不足', kind: 'iteration-cost', why: '`envelopeFor` が厳密値を下回る点。0.005 刻み 1001 点 × 6 標本で、1 セルあたり 28〜32 秒' },
  { file: 'src/image/blendModel.ts', table: 1, head: 'モデル | 仮定 | `blendF32` / `blendF16` / `blendF16FlushSource`', kind: 'non-numeric', why: '3 つのモデルの仮定を並べた対照表。数が 1 つも無く、列は文である' },
  { file: 'src/image/columnLine.ts', table: 1, head: '入力（同一幾何・深度 378） | 位相を除いた残差', kind: 'gpu-browser', why: '位相を除いた残差。実 GPU の加算合成の読み戻しで、node では作れない' },
  { file: 'src/image/spriteGain.ts', table: 1, head: 's0 | S = k·s0 | gainFor | 誤差', kind: 'historical', why: '`gainFor` の**クランプを入れる前**の式の値。現在の export では `MIN_CALIBRATED_S0` で潰れる（写経すると `x/x`）' },
  { file: 'src/image/spriteGain.ts', table: 2, head: '構成 | `gain · Σw`（1.0 なら較正どおり）', kind: 'historical', why: '`gain · Σw` の実測。Phase 1b の線経路（畳み前）の構成で、現在の `linePoints` では作れない' },
  { file: 'src/image/spriteGain.ts', table: 3, head: '構成 | `sampleWeight` | 意味', kind: 'historical', why: '列平均線 `d = 0` の 0.0058472 は**畳み（Phase 2a）より前**の値。現構成では 2.21（下の `it` が数値で記録する）' },
  { file: 'src/image/spriteGain.ts', table: 5, head: 'dimLevel | モデル | 実測 平均 | 実測 **最大** | モデル/実測最大', kind: 'gpu-browser', why: 'モデルと GPU 実測の重なりの比較。実測列が実 GPU の読み戻し' },
  { file: 'src/image/spriteGain.ts', table: 6, head: 'dimLevel | 位相のみの予測 | 実測', kind: 'gpu-browser', why: '位相のみの予測と実測の比較。実測列が実 GPU の読み戻し' },
  { file: 'src/ingest/capabilities.ts', table: 1, head: '構成 | Chromium 148 | Safari 18.6', kind: 'gpu-browser', why: 'Chromium / Safari の canvas 色管理の実測' },
  { file: 'src/ingest/decode.ts', table: 1, head: ' | median', kind: 'gpu-browser', why: 'ブラウザの `createImageBitmap` の median 時間' },
  { file: 'src/ingest/format.ts', table: 1, head: ' | `createImageBitmap`', kind: 'gpu-browser', why: 'HEIC の `createImageBitmap` の可否（ブラウザ差）' },
  { file: 'src/ingest/ingest.ts', table: 1, head: '区間 | wall | メインスレッドの最長遮断', kind: 'gpu-browser', why: 'ブラウザでのメインスレッド遮断時間の実測（wall と最長遮断）。node に相当物が無い' },
  { file: 'src/ingest/orientProbe.ts', table: 1, head: '経路 | 結果', kind: 'gpu-browser', why: 'EXIF の向きをデコーダが適用するかの実測（4 経路 × 実ブラウザ）。node では作れない' },
  { file: 'src/ingest/session.ts', table: 1, head: ' | median', kind: 'gpu-browser', why: '取り込みの区間ごとの median 時間。ブラウザの実測で、機体とブラウザで変わる' },
  { file: 'src/render/blendProbe.ts', table: 1, head: ' | composer のバッファ | この器具', kind: 'non-numeric', why: '器具と composer の構成の対照表。数が 3 つしか無く、どれも設定値' },
  { file: 'src/scene/lensScene.ts', table: 1, head: ' | カメラ距離', kind: 'iteration-cost', why: 'resize 後 300 秒のカメラ距離。18,000F' },
  { file: 'src/tests/collapsePhase.test.ts', table: 1, head: '因子 | 大きさ | 正体', kind: 'gpu-browser', why: 'G9 の −17.58% を 2 因子へ割った内訳。実測側が実 GPU の読み戻しである' },
  { file: 'src/tests/compress.test.ts', table: 1, head: '刻み h | 最大隣接差 | 予算 0.12 比 | `差 / h`', kind: 'iteration-cost', why: '刻みを 64 倍まで細かくした隣接差の掃引。閉形式の上界は同ファイルが別に持つ' },
  { file: 'src/tests/docLedger.test.ts', table: 1, head: '表 | 書かれていた前提 | 本当の引数 | 印字値で計算すると', kind: 'self', why: 'この台帳自身の解説（型 5 の 4 例）。**自分で自分を採点しない**' },
  { file: 'src/tests/docLedger.test.ts', table: 2, head: '対象 | `npm test` の増分 | `npm run teeth` 換算（×54）', kind: 'self', why: 'この台帳自身の費用表。`npm test` の実測で、機体で変わる' },
  { file: 'src/tests/framing.test.ts', table: 1, head: '壊し方 | 既存 222 件', kind: 'historical', why: '`core/fit.ts` の表 1 と同じ Phase 1b の記録' },
  { file: 'src/tests/robustness.test.ts', table: 1, head: '穴 | 変異 | 1b の 276 件', kind: 'historical', why: 'Phase 1b の 276 件がこの変異を素通しした記録。いまは `scripts/teeth.mjs`' },
  { file: 'src/tests/robustness.test.ts', table: 2, head: '符号値 | Δ色相 | Δ彩度', kind: 'iteration-cost', why: 'P3 → sRGB の色相差。この表の掃引は `color.test.ts` が別に持っている' },
  { file: 'src/tests/specimen.test.ts', table: 1, head: '標本 | 寸法 | BALANCED | HIGH | ULTRA', kind: 'iteration-cost', why: '3 ティア × 6 標本の加算深度。格子を 3 通り作り直す' },
  { file: 'src/tests/survival.test.ts', table: 1, head: 'フェーズ | 何が起きたか', kind: 'non-numeric', why: 'どのフェーズで何が配線されていなかったかの年表。数が無い' },
  { file: 'src/tests/widen.test.ts', table: 1, head: '演算子 | `npm test` の費用（このホスト・2 回計測） | 新しく赤になった主張', kind: 'iteration-cost', why: '`npm test` 自身の費用（10.7 倍 / 1.8 倍）。機体で変わる' },
  { file: 'src/tests/widen.test.ts', table: 2, head: '変異 | 2c-vii の機構', kind: 'iteration-cost', why: '包絡を 21 スロット × 100 位相へ広げた実測' },
  { file: 'src/tests/widen.test.ts', table: 3, head: '格子 | 費用 | 最悪 | 育った点', kind: 'iteration-cost', why: '`layout()` を挟んだときに動く `d` の掃引 1001 点。1 点あたり数百フレーム回す' },
  { file: 'src/tests/widen.test.ts', table: 4, head: '掃引 | 最悪の超過率', kind: 'iteration-cost', why: '傾斜帯の代償を飽和まで回した 36,000 フレームの実測。1 点で 400 秒かかる' },
  { file: 'src/tests/widen.test.ts', table: 5, head: '`d` の刻み | 点数 | 動いた点 | 最悪', kind: 'iteration-cost', why: '国勢調査の内訳（掃引の分類）。数え方は同ファイルの `EXPECTED_SWEEPS` が持つ' },
  { file: 'src/tests/widen.test.ts', table: 6, head: '`d` | 門 | 600F | 900F | 18000F | 36000F | 初動', kind: 'iteration-cost', why: '国勢調査の内訳（点集合の規模）。数え方は同ファイルの `EXPECTED_POINT_SETS` が持つ' },
];

/**
 * **除外のラチェット。** 除外表は 1 行で書けるので、これが無いと
 * 被覆検査は「表を足したら除外を 1 行足す」で永久に通る。
 * 増やすときはこの数も同じ PR で上げること（差分に出る）。
 */
const EXPECTED_EXCLUDED = 44;

/** **台帳のラチェット。** 減らすならこの数も同じ PR で下げること */
const EXPECTED_LEDGER_CELLS = 87;

/**
 * 採点したセルの **doc 側の表記桁の総和**。桁を落とすと許容が緩むので、ここもラチェットにする。
 * 実測で埋めること（下の `it` が印字する）。
 */
const EXPECTED_DIGIT_SUM = 419;

// --------------------------------------------------------------------- 検査

const key = (t: { file: string; table: number }) => `${t.file}#${t.table}`;
const CORPUS_BY_KEY = new Map(CORPUS.map((t) => [key({ file: t.file, table: t.index }), t]));

function tableOf(e: TableRef): DocTable {
  const t = CORPUS_BY_KEY.get(key(e));
  if (!t) throw new Error(`${key(e)} という表は実装に無い（台帳が doc からずれている）`);
  return t;
}

const headOf = (t: DocTable) => t.header.join(' | ');

function cellNumber(t: DocTable, c: LedgerCell): DocNumber {
  const row = t.rows[c.row];
  if (!row) throw new Error(`${key({ file: t.file, table: t.index })} に ${c.row} 行目が無い`);
  const text = row[c.col];
  if (text === undefined) throw new Error(`${key({ file: t.file, table: t.index })} 行 ${c.row} に ${c.col} 列目が無い`);
  const nums = docNumbers(text);
  if (nums.length === 0) throw new Error(`セル「${text}」に数が無い`);
  if (nums.length > 1 && c.pick === undefined) {
    throw new Error(`セル「${text}」に数が ${nums.length} 個ある ── 台帳に pick を書くこと（位置で選ぶ）`);
  }
  return nums[c.pick ?? 0];
}

describe('doc の数を関数で再現する台帳（型 5）', () => {
  it('corpus の表を機械が数える', () => {
    const impl = CORPUS.filter((t) => !t.file.startsWith('src/tests/'));
    const tests = CORPUS.filter((t) => t.file.startsWith('src/tests/'));
    // eslint-disable-next-line no-console
    console.log(`表: 実装 ${impl.length} / テスト ${tests.length} / 合計 ${CORPUS.length}`);
    expect(CORPUS.length).toBeGreaterThanOrEqual(49);
    // **2 つの独立な定義が同じ本数を出すこと。** 片方にしか見えない表を書けば
    // 被覆検査を素通りできる ── 区切り行を 1 文字変えるだけで足りる
    expect(
      LOOSE_COUNT,
      `厳しい定義 ${CORPUS.length} 表・緩い定義 ${LOOSE_COUNT} 表。`
        + '走査器の片方にしか見えない表が在る（被覆検査を素通りする）',
    ).toBe(CORPUS.length);
  });

  it('台帳 ∪ 除外表 ⊇ 全表（表を足したら必ずどちらかを選ばせる）', () => {
    const covered = new Set([...LEDGER.map(key), ...EXCLUDED.map(key)]);
    const missing = CORPUS.filter((t) => !covered.has(key({ file: t.file, table: t.index })));
    expect(
      missing.map((t) => `${t.file}#${t.index}:${t.line} ${t.header.join(' | ')}`),
      '採点も除外もされていない表がある',
    ).toEqual([]);
  });

  it('除外表と台帳が実装からずれていない（消えた表を指していない）', () => {
    const stale = [...LEDGER, ...EXCLUDED]
      .filter((e) => !CORPUS_BY_KEY.has(key(e)))
      .map(key);
    expect(stale, '台帳・除外表が実装に無い表を指している').toEqual([]);
  });

  it('台帳と除外表が重なっていない', () => {
    const inLedger = new Set(LEDGER.map(key));
    expect(EXCLUDED.filter((e) => inLedger.has(key(e))).map(key)).toEqual([]);
  });

  it('除外の本数がラチェットを超えていない', () => {
    expect(
      EXCLUDED.length,
      `除外が ${EXCLUDED.length} 件ある（${EXPECTED_EXCLUDED} 件のはず）。`
        + '増やすなら EXPECTED_EXCLUDED も同じ PR で上げること',
    ).toBeLessThanOrEqual(EXPECTED_EXCLUDED);
    for (const e of EXCLUDED) {
      expect(e.why.length, `${key(e)} の理由が短すぎる`).toBeGreaterThanOrEqual(24);
    }
    // **同じ理由の貼り付けを止める。** 「TODO」を 44 行並べれば被覆検査は通る
    const reasons = EXCLUDED.map((e) => e.why);
    expect(new Set(reasons).size, '除外の理由が重複している').toBe(reasons.length);
  });

  /**
   * **表記桁のラチェット**（独立監査の X4）。doc の桁を落とせば許容が緩む ──
   * `0.218262` を `0.2` に書き換えると、RN の表が RTZ の関数でも通る。
   * 桁の総和を持てば、**緩めたことが数として差分に出る**。
   */
  it('doc の表記桁が落ちていない', () => {
    let sum = 0;
    for (const e of LEDGER) {
      const t = tableOf(e);
      for (const c of e.cells) sum += Math.max(0, cellNumber(t, c).decimals);
    }
    // eslint-disable-next-line no-console
    console.log(`採点したセルの表記桁の総和: ${sum}`);
    expect(
      sum,
      `表記桁の総和が ${sum}（${EXPECTED_DIGIT_SUM} あったはず）。`
        + 'doc の桁を落とすと許容が緩む。落とすなら同じ PR でこの数も下げること',
    ).toBeGreaterThanOrEqual(EXPECTED_DIGIT_SUM);
  });

  it('指し先のヘッダが一致する（表を 1 つ挿すと添字が黙ってずれる）', () => {
    const wrong = [...LEDGER, ...EXCLUDED]
      .filter((e) => CORPUS_BY_KEY.has(key(e)))
      .filter((e) => headOf(tableOf(e)) !== e.head)
      .map((e) => `${key(e)}\n    台帳: ${e.head}\n    実装: ${headOf(tableOf(e))}`);
    expect(wrong, '台帳・除外表の指し先がずれている').toEqual([]);
  });

  it('台帳がテストファイルの表を採点していない（自己参照の禁止）', () => {
    // **`docLedger.test.ts` だけを禁じても足りない**（独立監査の X7）──
    // 別のテストファイルに自分で表を書けば、自分で書いた数を自分で緑にできる
    expect(LEDGER.filter((e) => e.file.startsWith('src/tests/')).map(key)).toEqual([]);
  });

  it('doc の側が関数名を名乗っている（どのモデルの表かを台帳の側だけに持たない）', () => {
    const silent: string[] = [];
    for (const e of LEDGER) {
      const t = tableOf(e);
      const hay = `${e.head}\n${t.preamble}`;
      for (const name of e.fn) {
        if (!hay.includes(name)) silent.push(`${key(e)} が ${name} を doc で名乗っていない`);
      }
      expect(e.fn.length, `${key(e)} が関数名を 1 つも宣言していない`).toBeGreaterThan(0);
    }
    expect(silent, 'doc が関数名を名乗っていない表がある').toEqual([]);
  });

  it('台帳のセル数がラチェットを下回っていない', () => {
    const n = LEDGER.reduce((a, e) => a + e.cells.length, 0);
    expect(
      n,
      `台帳のセルが ${n} 個（${EXPECTED_LEDGER_CELLS} 個のはず）。減らすなら同じ PR で数も下げること`,
    ).toBeGreaterThanOrEqual(EXPECTED_LEDGER_CELLS);
  });

  it('採点しない行・列に理由が書いてある（黙って飛ばさない）', () => {
    for (const e of LEDGER) {
      const t = tableOf(e);
      const scoredCols = new Set(e.cells.map((c) => c.col));
      const scoredRows = new Set(e.cells.map((c) => c.row));
      for (let col = 0; col < t.header.length; col++) {
        if (scoredCols.has(col)) continue;
        expect(
          e.skipCols?.[col],
          `${key(e)} の ${col} 列目（${t.header[col]}）が採点も説明もされていない`,
        ).toBeTruthy();
      }
      for (let row = 0; row < t.rows.length; row++) {
        if (scoredRows.has(row)) continue;
        expect(
          e.skipRows?.[row],
          `${key(e)} の ${row} 行目（${t.rows[row].join(' | ')}）が採点も説明もされていない`,
        ).toBeTruthy();
      }
    }
  });

  /**
   * **本体。** doc のテキストから期待値を読み、関数を呼んで、doc の表記桁で比べる。
   * 台帳に期待値は 1 つも書かれていない（規律 1）。
   */
  it('宣言した関数と引数が doc の数を再現する', { timeout: 120_000 }, () => {
    const bad: string[] = [];
    for (const e of LEDGER) {
      const t = tableOf(e);
      for (const c of e.cells) {
        const doc = cellNumber(t, c);
        const got = c.compute(c.args);
        if (!sameAtDocPrecision(got, doc)) {
          const args = Object.entries(c.args).map(([k, v]) => `${k}=${v}`).join(', ');
          bad.push(
            `${key(e)}:${t.line} 行${c.row} 列${c.col}（${t.header[c.col]}）`
              + ` doc=${doc.token} got=${got} 引数[${args}]`,
          );
        }
      }
    }
    expect(bad, `doc の数を再現できないセルが ${bad.length} 個ある`).toEqual([]);
  });

  /**
   * **規律 3。** 宣言した引数を 1 つずつ揺らして、doc の表記桁を超えて動くことを要求する。
   * 動かない引数は `inert` に理由つきで書かせ、**`inert` の側も検証する**
   * （動いてしまう引数を `inert` と書けば赤になる）。
   */
  it('宣言した引数が実際に効いている（飾りの引数を落とす）', { timeout: 120_000 }, () => {
    const decorative: string[] = [];
    const wronglyInert: string[] = [];
    let inertCells = 0;
    let cells = 0;
    for (const e of LEDGER) {
      const t = tableOf(e);
      for (const c of e.cells) {
      cells++;
      const doc = cellNumber(t, c);
      const tol = 10 ** -Math.max(0, doc.decimals);
      const base = c.compute(c.args);
      let moved = 0;
      for (const name of Object.keys(c.args)) {
        const v = c.args[name];
        // **両側へ揺らす。** 片側だけだと飽和する引数を「無関係」と読み違える ──
        // `viewportAspect` を上げると `fitDistance` の max が縦側へ移り、そこから先は動かない。
        // 実際にこの検査を片側で書いたとき、この repo の主題そのもの（`viewportAspect`）が
        // 「飾り」と判定された。
        const perturb = (f: number) => {
          if (v === 0) return f > 1 ? 1 : -1;
          const p = v * f;
          if (!Number.isInteger(v)) return p;
          const r = Math.round(p);
          return r === v ? v + (f > 1 ? 1 : -1) : r;
        };
        const trials = c.discrete?.[name]
          ? c.discrete[name].filter((x) => x !== v)
          : [perturb(1.25), perturb(0.8)];
        expect(trials.length, `${key(e)} の ${name} に揺らし先が無い`).toBeGreaterThan(0);
        const moves = trials.map((vp) => ({ vp, by: Math.abs(c.compute({ ...c.args, [name]: vp }) - base) }));
        const best = moves.reduce((a, b) => (a.by >= b.by ? a : b));
        const declaredInert = c.inert?.[name] !== undefined;
        if (best.by > tol) {
          moved++;
          if (declaredInert) {
            wronglyInert.push(`${key(e)} の ${name}: ${v} → ${best.vp} で ${best.by} 動く（inert と書いてある）`);
          }
        } else if (!declaredInert) {
          decorative.push(
            `${key(e)} の ${name}: ${v} → ${moves.map((m) => m.vp).join(' / ')} のどちらにしても`
              + ` ${best.by} しか動かない（doc の表記桁 ${doc.decimals} 桁 = ${tol}）。`
              + '無関係なら inert に理由を書くこと',
          );
        }
      }
      if (moved === 0) inertCells++;
      }
    }
    // eslint-disable-next-line no-console
    console.log(`感度検査: ${cells} セル全部を揺らした（全引数が inert のセル ${inertCells}）`);
    expect(decorative, '飾りで宣言された引数がある').toEqual([]);
    expect(wronglyInert, 'inert と書いた引数が実際には効いている').toEqual([]);
  });

  /**
   * **規律 1 に歯を付ける。** doc の数を書き換えたら赤になることを、
   * この場で実際に書き換えて確かめる（台帳が doc を読んでいることの確認）。
   *
   * `scripts/teeth.mjs` は `src/` の実装を壊す道具なので、
   * **「doc のテキストを壊す」歯はここにしか置けない。**
   */
  it('doc の数を 1 つ書き換えると、そのセルが赤になる', () => {
    const e = LEDGER[1]; // halfFloat の誤差表
    const t = tableOf(e);
    const c = e.cells[0];
    const doc = cellNumber(t, c);
    expect(sameAtDocPrecision(c.compute(c.args), doc)).toBe(true);
    // doc の数だけを 999 に差し替えた偽の表で同じ照合をする
    const forged: DocNumber = { value: 999, decimals: doc.decimals, token: '999' };
    expect(sameAtDocPrecision(c.compute(c.args), forged)).toBe(false);
    // **表記桁を落として通す道**も塞がっていないことを記録する（この機構の弱点）
    const coarse: DocNumber = { value: 0, decimals: 0, token: '0' };
    expect(sameAtDocPrecision(0.4, coarse)).toBe(true);
  });

  /**
   * **`spriteGain.ts` の表 3 が現構成では再現しないことを、数で留める。**
   *
   * doc の「列平均線 `d = 0` → 0.0058472」は**畳み（Phase 2a）より前**の値である。
   * `lensScene` の線経路は `extentX = 0` で `linePoints = 1` へ畳むので、
   * `collapseWeight` は基準格子の被覆そのもの（≈ 2.21）を返す。
   *
   * この数は `image/blendModel.ts` の `GAIN_TIMES_SAMPLE_WEIGHT` に
   * **生きたリテラルとして焼かれている** ── ただしそちらが再現しているのは
   * §4.6 の「深度 378 の二値実験」、つまり**畳む前の構成**なので、
   * 焼かれていること自体は正しい。**doc の表が構成を書いていないのが誤り**である。
   */
  it('畳み前と畳み後の `sampleWeight` を両方記録する（除外の理由を数で裏づける）', () => {
    const s0 = 2.2478;
    const S = 8.6548;
    const before = collapseWeight({
      s0x: s0, s0y: s0, spritePx: S, extentX: 0, extentY: 0, nx: 378, ny: 1, refNx: 378, refNy: 236,
    });
    const after = collapseWeight({
      s0x: s0, s0y: s0, spritePx: S, extentX: 0, extentY: 0, nx: 1, ny: 1, refNx: 378, refNy: 236,
    });
    // 畳む前は doc の 0.0058472 と 3 桁一致する。畳んだあとは 3 桁違う
    expect(before).toBeGreaterThan(0.0058);
    expect(before).toBeLessThan(0.0059);
    expect(after).toBeGreaterThan(2.2);
    expect(after / before).toBeGreaterThan(370);
  });
});
