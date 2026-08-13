/**
 * **型 2「掃引が主張より狭い」を機構にする**（Phase 2c-vii）。
 *
 * ## なぜ「刻みを細かくする」ではないのか —— 実測で設計が覆った
 *
 * 当初の設計は「各掃引の刻みを 4 倍細かくして、値が動いたらその掃引は狭い」だった。
 * **測ると、この repo ではほとんど効かない。**
 *
 * | 演算子 | `npm test` の費用（このホスト・2 回計測） | 新しく赤になった主張 |
 * |---|---|---|
 * | 刻みを 4 倍細かく（`--density`） | 監査の実測で 4.29s → **45.9s（10.7 倍）** | **0 本 / 19 本** |
 * | **1 点の軸を全域へ広げる（この節）** | **6.23 / 6.60s → 12.28 / 10.64s（約 1.8 倍）** | **3 本** |
 *
 * 内訳: 包絡 21 スロット × 100 位相 **2.9s** / `layout()` 掃引 **1.8s** /
 * ランプ帯 1500F × 9 点 **3.3s**（軽い格子。HIGH なら 14.2s）/ 国勢調査 0.02s。
 *
 * **`npm test` の 1 秒は `npm run teeth` では 53 秒になる。** 変異 53 本を 1 本ずつ
 * 試す仕組みなので、ここでの 1 秒が向こうで 1 分近くになる ──
 * **`npm test` 単体の費用だけを見て「載せられる」と判断してはいけない。**
 *
 * 理由は §7.10 の型 2 の 6 件を見れば分かる ── 「位相 0 の HDR」はデータ表、
 * 「候補 32」「位相 4096」「600 フレーム」「G9 の 2 フェーズ」は**反復回数**、
 * 「`n ≤ 512`」は 2c-v で既に折れ点列挙へ置き換えた。**刻みの掃引は 1 件も無い。**
 * 「刻みを 4 倍」で実装すると、名指しした 6 件のうち **0 件**に当たっていた。
 *
 * この repo の穴は「歩幅が大きすぎた」ではなく「**1 歩しか歩いていなかった**」である。
 *
 * ## この機構が引き受けるもの
 *
 *   1. **国勢調査** ── `src/tests/*.ts` の掃引を機械が数える。
 *      本数が人によって割れた（私 88 / 監査 A 123 / 監査 C 12）ので、
 *      **数え方を機械が持たないと本数は意見になる**
 *   2. **軸を広げた実測** ── 1 点に固定された軸を全域へ広げ、見えるものを留める
 *
 * ## この機構自身の限界（正直に）
 *
 * - **「広げて動かなかった」は「十分」の証明ではない。** ここで広げているのは
 *   `d` 軸と位相軸と反復軸だけで、標本・ティア・viewport は 1 種のままである（型 3）
 * - **反復軸は飽和まで回していない。** ランプ帯の後退は 1500F で見える量にとどまり、
 *   36000F まで回すと **×1.4035**（`d = 2.20`）。ここは費用で切っており、
 *   **切ったことを数字で書く**のがこの節の義務である
 * - **`d` 刻み 0.05 は 0.005 の 1/10 しか見ていない。** `layout()` の反例は
 *   0.005 で 14/1001 点、0.05 で 1/101 点、**0.25（2c-vi まで）で 0/21 点**。
 *   いま拾えているのは 14 点中 1 点である
 * - **`EXPECTED_SWEEPS` は「人が数字を上げれば通る」形**で、型 1 の再演になりうる
 *   （§7.10 が `EXPECTED_TOOTHED_BUDGETS` について書いた弱点と同じ）
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_CANDIDATES,
  ENVELOPE_DIM_STEP,
  ENVELOPE_PHASES,
  ENVELOPE_SLOTS,
  ORBIT_PERIOD,
  createEnvelopeScratch,
  extentFor,
  framingEnvelope,
} from '../core/framingEnvelope';
import { PLANES } from '../render/rotationSchedule';
import { composeRotN, foldExtent, liftProject5, safeDist } from '../math/rotationN';
import { makeSpecimen0 } from '../image/fixture';
import { linearizeRgba } from '../image/linearize';
import { computeScales, computeStats } from '../image/stats';
import { fitGrid, TIER_BUDGET } from '../image/grid';
import { makeLiftPayload } from '../ingest/session';
import { LensScene } from '../scene/lensScene';
import { CAMERA_FOV } from '../core/engine';

// ---------------------------------------------------------------------------
// 1. 国勢調査 —— 掃引を機械が数える
// ---------------------------------------------------------------------------

/**
 * 掃引の分類。**機械が候補を出し、人が分類し、未分類が在るかぎり赤**にする
 * （`ladder:budgets` と同じ形）。分類そのものを機械にはできない ──
 * `i += 3` が「vec3 のストライド（完全列挙）」なのか「間引き（標本）」なのかは
 * 意味の問題で、正規表現では決まらない。**決まらないことを認めて台帳に書く。**
 */
