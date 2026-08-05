// VENDORED_FROM: ops324/dimension@8cd37d8ffe74017acd18c1907195e36a20d9ec19 src/core/quality.ts
// STATUS: MODIFIED
//
// 変更点:
//   - **エスカレーション（実測フレーム時間による昇格）を移植しない。** Phase 2。
//     1a-iii の忠実性ラダーは測定中で、その最中に DPR や MSAA が動くと
//     「何を測ったか」が言えなくなる ── 測定フェーズでは品質は固定でなければならない
//   - ティアは点数予算（`image/grid.ts` の TIER_BUDGET）と組にした。
//     bench が測った点数（SPEC §4.3）と描画する点数を同じ表から出す
//   - bloom の解像度・強度の組は Phase 2（定数の再測定と同時にしか決められない）

/**
 * 品質ティア。**点数・DPR・MSAA を 1 つの表にまとめる。**
 *
 * 点数を別の場所から取ると、SPEC §4.3 の「ULTRA 159,414 点で 1.29 ms/frame」という
 * A 水準の主張が、実際に描いている点数についての主張でなくなる。
 */

import { TIER_BUDGET, type TierName } from '../image/grid';

export interface QualityTier {
  readonly name: TierName;
  /** 点数予算。`fitGrid` に渡す */
  readonly budget: number;
  /** devicePixelRatio の上限 */
  readonly dpr: number;
  /** MSAA サンプル数（`renderer.capabilities.maxSamples` でクランプされる） */
  readonly samples: number;
}

export const TIERS: Readonly<Record<TierName, QualityTier>> = {
  BALANCED: { name: 'BALANCED', budget: TIER_BUDGET.BALANCED, dpr: 1.5, samples: 0 },
  HIGH: { name: 'HIGH', budget: TIER_BUDGET.HIGH, dpr: 2, samples: 4 },
  ULTRA: { name: 'ULTRA', budget: TIER_BUDGET.ULTRA, dpr: 3, samples: 4 },
};

/**
 * 起動ティア。**推定であって測定ではない**（水準 C）。
 *
 * 実測に基づく昇格は Phase 2。ここでやっているのは「明らかに弱い端末で
 * ULTRA から始めない」という保険だけで、精度を主張しない。
 * `deviceMemory` は Chromium 系にしかなく、`hardwareConcurrency` は
 * 効率コアも数える ── どちらも当てにならないことを前提に、粗く倒す。
 */
export function bootTier(): TierName {
  if (typeof navigator === 'undefined') return 'BALANCED';
  const cores = navigator.hardwareConcurrency ?? 0;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 0;
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  // 高 DPR × 少コアはモバイルの典型。ここでは上げない
  if (cores >= 8 && memory >= 8 && dpr <= 2) return 'HIGH';
  if (cores <= 4) return 'BALANCED';
  return 'BALANCED';
}

export function tierFor(name: TierName): QualityTier {
  return TIERS[name];
}
