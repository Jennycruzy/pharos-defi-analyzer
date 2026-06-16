#!/usr/bin/env -S npx tsx
/**
 * cli.ts — command surface for the Pharos RWA Analyzer (READ-ONLY).
 *
 * Commands: verify | eligibility | maturity | trueyield | risk | nav | diff |
 *           snapshot | report
 * Flags:    --address <0x..>   (default: verified owner wallet / DEFAULT_ADDRESS)
 *           --json             (emit structured JSON — the Phase-2 bridge)
 *           --allow-testnet    (permit chain 688688; mainnet is the default)
 *
 * This tool NEVER signs, holds a key, or moves funds. Signing is Phase 2.
 */

import { ethers } from 'ethers';
import { AA_PREDEPLOYS, DEFAULT_ADDRESS, LENDING_VENUES } from './config.js';
import { assertPharosNetwork, getProvider } from './rpc.js';
import { collectWalletScan, type WalletScan } from './collect.js';
import { analyzeEligibility } from './layers/eligibility.js';
import { analyzeMaturity } from './layers/maturity.js';
import { analyzeTrueYield } from './layers/trueyield.js';
import { analyzeRisk, type RiskResult } from './layers/risk.js';
import { analyzeNav } from './layers/nav.js';
import { analyzeDiff, buildSnapshot } from './layers/diff.js';
import { loadPrevious, saveSnapshot, snapshotDir, type Snapshot } from './snapshot.js';
import { PharosWatchClient } from './pharoswatch.js';
import type { Sourced } from './types.js';

const COMMANDS = ['verify', 'eligibility', 'maturity', 'trueyield', 'risk', 'nav', 'diff', 'snapshot', 'report'] as const;
type Command = (typeof COMMANDS)[number];

interface Args {
  command: Command;
  address: string;
  json: boolean;
  allowTestnet: boolean;
}

function parseArgs(argv: string[]): Args {
  const [, , cmd, ...rest] = argv;
  const command = (cmd ?? 'report') as Command;
  let address = DEFAULT_ADDRESS;
  let json = false;
  let allowTestnet = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') json = true;
    else if (a === '--allow-testnet') allowTestnet = true;
    else if (a === '--address') {
      const next = rest[++i];
      if (!next) fail('--address requires a value');
      address = next as string;
    }
  }
  if (!COMMANDS.includes(command)) fail(`Unknown command "${command}". Use one of: ${COMMANDS.join(', ')}`);
  if (!ethers.isAddress(address)) fail(`Invalid address: ${address}`);
  return { command, address: ethers.getAddress(address), json, allowTestnet };
}

function fail(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// --- source-label helpers for human output ---
const TAG: Record<Sourced<unknown>['source'], string> = {
  'on-chain': '[on-chain]',
  api: '[api]',
  static: '[static]',
};
function fmt<T>(s: Sourced<T>): string {
  const v = s.value === null ? '—' : typeof s.value === 'number' ? trim(s.value) : String(s.value);
  return `${v} ${TAG[s.source]}${s.note ? ` (${s.note})` : ''}`;
}
function trim(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : String(n);
  return (Math.round(n * 1e6) / 1e6).toString();
}
function h(title: string): void {
  console.log(`\n${title}\n${'─'.repeat(title.length)}`);
}

/** USD-by-position map (key "Product:ASSET") derived from the risk layer. */
function usdMap(risk: RiskResult): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of risk.perPosition) m.set(`${p.product}:${p.asset}`, p.suppliedUsd);
  return m;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.command === 'verify') {
    await runVerify(args.json);
    return;
  }

  // All other commands work off one collected scan.
  const scan = await collectWalletScan(args.address, args.allowTestnet);
  const previous = await loadPrevious(args.address);

  switch (args.command) {
    case 'eligibility':
      return emit(args, { eligibility: analyzeEligibility(scan) }, () => printEligibility(scan));
    case 'maturity':
      return emit(args, { maturity: analyzeMaturity(scan) }, () => printMaturity(scan));
    case 'trueyield':
      return emit(args, { trueyield: analyzeTrueYield(scan, previous) }, () => printTrueYield(scan, previous));
    case 'risk':
      return emit(args, { risk: analyzeRisk(scan) }, () => printRisk(scan));
    case 'nav': {
      const nav = await analyzeNav(scan);
      return emit(args, { nav }, () => printNav(nav));
    }
    case 'snapshot': {
      const risk = analyzeRisk(scan);
      const snap = buildSnapshot(scan, usdMap(risk));
      await saveSnapshot(snap);
      if (args.json) console.log(json(snap));
      else {
        h(`SNAPSHOT SAVED — ${args.address}`);
        console.log(`Saved ${snap.positions.length} position(s), total $${trim(snap.totalUsd ?? 0)} to ${snapshotDir()}`);
        console.log('Run `diff` later to see what changed.');
      }
      return;
    }
    case 'diff': {
      const risk = analyzeRisk(scan);
      const current = buildSnapshot(scan, usdMap(risk));
      const diff = analyzeDiff(current, previous);
      return emit(args, { diff }, () => printDiff(diff));
    }
    case 'report':
      return runReport(scan, previous, args);
    default:
      fail(`Unhandled command ${args.command}`);
  }
}