type SweepKind =
  /** 実数区間を刻む。刻みが粗ければ見落とす */
  | '量子化'
  /** 時間・反復を途中で切る。短ければ見落とす */
  | '切り詰め'
  /** 手で選んだ点の集合。点の間を見ていない */
  | '点集合'
  /** 有限集合を余さず舐める。標本ではないので密度の概念が無い */
  | '完全列挙';

const SWEEP_LINE = /for\s*\(\s*(?:let|const)\s/;

/**
 * **コメント行を除く**（Phase 2c-viii）。
 *
 * 2c-vii の国勢調査は**自分自身の説明文を掃引として数えていた** ── 下の
 * 「`for (const x of y)` は本体が波括弧でないこともある」という注釈行が
 * `SWEEP_LINE` に当たり、`完全列挙` として 1 本計上されていた。
 * 独立監査が発見した。**数える機械が自分の説明を数える**のは型 1 の一種である。
 */
const isComment = (line: string): boolean => {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
};

/** 1 行から掃引らしさを読む。**読めなかったら `null` を返す**（人へ回す） */
function classifyLine(line: string, following: string): SweepKind | null {
  const step = /for\s*\(\s*let\s+(\w+)\s*=\s*[^;]+;[^;]*;\s*\1\s*(\+=|\*=)\s*([^)]+)\)/.exec(line);
  if (step) {
    const inc = step[3].trim();
    // 配列のレコード幅ぶん進むもの（`i += 3` / `+= 4` / `+= 5`）は完全列挙。
    // 判定は「ループ本体が添字を掛け算に使っているか」ではなく、
    // 上限が `.length` か `w*h` かで見る ── これも完全ではない（下の未分類へ落ちる）
    const bounded = /\.length|width\s*\*\s*height|w\s*\*\s*h|\bn\b\s*[;)]/.test(line);
    if (step[2] === '+=' && /^[0-9]+$/.test(inc) && bounded) return '完全列挙';
    return '量子化';
  }
  const cnt = /for\s*\(\s*let\s+(\w+)\s*=\s*[^;]+;\s*\1\s*<=?\s*([^;]+);\s*\1(?:\+\+|\s*\+=\s*1)\s*\)/.exec(line);
  if (cnt) {
    const limit = cnt[2].trim();
    const advancesTime = /advancePhases|\.update\(/.test(line + following);
    if (advancesTime && /^[0-9_]+$/.test(limit)) return '切り詰め';
    return '完全列挙';
  }
  // `for (const x of y)` は本体が波括弧でないこともある（`for (const v of a) expect(...)`）
  const ofIdx = line.indexOf(' of ');
  if (/for\s*\(\s*const\s/.test(line) && ofIdx >= 0) {
    return line.slice(ofIdx + 4).trim().startsWith('[') ? '点集合' : '完全列挙';
  }
  return null;
}

/**
 * **実測（Phase 2c-vii・この数え方で）。** 数え方を変えれば数は変わる ──
 * 私の別の数え方では 88、監査 A の数え方では 123、監査 C の数え方では 12 だった。
 * **だから数え方をここに固定する。** この数字自体には意味が無く、
 * 「掃引が増えたのに誰も分類していない」を検出するためだけに在る。
 */
const EXPECTED_SWEEPS = { 量子化: 12, 切り詰め: 16, 点集合: 65, 完全列挙: 179 } as const;

/**
 * **点集合の規模の台帳**（Phase 2c-viii）。
 *
 * ## 行数を数えるだけでは、掃引は静かに狭められる
 *
 * 上の国勢調査は `for` の**行数**しか見ていない。**行数はそのままで幅だけ縮める**変異は、
 * 数字を 1 つも動かさずに緑で通る。独立監査が 9 通り試し、**4 通りが通った**:
 *
 * | 変異 | 2c-vii の機構 |
 * |---|---|
 * | `survival` の `CASES` を 2 標本 → 1（**2c-iv の教訓の撤回**） | 🟢 通る |
 * | `survival` の `DIMS` を 9 → 2 水準（3,960 → 880 セル） | 🟢 通る |
 * | `framing` の `VIEWPORTS` を 3 → 1 | 🟢 通る |
 * | ランプ帯を 9 点 → 2 点 | 🟢 通る |
 *
 * → **要素数を数える。** 名前つきの配列リテラルを反復している掃引について、
 * その要素数を台帳に持ち、**下回ったら赤**にする。上の 4 通りは全部ここで止まる。
 *
 * ## 合計ではなく 1 本ずつ持つ理由
 *
 * 合計だけを見ると、**片方を縮めて他方を伸ばせば相殺できる**。
 * 1 本ずつ持てばその逃げ道が無い。新しい掃引が増えるぶんには何も言わない
 * （台帳に無い名前は自由）── この機構が主張するのは「**狭まっていないこと**」だけである。
 *
 * ## 射程（正直に）
 *
 * - **同じファイルの中で配列リテラルとして定義された名前**しか読めない。
 *   他ファイルから import した点集合（`SPECIMEN_LEDGER` など）は数えられない
 * - `for (let i = 0; i < N; i++)` の `N` が名前つき定数のときも読めない
 *   （監査の実測: 249 本のうち **120 本**は規模を静的に読めない）
 * - **要素数は「幅」ではない。** `DIMS` の 9 点が `[0, 0.5, …]` から `[0, 0, …]` へ
 *   変わっても本数は 9 のままである。値の分布は見ていない
 */
const EXPECTED_POINT_SET_SIZES: Readonly<Record<string, number>> = {
  'collapse.test.ts:cases': 7,
  'collapse.test.ts:targets': 6,
  'collapsePhase.test.ts:TIERS': 3,
  'color.test.ts:corners': 6,
  'color.test.ts:PAIRS': 12,
  'fit.test.ts:cases': 4,
  'framing.test.ts:VIEWPORTS': 4,
  'protocol.test.ts:cases': 4,
  'survival.test.ts:CASES': 2,
  // **2c-ix で足した。** 独立監査が「`EVENTS` から `layout` の 2 本を消しても
  // 全走行 EXIT=0」を実演した ── そのコメントは「これが 2c-iv のバグを捕まえる経路」である。
  // 点集合の台帳に無い名前は、この機構が 1 ビットも見ていない
  'survival.test.ts:EVENTS': 10,
  'survival.test.ts:DIMS': 9,
  'vendor.test.ts:EXPECTED': 7,
  'widen.test.ts:RAMP': 9,
};

/**
 * `const NAME = [ … ]` の要素数を読む。入れ子と末尾コンマを勘定に入れる。
 *
 * **型注釈に `=>` が入ると読めなかった**（Phase 2c-ix・独立監査が実演）──
 * `[^=]+` が矢印の `=` で止まるので、`const EVENTS: Array<[string, (s: LensScene) => void]>`
 * は名前ごと見えず、**`EVENTS` から `layout` の 2 本を消しても全走行 EXIT=0** だった。
 * あの 2 行に付いているコメントは「これが 2c-iv のバグを捕まえる経路」である。
 * **読めない名前は「無い」と同じ**なので、走査器のほうを直した。
 */
function literalSizes(src: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = /(?:const|let)\s+([A-Za-z_$][\w$]*)(?:\s*:[^=]*(?:=>[^=]*)*)?\s*=\s*\[/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = re.lastIndex;
    let depth = 1;
    let commas = 0;
    let empty = true;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (c === '[' || c === '(' || c === '{') depth++;
      else if (c === ']' || c === ')' || c === '}') depth--;
      else if (c === ',' && depth === 1) commas++;
      if (depth === 1 && !/\s/.test(c) && c !== ',') empty = false;
    }
    if (depth !== 0) continue;
    const trailing = /,\s*$/.test(src.slice(re.lastIndex, i - 1)) ? 1 : 0;
    out.set(m[1], empty ? 0 : commas + 1 - trailing);
  }
  return out;
}

