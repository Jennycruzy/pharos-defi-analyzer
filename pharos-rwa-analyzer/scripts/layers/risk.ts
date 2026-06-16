/**
 * Layer 4 — risk. Cross-protocol: aggregate USD exposure, the most fragile
 * position (liquidation distance), and concentration warnings.
 *
 *  - USD exposure via each venue's own oracle (8-decimal base, verified). [on-chain]
 *  - For borrowed positions: health factor (Aave 1e18, HF<1 = liquidatable) and
 *    the % collateral-price drop to liquidation ≈ (1 - 1/HF)·100. [on-chain]
 *  - Concentration: each product's % of total wallet value, flagged over threshold.
 */

import { THRESHOLDS } from '../config.js';
import type { WalletScan } from '../collect.js';
import { sourced, type Sourced } from '../types.js';

export interface PositionExposure {
  product: string;
  asset: string;
  suppliedUsd: number;
  borrowedUsd: number;
  netUsd: number;
}

export interface FragilePosition {
  product: string;
  healthFactor: number | null; // null when no debt anywhere
  priceDropToLiquidationPct: number | null;
  note: string;
}

export interface RiskResult {
  layer: 'risk';
  totalUsd: Sourced<number>;
  perPosition: PositionExposure[];
  mostFragile: Sourced<FragilePosition>;
  concentrationWarnings: string[];
}

export function analyzeRisk(scan: WalletScan): RiskResult {
  const perPosition: PositionExposure[] = [];

  // Lending exposure.
  for (const l of scan.lending) {
    for (const p of l.positions) {
      const price = l.assetUsd[p.address.toLowerCase()];
      const suppliedUsd = price !== undefined ? p.suppliedAmount * price : 0;
      const borrowedUsd = price !== undefined ? p.borrowedAmount * price : 0;
      if (suppliedUsd > 0 || borrowedUsd > 0) {
        perPosition.push({
          product: l.product,
          asset: p.symbol,
          suppliedUsd: round(suppliedUsd),
          borrowedUsd: round(borrowedUsd),
          netUsd: round(suppliedUsd - borrowedUsd),
        });
      }
    }
  }

  // Vault exposure (shares * sharePrice * underlying USD).
  if (scan.vault && scan.vault.position.shares > 0) {
    const v = scan.vault;
    const underlyingUsd = v.assetUsd ?? 1; // vault asset is USDC ~ $1; oracle-priced when available
    const usd = v.position.shares * v.info.sharePrice * underlyingUsd;
    perPosition.push({
      product: v.info.product,
      asset: v.info.symbol,
      suppliedUsd: round(usd),
      borrowedUsd: 0,
      netUsd: round(usd),
    });
  }

  const totalUsd = perPosition.reduce((s, p) => s + p.suppliedUsd, 0);

  // Most fragile: lowest finite health factor among venues that have debt.
  let fragile: FragilePosition = {
    product: '(none)',
    healthFactor: null,
    priceDropToLiquidationPct: null,
    note: 'No borrowed positions detected — no liquidation risk for this wallet.',
  };
  let lowestHf = Number.POSITIVE_INFINITY;
  for (const l of scan.lending) {
    const hf = l.account.healthFactor;
    if (l.account.totalDebtUsd > 0 && Number.isFinite(hf) && hf < lowestHf) {
      lowestHf = hf;
      const dropPct = hf > 0 ? (1 - 1 / hf) * 100 : 0;
      fragile = {
        product: l.product,
        healthFactor: round(hf),
        priceDropToLiquidationPct: round(dropPct),
        note:
          hf < THRESHOLDS.fragileHealthFactor
            ? `FRAGILE: health factor ${round(hf)} < ${THRESHOLDS.fragileHealthFactor}. ` +
              `A ~${round(dropPct)}% collateral price drop triggers liquidation.`
            : `Health factor ${round(hf)}. A ~${round(dropPct)}% collateral price drop would reach liquidation.`,
      };
    }
  }

  // Concentration warnings.
  const warnings: string[] = [];
  if (totalUsd > 0) {
    const byProduct = new Map<string, number>();
    for (const p of perPosition) byProduct.set(p.product, (byProduct.get(p.product) ?? 0) + p.suppliedUsd);
    for (const [product, usd] of byProduct) {
      const pct = (usd / totalUsd) * 100;
      if (pct > THRESHOLDS.concentrationPct) {
        warnings.push(
          `${round(pct)}% of wallet value ($${round(usd)}) is concentrated in ${product} (> ${THRESHOLDS.concentrationPct}% threshold).`,
        );
      }
    }
  }

  return {
    layer: 'risk',
    totalUsd: sourced(round(totalUsd), 'on-chain', totalUsd > 0 ? 'high' : 'medium'),
    perPosition,
    mostFragile: sourced(fragile, 'on-chain', 'high'),
    concentrationWarnings: warnings,
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