/** Emit JSON or run the human printer. */
function emit(args: Args, jsonObj: object, printer: () => void): void {
  if (args.json) console.log(json({ address: args.address, ...jsonObj }));
  else printer();
}

function json(obj: unknown): string {
  return JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}

// ---------------------------------------------------------------- verify ----
async function runVerify(asJson: boolean): Promise<void> {
  const net = await assertPharosNetwork(true);
  const provider = getProvider();
  const venues: Array<Record<string, unknown>> = [];
  for (const v of LENDING_VENUES) {
    const ap = new ethers.Contract(v.addressesProvider, ['function getPriceOracle() view returns (address)', 'function getPoolDataProvider() view returns (address)'], provider);
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
  const watch = await new PharosWatchClient().health();

  const result = {
    network: { chainId: net.chainId.toString(), blockNumber: net.blockNumber, isMainnet: net.isMainnet, rpc: net.rpcUrl },
    lendingVenues: venues,
    aaPredeploys: aa,
    pharosWatch: { reachable: watch.reachable, status: watch.status, upstreamProvider: watch.upstreamProvider, keyConfigured: new PharosWatchClient().isConfigured() },
  };

  if (asJson) {
    console.log(json(result));
    return;
  }
  h('STEP-0 LIVE VERIFICATION');
  console.log(`Network         : chainId ${result.network.chainId} ${net.isMainnet ? '(Pharos mainnet ✓)' : '(NOT mainnet)'} block ${net.blockNumber}`);
  console.log(`RPC             : ${net.rpcUrl}`);
  for (const v of venues) {
    if (v['error']) console.log(`${String(v['product']).padEnd(15)} : ERROR ${String(v['error'])}`);
    else console.log(`${String(v['product']).padEnd(15)} : oracle ${v['oracle']}  dataProvider ${v['dataProvider']}`);
  }
  console.log('AA predeploys   : (Phase-2 prep — this app signs nothing)');
  for (const c of aa) {
    console.log(`  ${c.deployed ? '✓' : '✗'} ${c.name.padEnd(22)} ${String(c.bytecodeBytes).padStart(6)} bytes  ${c.address}`);
  }
  console.log(`Pharos Watch    : health ${watch.reachable ? '✓' : '✗'} status=${watch.status ?? 'n/a'} upstream=${watch.upstreamProvider ?? 'n/a'} key=${result.pharosWatch.keyConfigured ? 'set' : 'not set'}`);
}

// ---------------------------------------------------------------- report ----
async function runReport(scan: WalletScan, previous: Snapshot | null, args: Args): Promise<void> {
  const eligibility = analyzeEligibility(scan);
  const maturity = analyzeMaturity(scan);
  const trueyield = analyzeTrueYield(scan, previous);
  const risk = analyzeRisk(scan);
  const nav = await analyzeNav(scan);
  const current = buildSnapshot(scan, usdMap(risk));
  const diff = analyzeDiff(current, previous);

  if (args.json) {
    // The Phase-2 bridge: one structured, source-labeled object.
    console.log(
      json({
        meta: {
          generatedAt: Math.floor(Date.now() / 1000),
          address: scan.address,
          network: { chainId: scan.network.chainId.toString(), block: scan.network.blockNumber },
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
      }),
    );
    return;
  }

  h(`PHAROS RWA POSITION REPORT — ${scan.address}`);
  console.log(`Network: Pharos mainnet (chain ${scan.network.chainId}) @ block ${scan.network.blockNumber}`);
  console.log('Legend: [on-chain] live read · [api] Pharos Watch · [static] known/off-chain · READ-ONLY (no signing)');
  printEligibility(scan);
  printMaturity(scan);
  printTrueYield(scan, previous);
  printRisk(scan);
  printNav(nav);
  printDiff(diff);
  if (scan.errors.length) {
    h('NOTES / DEGRADED READS');
    for (const e of scan.errors) console.log(`• ${e.scope}: ${e.message}`);
  }
  console.log('\nTip: `report --json` emits the full machine-readable object for the Phase-2 agent.');
}

// ---------------------------------------------------------------- printers ----
function printEligibility(scan: WalletScan): void {
  h('1) ELIGIBILITY — can this wallet act?');
  for (const e of analyzeEligibility(scan).entries) {
    console.log(`• ${e.product.padEnd(10)} ${e.actionable ? 'ACTIONABLE' : 'not actionable'} [${e.access}]`);
    console.log(`    ${fmt(e.reason)}`);
  }
}
function printMaturity(scan: WalletScan): void {
  h('2) MATURITY — when can you get out?');
  const m = analyzeMaturity(scan);
  if (!m.entries.length) console.log('• No held positions with a time/liquidity dimension.');
  for (const e of m.entries) {
    console.log(`• ${e.product} ${e.asset}: ${fmt(e.status)}`);
    console.log(`    redeemable now: ${fmt(e.redeemableNow)}`);
  }
}
function printTrueYield(scan: WalletScan, previous: Snapshot | null): void {
  h('3) TRUE YIELD — one comparable, honest number');
  for (const e of analyzeTrueYield(scan, previous).entries) {
    console.log(`• ${e.product} ${e.asset}`);
    console.log(`    base APY     : ${fmt(e.baseApyPct)}`);
    console.log(`    RWA income   : ${fmt(e.rwaIncomeApyPct)}`);
    console.log(`    net estimate : ${fmt(e.netApyEstimatePct)}`);
    console.log(`    incentives   : ${fmt(e.incentiveApyNote)}`);
  }
}
function printRisk(scan: WalletScan): void {
  const r = analyzeRisk(scan);
  h('4) RISK — exposure, fragility, concentration');
  console.log(`• Total wallet value: $${fmt(r.totalUsd)}`);
  for (const p of r.perPosition) {
    console.log(`    ${p.product} ${p.asset}: supplied $${trim(p.suppliedUsd)} | borrowed $${trim(p.borrowedUsd)} | net $${trim(p.netUsd)}`);
  }
  const f = r.mostFragile.value;
  console.log(`• Most fragile: ${f ? f.note : '—'} ${TAG[r.mostFragile.source]}`);
  if (r.concentrationWarnings.length) {
    for (const w of r.concentrationWarnings) console.log(`• ⚠ ${w}`);
  } else {
    console.log('• Concentration: within threshold.');
  }
}
function printNav(nav: Awaited<ReturnType<typeof analyzeNav>>): void {
  h('5) NAV / DEPEG — is each token worth what it should be?');
  console.log(`• API: ${nav.apiNote}`);
  for (const f of nav.flags) {
    const flag = f.depegged ? '⚠ DRIFT' : 'ok';
    console.log(`• ${f.subject} — ${f.metric}: ${fmt(f.value)} | drift ${f.driftPct === null ? '—' : `${trim(f.driftPct)}%`} [${flag}]`);
  }
}
function printDiff(diff: ReturnType<typeof analyzeDiff>): void {
  h('6) DIFF — what changed since last snapshot');
  console.log(`• ${fmt(diff.summary)}`);
  for (const c of diff.changes) {
    console.log(`    ${c.product} ${c.asset} — ${c.field}: ${c.before} → ${c.after} (${c.note})`);
  }
}

main().catch((err) => {
  console.error(`\nFatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
