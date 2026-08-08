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
 * 各変異について「**少なくとも 1 件のテストが落ちる**」ことだけを hard gate にする。
 * 落ちた件数も記録して、**前より減っていたら警告**する ── 件数が減るのは
 * 「テストが恒等に潰れ始めた」の早期兆候だが、リファクタで正当に減ることもあるので
 * 落とさずに出す。ゼロになったら落とす。
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
  { phase: '2b', name: 'bloom の閾値を d=0 の平均色の下へ下げる（G9 の測定点が bloom の内側へ入る）',
    file: 'src/core/bloom.ts',
    find: 'export const BLOOM_BASE_THRESHOLD = 0.28;',
    replace: 'export const BLOOM_BASE_THRESHOLD = 0.26;' },
  { phase: '2b', name: '輝度の重みを等分に取り違える（別の量に対する柵になる）',
    file: 'src/core/bloom.ts',
    find: 'export const LUMA_WEIGHTS: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];',
    replace: 'export const LUMA_WEIGHTS: readonly [number, number, number] = [1 / 3, 1 / 3, 1 / 3];' },
  { phase: '2b', name: 'ニーを平均色の下へ動かす（錨が後処理で動きうる位置へ）',
    file: 'src/core/compress.ts',
    find: 'export const COMPRESS_KNEE = 0.8;', replace: 'export const COMPRESS_KNEE = 0.2;' },
  { phase: '2b', name: '圧縮の強度から門を外す（アンカー窓で圧縮が立ち上がる）',
    file: 'src/core/compress.ts',
    find: '  return rotationGate(dimLevel) * COMPRESS_MAX_STRENGTH;',
    replace: '  return COMPRESS_MAX_STRENGTH;' },
  // ---- Phase 2c で差し替えた歯 ----
  //
  // 旧: `PEAK_MARGIN = 1.25` を 1.0 にする。定数ごと消えたので置き換える。
  // 2b の設計（実測の包絡に余裕を掛けて強度を逆算する）は、余裕を何倍にしても
  // 上限 `knee + 1/s` が 1 を超えるためクリップを消せない ── その設計へ**戻す**変異を
  // 歯にする。`compress.test.ts` の「1/(1−knee) である」と half-float 全域の 2 本が噛む。
  { phase: '2c', name: '強度を「設計峰からの逆算」へ戻す（有限の峰では上限が 1 を超える）',
    file: 'src/core/compress.ts',
    find: 'export const COMPRESS_MAX_STRENGTH = 1 / (1 - COMPRESS_KNEE);',
    replace: 'export const COMPRESS_MAX_STRENGTH = strengthForPeak(MEASURED_PEAK_ENVELOPE * 1.25);' },
  // ニーの値そのもの。2b までこれを留めるテストが 1 本も無く、「代償を記録する」つもりの
  // テストが副作用で ±0.15% だけ固定していた（監査が逆算）。2c で独立した柵を置いた。
  { phase: '2c', name: 'ニーを 0.9 へ動かす（2b では 11 本すべてが素通しした変異）',
    file: 'src/core/compress.ts',
    find: 'export const COMPRESS_KNEE = 0.8;', replace: 'export const COMPRESS_KNEE = 0.9;' },
  { phase: '2b', name: 'fp16 の丸めを最近接に取り違える（監査のモデルへ戻す）',
    file: 'src/image/blendModel.ts',
    find: '  return sign * Math.min(quantize(Math.abs(value), Math.floor), F16_MAX);',
    replace: '  return sign * Math.min(quantize(Math.abs(value), Math.round), F16_MAX);' },
  { phase: '2b', name: '最近接偶数を「常に上へ」にする（ties-to-even を落とす）',
    file: 'src/image/blendModel.ts',
    find: '  return floor % 2 === 0 ? floor : floor + 1;',
    replace: '  return floor + 1;' },
  { phase: '2b', name: '二値ケースの暗い側を正規数にする（非正規域を問わなくなる）',
    file: 'src/image/blendModel.ts',
    find: '  const dark = binaryContribution(30);',
    replace: '  const dark = binaryContribution(130);' },
  { phase: '2b', name: '判定の許容を最小の分離幅より広げる（2 モデルが同時に一致する）',
    file: 'src/image/blendModel.ts',
    find: '  tolerance = 1e-6,', replace: '  tolerance = 1e-2,' },
  { phase: '2b', name: '光過敏の配慮が回転へ届かない（2a まで実際にこうだった）',
    file: 'src/scene/lensScene.ts',
    find: '    if (!this.frozen && !this.reducedMotion) advancePhases(this.phases, d, dt);',
    replace: '    if (!this.frozen) advancePhases(this.phases, d, dt);' },
  { phase: '2b', name: '配慮を測定用の凍結と共用する（測定が終わると配慮が解ける）',
    file: 'src/scene/lensScene.ts',
    find: '  setReducedMotion(on: boolean): void {\n    this.reducedMotion = on;\n  }',
    replace: '  setReducedMotion(on: boolean): void {\n    this.frozen = on;\n  }' },
  { phase: '2b', name: '色場 `image+mean` を恒等にする（G12 が同じ絵を 2 回測る）',
    file: 'src/scene/lensScene.ts',
    find: "        const base = field === 'mean' ? 0 : 1;",
    replace: "        const base = field === 'mean' ? 0 : 1; if (field !== 'mean') { dst[i] = src[i]; dst[i + 1] = src[i + 1]; dst[i + 2] = src[i + 2]; continue; }" },
  { phase: '2b', name: '色場の差し替えが位置も触る（幾何固定という前提を壊す）',
    file: 'src/scene/lensScene.ts',
    find: '  setColorField(mode: ColorField): void {\n    if (mode === this.colorField) return;',
    replace: '  setColorField(mode: ColorField): void {\n    this.points.positions[0] += 1e-3;\n    if (mode === this.colorField) return;' },

  // ---- Phase 2a で足した歯 ----
  //
  // G9 の −17.58% は 2 つの因子の積だった。**node で採点できるのはその「割り方」**で、
  // 実際に読める値は `npm run ladder` が実 GPU で見る。ここで守るのは前者だけである。
  { phase: '2a', name: '中心の位相を常に 0 にする（＝ 図の中心にフラグメントが在ると仮定する）',
    file: 'src/image/spriteGain.ts',
    find: '    return Math.abs(c - (Math.floor(c) + 0.5));',
    replace: '    return 0;' },
  { phase: '2a', name: '位相減衰を恒等にする（1c まで暗黙にそう扱っていた）',
    file: 'src/image/spriteGain.ts',
    find: '  const r2 = (offsetX * offsetX + offsetY * offsetY) / (spritePx * spritePx);\n  return Math.exp(-F * r2);',
    replace: '  void offsetX; void offsetY;\n  return 1;' },
  { phase: '2a', name: '位相の減衰に F を使わない（k を取り違える）',
    file: 'src/image/spriteGain.ts',
    find: '  return Math.exp(-F * r2);', replace: '  return Math.exp(-K_SPRITE * r2);' },
  { phase: '2a', name: '潰れた軸を畳まない（1b の挙動へ戻す = 深度 378）',
    file: 'src/image/columnLine.ts',
    find: '  const n = Math.round(extentX * max);\n  return n < 1 ? 1 : n > max ? max : n;',
    replace: '  return max;' },
  { phase: '2a', name: '畳んだ点数の下限を 0 にする（1 点すら描かなくなる）',
    file: 'src/image/columnLine.ts',
    find: '  if (!(extentX > 0)) return 1;', replace: '  if (!(extentX > 0)) return 0;' },
  { phase: '2a', name: 'half-float の非正規数を 0 に潰す（暗い列が消えたことを観測できなくする）',
    file: 'src/core/capture.ts',
    find: '  if (e === 0) return s * m * 2 ** -24;', replace: '  if (e === 0) return 0;' },
  { phase: '2a', name: '潰しの基準を無限格子へ戻す（アンカーの厳密 1 がティア依存に戻る）',
    file: 'src/image/spriteGain.ts',
    find: '    axisCoverage(c.s0x, c.refNx ?? AXIS_UNBOUNDED, c.spritePx)\n    * axisCoverage(c.s0y, c.refNy ?? AXIS_UNBOUNDED, c.spritePx);',
    replace: '    axisCoverage(c.s0x, AXIS_UNBOUNDED, c.spritePx)\n    * axisCoverage(c.s0y, AXIS_UNBOUNDED, c.spritePx);' },
  { phase: '2a', name: 'HDR 自己検査の値を 1.0 以下にする（1.0 超を区別する口の意味が消える）',
    file: 'src/core/capture.ts',
    find: 'export const HDR_SELFTEST_VALUE: readonly [number, number, number] = [2.5, 0.25, 0.0625];',
    replace: 'export const HDR_SELFTEST_VALUE: readonly [number, number, number] = [0.5, 0.25, 0.0625];' },

  // ---- Phase 1c で足した歯 ----
  { phase: '1c', name: 'safeDist をリテラル 2.4 に', observed: 5,
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
  { phase: '1c', name: 'axisPresence が常に全 true', observed: 2,
    file: 'src/image/stats.ts',
    find: 'return [true, true, !lightness, !chroma, !chroma];',
    replace: 'return [true, true, true, true, true];' },
  { phase: '1c', name: 'lensScene が退化を読まない', observed: 1,
    file: 'src/scene/lensScene.ts',
    find: 'this.axisPresent = axisPresence(source.scales);',
    replace: 'this.axisPresent = [true, true, true, true, true];' },
  { phase: '1c', name: 'extent の 0 固定を外す', observed: 1,
    file: 'src/scene/lensScene.ts',
    find: 'this.extent[k] = this.axisPresent[k] ? clamp01(d - k) : 0;',
    replace: 'this.extent[k] = clamp01(d - k);' },
  { phase: '1c', name: 'HEIF の brand 判定を殺す', observed: 1,
    file: 'src/ingest/format.ts',
    find: "if (b0 === 0x68 && b1 === 0x65) return 'heif';", replace: 'if (false) return null;' },
  { phase: '1c', name: 'decode.ts に日本語の文言を戻す', observed: 1,
    file: 'src/ingest/decode.ts',
    find: "throw new IngestError('empty-source');",
    replace: "throw new IngestError('empty-source'); const _leak = 'ファイルが空です。'; void _leak;" },

  // ---- Phase 1b が「壊して確かめた」と PR に書いた分（台帳へ移した）----
  { phase: '1b', name: 'DEFAULT_FILL を 0.86 → 0.95', observed: 6,
    file: 'src/core/fit.ts',
    find: 'export const DEFAULT_FILL = 0.86;', replace: 'export const DEFAULT_FILL = 0.95;' },
  { phase: '1b', name: '画角の半角変換を /360 → /180', observed: 6,
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
  { phase: '1a-iii', name: 'instanceCount = 1 の明示を消す', observed: 1,
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

const only = process.argv[2];
const targets = only
  ? MUTATIONS.filter((m) => m.name.includes(only) || m.phase === only)
  : MUTATIONS;

console.log(`歯の確認: ${targets.length} 変異\n`);

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
      console.log(`⚠️  ${m.name} → ${failed} 件（${m.phase} 時点は ${m.observed} 件。減っている）`);
      results.push({ ...m, status: 'weaker', failed });
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
process.exit(exitCode);
