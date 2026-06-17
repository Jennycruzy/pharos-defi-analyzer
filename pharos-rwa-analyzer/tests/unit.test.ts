/**
 * unit.test.ts — pure-function tests (no network, no mocks of chain data).
 *
 * These exercise the deterministic LOGIC of the analyzer with hand-constructed
 * inputs: the diff engine and the per-collateral liquidation math. Testing a pure
 * function with sample numbers is not a "mock" of on-chain data — it verifies the
 * math the live layers depend on, which we otherwise can't trigger because the
 * demo wallet carries no debt.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { analyzeDiff } from '../scripts/layers/diff.js';
import { priceDropToLiquidation } from '../scripts/layers/risk.js';
import { findBestRebalance } from '../scripts/plan.js';
import type { WalletScan } from '../scripts/collect.js';
import type { Snapshot } from '../scripts/snapshot.js';

function snap(overrides: Partial<Snapshot> & { takenAt: number }): Snapshot {
  return {
    version: 1,
    address: '0x0000000000000000000000000000000000000001',
    chainId: '1672',
    totalUsd: 100,
    positions: [],
    ...overrides,
  };
}

test('priceDropToLiquidation: single collateral, 50% headroom', () => {
  // $100 collateral, LT 0.8 → weight 80; debt $40 → d = 1 - 40/80 = 0.5.
  assert.equal(priceDropToLiquidation(100, 0.8, 0, 40), 0.5);
});

test('priceDropToLiquidation: already at/over the boundary clamps to 0', () => {
  // debt 100 > weight 80 → negative, clamped to 0 (already liquidatable).
  assert.equal(priceDropToLiquidation(100, 0.8, 0, 100), 0);
});

test('priceDropToLiquidation: other collateral fully covers debt clamps to 1', () => {
  // other weighted ($50) already exceeds debt ($40): this asset can drop 100% safely.
  assert.equal(priceDropToLiquidation(10, 0.8, 50, 40), 1);
});

test('priceDropToLiquidation: a non-collateral asset returns null', () => {
  assert.equal(priceDropToLiquidation(0, 0.8, 0, 40), null);
  assert.equal(priceDropToLiquidation(100, 0, 0, 40), null);
});

test('analyzeDiff: no previous snapshot reports clean baseline', () => {
  const cur = snap({ takenAt: 1000 });
  const d = analyzeDiff(cur, null);
  assert.equal(d.hasPrevious, false);
  assert.equal(d.changes.length, 0);
  assert.ok(d.summary.value && d.summary.value.includes('No prior snapshot'));
});

test('analyzeDiff: detects supplied-balance growth (yield accrued)', () => {
  const prev = snap({
    takenAt: 1000,
    positions: [
      {
        product: 'OpenFi',
        asset: 'USDC',
        suppliedAmount: 100,
        borrowedAmount: 0,
        suppliedUsd: 100,
        baseApyPct: 1,
        sharePrice: null,
        redeemableAssets: null,
        isFrozen: false,
      },
    ],
  });
  const cur = snap({
    takenAt: 1000 + 86_400,
    positions: [{ ...prev.positions[0]!, suppliedAmount: 100.5 }],
  });
  const d = analyzeDiff(cur, prev);
  assert.equal(d.hasPrevious, true);
  const change = d.changes.find((c) => c.field === 'suppliedAmount');
  assert.ok(change, 'should detect supplied balance change');
  assert.equal(change.before, 100);
  assert.equal(change.after, 100.5);
  assert.ok(change.note.includes('increased'));
});

test('analyzeDiff: detects a market freezing', () => {
  const base = {
    product: 'ZonaLend',
    asset: 'WETH',
    suppliedAmount: 1,
    borrowedAmount: 0,
    suppliedUsd: 3000,
    baseApyPct: 0,
    sharePrice: null,
    redeemableAssets: null,
    isFrozen: false,
  };
  const prev = snap({ takenAt: 1000, positions: [base] });
  const cur = snap({ takenAt: 2000, positions: [{ ...base, isFrozen: true }] });
  const d = analyzeDiff(cur, prev);
  const frozen = d.changes.find((c) => c.field === 'isFrozen');
  assert.ok(frozen, 'should detect freeze toggle');
  assert.equal(frozen.after, true);
  assert.ok(frozen.note.includes('FROZEN'));
});

function scanForPlan(overrides: Partial<WalletScan> = {}): WalletScan {
  return {
    address: '0x0000000000000000000000000000000000000001',
    network: { chainId: 1672n, blockNumber: 1, isMainnet: true, rpcUrl: 'local' },
    block: 1,
    blockHash: null,
    reads: [],
    lending: [],
    vault: null,
    watch: { configured: false, health: { reachable: false, status: null, upstreamProvider: null, raw: null } },
    errors: [],
    ...overrides,
  };
}

test('findBestRebalance: selects higher APY venue for the same supplied asset', () => {
  const scan = scanForPlan({
    lending: [
      {
        product: 'OpenFi',
        venue: 'OpenFi',
        access: 'permissionless',
        oracleAddress: '0x0000000000000000000000000000000000000002',
        dataProviderAddress: '0x0000000000000000000000000000000000000003',
        reserves: [],
        positions: [
          {
            symbol: 'USDC',
            address: '0x0000000000000000000000000000000000000004',
            decimals: 6,
            suppliedAmount: 100,
            borrowedAmount: 0,
            supplyAprPct: 2,
            liquidationThresholdPct: 80,
            usageAsCollateral: false,
            withdrawableNow: 100,
          },
        ],
        account: { totalCollateralUsd: 0, totalDebtUsd: 0, ltvPct: 0, liquidationThresholdPct: 0, healthFactor: Infinity },
        assetUsd: { '0x0000000000000000000000000000000000000004': 1 },
        incentives: {},
      },
      {
        product: 'ZonaLend',
        venue: 'ZonaLend',
        access: 'permissionless',
        oracleAddress: '0x0000000000000000000000000000000000000005',
        dataProviderAddress: '0x0000000000000000000000000000000000000006',
        reserves: [
          {
            symbol: 'USDC',
            address: '0x0000000000000000000000000000000000000004',
            aTokenAddress: '0x0000000000000000000000000000000000000007',
            decimals: 6,
            supplyAprPct: 4,
            supplyApyPct: 4.1,
            variableBorrowAprPct: 0,
            ltvPct: 0,
            liquidationThresholdPct: 0,
            isActive: true,
            isFrozen: false,
            availableLiquidity: 1000,
          },
        ],
        positions: [],
        account: { totalCollateralUsd: 0, totalDebtUsd: 0, ltvPct: 0, liquidationThresholdPct: 0, healthFactor: Infinity },
        assetUsd: {},
        incentives: {},
      },
    ],
  });

  const candidate = findBestRebalance(scan, { maxSpendUsd: 500 });
  assert.ok(candidate);
  assert.equal(candidate.fromProduct, 'OpenFi');
  assert.equal(candidate.toProduct, 'ZonaLend');
  assert.equal(candidate.asset, 'USDC');
  assert.equal(candidate.amount, 100);
});

test('findBestRebalance: spend cap rejects otherwise profitable move', () => {
  const scan = scanForPlan({
    lending: [
      {
        product: 'A',
        venue: 'A',
        access: 'permissionless',
        oracleAddress: '0x0000000000000000000000000000000000000002',
        dataProviderAddress: '0x0000000000000000000000000000000000000003',
        reserves: [],
        positions: [
          {
            symbol: 'USDC',
            address: '0x0000000000000000000000000000000000000004',
            decimals: 6,
            suppliedAmount: 100,
            borrowedAmount: 0,
            supplyAprPct: 1,
            liquidationThresholdPct: 80,
            usageAsCollateral: false,
            withdrawableNow: 100,
          },
        ],
        account: { totalCollateralUsd: 0, totalDebtUsd: 0, ltvPct: 0, liquidationThresholdPct: 0, healthFactor: Infinity },
        assetUsd: { '0x0000000000000000000000000000000000000004': 1 },
        incentives: {},
      },
      {
        product: 'B',
        venue: 'B',
        access: 'permissionless',
        oracleAddress: '0x0000000000000000000000000000000000000005',
        dataProviderAddress: '0x0000000000000000000000000000000000000006',
        reserves: [
          {
            symbol: 'USDC',
            address: '0x0000000000000000000000000000000000000004',
            aTokenAddress: '0x0000000000000000000000000000000000000007',
            decimals: 6,
            supplyAprPct: 8,
            supplyApyPct: 8,
            variableBorrowAprPct: 0,
            ltvPct: 0,
            liquidationThresholdPct: 0,
            isActive: true,
            isFrozen: false,
            availableLiquidity: 1000,
          },
        ],
        positions: [],
        account: { totalCollateralUsd: 0, totalDebtUsd: 0, ltvPct: 0, liquidationThresholdPct: 0, healthFactor: Infinity },
        assetUsd: {},
        incentives: {},
      },
    ],
  });

  assert.equal(findBestRebalance(scan, { maxSpendUsd: 50 }), null);
});
