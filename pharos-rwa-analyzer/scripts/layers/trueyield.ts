/**
 * Layer 3 — trueyield. Decompose each position's yield into a single comparable,
 * HONEST number: base interest vs RWA income vs incentive emissions, net of fees.
 *
 *  - Lending base APY: from getReserveData.currentLiquidityRate (already net of
 *    the reserve factor — it's the supply rate). [on-chain]
 *  - Tulipa RWA income: annualized ERC-4626 share-price change between the
 *    previous snapshot and now. Needs >=2 snapshots; otherwise null + note. [on-chain]
 *  - Incentive/advertised APY (e.g. Zona ~210%): shown ONLY as a labeled note,
 *    NOT added to the comparable number, because no on-chain incentive source was
 *    verified. We rank on the verified base/RWA components. [static note]
 */

import { THRESHOLDS } from '../config.js';
import type { WalletScan } from '../collect.js';
import type { Snapshot } from '../snapshot.js';
import { sourced, type Sourced } from '../types.js';

export interface YieldEntry {
  product: string;
  asset: string;
  baseApyPct: Sourced<number>;
  rwaIncomeApyPct: Sourced<number>;
  incentiveApyNote: Sourced<string>;
  /** The one comparable number: sum of VERIFIED components only. */
  netApyEstimatePct: Sourced<number>;
}

export interface TrueYieldResult {
  layer: 'trueyield';
  entries: YieldEntry[];
}

export function analyzeTrueYield(scan: WalletScan, previous: Snapshot | null): TrueYieldResult {
  const entries: YieldEntry[] = [];

  for (const l of scan.lending) {
    // Report every reserve's base supply APY as a benchmark, flag the ones held.
    for (const r of l.reserves) {
      const held = l.positions.some((p) => p.symbol === r.symbol && p.suppliedAmount > 0);
      const base = r.supplyApyPct;
      // We now READ the on-chain RewardsController, so the incentive note is a
      // verified [on-chain] fact rather than a guess. Emissions are still never
      // folded into the comparable number unless they are active and priceable.
      const inc = l.incentives[r.address.toLowerCase()];
      const advertised =
        l.product === 'ZonaLend' ? ' (Zona advertises ~210% total — see this verified on-chain check.)' : '';
      const incentiveNote = inc
        ? inc.note + advertised
        : 'Incentive controller not read for this reserve.' + advertised;
      entries.push({
        product: l.product,
        asset: r.symbol + (held ? ' (held)' : ''),
        baseApyPct: sourced(round(base), 'on-chain', 'high'),
        rwaIncomeApyPct: sourced(0, 'on-chain', 'high', 'Lending market: no separate RWA-income component.'),
        incentiveApyNote: sourced(incentiveNote, 'on-chain', inc ? 'high' : 'low'),
        netApyEstimatePct: sourced(round(base), 'on-chain', 'high', 'Verified base supply APY only.'),
      });
    }
  }

  // Tulipa: RWA income from share-price drift between snapshots.
  if (scan.vault) {
    const { info } = scan.vault;
    const rwa = annualizedSharePriceApy(scan, previous);
    const base = sourced(0, 'on-chain', 'high', 'Vault yield is realized as share-price growth, shown as RWA income.');
    entries.push({
      product: info.product,
      asset: info.symbol,
      baseApyPct: base,
      rwaIncomeApyPct: rwa,
      incentiveApyNote: sourced(
        'RWA income is realized in NAV/share-price growth; no token incentive component. ' +
          'Ember updates this vault\'s share price ~twice weekly (Tue/Fri), so space snapshots ' +
          '>=4 days apart to capture a real change (otherwise RWA-income reads 0).',
        'static',
        'low',
      ),
      // Mirror the RWA calc's confidence/note so a degraded or implausible figure
      // is never silently promoted to a confident headline number.
      netApyEstimatePct:
        rwa.value === null
          ? sourced<number>(null, 'on-chain', 'low', rwa.note ?? 'Insufficient snapshot history.')
          : sourced<number>(
              round(rwa.value),
              'on-chain',
              rwa.confidence,
              rwa.note ?? 'Annualized share-price growth since last snapshot.',
            ),
    });
  }

  return { layer: 'trueyield', entries };
}

/** Annualize Tulipa share-price change between the previous snapshot and now. */
function annualizedSharePriceApy(scan: WalletScan, previous: Snapshot | null): Sourced<number> {
  if (!scan.vault) return sourced<number>(null, 'on-chain', 'low', 'No vault.');
  const now = scan.vault.info.sharePrice;
  const prevPos = previous?.positions.find((p) => p.product === scan.vault!.info.product);
  if (!previous || !prevPos || prevPos.sharePrice === null || prevPos.sharePrice <= 0) {
    return sourced<number>(
      null,
      'on-chain',
      'low',
      'Needs >=2 snapshots to measure RWA income. Ember updates share price ~twice weekly ' +
        '(Tue/Fri) — take a snapshot now and another >=4 days later for a meaningful reading.',
    );
  }
  const dtSeconds = Math.max(1, Math.floor(Date.now() / 1000) - previous.takenAt);
  // Enforce a minimum interval: below it, annualizing a tiny move is meaningless.
  if (dtSeconds < THRESHOLDS.minSnapshotIntervalSeconds) {
    return sourced<number>(
      null,
      'on-chain',
      'low',
      `Snapshots are only ${Math.round(dtSeconds / 3600)}h apart; need >=` +
        `${Math.round(THRESHOLDS.minSnapshotIntervalSeconds / 86_400)} days to annualize Tulipa's ~twice-weekly ` +
        'share-price update without producing a meaningless figure.',
    );
  }
  const growth = now / prevPos.sharePrice - 1; // fractional growth over the interval
  const apy = ((1 + growth) ** (THRESHOLDS.secondsPerYear / dtSeconds) - 1) * 100;
  if (!Number.isFinite(apy)) {
    return sourced<number>(null, 'on-chain', 'low', 'Share price unchanged or interval too short to annualize.');
  }
  // Flag implausibly high annualized figures (short/volatile interval artifact).
  if (Math.abs(apy) > THRESHOLDS.maxPlausibleApyPct) {
    return sourced<number>(
      round(apy),
      'on-chain',
      'low',
      `Implausibly high annualized figure (>${THRESHOLDS.maxPlausibleApyPct}%) from a small move over a short ` +
        'interval — treat as noise, not a real yield. Use a longer snapshot gap.',
    );
  }
  return sourced(round(apy), 'on-chain', 'medium');
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
