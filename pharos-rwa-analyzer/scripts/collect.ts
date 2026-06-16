/**
 * collect.ts — gather every live read ONCE into a WalletScan.
 *
 * The six layers are pure functions over this object, so `report` makes one pass
 * of RPC/API calls instead of six. Each venue is scanned independently and a
 * failure in one venue is captured as an error, never silently dropped.
 */

import {
  getLendingAdapters,
  type LendingVenueAdapter,
  type ReserveInfo,
  type UserAccount,
  type UserReservePosition,
} from './lending.js';
import { readIncentives, type IncentiveInfo } from './incentives.js';
import { type ReadCtx } from './multicall.js';
import { assertPharosNetwork, type NetworkCheck } from './rpc.js';
import { TulipaVault, type VaultInfo, type VaultPosition } from './vault.js';
import { PharosWatchClient, type WatchHealth } from './pharoswatch.js';
import type { AnalyzerError } from './types.js';

export interface LendingScan {
  product: string;
  venue: string;
  access: string;
  oracleAddress: string;
  dataProviderAddress: string;
  reserves: ReserveInfo[];
  positions: UserReservePosition[];
  account: UserAccount;
  /** USD price per reserve asset (from this venue's oracle). */
  assetUsd: Record<string, number>;
  /** On-chain incentive info per reserve asset address (lowercased). */
  incentives: Record<string, IncentiveInfo>;
}

export interface VaultScan {
  info: VaultInfo;
  position: VaultPosition;
  /** Underlying asset USD price (from a lending oracle), if resolvable. */
  assetUsd: number | null;
}

export interface WalletScan {
  address: string;
  network: NetworkCheck;
  /** Block every read in this scan was pinned to (consistency + reproducibility). */
  block: number;
  lending: LendingScan[];
  vault: VaultScan | null;
  watch: { configured: boolean; health: WatchHealth };
  errors: AnalyzerError[];
}

async function scanLendingVenue(
  adapter: LendingVenueAdapter,
  address: string,
  errors: AnalyzerError[],
  ctx: ReadCtx,
): Promise<LendingScan | null> {
  try {
    const resolved = await adapter.refreshResolvedAddresses(ctx);
    const reserves = await adapter.getReserves(ctx);
    const [positions, account] = await Promise.all([
      adapter.getUserPositions(address, reserves, ctx),
      adapter.getUserAccount(address, ctx),
    ]);
    // Price every reserve asset once via this venue's oracle, and read its
    // on-chain incentive config (verified [on-chain] base for the incentive note).
    const oracle = adapter.getOracle();
    const assetUsd: Record<string, number> = {};
    const incentives: Record<string, IncentiveInfo> = {};
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const r of reserves) {
      try {
        assetUsd[r.address.toLowerCase()] = await oracle.getUsdPrice(r.address, ctx);
      } catch (err) {
        errors.push({ scope: `${adapter.product} price ${r.symbol}`, message: errMsg(err) });
      }
      try {
        incentives[r.address.toLowerCase()] = await readIncentives(r.aTokenAddress, nowSeconds, ctx);
      } catch (err) {
        errors.push({ scope: `${adapter.product} incentives ${r.symbol}`, message: errMsg(err) });
      }
    }
    return {
      product: adapter.product,
      venue: adapter.venue,
      access: adapter.access,
      oracleAddress: resolved.oracle,
      dataProviderAddress: resolved.dataProvider,
      reserves,
      positions,
      account,
      assetUsd,
      incentives,
    };
  } catch (err) {
    errors.push({ scope: `${adapter.product} scan`, message: errMsg(err) });
    return null;
  }
}

export async function collectWalletScan(address: string, allowTestnet = false): Promise<WalletScan> {
  const errors: AnalyzerError[] = [];
  const network = await assertPharosNetwork(allowTestnet);
  // Pin the block once: every read below is consistent and the snapshot is reproducible.
  const ctx: ReadCtx = { blockTag: network.blockNumber };

  const adapters = getLendingAdapters();
  const lendingResults = await Promise.all(adapters.map((a) => scanLendingVenue(a, address, errors, ctx)));
  const lending = lendingResults.filter((x): x is LendingScan => x !== null);

  // Vault scan.
  let vault: VaultScan | null = null;
  try {
    const tv = new TulipaVault();
    const info = await tv.getInfo(ctx);
    if (info) {
      const position = await tv.getPosition(address, info, ctx);
      // Resolve the vault asset's USD price from any venue oracle that prices it.
      let assetUsd: number | null = null;
      for (const l of lending) {
        const p = l.assetUsd[info.assetAddress.toLowerCase()];
        if (typeof p === 'number') {
          assetUsd = p;
          break;
        }
      }
      vault = { info, position, assetUsd };
    } else {
      errors.push({ scope: 'Tulipa', message: 'Vault did not respond as ERC-4626 (asset() reverted).' });
    }
  } catch (err) {
    errors.push({ scope: 'Tulipa scan', message: errMsg(err) });
  }

  // Pharos Watch reachability (key-exempt health always; data routes gated).
  const watchClient = new PharosWatchClient();
  const health = await watchClient.health();

  return {
    address,
    network,
    block: ctx.blockTag,
    lending,
    vault,
    watch: { configured: watchClient.isConfigured(), health },
    errors,
  };
}

function errMsg(err: unknown): string {
  if (err && typeof err === 'object' && 'shortMessage' in err) {
    return String((err as { shortMessage: unknown }).shortMessage);
  }
  return err instanceof Error ? err.message : String(err);
}
