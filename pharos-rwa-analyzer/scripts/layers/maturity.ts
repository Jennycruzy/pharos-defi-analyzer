/**
 * Layer 2 — maturity. The time dimension: redemption limits / lockups / maturity.
 *
 * On-chain where ERC-4626 exposes it (Tulipa maxWithdraw / maxRedeem). For
 * lending, supplied funds are withdrawable subject to pool liquidity — reported
 * on-chain as "no fixed lockup". True off-chain maturity dates are NOT faked:
 * if not on-chain, we label them [static] and only show a date we actually know.
 */

import type { WalletScan } from '../collect.js';
import { sourced, type Sourced } from '../types.js';

export interface MaturityEntry {
  product: string;
  asset: string;
  /** Human description of the wallet's time/liquidity constraint. */
  status: Sourced<string>;
  /** Underlying units redeemable right now, if known. */
  redeemableNow: Sourced<number>;
}

export interface MaturityResult {
  layer: 'maturity';
  entries: MaturityEntry[];
}

export function analyzeMaturity(scan: WalletScan): MaturityResult {
  const entries: MaturityEntry[] = [];

  // Lending positions: open-term. Withdrawable NOW is bounded by the pool's
  // actual on-chain liquidity (underlying held by the aToken), not just the
  // supplied balance — so an illiquid market is reported honestly.
  for (const l of scan.lending) {
    for (const p of l.positions) {
      if (p.suppliedAmount > 0) {
        const liquidityLimited = p.withdrawableNow < p.suppliedAmount - 1e-9;
        entries.push({
          product: l.product,
          asset: p.symbol,
          status: sourced(
            liquidityLimited
              ? `Open-term supply (no fixed maturity), but pool liquidity currently caps an instant ` +
                  `withdrawal at ${round(p.withdrawableNow)} of your ${round(p.suppliedAmount)} ${p.symbol}.`
              : 'Open-term supply (no fixed maturity). Fully withdrawable on demand — pool liquidity covers your balance.',
            'on-chain',
            'high',
          ),
          redeemableNow: sourced(
            round(p.withdrawableNow),
            'on-chain',
            'high',
            liquidityLimited ? 'Capped by current available pool liquidity.' : undefined,
          ),
        });
      }
    }
  }

  // Tulipa vault: redemption capacity is on-chain via maxWithdraw/maxRedeem.
  if (scan.vault && scan.vault.position.shares > 0) {
    const { position, info } = scan.vault;
    entries.push({
      product: info.product,
      asset: info.symbol,
      status: sourced(
        position.fullyLiquid
          ? `Fully redeemable now: maxRedeem covers your full ${position.shares} ${info.symbol} balance.`
          : `Partially locked: maxRedeem (${position.maxRedeemShares}) is below your balance (${position.shares}).`,
        'on-chain',
        'high',
      ),
      redeemableNow: sourced(position.redeemableAssets, 'on-chain', 'high'),
    });
    // Note any true RWA maturity date would be off-chain; we have none verified, so we omit it
    // rather than invent one (HARD RULE #2). If a published date is later confirmed, add it as [static].
  }

  return { layer: 'maturity', entries };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
