/**
 * plan.ts — guarded intent planner for the write-side actuator.
 *
 * The planner is deliberately conservative. It builds Safe meta-transactions and
 * refuses anything that exceeds the configured spend cap or starts from an
 * already-unsafe borrow position. Exact post-action protocol checks are left to
 * the UserOperation simulation path before signing/broadcasting.
 */

import { WRITE_GUARDS } from './config.js';
import type { WalletScan } from './collect.js';
import {
  buildBorrow,
  buildRedeem,
  buildRepay,
  buildSetCollateral,
  buildSupply,
  buildWithdraw,
  type Amount,
  type BuiltAction,
} from './actions.js';
import type { MetaTx } from './aa/safe.js';

export type IntentKind = 'supply' | 'withdraw' | 'borrow' | 'repay' | 'setCollateral' | 'redeem' | 'rebalance';

export interface GuardOptions {
  maxSpendUsd?: number;
  minHealthFactor?: number;
}

export interface IntentRequest {
  kind: IntentKind;
  product?: string;
  asset?: string;
  amount?: Amount;
  useAsCollateral?: boolean;
}

export interface PlannedAction {
  kind: IntentKind;
  description: string;
  metaTxs: MetaTx[];
  spendUsd: number;
  warnings: string[];
  guard: {
    maxSpendUsd: number;
    minHealthFactor: number;
  };
}

export interface RebalanceCandidate {
  asset: string;
  fromProduct: string;
  toProduct: string;
  amount: number;
  fromApyPct: number;
  toApyPct: number;
  gainPct: number;
  spendUsd: number;
}

function guardValues(opts: GuardOptions = {}) {
  const minHealthFactor = Math.max(
    WRITE_GUARDS.absoluteHealthFactorFloor,
    opts.minHealthFactor ?? WRITE_GUARDS.minHealthFactorFloor,
  );
  const maxSpendUsd = opts.maxSpendUsd ?? WRITE_GUARDS.maxSpendUsdPerAction;
  if (!Number.isFinite(maxSpendUsd) || maxSpendUsd < 0) throw new Error('maxSpendUsd must be a non-negative number.');
  return { maxSpendUsd, minHealthFactor };
}

function enforceSpend(action: BuiltAction, maxSpendUsd: number): void {
  if (action.spendUsd > maxSpendUsd) {
    throw new Error(
      `Refusing ${action.kind}: moves $${round(action.spendUsd)}, above max spend cap $${round(maxSpendUsd)}.`,
    );
  }
}

function enforceCurrentHealth(scan: WalletScan, product: string | undefined, minHealthFactor: number): void {
  if (!product) return;
  const venue = scan.lending.find((x) => x.product.toLowerCase() === product.toLowerCase());
  if (!venue || venue.account.totalDebtUsd <= 0) return;
  if (venue.account.healthFactor < minHealthFactor) {
    throw new Error(
      `Refusing action on ${venue.product}: current health factor ${round(venue.account.healthFactor)} is below ` +
        `the required floor ${round(minHealthFactor)}.`,
    );
  }
}

