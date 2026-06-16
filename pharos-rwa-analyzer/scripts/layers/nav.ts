/**
 * Layer 5 — nav. NAV-drift / depeg flags for RWA vault tokens & stablecoins.
 *
 * Two independent signals, each clearly labeled:
 *  - [on-chain] Tulipa ERC-4626 share-price vs 1.0 (NAV drift), and the lending
 *    oracle's USD price of USDC/WETH/WPROS vs $1 for the stablecoin.
 *  - [api] Pharos Watch issuer-level peg for the underlying stablecoin (e.g.
 *    usdc-circle) when an API key is configured; otherwise marked unavailable.
 *
 * Pharos Watch does NOT track the Pharos-native vault token, so vault NAV always
 * comes from the on-chain share price — never blurred into an API value.
 */

import { PHAROS_WATCH, THRESHOLDS } from '../config.js';
import type { WalletScan } from '../collect.js';
import { PharosWatchClient } from '../pharoswatch.js';
import { sourced, type Sourced } from '../types.js';

export interface NavFlag {
  subject: string; // what we're checking (token / vault)
  metric: string; // "share price" | "oracle USD price" | "issuer peg"
  value: Sourced<number>;
  expected: number;
  driftPct: number | null;
  depegged: boolean;
}

export interface NavResult {
  layer: 'nav';
  apiAvailable: boolean;
  apiNote: string;
  flags: NavFlag[];
}

export async function analyzeNav(scan: WalletScan): Promise<NavResult> {
  const flags: NavFlag[] = [];

  // --- On-chain: Tulipa vault NAV via share price ---
  if (scan.vault) {
    const sp = scan.vault.info.sharePrice;
    const drift = (sp - 1) * 100;
    flags.push({
      subject: `${scan.vault.info.product} (${scan.vault.info.symbol})`,
      metric: 'ERC-4626 share price vs 1.0',
      value: sourced(round(sp), 'on-chain', 'high'),
      expected: 1,
      driftPct: round(drift),
      depegged: Math.abs(drift) > THRESHOLDS.depegDriftPct,
    });
  }

  // --- On-chain: stablecoin (USDC) oracle price depeg check ---
  for (const l of scan.lending) {
    for (const [addr, price] of Object.entries(l.assetUsd)) {
      const reserve = l.reserves.find((r) => r.address.toLowerCase() === addr);
      if (!reserve || reserve.symbol !== 'USDC') continue; // only stablecoins are "depeggable" vs $1
      const drift = (price - 1) * 100;
      flags.push({
        subject: `${reserve.symbol} @ ${l.product}`,
        metric: 'oracle USD price vs $1.00',
        value: sourced(round(price), 'on-chain', 'high'),
        expected: 1,
        driftPct: round(drift),
        depegged: Math.abs(drift) > THRESHOLDS.depegDriftPct,
      });
      break; // one USDC reading per venue is enough
    }
  }

  // --- API: Pharos Watch issuer-level peg reference ---
  const client = new PharosWatchClient();
  let apiNote: string;
  if (!scan.watch.health.reachable) {
    apiNote = 'Pharos Watch API unreachable; using on-chain signals only.';
  } else if (!client.isConfigured()) {
    apiNote =
      'Pharos Watch reachable (health OK) but data routes need an API key (set PHAROS_WATCH_API_KEY). ' +
      'Showing on-chain NAV/depeg only. Pharos Watch tracks global stablecoin issuers, not the Pharos vault token.';
  } else {
    apiNote = 'Pharos Watch issuer-level peg references (from /api/peg-summary) included below.';
    for (const id of PHAROS_WATCH.referenceStablecoinIds) {
      const peg = await client.getPeg(id);
      // Depeg if Pharos Watch flags an active depeg OR drift exceeds our threshold.
      const depegged =
        peg.activeDepeg === true || (peg.driftPct !== null && Math.abs(peg.driftPct) > THRESHOLDS.depegDriftPct);
      flags.push({
        subject: `${id} (issuer reference)`,
        metric: 'Pharos Watch peg (deviation bps / pegScore)',
        value: sourced(peg.priceUsd, 'api', peg.available ? 'high' : 'low', peg.note),
        expected: 1,
        driftPct: peg.driftPct === null ? null : round(peg.driftPct),
        depegged,
      });
    }
  }

  return {
    layer: 'nav',
    apiAvailable: scan.watch.configured && scan.watch.health.reachable,
    apiNote,
    flags,
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
