/**
 * multicall.ts — batched on-chain reads + transient-error retry.
 *
 * Multicall3 is deployed at the canonical address on Pharos mainnet (confirmed
 * via eth_getCode, 3,808 bytes). Batching collapses the per-reserve sequential
 * round-trips into ONE eth_call, and — crucially for honesty — lets every value
 * in a single report be read at the SAME block (`blockTag`), so the numbers are
 * internally consistent and a saved snapshot is reproducible.
 *
 * `withRetry` wraps reads so a transient RPC hiccup (timeout / 5xx / rate-limit)
 * is retried with backoff instead of degrading a layer for no real reason.
 */

import { ethers } from 'ethers';
import { getProvider } from './rpc.js';

/** Canonical Multicall3 — same address on every chain; verified deployed on Pharos. */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
] as const;

/** A single call in a batch: which contract, which encoded calldata, may it fail. */
export interface Call3 {
  target: string;
  allowFailure: boolean;
  callData: string;
}

export interface Call3Result {
  success: boolean;
  returnData: string;
}

/** One on-chain read recorded for the replayable proof: contract + 4-byte selector. */
export interface ReadRecord {
  target: string; // lowercased contract address
  selector: string; // 0x + 8 hex chars (the function selector)
}

/**
 * Read context shared across one scan. Pinning a block makes every read in a
 * report consistent (no drift between the first and last RPC call). When `reads`
 * is supplied, batched and singleton reads append a (target, selector) record so
 * the report can carry a replayable proof of exactly what it read.
 */
export interface ReadCtx {
  blockTag: number;
  reads?: ReadRecord[];
}

/** Record a single (target, selector) read on the proof log, if one is attached. */
export function logRead(ctx: ReadCtx | undefined, target: string, selector: string): void {
  if (ctx?.reads) ctx.reads.push({ target: target.toLowerCase(), selector });
}

/** Execute a Multicall3 batch as a static (read-only) call at an optional block. */
export async function aggregate3(calls: Call3[], ctx?: ReadCtx): Promise<Call3Result[]> {
  const mc = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, getProvider());
  const overrides = ctx ? { blockTag: ctx.blockTag } : {};
  // Record each batched read (target + 4-byte selector) for the proof.
  for (const c of calls) logRead(ctx, c.target, c.callData.slice(0, 10));
  const raw = (await withRetry(
    () => mc.aggregate3.staticCall(calls, overrides),
    'multicall.aggregate3',
  )) as Array<{ success: boolean; returnData: string }>;
  return raw.map((r) => ({ success: r.success, returnData: r.returnData }));
}

/**
 * Retry a read on transient errors with exponential backoff. Re-throws on the
 * final attempt and on clearly non-transient errors (e.g. a real revert), so we
 * never paper over a genuine contract failure.
 */
export async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === attempts - 1) throw err;
      const backoffMs = 200 * 2 ** i; // 200ms, 400ms, 800ms…
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  // Unreachable (loop either returns or throws), but keeps the type checker happy.
  throw lastErr instanceof Error ? lastErr : new Error(`${label} failed: ${String(lastErr)}`);
}

/** Heuristic: network/timeout/server/rate-limit errors are worth retrying; reverts are not. */
function isTransient(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code && ['TIMEOUT', 'NETWORK_ERROR', 'SERVER_ERROR', 'ECONNRESET', 'ECONNREFUSED'].includes(code)) {
    return true;
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('socket') ||
    msg.includes('429') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('rate limit')
  );
}
