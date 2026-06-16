/**
 * snapshot.ts — persist position snapshots to local JSON for the `diff` layer.
 *
 * Pure filesystem (not browser storage). One file per wallet under ./snapshots,
 * append-only history so `diff` can compare "now" against the most recent prior
 * snapshot: yield accrued, status changes, share-price/NAV drift, maturity countdown.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const SNAP_DIR = path.resolve(process.cwd(), 'snapshots');

/** A single position's diff-relevant fields. Kept minimal and stable. */
export interface SnapshotPosition {
  product: string;
  asset: string;
  suppliedAmount: number;
  borrowedAmount: number;
  suppliedUsd: number | null;
  baseApyPct: number | null;
  sharePrice: number | null; // vaults only
  redeemableAssets: number | null; // vaults only
  isFrozen: boolean | null;
}

export interface Snapshot {
  version: 1;
  address: string;
  takenAt: number; // unix seconds
  chainId: string;
  totalUsd: number | null;
  positions: SnapshotPosition[];
}

function fileFor(address: string): string {
  return path.join(SNAP_DIR, `${address.toLowerCase()}.json`);
}

/** Load full snapshot history for an address (oldest -> newest). */
export async function loadHistory(address: string): Promise<Snapshot[]> {
  try {
    const raw = await fs.readFile(fileFor(address), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Snapshot[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** The most recent snapshot strictly before `now`, or null if none. */
export async function loadPrevious(address: string): Promise<Snapshot | null> {
  const history = await loadHistory(address);
  return history.length > 0 ? (history[history.length - 1] ?? null) : null;
}

/** Lowercased addresses that have at least one saved snapshot (for MCP resource listing). */
export async function listSnapshotAddresses(): Promise<string[]> {
  try {
    const files = await fs.readdir(SNAP_DIR);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '').toLowerCase());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Append a snapshot to the address's history file. Returns the saved snapshot. */
export async function saveSnapshot(snap: Snapshot): Promise<Snapshot> {
  await fs.mkdir(SNAP_DIR, { recursive: true });
  const history = await loadHistory(snap.address);
  history.push(snap);
  await fs.writeFile(fileFor(snap.address), JSON.stringify(history, null, 2), 'utf8');
  return snap;
}

export function snapshotDir(): string {
  return SNAP_DIR;
}
