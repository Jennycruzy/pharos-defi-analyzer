/**
 * actions.ts — the write PRIMITIVES, as Safe meta-transactions.
 *
 * Each builder turns a requested action into one or more `MetaTx`es the Safe will
 * execute (ERC-20 approve is auto-prepended when the allowance is short), and
 * returns the USD value it moves OUT of the Safe so the caller can enforce a spend
 * cap. Structural safety lives here (reserve active/not-frozen, amount > 0, pool
 * liquidity bound); financial gating (health-factor floor, max-spend) is applied
 * uniformly by the runner. Vault DEPOSIT is intentionally refused — it is
 * signature-gated on Tulipa, so we never pretend we can do it.
 */

import { ethers } from 'ethers';
import { ERC20_ABI, ERC4626_WRITE_ABI, POOL_WRITE_ABI } from './abi.js';
import { LENDING_VENUES } from './config.js';
import type { LendingScan, WalletScan } from './collect.js';
import { getProvider } from './rpc.js';
import type { MetaTx } from './aa/safe.js';

const POOL_IFACE = new ethers.Interface(POOL_WRITE_ABI);
const ERC20_IFACE = new ethers.Interface(ERC20_ABI);
const VAULT_IFACE = new ethers.Interface(ERC4626_WRITE_ABI);

const VARIABLE_RATE = 2n; // Aave interestRateMode: 2 = variable
const REFERRAL = 0;

export type ActionKind = 'supply' | 'withdraw' | 'borrow' | 'repay' | 'setCollateral' | 'redeem';

export interface BuiltAction {
  kind: ActionKind;
  description: string;
  metaTxs: MetaTx[];
  /** USD value leaving the Safe (supply/repay), or the new exposure (borrow). 0 for inflows. */
  spendUsd: number;
  warnings: string[];
}

/** "all" means the full position; a number is a human (non-wei) amount. */
export type Amount = number | 'all';

function poolFor(product: string): string {
  const v = LENDING_VENUES.find((x) => x.product === product);
  if (!v) throw new Error(`Unknown lending venue "${product}". Known: ${LENDING_VENUES.map((x) => x.product).join(', ')}`);
  return ethers.getAddress(v.pool);
}

function venueFor(scan: WalletScan, product: string): LendingScan {
  const l = scan.lending.find((x) => x.product === product);
  if (!l) throw new Error(`Venue "${product}" was not scanned (not reachable this run).`);
  return l;
}

function reserveFor(l: LendingScan, asset: string) {
  const r = l.reserves.find((x) => x.symbol.toUpperCase() === asset.toUpperCase());
  if (!r) throw new Error(`Asset "${asset}" is not a reserve on ${l.product}. Reserves: ${l.reserves.map((x) => x.symbol).join(', ')}`);
  return r;
}

function priceOf(l: LendingScan, assetAddress: string): number {
  const p = l.assetUsd[assetAddress.toLowerCase()];
  if (p === undefined) {
    throw new Error(
      `No oracle price for ${assetAddress} on ${l.product} this run — refusing to size a write off an unsourced price.`,
    );
  }
  return p;
}

