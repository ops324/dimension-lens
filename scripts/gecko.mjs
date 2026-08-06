#!/usr/bin/env node
/**
 * Gecko（Firefox）の EXIF 向き判定を 1 回測る（`npm run gecko`・Phase 2a）。
 *
 * ## なぜこれが 1 本のスクリプトとして repo に在るのか
 *
 * SPEC §4.12 の最後の空欄は Gecko である。そして 1c はそこにこう書いた ──
 * 「**測れないのではなく入れていない**。A に上げる手段は probe を 1 回開くことだけ」。
 * ローカルへ Firefox は入れない（そう決めた）。代わりに GitHub の runner イメージ
 * （ubuntu-24.04）に **Mozilla Firefox 152.0.6** が在ることを `gh api` で確かめたので、
 * **CI で 1 回開く**。
 *
 * playwright の `firefox` は**同梱の patched build** であってシステムの Firefox ではない。
 * `playwright-core` はブラウザを落とさない方針なので、ここでは使わない ──
 * **実物の `firefox --headless` を起動する**。1c が Safari でやったのと同じ形
 * （ブラウザを開いて、同一オリジンの `/COLLECT` で回収する）である。
 *
 * ## 判定を書き直さない
 *
 * ページ側は `src/ingest/orientProbe.ts` の関数をそのまま呼ぶ。ここで判定を書き直すと、
 * **測っているのは出荷している probe ではなく、測定用に書いた別の実装**になる。
 *
 * ## このスクリプトが主張すること / しないこと
 *
 * - **主張する**: 「Gecko が `'applied'` / `'not-applied'` のどちらを返すか」。
 *   `'unknown'` は**答えではない**ので失敗にする（probe が壊れているか、
 *   Firefox が起動していないか、どちらにせよ測れていない）。
 * - **主張しない**: `'not-applied'` だったときにどうするか。それは設計判断であって
 *   測定ではないので、返ってきたその PR で人が決める（SPEC §4.12 / §8）。
 */

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const VITE_PORT = 5194;
const COLLECT_PORT = 5195;

