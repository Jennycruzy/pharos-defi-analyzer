/**
 * Layer 6 — diff. Compare now vs the most recent saved snapshot.
 *
 * Reports deltas that make the analyzer continuously useful and feed Phase 2:
 * yield accrued (supplied amount / share-price change), status changes
 * (frozen toggled), redemption-capacity changes, and time since last snapshot.
 * Pure reads + local JSON snapshots; nothing is written on-chain.
 */

import type { WalletScan } from '../collect.js';
import type { Snapshot, SnapshotPosition } from '../snapshot.js';
import { sourced, type Sourced } from '../types.js';

export interface DiffChange {
  product: string;
  asset: string;
  field: string;
  before: number | boolean | null;
  after: number | boolean | null;
  delta: number | null;
  note: string;
}

export interface DiffResult {
  layer: 'diff';
  hasPrevious: boolean;
  previousAt: number | null;
  ageSeconds: number | null;
  changes: DiffChange[];
  summary: Sourced<string>;
}

/** Build the diff-relevant snapshot from a scan (USD per-position computed by caller). */
export function buildSnapshot(scan: WalletScan, usdByKey: Map<string, number>): Snapshot {
  const positions: SnapshotPosition[] = [];

  for (const l of scan.lending) {
    for (const p of l.positions) {
      const key = `${l.product}:${p.symbol}`;
      const reserve = l.reserves.find((r) => r.symbol === p.symbol);
      positions.push({
        product: l.product,
        asset: p.symbol,
        suppliedAmount: p.suppliedAmount,
        borrowedAmount: p.borrowedAmount,
        suppliedUsd: usdByKey.get(key) ?? null,
        baseApyPct: reserve ? reserve.supplyApyPct : null,
        sharePrice: null,
        redeemableAssets: null,
        isFrozen: reserve ? reserve.isFrozen : null,
      });
    }
  }

  if (scan.vault && scan.vault.position.shares > 0) {
    const key = `${scan.vault.info.product}:${scan.vault.info.symbol}`;
    positions.push({
      product: scan.vault.info.product,
      asset: scan.vault.info.symbol,
      suppliedAmount: scan.vault.position.shares,
      borrowedAmount: 0,
      suppliedUsd: usdByKey.get(key) ?? null,
      baseApyPct: null,
      sharePrice: scan.vault.info.sharePrice,
      redeemableAssets: scan.vault.position.redeemableAssets,
      isFrozen: null,
    });
  }

  const totalUsd = positions.reduce((s, p) => s + (p.suppliedUsd ?? 0), 0);
  return {
    version: 1,
    address: scan.address,
    takenAt: Math.floor(Date.now() / 1000),
    chainId: scan.network.chainId.toString(),
    totalUsd: positions.length ? totalUsd : null,
    positions,
  };
}

export function analyzeDiff(current: Snapshot, previous: Snapshot | null): DiffResult {
  if (!previous) {
    return {
      layer: 'diff',
      hasPrevious: false,
      previousAt: null,
      ageSeconds: null,
      changes: [],
      summary: sourced(
        'No prior snapshot for this wallet. Run `snapshot` now, come back later, and `diff` will show what changed.',
        'static',
        'high',
      ),
    };
  }

  const ageSeconds = current.takenAt - previous.takenAt;
  const changes: DiffChange[] = [];
  const prevByKey = new Map(previous.positions.map((p) => [`${p.product}:${p.asset}`, p]));

  for (const cur of current.positions) {
    const key = `${cur.product}:${cur.asset}`;
    const prev = prevByKey.get(key);
    if (!prev) {
      changes.push({
        product: cur.product,
        asset: cur.asset,
        field: 'position',
        before: null,
        after: cur.suppliedAmount,
        delta: cur.suppliedAmount,
        note: 'New position since last snapshot.',
      });
      continue;
    }
    pushNumberChange(changes, cur, 'suppliedAmount', prev.suppliedAmount, cur.suppliedAmount, 'supplied balance');
    pushNumberChange(changes, cur, 'sharePrice', prev.sharePrice, cur.sharePrice, 'vault share price (RWA income)');
    pushNumberChange(changes, cur, 'redeemableAssets', prev.redeemableAssets, cur.redeemableAssets, 'redeemable now');
    if (prev.isFrozen !== null && cur.isFrozen !== null && prev.isFrozen !== cur.isFrozen) {
      changes.push({
        product: cur.product,
        asset: cur.asset,
        field: 'isFrozen',
        before: prev.isFrozen,
        after: cur.isFrozen,
        delta: null,
        note: cur.isFrozen ? 'Market FROZEN since last snapshot.' : 'Market un-frozen since last snapshot.',
      });
    }
  }

  const summary =
    changes.length === 0
      ? `No material changes in ${fmtAge(ageSeconds)}.`
      : `${changes.length} change(s) over ${fmtAge(ageSeconds)}.`;

  return {
    layer: 'diff',
    hasPrevious: true,
    previousAt: previous.takenAt,
    ageSeconds,
    changes,
    summary: sourced(summary, 'on-chain', 'high'),
  };
}

function pushNumberChange(
  changes: DiffChange[],
  cur: SnapshotPosition,
  field: string,
  before: number | null,
  after: number | null,
  label: string,
): void {
  if (before === null || after === null) return;
  const delta = after - before;
  if (Math.abs(delta) < 1e-12) return;
  changes.push({
    product: cur.product,
    asset: cur.asset,
    field,
    before,
    after,
    delta: Math.round(delta * 1e8) / 1e8,
    note: `${label} ${delta > 0 ? 'increased' : 'decreased'} by ${Math.abs(delta)}.`,
  });
}

function fmtAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}
