/**
 * 移植ファイルの出自と改変を、記録から外れさせないためのテスト。
 *
 * ── 「8月1日から変更されていないから複製コストは低い」は生存者バイアスだった
 *
 * dimension リポジトリは 2 日で 21 PR を吐いており(engine.ts 5 回、postfx.ts 4 回、
 * quality.ts 3 回の変更)、「変わっていない」の観測窓は丸 1 日しかない。しかもそれは
 * 作品が完成状態に達したあとの静止期で、そこから外挿できるのは
 * 「完成後は変わらない」という循環論法にすぎない。
 *
 * ── だから禁じるのは「乖離」ではなく「記録されない乖離」
 *
 * monorepo にも git subtree にもしないと決めた以上、必要なのは
 * (1) どのコミットから来たかがファイルに書いてあること、
 * (2) 中身が黙って書き換わらないこと、の 2 点だけである。
 *
 * このテストが落ちたら:
 *   - 意図した改変なら → 下の EXPECTED を更新し、STATUS 欄を MODIFIED にして、
 *     何を変えたかをヘッダに書く。差分は PR に出る。
 *   - 意図していないなら → それが捕まえたかったもの。
 *
 * 逆流の向きは一方向: LENS でバグを見つけたら、まず dimension 側で直して PR にし、
 * その SHA を VENDORED_FROM に反映してからコピーし直す。
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 移植元コミット。ここを上げるときは全ファイルのハッシュを取り直す。 */
const SOURCE_COMMIT = '8cd37d8ffe74017acd18c1907195e36a20d9ec19';

interface VendoredFile {
  path: string;
  /** 移植元のパス */
  from: string;
  status: 'VERBATIM' | 'MODIFIED';
  /** sha256 の先頭 16 桁 */
  sha256: string;
}

const EXPECTED: readonly VendoredFile[] = [
  {
    path: 'src/math/ease.ts',
    from: 'src/math/ease.ts',
    status: 'VERBATIM',
    sha256: 'fb7688906f87c198',
  },
  {
    path: 'src/math/rotation.ts',
    from: 'src/math/rotation.ts',
    status: 'VERBATIM',
    sha256: '24a2ac374b77a806',
  },
  {
    path: 'src/math/projection.ts',
    from: 'src/math/projection.ts',
    status: 'MODIFIED', // projectStereographic を削除
    sha256: 'cef78789aea91f55',
  },
  // ---- Phase 1a-iii ----
  {
    path: 'src/core/engine.ts',
    from: 'src/core/engine.ts',
    // NoToneMapping / portraitDolly を移植しない / renderOnce / pxPerWorld / capture
    status: 'MODIFIED',
    sha256: 'a0a7531ac1661735',
  },
  {
    path: 'src/core/quality.ts',
    from: 'src/core/quality.ts',
    // エスカレーションを移植しない（Phase 2）/ ティアと点数予算を 1 表に
    status: 'MODIFIED',
    sha256: 'a58815029fc5d08d',
  },
  {
    path: 'src/render/postfx.ts',
    from: 'src/render/postfx.ts',
    // CompressPass を新設 / bloom・grade を既定オフ / capture パスを受ける
    status: 'MODIFIED',
    sha256: '787f73e5531f4353',
  },
  {
    path: 'src/render/colorPointBatch.ts',
    from: 'src/render/pointBatch.ts',
    // 点ごとの色 / InstancedBufferGeometry / F=21 / 正規化ゲイン
    // Phase 1b: uSampleWeight（潰しの補正）を第 3 の uniform として追加、
    //           configure が s0y と較正域の判定を返す
    status: 'MODIFIED',
    sha256: '7b811c59cb0a9fac',
  },
];

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

describe('移植ファイルの出自', () => {
  for (const f of EXPECTED) {
    describe(f.path, () => {
      const src = read(f.path);

      it('VENDORED_FROM ヘッダが移植元コミットを指している', () => {
        expect(src).toContain(`// VENDORED_FROM: ops324/dimension@${SOURCE_COMMIT} ${f.from}`);
      });

      it(`STATUS が ${f.status} と宣言されている`, () => {
        expect(src).toMatch(new RegExp(`^// STATUS: ${f.status}\\b`, 'm'));
      });

      it('中身が記録どおり(黙って書き換わっていない)', () => {
        const actual = createHash('sha256').update(src).digest('hex').slice(0, 16);
        expect(
          actual,
          `${f.path} が変わっている。意図した改変なら vendor.test.ts の sha256 を`
            + ` '${actual}' に更新し、STATUS とヘッダに何を変えたかを書くこと。`,
        ).toBe(f.sha256);
      });
    });
  }

  it('rotation.ts には何も追記されていない(親テストの継承が切れないこと)', () => {
    // コメントは落として**コード部分だけ**を見る ── ヘッダの注意書き自体が
    // 「composeRotN は rotationN.ts に置け」と書いているので、素朴な文字列検索だと
    // 自分の注意書きに引っかかる。
    const code = read('src/math/rotation.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // composeRotN / applyMatrixBatch / 融合カーネルは rotationN.ts の担当。
    // ここに移すと math.test.ts の rotation ブロックが「自分で書いた新関数を含むファイル」を
    // 検証することになり、親で実測済み(A 水準)の継承が切れる。
    expect(code).not.toContain('composeRotN');
    expect(code).not.toContain('applyMatrixBatch');
    expect(code).not.toContain('liftProject');

    // 公開 API は rotateBatch と PlaneRotation の 2 つだけ
    const exports = [...code.matchAll(/^export\s+(?:function|interface|const)\s+(\w+)/gm)].map(
      (m) => m[1],
    );
    expect(exports.sort()).toEqual(['PlaneRotation', 'rotateBatch']);
  });
});
