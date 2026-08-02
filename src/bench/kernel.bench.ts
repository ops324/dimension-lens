/**
 * 融合カーネルのマイクロベンチ。three もキャンバスも不要。
 *
 * ── なぜ Phase 0 でこれを書くのか
 *
 * 初版の計画には「約 15〜20 ns/点/フレーム」というティア表が載っていた。**根拠は無かった。**
 * リポジトリに存在する唯一の実測は姉妹作 dimension の SPEC §10「CPU ホットパス
 * (10次元超立方体) 1.74 ms/frame」で、これは約 26,600 点なので ≈65 ns/点。そこから
 * n=5 の融合カーネルへ外挿できるのは 2.5〜3 倍ぶんで、しかも作業セットが L2 を超える。
 *
 * 測っていない数を、測った数の書式で書かない。ティア表の ms 列は、
 * このベンチが出るまで空欄にしてある。
 *
 * `mean` (ms/iteration) がそのまま **ms/frame** である。
 *
 *   npm run bench
 *
 * 見るべきもの:
 *   1. ULTRA(159,414点)の融合カーネルが 16.7ms のフレーム予算のどれだけを食うか
 *   2. liftProject5(展開版)が liftProject(一般版)より有意に速いか
 *      → 差が無ければ liftProject5 を消す。コードは短いほうがよい
 *   3. 素直な 3 パス実装(extent → rotateBatch → projectPerspective)との比
 *      → 融合の効果がここに出る。出なければ融合の理屈が間違っている
 */

import { bench, describe } from 'vitest';
import { rotateBatch, type PlaneRotation } from '../math/rotation';
import { projectPerspective } from '../math/projection';
import { composeRotN, foldExtent, liftProject, liftProject5 } from '../math/rotationN';
import { clamp01 } from '../math/ease';

const N = 5;
const DIST = 2.4;
const DIM_LEVEL = 3.4; // 全 5 軸のうち 4 本が立っている、最も重い側の代表値

const TIERS = [
  { name: 'BALANCED', w: 244, h: 162 },
  { name: 'HIGH', w: 366, h: 244 },
  { name: 'ULTRA', w: 489, h: 326 },
] as const;

const ROTS: PlaneRotation[] = [
  { i: 0, j: 1, angle: 0.31 },
  { i: 0, j: 2, angle: 0.77 },
  { i: 3, j: 4, angle: 1.93 },
  { i: 1, j: 3, angle: -0.41 },
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 画像格子を模した base バッファ(‖x‖ ≤ 1 に正規化済み) */
function makeBase(count: number): Float32Array {
  const rand = mulberry32(99);
  const out = new Float32Array(count * N);
  for (let v = 0; v < count; v++) {
    const o = v * N;
    let norm2 = 0;
    for (let k = 0; k < N; k++) {
      const x = rand() * 2 - 1;
      out[o + k] = x;
      norm2 += x * x;
    }
    const r = 1 / Math.max(1, Math.sqrt(norm2));
    for (let k = 0; k < N; k++) out[o + k] *= r;
  }
  return out;
}

const extent = new Float64Array(N);
for (let k = 0; k < N; k++) extent[k] = clamp01(DIM_LEVEL - k);

for (const tier of TIERS) {
  const count = tier.w * tier.h;
  const base32 = makeBase(count);
  const base64 = Float64Array.from(base32);
  const out = new Float32Array(count * 3);
  const m = new Float64Array(N * N);

  // 3 パス実装用の作業バッファ(こちらは毎フレーム materialize が要る)
  const scaled = new Float64Array(count * N);
  const rotated = new Float64Array(count * N);

  describe(`${tier.name} — ${tier.w}×${tier.h} = ${count.toLocaleString()} 点`, () => {
    bench('融合カーネル(n=5 展開)', () => {
      composeRotN(ROTS, N, m);
      foldExtent(m, N, extent);
      liftProject5(base32, count, m, DIST, out);
    });

    bench('融合カーネル(一般 n)', () => {
      composeRotN(ROTS, N, m);
      foldExtent(m, N, extent);
      liftProject(base32, count, N, m, DIST, out);
    });

    bench('素直な 3 パス(extent → rotateBatch → projectPerspective)', () => {
      for (let v = 0; v < count; v++) {
        const o = v * N;
        for (let k = 0; k < N; k++) scaled[o + k] = base64[o + k] * extent[k];
      }
      rotateBatch(scaled, rotated, N, count, ROTS);
      projectPerspective(rotated, N, count, DIST, out);
    });
  });
}
