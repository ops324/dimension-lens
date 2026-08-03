/**
 * 「画像は端末から出ません」を、観測ではなく**強制**に近づけるためのテスト。
 *
 * ブラウザで `read_network_requests` を見て「外向きゼロだった」と言うのは観測であって、
 * 「そのセッションでは起きなかった」しか主張できない。visibilitychange での sendBeacon は
 * 観測窓の外に落ちる。ここでやるのは、**ビルド成果物に通信 API が現れないことの静的検査**で、
 * これは再現可能で、CI で回り、観測窓に依存しない。
 *
 * 完全な証明ではない(難読化された動的呼び出しは捕まらない)。しかし
 * 「依存関係の更新でうっかり fetch を撒いた」は確実に捕まる ── それがこの検査の狙い。
 *
 * allowlist は**集合として一致**を要求する。three.js のローダは fetch を含むので
 * 「存在しないこと」では書けない。集合一致にすると、増えたときも減ったときも落ちる ──
 * 増加は新しい通信経路の混入、減少は allowlist の陳腐化で、どちらも PR の diff に出る。
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(process.cwd(), 'dist');

/** 検査する通信 API。名前 → 検出パターン */
const NETWORK_APIS: Record<string, RegExp> = {
  fetch: /\bfetch\s*\(/,
  XMLHttpRequest: /\bXMLHttpRequest\b/,
  sendBeacon: /\bsendBeacon\b/,
  WebSocket: /\bWebSocket\b/,
  EventSource: /\bEventSource\b/,
  RTCPeerConnection: /\bRTCPeerConnection\b/,
  importScripts: /\bimportScripts\s*\(/,
  serviceWorker: /\bserviceWorker\b/,
};

/**
 * 出現が許されている API の集合。**空にできるうちは空にしておく。**
 * ここに何かを足す PR は、必ず「なぜその API がバンドルに入ったか」を本文に書くこと。
 *
 * Phase 0: 空(three をまだ import していない)
 */
const ALLOWED: readonly string[] = [];

function collectJs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collectJs(p, acc);
    else if (entry.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

describe('プライバシー(ビルド成果物の静的検査)', () => {
  it('dist/ が存在する', () => {
    // 意図的に skip しない ── 黙って飛ぶプライバシーテストは、
    // 「常に緑」という最悪の失敗モードそのもの。
    expect(
      existsSync(DIST),
      'dist/ が無い。先に `npm run build` を実行すること。'
        + ' CI では build → test の順に走る(.github/workflows/deploy.yml)。',
    ).toBe(true);
  });

  it('バンドルに現れる通信 API が allowlist と集合として一致する', () => {
    const found = new Set<string>();
    const where: Record<string, string[]> = {};
    for (const file of collectJs(DIST)) {
      const src = readFileSync(file, 'utf8');
      for (const [name, re] of Object.entries(NETWORK_APIS)) {
        if (re.test(src)) {
          found.add(name);
          (where[name] ??= []).push(file.slice(DIST.length + 1));
        }
      }
    }
    const actual = [...found].sort();
    expect(actual, `検出場所: ${JSON.stringify(where, null, 2)}`).toEqual(
      [...ALLOWED].sort(),
    );
  });

  it('本番 index.html に CSP meta が入っていて default-src と img-src を閉じている', () => {
    const html = readFileSync(join(DIST, 'index.html'), 'utf8');
    const m = html.match(
      /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/,
    );
    expect(m, 'cspPlugin が本番ビルドで動いていない').not.toBeNull();
    const csp = m![1];

    // default-src 'none' が基点であること。これが無いと他の指令は
    // 「default-allow の海に浮かぶ島」でしかない。
    expect(csp).toContain("default-src 'none'");
    // connect-src だけでは new Image().src= による送信が塞げない ──
    // img-src を閉じることのほうが重要。
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("connect-src 'none'");
    // 注入された <base href> は全相対 URL を付け替えて script-src 'self' を無効化する。
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    // 取り込み worker が起動できること
    expect(csp).toContain("worker-src 'self' blob:");
  });

  it('Referrer ポリシーが no-referrer である(?d= 等が外部へ漏れない)', () => {
    const html = readFileSync(join(DIST, 'index.html'), 'utf8');
    expect(html).toContain('name="referrer" content="no-referrer"');
  });
});
