/**
 * DIMENSION-LENS 起動点。
 *
 * Phase 1a-ii の時点でもまだ three もキャンバスも登場しない。ここにあるのは
 * **取り込み経路が実際に通ること**の確認である ── 標本 No.0 を PNG にして、
 * ユーザーのファイルと同じ入口(`Blob`)から worker へ渡し、正準バッファと
 * 点群バッファができるところまでを起動時に走らせる。
 *
 * 描画は Phase 1a-iii。だから今はまだ空ページのままだが、
 * `data-lens-ingest` が本番ページにも残るので、**公開経路の上で取り込みが
 * 動いたかどうかを外から確かめられる**(SPEC §7.3 の規律を 1a-ii の内容へ延長したもの)。
 */

import { installDevHook, type LensIngestReport } from './dev/hook';
import { createIngestClient } from './ingest/ingest';
import { specimenBlob } from './ingest/specimenSource';
import { IngestError } from './ingest/protocol';
import type { IngestPayload } from './ingest/session';

/**
 * 起動印。**本番ビルドでも消えない副作用**であることに意味がある。
 *
 * これを置かないと Phase 0 のエントリは丸ごと tree-shake され、vite は
 * <script type="module"> ごと出力から落とす ── つまり
 * 「自前の JS が `script-src 'self'` の下で実際に読めるか」を一度も検証しないまま
 * 「公開経路が揃った」と言うことになる。
 */
document.documentElement.dataset.lens = 'booted';

const client = createIngestClient();

/** Phase 1a-iii が受け取る板のテクスチャ源。ここで手放さない */
let plate: ImageBitmap | null = null;
let report: LensIngestReport | null = null;

function toReport(payload: IngestPayload): LensIngestReport {
  return {
    mode: client.mode,
    meta: payload.meta,
    gridW: payload.grid.cols,
    gridH: payload.grid.rows,
    pointCount: payload.grid.cols * payload.grid.rows,
    meanHex: payload.stats.meanHex,
    maxNorm: payload.maxNorm,
    safeDist: payload.safeDist,
    degenerate: {
      lightness: payload.scales.degenerate.lightness,
      chroma: payload.scales.degenerate.chroma,
    },
  };
}

async function ingestBlob(source: Blob): Promise<LensIngestReport> {
  const payload = await client.ingest(source);
  // 前の板を明示的に閉じる(SPEC §6.4 の残留物のうち、ImageBitmap だけは 1a-ii で閉じる)
  plate?.close();
  plate = payload.plate;
  report = toReport(payload);
  return report;
}

installDevHook({
  capabilities: () => client.capabilities(),
  ingestReport: () => report,
  ingestBlob,
});

async function boot(): Promise<void> {
  const r = await ingestBlob(await specimenBlob());
  document.documentElement.dataset.lensIngest = 'ok';
  if (import.meta.env.DEV) {
    console.info(
      `[LENS] Phase 1a-ii — 取り込み経路(${r.mode}): `
        + `${r.meta.decodedWidth}×${r.meta.decodedHeight} → 正準 ${r.meta.width}×${r.meta.height}`
        + ` / 格子 ${r.gridW}×${r.gridH} = ${r.pointCount} 点`
        + ` / 平均 ${r.meanHex} / safeDist ${r.safeDist.toFixed(3)}`
        + ` / EXIF 向き: ${r.meta.orientation} / 縮小: ${r.meta.resizePath}`
        + ` / ${r.meta.timings.totalMs.toFixed(1)} ms`,
    );
    console.info('[LENS] window.__LENS__.capabilities() で機能検出の実測が読める。');
  }
}

void boot().catch((e: unknown) => {
  document.documentElement.dataset.lensIngest =
    e instanceof IngestError ? `failed:${e.code}` : 'failed:internal';
  // 失敗を黙って飲まない。空状態の UI は Phase 1c。
  console.error('[LENS] 取り込みに失敗しました。', e);
});
