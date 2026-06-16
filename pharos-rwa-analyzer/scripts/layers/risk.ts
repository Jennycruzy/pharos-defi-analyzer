/**
 * Layer 4 — risk. Cross-protocol: aggregate USD exposure, the most fragile
 * position (liquidation distance), and concentration warnings.
 *
 *  - USD exposure via each venue's own oracle (8-decimal base, verified). [on-chain]
 *  - For borrowed positions: account health factor (Aave 1e18, HF<1 = liquidatable)
 *    plus a PER-COLLATERAL price-drop-to-liquidation, holding other prices fixed.
 *  - Concentration: each product's % of total wallet value, flagged over threshold.
 *
 * If a position's USD price can't be sourced this run, the total is labeled
 * degraded ([static]/low) rather than silently presented as a live [on-chain] read.
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

/** Per-collateral liquidation distance within a venue that carries debt. */
export interface CollateralLiquidation {
  product: string;
  asset: string;
  collateralUsd: number;
  liquidationThresholdPct: number;
  /** % this asset's price can fall (others held constant) before HF reaches 1. */
  priceDropToLiquidationPct: number | null;
}

export interface FragilePosition {
  product: string;
  healthFactor: number | null; // null when no debt anywhere
  priceDropToLiquidationPct: number | null; // aggregate (all collateral moves together)
  perCollateral: CollateralLiquidation[];
  note: string;
}

export interface RiskResult {
  layer: 'risk';
  totalUsd: Sourced<number>;
  perPosition: PositionExposure[];
  mostFragile: Sourced<FragilePosition>;
  concentrationWarnings: string[];
}

/**
 * Pure: the fractional price drop in ONE collateral asset (others fixed) that
 * brings an Aave account to the liquidation boundary Σ(collateralᵢ·LTᵢ) = debt.
 *
 *   debt = (otherCollateralWeighted) + thisCollateralUsd·(1−d)·LT_this
 *   ⇒ d = 1 − (debt − otherCollateralWeighted) / (thisCollateralUsd·LT_this)
 *
 * Returns a value in [0,1], or null when this asset is not collateral / has no
 * weight. d≤0 means already at/over the boundary; d≥1 means even a total wipeout
 * of this one asset wouldn't trigger liquidation (other collateral covers it).
 */
export function priceDropToLiquidation(
  thisCollateralUsd: number,
  thisLiquidationThreshold: number, // fraction, e.g. 0.78
  otherCollateralWeightedUsd: number, // Σ over other assets of collateralUsd·LT
  debtUsd: number,
): number | null {
  const weightThis = thisCollateralUsd * thisLiquidationThreshold;
  if (weightThis <= 0) return null;
  const d = 1 - (debtUsd - otherCollateralWeightedUsd) / weightThis;
  if (!Number.isFinite(d)) return null;
  return Math.min(1, Math.max(0, d));
}

export function analyzeRisk(scan: WalletScan): RiskResult {
  const perPosition: PositionExposure[] = [];
  let priceDegraded = false; // set when any USD figure falls back to an assumption

  // Lending exposure.
  for (const l of scan.lending) {
    for (const p of l.positions) {
      const price = l.assetUsd[p.address.toLowerCase()];
      if (price === undefined && (p.suppliedAmount > 0 || p.borrowedAmount > 0)) priceDegraded = true;
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
    let underlyingUsd = v.assetUsd;
    if (underlyingUsd === null) {
      underlyingUsd = 1; // vault asset is USDC; $1 is an assumption, so flag it.
      priceDegraded = true;
    }
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

  // Most fragile: the venue with the lowest finite health factor among those with debt.
  let fragile: FragilePosition = {
    product: '(none)',
    healthFactor: null,
    priceDropToLiquidationPct: null,
    perCollateral: [],
    note: 'No borrowed positions detected — no liquidation risk for this wallet.',
  };
  let lowestHf = Number.POSITIVE_INFINITY;
  for (const l of scan.lending) {
    const hf = l.account.healthFactor;
    if (l.account.totalDebtUsd > 0 && Number.isFinite(hf) && hf < lowestHf) {
      lowestHf = hf;
      // Aggregate distance: all collateral prices move together. HF = ΣcᵢLTᵢ/debt,
      // so a uniform drop d hits HF=1 at d = 1 − 1/HF.
      const aggDrop = hf > 0 ? (1 - 1 / hf) * 100 : 0;

      // Per-collateral distance: only one asset's price moves at a time.
      const collateral = l.positions.filter((p) => p.usageAsCollateral && p.suppliedAmount > 0);
      const weighted = collateral.map((p) => {
        const usd = (l.assetUsd[p.address.toLowerCase()] ?? 0) * p.suppliedAmount;
        return { p, usd, weight: usd * (p.liquidationThresholdPct / 100) };
      });
      const totalWeight = weighted.reduce((s, w) => s + w.weight, 0);
      const perCollateral: CollateralLiquidation[] = weighted.map((w) => {
        const otherWeight = totalWeight - w.weight;
        const d = priceDropToLiquidation(
          w.usd,
          w.p.liquidationThresholdPct / 100,
          otherWeight,
          l.account.totalDebtUsd,
        );
        return {
          product: l.product,
          asset: w.p.symbol,
          collateralUsd: round(w.usd),
          liquidationThresholdPct: w.p.liquidationThresholdPct,
          priceDropToLiquidationPct: d === null ? null : round(d * 100),
        };
      });

      fragile = {
        product: l.product,
        healthFactor: round(hf),
        priceDropToLiquidationPct: round(aggDrop),
        perCollateral,
        note:
          hf < THRESHOLDS.fragileHealthFactor
            ? `FRAGILE: health factor ${round(hf)} < ${THRESHOLDS.fragileHealthFactor}. ` +
              `A ~${round(aggDrop)}% across-the-board collateral price drop triggers liquidation.`
            : `Health factor ${round(hf)}. A ~${round(aggDrop)}% across-the-board collateral price drop would reach liquidation.`,
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
    totalUsd: priceDegraded
      ? sourced(
          round(totalUsd),
          'static',
          'low',
          'At least one position used an assumed price (oracle unavailable this run) — total is an estimate, not a pure on-chain read.',
        )
      : sourced(round(totalUsd), 'on-chain', totalUsd > 0 ? 'high' : 'medium'),
    perPosition,
    mostFragile: sourced(fragile, 'on-chain', 'high'),
    concentrationWarnings: warnings,
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
