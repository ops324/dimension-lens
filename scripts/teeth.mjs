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

function run(cmd, args) {
  try {
    return { code: 0, out: execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** vitest の出力から「落ちた件数」を読む。落ちていなければ 0 */
function failCount(out) {
  const m = out.match(/Tests\s+(?:\[[\d;]*m)*(\d+)\s+failed/);
  return m ? Number(m[1]) : 0;
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
    if (r.code === 0 || failed === 0) {
      console.log(`❌ ${m.name}\n   壊しても緑のまま。**この歯は抜けている**（${m.file}）`);
      results.push({ ...m, status: 'no-bite', failed: 0 });
      exitCode = 1;
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
