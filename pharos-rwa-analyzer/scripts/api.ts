/**
 * api.ts — the programmatic interface to the analyzer.
 *
 * Single source of truth for the structured report shape, used by BOTH the CLI
 * (`report --json`) and the MCP server, so their outputs can never drift. Other
 * TypeScript agents can also import these functions directly instead of shelling
 * out to the CLI.
 *
 * Everything here is READ-ONLY — it collects a live scan and runs the six pure
 * layer functions over it. It never signs or writes.
 */

import { ethers } from 'ethers';
import { AA_PREDEPLOYS, LENDING_VENUES } from './config.js';
import { collectWalletScan, type WalletScan } from './collect.js';
import { assertPharosNetwork, getProvider } from './rpc.js';
import { PharosWatchClient } from './pharoswatch.js';
import { loadPrevious, saveSnapshot, snapshotDir, type Snapshot } from './snapshot.js';
import { analyzeEligibility, type EligibilityResult } from './layers/eligibility.js';
import { analyzeMaturity, type MaturityResult } from './layers/maturity.js';
import { analyzeTrueYield, type TrueYieldResult } from './layers/trueyield.js';
import { analyzeRisk, type RiskResult } from './layers/risk.js';
import { analyzeNav, type NavResult } from './layers/nav.js';
import { analyzeDiff, buildSnapshot, type DiffResult } from './layers/diff.js';
import type { AnalyzerError } from './types.js';

export type LayerName = 'eligibility' | 'maturity' | 'trueyield' | 'risk' | 'nav' | 'diff';

export interface ReportMeta {
  generatedAt: number;
  address: string;
  network: { chainId: string; block: number };
  readOnly: true;
}

export interface FullReport {
  meta: ReportMeta;
  snapshot: Snapshot;
  eligibility: EligibilityResult;
  maturity: MaturityResult;
  trueyield: TrueYieldResult;
  risk: RiskResult;
  nav: NavResult;
  diff: DiffResult;
  errors: AnalyzerError[];
}

/** USD-by-position map (key "Product:ASSET") derived from the risk layer. */
export function usdMap(risk: RiskResult): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of risk.perPosition) m.set(`${p.product}:${p.asset}`, p.suppliedUsd);
  return m;
}

/** Assemble the full structured report from an already-collected scan. */
export async function buildReport(scan: WalletScan, previous: Snapshot | null): Promise<FullReport> {
  const eligibility = analyzeEligibility(scan);
  const maturity = analyzeMaturity(scan);
  const trueyield = analyzeTrueYield(scan, previous);
  const risk = analyzeRisk(scan);
  const nav = await analyzeNav(scan);
  const current = buildSnapshot(scan, usdMap(risk));
  const diff = analyzeDiff(current, previous);
  return {
    meta: {
      generatedAt: Math.floor(Date.now() / 1000),
      address: scan.address,
      network: { chainId: scan.network.chainId.toString(), block: scan.block },
      readOnly: true,
    },
    snapshot: current,
    eligibility,
    maturity,
    trueyield,
    risk,
    nav,
    diff,
    errors: scan.errors,
  };
}

/** Collect a live scan for `address` and return the full structured report. */
export async function getReport(address: string, allowTestnet = false): Promise<FullReport> {
  const scan = await collectWalletScan(address, allowTestnet);
  const previous = await loadPrevious(address);
  return buildReport(scan, previous);
}

/** One layer only, returned as `{ address, <layer>: result }`. */
export async function getLayer(
  layer: LayerName,
  address: string,
  allowTestnet = false,
): Promise<Record<string, unknown>> {
  const scan = await collectWalletScan(address, allowTestnet);
  const previous = await loadPrevious(address);
  switch (layer) {
    case 'eligibility':
      return { address, eligibility: analyzeEligibility(scan) };
    case 'maturity':
      return { address, maturity: analyzeMaturity(scan) };
    case 'trueyield':
      return { address, trueyield: analyzeTrueYield(scan, previous) };
    case 'risk':
      return { address, risk: analyzeRisk(scan) };
    case 'nav':
      return { address, nav: await analyzeNav(scan) };
    case 'diff': {
      const current = buildSnapshot(scan, usdMap(analyzeRisk(scan)));
      return { address, diff: analyzeDiff(current, previous) };
    }
    default: {
      // Exhaustiveness guard — a new LayerName must be handled above.
      const _never: never = layer;
      throw new Error(`Unknown layer: ${String(_never)}`);
    }
  }
}

/** Save a snapshot of the current state so a later `diff` has a baseline. Returns the saved snapshot. */
export async function saveWalletSnapshot(address: string, allowTestnet = false): Promise<Snapshot & { savedTo: string }> {
  const scan = await collectWalletScan(address, allowTestnet);
  const snap = buildSnapshot(scan, usdMap(analyzeRisk(scan)));
  await saveSnapshot(snap);
  return { ...snap, savedTo: snapshotDir() };
}

export interface VerifyResult {
  network: { chainId: string; blockNumber: number; isMainnet: boolean; rpc: string };
  lendingVenues: Array<Record<string, unknown>>;
  aaPredeploys: Array<{ name: string; address: string; deployed: boolean; bytecodeBytes: number }>;
  pharosWatch: { reachable: boolean; status: string | null; upstreamProvider: string | null; keyConfigured: boolean };
}

/** Step-0 live verification: chain id, per-venue oracle/data-provider, AA predeploys, Watch health. */
export async function getVerify(allowTestnet = true): Promise<VerifyResult> {
  const net = await assertPharosNetwork(allowTestnet);
  const provider = getProvider();
  const venues: Array<Record<string, unknown>> = [];
  for (const v of LENDING_VENUES) {
    const ap = new ethers.Contract(
      v.addressesProvider,
      ['function getPriceOracle() view returns (address)', 'function getPoolDataProvider() view returns (address)'],
      provider,
    );
    try {
      const [oracle, dp] = await Promise.all([ap.getPriceOracle(), ap.getPoolDataProvider()]);
      venues.push({ product: v.product, addressesProvider: v.addressesProvider, oracle, dataProvider: dp });
    } catch (err) {
      venues.push({ product: v.product, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const aa = await Promise.all(
    AA_PREDEPLOYS.map(async (c) => {
      const code = await provider.getCode(c.address);
      return { name: c.name, address: c.address, deployed: code !== '0x', bytecodeBytes: (code.length - 2) / 2 };
    }),
  );
  const client = new PharosWatchClient();
  const watch = await client.health();
  return {
    network: { chainId: net.chainId.toString(), blockNumber: net.blockNumber, isMainnet: net.isMainnet, rpc: net.rpcUrl },
    lendingVenues: venues,
    aaPredeploys: aa,
    pharosWatch: {
      reachable: watch.reachable,
      status: watch.status,
      upstreamProvider: watch.upstreamProvider,
      keyConfigured: client.isConfigured(),
    },
  };
}

/** Serialize any analyzer object to JSON, rendering bigint as string. */
export function toJson(obj: unknown): string {
  return JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}