function requireString(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for this intent.`);
  return value;
}

function requireAmount(value: Amount | undefined): Amount {
  if (value === undefined) throw new Error('amount is required for this intent.');
  return value;
}

export async function buildIntentPlan(
  scan: WalletScan,
  safeAddress: string,
  intent: IntentRequest,
  opts: GuardOptions = {},
): Promise<PlannedAction> {
  const guard = guardValues(opts);
  let action: BuiltAction;

  switch (intent.kind) {
    case 'supply':
      action = await buildSupply(
        scan,
        requireString(intent.product, 'product'),
        requireString(intent.asset, 'asset'),
        numberAmount(requireAmount(intent.amount), 'supply'),
        safeAddress,
      );
      break;
    case 'withdraw':
      enforceCurrentHealth(scan, intent.product, guard.minHealthFactor);
      action = await buildWithdraw(
        scan,
        requireString(intent.product, 'product'),
        requireString(intent.asset, 'asset'),
        requireAmount(intent.amount),
        safeAddress,
      );
      break;
    case 'borrow':
      enforceCurrentHealth(scan, intent.product, guard.minHealthFactor);
      action = await buildBorrow(
        scan,
        requireString(intent.product, 'product'),
        requireString(intent.asset, 'asset'),
        numberAmount(requireAmount(intent.amount), 'borrow'),
        safeAddress,
      );
      break;
    case 'repay':
      action = await buildRepay(
        scan,
        requireString(intent.product, 'product'),
        requireString(intent.asset, 'asset'),
        requireAmount(intent.amount),
        safeAddress,
      );
      break;
    case 'setCollateral':
      enforceCurrentHealth(scan, intent.product, guard.minHealthFactor);
      if (intent.useAsCollateral === undefined) throw new Error('useAsCollateral is required for setCollateral.');
      action = buildSetCollateral(
        scan,
        requireString(intent.product, 'product'),
        requireString(intent.asset, 'asset'),
        intent.useAsCollateral,
        safeAddress,
      );
      break;
    case 'redeem':
      action = buildRedeem(scan, requireAmount(intent.amount), safeAddress);
      break;
    case 'rebalance':
      return buildRebalancePlan(scan, safeAddress, opts);
    default: {
      const _never: never = intent.kind;
      throw new Error(`Unknown intent: ${String(_never)}`);
    }
  }

  enforceSpend(action, guard.maxSpendUsd);
  return {
    kind: intent.kind,
    description: action.description,
    metaTxs: action.metaTxs,
    spendUsd: round(action.spendUsd),
    warnings: action.warnings,
    guard,
  };
}

export function findBestRebalance(scan: WalletScan, opts: GuardOptions = {}): RebalanceCandidate | null {
  const guard = guardValues(opts);
  let best: RebalanceCandidate | null = null;

  for (const from of scan.lending) {
    for (const pos of from.positions) {
      if (pos.suppliedAmount <= 0 || pos.borrowedAmount > 0) continue;
      const price = from.assetUsd[pos.address.toLowerCase()];
      if (price === undefined) continue;
      const fromReserve = from.reserves.find((r) => r.symbol.toUpperCase() === pos.symbol.toUpperCase());
      const fromApyPct = fromReserve?.supplyApyPct ?? pos.supplyAprPct;

      for (const to of scan.lending) {
        if (to.product === from.product) continue;
        const reserve = to.reserves.find((r) => r.symbol.toUpperCase() === pos.symbol.toUpperCase());
        if (!reserve || !reserve.isActive || reserve.isFrozen) continue;
        const gainPct = reserve.supplyApyPct - fromApyPct;
        if (gainPct < WRITE_GUARDS.minYieldGainPct) continue;
        const spendUsd = pos.suppliedAmount * price;
        if (spendUsd > guard.maxSpendUsd) continue;
        const candidate: RebalanceCandidate = {
          asset: pos.symbol,
          fromProduct: from.product,
          toProduct: to.product,
          amount: pos.withdrawableNow > 0 ? Math.min(pos.suppliedAmount, pos.withdrawableNow) : pos.suppliedAmount,
          fromApyPct: round(fromApyPct),
          toApyPct: round(reserve.supplyApyPct),
          gainPct: round(gainPct),
          spendUsd: round(spendUsd),
        };
        if (!best || candidate.gainPct > best.gainPct) best = candidate;
      }
    }
  }

  return best;
}

export async function buildRebalancePlan(
  scan: WalletScan,
  safeAddress: string,
  opts: GuardOptions = {},
): Promise<PlannedAction> {
  const guard = guardValues(opts);
  const candidate = findBestRebalance(scan, opts);
  if (!candidate) {
    throw new Error(
      `No rebalance candidate clears the ${WRITE_GUARDS.minYieldGainPct}% APY gain floor and spend cap.`,
    );
  }
  enforceCurrentHealth(scan, candidate.fromProduct, guard.minHealthFactor);

  const withdraw = await buildWithdraw(
    scan,
    candidate.fromProduct,
    candidate.asset,
    candidate.amount,
    safeAddress,
  );
  const supply = await buildSupply(scan, candidate.toProduct, candidate.asset, candidate.amount, safeAddress);
  const metaTxs = [...withdraw.metaTxs, ...supply.metaTxs];

  return {
    kind: 'rebalance',
    description:
      `Move ${round(candidate.amount)} ${candidate.asset} from ${candidate.fromProduct} ` +
      `to ${candidate.toProduct} for +${candidate.gainPct}% APY.`,
    metaTxs,
    spendUsd: round(candidate.spendUsd),
    warnings: [...withdraw.warnings, ...supply.warnings],
    guard,
  };
}

function numberAmount(amount: Amount, kind: string): number {
  if (amount === 'all') throw new Error(`${kind} requires a numeric amount, not "all".`);
  return amount;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