describe('掃引の国勢調査', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts')).sort();

  it('掃引を機械が数える（分類できない行が 1 本も無い）', () => {
    const tally: Record<string, number> = { 量子化: 0, 切り詰め: 0, 点集合: 0, 完全列挙: 0 };
    const unreadable: string[] = [];
    for (const f of files) {
      const lines = readFileSync(join(dir, f), 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!SWEEP_LINE.test(lines[i]) || isComment(lines[i])) continue;
        const kind = classifyLine(lines[i], lines.slice(i + 1, i + 4).join(' '));
        if (kind === null) unreadable.push(`${f}:${i + 1}  ${lines[i].trim().slice(0, 90)}`);
        else tally[kind]++;
      }
    }
    // **読めなかった行は人へ回す。** 黙って数えないのが `record(…, null)` の型
    expect(unreadable, `分類できない for 行:\n${unreadable.join('\n')}`).toEqual([]);
    expect(tally, JSON.stringify(tally)).toEqual({ ...EXPECTED_SWEEPS });
  });

  /**
   * **標本掃引が全体の何割か**を出しておく。完全列挙は密度の概念を持たないので、
   * 型 2 の機構が届く範囲はここで頭打ちになる。
   */
  it('標本掃引は 93 / 272 本（残り 179 本は完全列挙で密度の概念が無い）', () => {
    const sample = EXPECTED_SWEEPS.量子化 + EXPECTED_SWEEPS.切り詰め + EXPECTED_SWEEPS.点集合;
    expect(sample).toBe(93);
    // **249 → 251**（2c-viii）。内訳は −1 と +3 である:
    //   −1: 国勢調査が数えていた**自分の説明文**（コメント行）を除いた
    //   +3: 下の「点集合の規模」が台帳とファイルを舐めるための完全列挙 3 本
    // **251 → 272**（2c-ix）。+21 はすべて `docLedger.test.ts` の完全列挙で、
    // corpus・台帳・除外表・セルを舐める `for` である。**標本掃引は 1 本も増えていない**
    // （93 は据え置き）── doc の数を再現する機構は、掃引を広げる機構ではない。
    // **後者は自分で足した掃引を自分で数えている。** 完全列挙なので密度の概念は無く、
    // 幅の主張には使えない ── 本数が増えたことを「広くなった」と読んではいけない。
    expect(sample + EXPECTED_SWEEPS.完全列挙).toBe(272);
  });

  /**
   * **点集合が狭められていないか。** 上の 3 本は行数しか見ないので、
   * 幅を縮める変異（標本 2 → 1・水準 9 → 2）を 1 本も捕まえない。
   */
  it('名前つき点集合の要素数が台帳を下回らない', () => {
    const found = new Map<string, number>();
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      const sizes = literalSizes(src);
      for (const line of src.split('\n')) {
        if (isComment(line)) continue;
        const m = /for\s*\(\s*const\s+.*?\bof\s+([A-Za-z_$][\w$]*)\s*\)/.exec(line);
        if (!m) continue;
        const size = sizes.get(m[1]);
        if (size !== undefined) found.set(`${f}:${m[1]}`, size);
      }
    }
    // **台帳そのものが消せてはいけない。** 行を消せば掃引は「台帳に無い名前」になり、
    // 縮めても何も言われなくなる ── 機構の中に同じ穴を掘らないための 1 行である。
    expect(Object.keys(EXPECTED_POINT_SET_SIZES).length).toBeGreaterThanOrEqual(12);
    const shrunk: string[] = [];
    for (const [key, want] of Object.entries(EXPECTED_POINT_SET_SIZES)) {
      const got = found.get(key);
      if (got === undefined) shrunk.push(`${key}: 掃引ごと消えた（${want} 点あった）`);
      else if (got < want) shrunk.push(`${key}: ${want} → ${got} 点へ縮んだ`);
    }
    expect(
      shrunk,
      `点集合が狭まっている:\n${shrunk.join('\n')}\n`
        + '正当に減らしたのなら、この PR の中で EXPECTED_POINT_SET_SIZES も下げること',
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. 軸を広げた実測
// ---------------------------------------------------------------------------

const spec = makeSpecimen0();
const canonical = linearizeRgba(spec.rgba, spec.width, spec.height, 'srgb');
const stats = computeStats(canonical);
const scales = computeScales(stats);
const grid = fitGrid(canonical.width, canonical.height, TIER_BUDGET.HIGH);
const lifted = makeLiftPayload(canonical, grid, scales);
const count = grid.cols * grid.rows;
const cascadeDist = safeDist(lifted.maxNorm);
const ALL_PRESENT = [true, true, true, true, true];

function buildScene(): LensScene {
  return new LensScene({
    grid,
    base: lifted.base,
    colors: lifted.colors,
    columnMeans: stats.columnMeans,
    scales,
    width: canonical.width,
    height: canonical.height,
    gamut: canonical.gamut,
    maxNorm: lifted.maxNorm,
    plate: null,
  });
}

/**
 * **測定用の軽い格子**（`framing.test.ts` と同じ 20,000 点）。
 *
 * 反復軸の掃引は 9 点 × 1500 フレームなので、点数がそのまま費用になる。
 * **軽くしても現象は残ることを先に測った**（1500F・`d = 2.25` の後退）:
 *
 * | 格子 | 費用 | 最悪 | 育った点 |
 * |---|---|---|---|
 * | HIGH 89,304 | 14.24s | ×1.082658 | 下側 1・上側 4 |
 * | **軽 20,000** | **3.25s** | **×1.082529**（差 0.012%） | 下側 1・上側 4 |
 * | 軽 8,000 | 1.52s | ×1.080196（差 0.23%） | 下側 1・上側 4 |
 *
 * **`npm test` の 1 秒は `npm run teeth` では 53 秒になる**（変異 53 本 × 1 回ずつ）。
 * ここを HIGH のままにすると teeth への寄与だけで 11.4 分 ── 費用の 7 割が 1 本に乗る。
 * 包絡の行は `framingEnvelope.test.ts` と数字を突き合わせる必要があるので HIGH のまま。
 */
const lightGrid = fitGrid(canonical.width, canonical.height, 20_000);
const lightLifted = makeLiftPayload(canonical, lightGrid, scales);

function buildLightScene(): LensScene {
  return new LensScene({
    grid: lightGrid,
    base: lightLifted.base,
    colors: lightLifted.colors,
    columnMeans: stats.columnMeans,
    scales,
    width: canonical.width,
    height: canonical.height,
    gamut: canonical.gamut,
    maxNorm: lightLifted.maxNorm,
    plate: null,
  });
}

describe('軸を広げる（型 2）', () => {
  /**
   * ## 包絡は 21 スロット中 2 つで実際に超えられる
   *
   * `framingEnvelope.test.ts` の「掃いていない 40 位相のどれも包絡を 2% 以上は超えない」は
   * **`d = 3` の 1 点 × 40 位相の 1 セル**しか測っていない。そして `d = 3` は
   * 全開域で唯一まったく動かない点である（下の反復軸の節を見よ）。
   *
   * **実測（Phase 2c-vii）**: `d` を 21 スロットへ、位相を 100 本へ広げると
   *
   * | 掃引 | 最悪の超過率 |
   * |---|---|
   * | `d = 3` × 40 位相（2c-vi の掃引） | **94.226%** |
   * | `d` 21 点 × 40 位相 | 99.989%（`d = 0.25`） |
   * | **`d` 21 点 × 100 位相** | **100.124%（`d = 1.75`）** |
   * | `d` 21 点 × 400 位相 | 100.326%（`d = 2.75`） |
   *
   * → **`d = 3` の 94.226% という「余裕 5.8 ポイント」は、21 × N セル中
   * いちばん有利な 1 セルの値だった。** 実際には包絡は超えられる。
   *
   * `framingEnvelope.ts` のコメントは「見積もりであって上界ではない」と正しく書いており、
   * 柵 2% も割っていない ── **狭かったのは掃引であって、主張ではない。**
   * ここでは超過が起きることそのものを留める（消えたら包絡の性質が変わっている）。
   */
  it('包絡は 100% を超える点を持つ（21 スロット × 100 位相）', () => {
    const extent = new Float64Array(5);
    const m = new Float64Array(25);
    const proj = new Float32Array(count * 3);
    let worst = 0;
    let worstAt = '';
    let exceeded = 0;
    for (let si = 0; si < ENVELOPE_SLOTS; si++) {
      const d = si * ENVELOPE_DIM_STEP;
      extentFor(d, ALL_PRESENT, extent);
      const env = framingEnvelope(
        lifted.base, count, extent, cascadeDist,
        createEnvelopeScratch(ENVELOPE_CANDIDATES), ENVELOPE_PHASES,
      );
      if (!(env.aX > 0)) continue; // d = 0 は図が 1 点
      let slotWorst = 0;
      for (let i = 0; i < 100; i++) {
        const s = ORBIT_PERIOD * ((i * Math.SQRT2) % 1);
        extentFor(d, ALL_PRESENT, extent);
        const angles = PLANES.map((p) => ({ i: p.i, j: p.j, angle: p.omega * s }));
        composeRotN(angles, 5, m);
        foldExtent(m, 5, extent);
        liftProject5(lifted.base, count, m, cascadeDist, proj);
        let aX = 0, aY = 0, zHi = 0;
        for (let v = 0; v < count; v++) {
          const o = v * 3;
          const x = Math.abs(proj[o]);
          const y = Math.abs(proj[o + 1]);
          if (x > aX) aX = x;
          if (y > aY) aY = y;
          if (proj[o + 2] > zHi) zHi = proj[o + 2];
        }
        slotWorst = Math.max(slotWorst, aX / env.aX, aY / env.aY, env.zHi > 0 ? zHi / env.zHi : 0);
      }
      if (slotWorst > 1) exceeded++;
      if (slotWorst > worst) { worst = slotWorst; worstAt = `d=${d}`; }
    }
    // 柵 2% は割らない（`framingEnvelope.test.ts` の主張はそのまま真）
    expect(worst, `最悪 ${(worst * 100).toFixed(3)}% @${worstAt}`).toBeLessThan(1.02);
    // **しかし 100% は超える。** `d = 3` の 1 点だけでは見えなかった事実を留める
    expect(worst, `最悪 ${(worst * 100).toFixed(3)}% @${worstAt}`).toBeGreaterThan(1.0);
    expect(exceeded, `100% を超えたスロット数`).toBeGreaterThanOrEqual(1);
  }, 60_000);

  /**
   * ## `layout()` の反例は `d` を広げないと 1 点も見えない
   *
   * `framingEnvelope.test.ts:310`「`layout()` を挟んでも、カメラ距離は 600 フレーム回して
   * 1 ビットも動かない」は題に `d` の限定が無いが、測っているのは `d = 3` の 1 点である
   * （兄弟の :281 は 2c-vi で「`d = 3` では」と狭めたが、こちらは狭めていない）。
   *
   * **実測（Phase 2c-vii）**: `layout()` を 2 回通した前後でカメラ距離が動く点の数
   *
   * | `d` の刻み | 点数 | 動いた点 | 最悪 |
   * |---|---|---|---|
   * | **0.25（2c-vi）** | 21 | **0** | — |
   * | **0.05（ここ）** | 101 | **1**（`d = 2.15`） | 3.674e−6 |
   * | 0.005 | 1001 | **14**（`d ∈ [2.110, 2.175]`） | 1.622e−5 @ `d = 2.175` |
   *
   * 帯は門の傾斜帯の入口だけに在る（`gate(2.110) = 0.0024`〜`gate(2.175) = 0.1181`）。
   * **0.005 まで細かくすると 18.75 秒かかるので 0.05 で切った** ── いま拾えているのは
   * 14 点中 1 点である。**切ったことをここに書く。**
   */
  it('layout() を挟むとカメラ距離が動く d が在る（刻み 0.05 で 1/101 点）', () => {
    const relayoutOf = (scene: LensScene) => () =>
      scene.layout({
        camera: new THREE.PerspectiveCamera(CAMERA_FOV, 988 / 778, 0.1, 100),
        viewportAspect: 988 / 778,
        bandFrac: 1,
        pxPerWorld: 778 / (2 * Math.tan((CAMERA_FOV * Math.PI) / 360)),
        maxPointSize: 1024,
      });
    const moved: string[] = [];
    let worst = 0;
    for (let d = 0; d <= 5.0001; d += 0.05) {
      const scene = buildScene();
      const relayout = relayoutOf(scene);
      relayout();
      scene.setDimLevel(d);
      scene.update(1 / 60);
      const before = scene.stats().cameraDistance;
      relayout();
      scene.update(1 / 60);
      const after = scene.stats().cameraDistance;
      if (!Object.is(before, after)) {
        moved.push(`d=${d.toFixed(3)}`);
        worst = Math.max(worst, Math.abs(after / before - 1));
      }
    }
    // **1 点でも動くことを留める。** これが 0 になったら包絡の入り方が変わっている
    expect(moved.length, `動いた d: ${moved.join(' ')}`).toBeGreaterThanOrEqual(1);
    // 動く量は 1e-4 未満（絵としては見えない）。ここが大きくなったら別の話になる
    expect(worst, `最悪 ${worst.toExponential(3)}`).toBeLessThan(1e-4);
  }, 60_000);

  /**
   * ## 反復軸 —— 600 フレームは門の傾斜帯を見ていない
   *
   * `framingEnvelope.test.ts` の 2 本はどちらも **`d = 3` を 600 フレーム**である。
   * `d = 3` は**全開域で唯一まったく動かない点**だった。
   *
   * **実測（Phase 2c-vii・標本 No.0 / HIGH / 18000〜36000 フレーム）**:
   *
   * | `d` | 門 | 600F | 900F | 18000F | 36000F | 初動 |
   * |---|---|---|---|---|---|---|
   * | 1.75 | 0.394 | 1.000000 | — | 1.230210 | 1.230223 | 22.1 s |
   * | **1.80** | 0.198 | 1.000000 | — | 1.265899 | **1.323447** | 46.2 s |
   * | 2.15 | 0.055 | **1.001760** | — | 1.052851 | 1.105082 | **0.0 s** |
   * | **2.20** | 0.198 | 1.000000 | — | 1.353629 | **1.403541** | **11.3 s** |
   * | 2.25 | 0.394 | 1.000000 | — | 1.228346 | 1.228347 | 12.0 s |
   * | 2.375 | 0.882 | 1.000000 | — | 1.000000 | 1.018602 | **459.2 s** |
   * | **3.00** | 1.000 | 1.000000 | — | **1.000000** | **1.000000** | **動かず** |
   *
   * **この挙動は意図されたもので、`lensScene.ts` がそう書いている**
   * （「門が途中の帯では目標が包絡に届かないので、そこではホールドがまだ育ちうる。
   * それは正しい」）。**そして 2c-iv が既に両側を実測して記録している**
   * （SPEC §0 の到達水準表と `core/fit.ts:208`。`d=2.20` は 679F（11.3 秒）で
   * 動き出し 300 秒に ×1.354）── ここでの 18000F の実測 **×1.3536289** は
   * その記録と 4 桁一致する。**掃引が狭かったのは既存のテストであって、SPEC ではない。**
   *
   * 広げて**新しく分かったのは 2 点だけ**である:
   *
   *   - **300 秒（18000F）で飽和していない。** 600 秒（36000F）まで回すと
   *     `d = 2.20` は **×1.4035**。記録の ×1.354 は飽和値ではなく 300 秒時点の値である
   *   - **`d = 2.375` の初動は 27554F（459 秒）**で、18000F の窓の外に在る ──
   *     既存の掃引はこの点を「動かない」側に分類しうる
   *
   * なお `lensScene.ts` のコード内コメントは上側 `(2.1, 2.45)` しか挙げていない
   * （SPEC は両側を書いている）。**小さな不整合だが、コードだけを読む者には
   * 帯が片側にしか無いように見える。**
   *
   * ここでは **1500 フレーム**で切る（軽い格子で 9 点 3.3 秒）。飽和まで回すと 36000F × 9 点で
   * 約 5 分になり `npm test` に載らない。**切った結果、見えている量は飽和より小さい。**
   * **900F では下側が 1 点も育たず赤くなった**（下側の初動は最速で `d = 1.75` の 1327F）──
   * 「両側で育つ」という主張には、下側の初動を跨ぐ反復数が要る。
   */
  it('門の傾斜帯ではホールドが育つ（窓の両側で）', () => {
    /**
     * **1500 フレーム。** 900F では上側しか育たない ── 下側の初動は最速でも
     * `d = 1.75` の **1327F（22.1 秒）**で、900F はそこに届かない（実測して赤くなった）。
     * 「両側で育つ」を主張するには下側の初動を跨がなければならない。
     */
    const RAMP_FRAMES = 1500;
    const RAMP = [1.65, 1.75, 1.8, 1.85, 2.15, 2.2, 2.25, 2.3, 2.4];
    let worst = 1;
    let worstAt = '';
    const grew: string[] = [];
    for (const d of RAMP) {
      const scene = buildLightScene();
      scene.setDimLevel(d);
      scene.update(1 / 60);
      const d0 = scene.stats().cameraDistance;
      for (let i = 0; i < RAMP_FRAMES; i++) scene.update(1 / 60);
      const ratio = scene.stats().cameraDistance / d0;
      if (ratio > 1) grew.push(`d=${d}`);
      if (ratio > worst) { worst = ratio; worstAt = `d=${d}`; }
    }
    // **窓の両側で育つ。** 下側 (1.55,1.9) も上側 (2.1,2.45) も
    expect(grew.some((g) => Number(g.slice(2)) < 1.9), `育った: ${grew.join(' ')}`).toBe(true);
    expect(grew.some((g) => Number(g.slice(2)) > 2.1), `育った: ${grew.join(' ')}`).toBe(true);
    // 1500F で見える量。飽和は ×1.4035（36000F・d=2.20）で、そこはここでは測っていない
    expect(worst, `最悪 ×${worst.toFixed(6)} @${worstAt}`).toBeGreaterThan(1.02);
    expect(worst, `最悪 ×${worst.toFixed(6)} @${worstAt}`).toBeLessThan(1.30);
  }, 60_000);

  /**
   * **`d = 3` は動かない。** 上の 3 本が「広げたから見えた」ことの対照である ──
   * 既存の 2 本が測っている 1 点は、実際に 1 ビットも動かない。
   * **既存のテストが嘘だったのではなく、題が掃引より広かった。**
   */
  it('対照: d = 3 は 1500 フレーム回しても 1 ビットも動かない', () => {
    const scene = buildLightScene();
    scene.setDimLevel(3);
    scene.update(1 / 60);
    const d0 = scene.stats().cameraDistance;
    for (let i = 0; i < 1500; i++) scene.update(1 / 60);
    expect(Object.is(scene.stats().cameraDistance, d0)).toBe(true);
  }, 30_000);
});