/** Human number → wei, clamped to the token's decimals (no float/exponent surprises). */
export function toWei(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Amount must be a positive finite number (got ${amount}).`);
  return ethers.parseUnits(amount.toFixed(decimals), decimals);
}

/** Read the Safe's current ERC-20 allowance to `spender` (0 if the Safe is undeployed). */
async function allowance(token: string, owner: string, spender: string): Promise<bigint> {
  try {
    const c = new ethers.Contract(token, ERC20_ABI, getProvider());
    return (await c.allowance(owner, spender)) as bigint;
  } catch {
    return 0n; // undeployed Safe / non-standard token → treat as no allowance
  }
}

/** Prepend an approve only when the current allowance is insufficient. */
async function approveIfNeeded(
  token: string,
  symbol: string,
  owner: string,
  spender: string,
  amountWei: bigint,
): Promise<MetaTx[]> {
  const current = await allowance(token, owner, spender);
  if (current >= amountWei) return [];
  return [
    {
      to: ethers.getAddress(token),
      value: 0n,
      data: ERC20_IFACE.encodeFunctionData('approve', [spender, amountWei]),
      label: `approve ${ethers.formatUnits(amountWei, 0)} (raw) ${symbol} to ${spender}`,
    },
  ];
}

// ─────────────────────────────────────────────────────────────── lending ────

export async function buildSupply(
  scan: WalletScan,
  product: string,
  asset: string,
  amount: number,
  safe: string,
): Promise<BuiltAction> {
  const l = venueFor(scan, product);
  const r = reserveFor(l, asset);
  if (!r.isActive || r.isFrozen) throw new Error(`${product} ${asset} reserve is not active/usable (frozen=${r.isFrozen}).`);
  const pool = poolFor(product);
  const amountWei = toWei(amount, r.decimals);
  const approve = await approveIfNeeded(r.address, r.symbol, safe, pool, amountWei);
  const supply: MetaTx = {
    to: pool,
    value: 0n,
    data: POOL_IFACE.encodeFunctionData('supply', [r.address, amountWei, safe, REFERRAL]),
    label: `supply ${amount} ${r.symbol} to ${product}`,
  };
  return {
    kind: 'supply',
    description: `Supply ${amount} ${r.symbol} into ${product} (≈$${round(amount * priceOf(l, r.address))}).`,
    metaTxs: [...approve, supply],
    spendUsd: amount * priceOf(l, r.address),
    warnings: [],
  };
}

export async function buildWithdraw(
  scan: WalletScan,
  product: string,
  asset: string,
  amount: Amount,
  safe: string,
): Promise<BuiltAction> {
  const l = venueFor(scan, product);
  const r = reserveFor(l, asset);
  const pos = l.positions.find((p) => p.symbol.toUpperCase() === asset.toUpperCase());
  const supplied = pos?.suppliedAmount ?? 0;
  if (supplied <= 0) throw new Error(`Safe has no supplied ${asset} on ${product} to withdraw.`);
  const human = amount === 'all' ? supplied : amount;
  const warnings: string[] = [];
  // Real on-demand withdrawability is bounded by pool liquidity.
  const liquidityCap = pos?.withdrawableNow ?? r.availableLiquidity;
  if (human > liquidityCap + 1e-9) {
    warnings.push(`Requested ${human} ${asset} exceeds pool liquidity (${round(liquidityCap)}); it may revert or partially fill.`);
  }
  const amountWei = amount === 'all' ? ethers.MaxUint256 : toWei(human, r.decimals);
  const withdraw: MetaTx = {
    to: poolFor(product),
    value: 0n,
    data: POOL_IFACE.encodeFunctionData('withdraw', [r.address, amountWei, safe]),
    label: `withdraw ${amount === 'all' ? 'ALL' : human} ${r.symbol} from ${product}`,
  };
  return {
    kind: 'withdraw',
    description: `Withdraw ${amount === 'all' ? 'all' : human} ${r.symbol} from ${product} back to the Safe.`,
    metaTxs: [withdraw],
    spendUsd: 0, // inflow to the Safe
    warnings,
  };
}

export async function buildBorrow(
  scan: WalletScan,
  product: string,
  asset: string,
  amount: number,
  safe: string,
): Promise<BuiltAction> {
  const l = venueFor(scan, product);
  const r = reserveFor(l, asset);
  if (!r.isActive || r.isFrozen) throw new Error(`${product} ${asset} reserve is not active/usable.`);
  const amountWei = toWei(amount, r.decimals);
  const borrow: MetaTx = {
    to: poolFor(product),
    value: 0n,
    data: POOL_IFACE.encodeFunctionData('borrow', [r.address, amountWei, VARIABLE_RATE, REFERRAL, safe]),
    label: `borrow ${amount} ${r.symbol} (variable) from ${product}`,
  };
  return {
    kind: 'borrow',
    description: `Borrow ${amount} ${r.symbol} from ${product} (≈$${round(amount * priceOf(l, r.address))} new debt).`,
    metaTxs: [borrow],
    spendUsd: amount * priceOf(l, r.address), // treat new debt as "spend" for the cap
    warnings: [],
  };
}

export async function buildRepay(
  scan: WalletScan,
  product: string,
  asset: string,
  amount: Amount,
  safe: string,
): Promise<BuiltAction> {
  const l = venueFor(scan, product);
  const r = reserveFor(l, asset);
  const pos = l.positions.find((p) => p.symbol.toUpperCase() === asset.toUpperCase());
  const debt = pos?.borrowedAmount ?? 0;
  if (debt <= 0) throw new Error(`Safe has no ${asset} debt on ${product} to repay.`);
  const human = amount === 'all' ? debt : amount;
  const pool = poolFor(product);
  // For "all" we approve a touch over the debt and pass MaxUint256 so Aave repays exactly.
  const approveWei = amount === 'all' ? toWei(debt * 1.001, r.decimals) : toWei(human, r.decimals);
  const repayWei = amount === 'all' ? ethers.MaxUint256 : toWei(human, r.decimals);
  const approve = await approveIfNeeded(r.address, r.symbol, safe, pool, approveWei);
  const repay: MetaTx = {
    to: pool,
    value: 0n,
    data: POOL_IFACE.encodeFunctionData('repay', [r.address, repayWei, VARIABLE_RATE, safe]),
    label: `repay ${amount === 'all' ? 'ALL' : human} ${r.symbol} on ${product}`,
  };
  return {
    kind: 'repay',
    description: `Repay ${amount === 'all' ? 'all' : human} ${r.symbol} debt on ${product} (≈$${round(human * priceOf(l, r.address))}).`,
    metaTxs: [...approve, repay],
    spendUsd: human * priceOf(l, r.address),
    warnings: [],
  };
}

export function buildSetCollateral(scan: WalletScan, product: string, asset: string, use: boolean, _safe: string): BuiltAction {
  const l = venueFor(scan, product);
  const r = reserveFor(l, asset);
  return {
    kind: 'setCollateral',
    description: `${use ? 'Enable' : 'Disable'} ${r.symbol} as collateral on ${product}.`,
    metaTxs: [
      {
        to: poolFor(product),
        value: 0n,
        data: POOL_IFACE.encodeFunctionData('setUserUseReserveAsCollateral', [r.address, use]),
        label: `setUserUseReserveAsCollateral ${r.symbol}=${use}`,
      },
    ],
    spendUsd: 0,
    warnings: [],
  };
}

// ───────────────────────────────────────────────────────────────── vault ────

export function buildRedeem(scan: WalletScan, amount: Amount, safe: string): BuiltAction {
  if (!scan.vault) throw new Error('No Tulipa vault position scanned for this account.');
  const v = scan.vault;
  const shares = v.position.shares;
  if (shares <= 0) throw new Error('Safe holds no vault shares to redeem.');
  const human = amount === 'all' ? Math.min(shares, v.position.maxRedeemShares || shares) : amount;
  const warnings: string[] = [];
  if (human > v.position.maxRedeemShares + 1e-9) {
    warnings.push(`Requested ${human} shares exceeds redeemable-now (${round(v.position.maxRedeemShares)}); may revert/partial.`);
  }
  const sharesWei = toWei(human, v.info.decimals);
  return {
    kind: 'redeem',
    description: `Redeem ${amount === 'all' ? 'all redeemable' : human} ${v.info.symbol} shares from ${v.info.product} to the Safe.`,
    metaTxs: [
      {
        to: ethers.getAddress(v.info.address),
        value: 0n,
        data: VAULT_IFACE.encodeFunctionData('redeem', [sharesWei, safe, safe]),
        label: `redeem ${human} ${v.info.symbol} shares`,
      },
    ],
    spendUsd: 0, // inflow
    warnings,
  };
}

/** Vault deposits are signature-gated on Tulipa — we refuse rather than fake it. */
export function buildDeposit(): never {
  throw new Error(
    'Tulipa deposits are signature-gated (require an allowlisted signer, selector 0x50921b23). ' +
      'This actuator will not fabricate a deposit it cannot perform.',
  );
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