function findFirefox() {
  const candidates = [
    process.env.LENS_FIREFOX,
    '/usr/bin/firefox',
    '/snap/bin/firefox',
    '/Applications/Firefox.app/Contents/MacOS/firefox',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'pipe' });
      return c;
    } catch {
      /* 次へ */
    }
  }
  try {
    return execFileSync('which', ['firefox'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function startVite() {
  const child = spawn(
    'npx',
    ['vite', '--port', String(VITE_PORT), '--strictPort', '--clearScreen', 'false'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('vite が起動しなかった')), 30_000);
    const on = (b) => {
      if (/ready in|Local:/i.test(String(b))) { clearTimeout(t); resolve(child); }
    };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
    child.on('error', reject);
  });
}

/**
 * 回収サーバ。**vite とは別ポートにする** ── vite のミドルウェアへ `/COLLECT` を
 * 差し込むと、測定のために dev サーバの設定を変えることになる（測るために作品を変えない）。
 * ページからは絶対 URL で叩く。
 */
function startCollector() {
  let resolveHit;
  const hit = new Promise((r) => { resolveHit = r; });
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url?.startsWith('/COLLECT')) {
      const u = new URL(req.url, `http://localhost:${COLLECT_PORT}`);
      res.writeHead(204).end();
      try { resolveHit(JSON.parse(u.searchParams.get('r') ?? 'null')); }
      catch (e) { resolveHit({ support: 'unknown', error: 'parse: ' + String(e) }); }
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(COLLECT_PORT);
  return { server, hit };
}

async function main() {
  const firefox = findFirefox();
  if (!firefox) {
    console.error('Firefox が見つからない。');
    console.error('このホストには入れない方針なので、これは CI（ubuntu-24.04）で走らせる。');
    console.error('別の場所を指すなら LENS_FIREFOX=/path/to/firefox。');
    process.exit(2);
  }
  const version = execFileSync(firefox, ['--version'], { encoding: 'utf8' }).trim();

  const vite = await startVite();
  const { server, hit } = startCollector();
  let ff;
  try {
    const url = `http://localhost:${VITE_PORT}/scripts/probe/gecko.html`
      + `?collect=${encodeURIComponent(`http://localhost:${COLLECT_PORT}/COLLECT`)}`;
    ff = spawn(firefox, ['--headless', '--no-remote', url], { stdio: 'ignore' });
    const payload = await Promise.race([
      hit,
      sleep(60_000).then(() => ({ support: 'unknown', error: 'timeout: 60s' })),
    ]);

    console.log('');
    console.log('  Gecko orientation probe');
    console.log(`  実行ファイル : ${firefox}`);
    console.log(`  版           : ${version}`);
    console.log(`  UA           : ${payload?.ua ?? '(なし)'}`);
    console.log(`  probe のバイト数: ${payload?.probeBytes ?? '(なし)'}（Orientation=${payload?.orientationTag ?? '?'}）`);
    console.log(`  デコード結果 : ${JSON.stringify(payload?.decoded ?? null)}`);
    console.log(`  期待（適用済み / 未適用）: ${JSON.stringify(payload?.expectOriented)} / ${JSON.stringify(payload?.expectUnoriented)}`);
    console.log(`  imageOrientation:'none' : ${JSON.stringify(payload?.none ?? null)} `
      + `（既定と一致: ${payload?.noneMatchesDefault ?? '?'}）`);
    /**
     * **どのエンジンで測ったかを、結果の隣に必ず出す。**
     *
     * §7.9 の事故（同じページで峰が SwiftShader 133 / ANGLE Metal 129 と出たのに、
     * どこにも素性が出ていなかった）と同じ形が、ここにもある ── `LENS_FIREFOX` で
     * 別のブラウザを指せるので、**Chrome で走らせたログが「Gecko の結果」として
     * 読まれうる**。実際、ハーネスの自己検査は Chrome で走らせている。
     */
    const ua = String(payload?.ua ?? '');
    const isGecko = /Gecko\/\d/.test(ua) && /Firefox\/\d/.test(ua);

    console.log('');
    console.log(`  エンジン     : ${isGecko ? '**Gecko（Firefox）**' : '**Gecko ではない**'}`);
    console.log(`  → **${payload?.support ?? 'unknown'}**`);
    console.log('');

    if (!isGecko) {
      console.log('  **これは自己検査であって Gecko の測定ではない。**');
      console.log('  既知のエンジンで既知の答えが出ることを確かめるための実行なので、');
      console.log('  この結果を SPEC §4.12 の Gecko の行へ書いてはいけない。');
      console.log(`  判定: ${payload?.support === 'applied' ? '既知の答え（applied）を再現した ✅' : '既知の答えと違う ❌'}`);
      process.exit(payload?.support === 'applied' ? 0 : 1);
    }
    if (payload?.support === 'applied') {
      console.log('  Gecko もデコーダが向きを適用している。');
      console.log('  → SPEC §4.12 の 4 実装目が埋まり、「自前回転を書かない」は B → A。');
      process.exit(0);
    }
    if (payload?.support === 'not-applied') {
      console.log('  **Gecko はデコーダが向きを適用していない。**');
      console.log('  → 1c が「実測されたその PR で書く」と決めた分岐が現実になった。');
      console.log('  これは設計判断が要る事実であって、このスクリプトが決めることではない。');
      console.log('  終了コードは 0 にする（測定は成功している）。SPEC §4.12 を書き換えること。');
      process.exit(0);
    }
    console.error('  測れていない（`unknown`）。probe が壊れているか、Firefox が動いていない。');
    console.error(`  detail: ${JSON.stringify(payload)}`);
    process.exit(1);
  } finally {
    ff?.kill('SIGTERM');
    server.close();
    vite.kill('SIGTERM');
    await sleep(200);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
