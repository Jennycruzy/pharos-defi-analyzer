#!/usr/bin/env -S npx tsx
/**
 * mcp.ts — Model Context Protocol server exposing the Pharos RWA Analyzer as
 * tools any MCP-capable client can call over stdio.
 *
 * Transport: stdio. Read tools collect a live Pharos mainnet scan and return the
 * same structured, source-labeled JSON the CLI emits. The explicit actuator tool
 * signs only when mode=simulate or mode=execute and PHAROS_SIGNER_KEY is local.
 *
 * Run:  npm run mcp     (or:  npx tsx scripts/mcp.ts)
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ethers } from 'ethers';
import { DEFAULT_ADDRESS } from './config.js';
import { getLayer, getReport, getVerify, runActuatorIntent, saveWalletSnapshot, toJson, type LayerName } from './api.js';
import { listSnapshotAddresses, loadHistory } from './snapshot.js';

const LAYERS = ['eligibility', 'maturity', 'trueyield', 'risk', 'nav', 'diff'] as const;

/** Validate/normalize an optional address argument; default to the configured wallet. */
function resolveAddress(address?: string): string {
  const a = address?.trim() || DEFAULT_ADDRESS;
  if (!ethers.isAddress(a)) throw new Error(`Invalid address: ${a}`);
  return ethers.getAddress(a);
}

/** Wrap a tool body so any error becomes a clean MCP error result instead of crashing the server. */
async function safe(fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    return { content: [{ type: 'text' as const, text: toJson(result) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
  }
}

const server = new McpServer({ name: 'pharos-rwa-analyzer', version: '1.1.0' });

const addressShape = {
  address: z
    .string()
    .optional()
    .describe('Wallet to analyze (0x… on Pharos mainnet). Defaults to the configured wallet if omitted.'),
  allowTestnet: z
    .boolean()
    .optional()
    .describe('Permit chain 688688 (Pharos testnet). Default false — mainnet 1672 only.'),
};

server.registerTool(
  'pharos_report',
  {
    title: 'Full Pharos position report',
    description:
      'Run all six layers (eligibility, maturity, trueyield, risk, nav, diff) for a wallet on Pharos mainnet ' +
      'and return one structured, source-labeled JSON object. Every value is tagged [on-chain]/[api]/[static]; ' +
      'a null value means it could not be sourced (do not fabricate). READ-ONLY — never signs or moves funds.',
    inputSchema: addressShape,
  },
  async ({ address, allowTestnet }) => safe(() => getReport(resolveAddress(address), allowTestnet ?? false)),
);

server.registerTool(
  'pharos_analyze_layer',
  {
    title: 'Analyze one layer',
    description:
      'Run a SINGLE analysis layer for a wallet. Use when you only need one dimension. ' +
      'eligibility = can this wallet act; maturity = redemption/lockups; trueyield = real comparable yield; ' +
      'risk = exposure/fragility/concentration; nav = depeg/NAV drift; diff = changes since last snapshot.',
    inputSchema: {
      layer: z.enum(LAYERS).describe('Which layer to run.'),
      ...addressShape,
    },
  },
  async ({ layer, address, allowTestnet }) =>
    safe(() => getLayer(layer as LayerName, resolveAddress(address), allowTestnet ?? false)),
);

server.registerTool(
  'pharos_verify',
  {
    title: 'Verify Pharos infrastructure (Step-0)',
    description:
      'Live health check: confirms chain id 1672, resolves each lending venue’s oracle + data provider, checks ' +
      'the ERC-4337 / account-abstraction predeploys, and pings the Pharos Watch API. Use to confirm the ' +
      'network and integrations are healthy before trusting a report.',
    inputSchema: {
      allowTestnet: z.boolean().optional().describe('Permit chain 688688. Default true for verify (diagnostic).'),
    },
  },
  async ({ allowTestnet }) => safe(() => getVerify(allowTestnet ?? true)),
);

server.registerTool(
  'pharos_snapshot',
  {
    title: 'Save a position snapshot',
    description:
      'Persist the wallet’s current positions to a local JSON snapshot so a later `diff` (via pharos_report or ' +
      'pharos_analyze_layer with layer="diff") can show what changed. The only tool that writes — to the local ' +
      'filesystem only, never on-chain.',
    inputSchema: addressShape,
  },
  async ({ address, allowTestnet }) => safe(() => saveWalletSnapshot(resolveAddress(address), allowTestnet ?? false)),
);

server.registerTool(
  'pharos_act',
  {
    title: 'Plan, simulate, or execute a guarded Pharos action',
    description:
      'Write-side actuator for Pharos. Builds Safe/ERC-4337 UserOperations for supply, withdraw, borrow, repay, ' +
      'setCollateral, redeem, or rebalance. mode="dry-run" only plans and needs no key. mode="simulate" signs ' +
      'with PHAROS_SIGNER_KEY and validates without broadcasting. mode="execute" simulates first, then broadcasts. ' +
      'Never pass a private key as an argument; it is read only from the local environment.',
    inputSchema: {
      owner: z
        .string()
        .optional()
        .describe('Owner EOA for the Safe smart account. If omitted in simulate/execute, the signer key address is used.'),
      mode: z.enum(['dry-run', 'simulate', 'execute']).optional().describe('Default dry-run. execute always simulates first.'),
      kind: z
        .enum(['supply', 'withdraw', 'borrow', 'repay', 'setCollateral', 'redeem', 'rebalance'])
        .describe('Action intent.'),
      product: z.string().optional().describe('Lending product, e.g. OpenFi or ZonaLend.'),
      asset: z.string().optional().describe('Reserve asset symbol, e.g. USDC, WETH, WPROS.'),
      amount: z.union([z.number(), z.literal('all')]).optional().describe('Human token amount, or "all".'),
      useAsCollateral: z.boolean().optional().describe('Required for setCollateral.'),
      maxSpendUsd: z.number().optional().describe('Tighten the per-action USD spend cap.'),
      minHealthFactor: z.number().optional().describe('Tighten the health-factor floor; cannot go below the hard floor.'),
      allowTestnet: z.boolean().optional().describe('Permit chain 688688. Default false — mainnet 1672 only.'),
    },
  },
  async ({
    owner,
    mode,
    kind,
    product,
    asset,
    amount,
    useAsCollateral,
    maxSpendUsd,
    minHealthFactor,
    allowTestnet,
  }) =>
    safe(() =>
      runActuatorIntent({
        owner: owner ? resolveAddress(owner) : undefined,
        ownerExplicit: Boolean(owner),
        mode: mode ?? 'dry-run',
        intent: { kind, product, asset, amount, useAsCollateral },
        maxSpendUsd,
        minHealthFactor,
        allowTestnet: allowTestnet ?? false,
      }),
    ),
);

// --- Resources: saved snapshots, readable without a fresh scan ----------------

server.registerResource(
  'pharos-snapshots',
  new ResourceTemplate('pharos://snapshot/{address}', {
    // Enumerate wallets that have a saved snapshot, so a client can browse them.
    list: async () => {
      const addresses = await listSnapshotAddresses();
      return {
        resources: addresses.map((a) => ({
          uri: `pharos://snapshot/${a}`,
          name: `Snapshot history — ${a}`,
          mimeType: 'application/json',
        })),
      };
    },
  }),
  {
    title: 'Pharos position snapshots',
    description:
      'Full saved snapshot history for a wallet (oldest→newest), as JSON. Read this to see prior state ' +
      'without running a new scan — useful for explaining what changed over time.',
    mimeType: 'application/json',
  },
  async (uri, variables) => {
    const raw = Array.isArray(variables['address']) ? variables['address'][0] : variables['address'];
    const address = ethers.isAddress(raw ?? '') ? ethers.getAddress(raw as string) : null;
    if (!address) throw new Error(`Invalid address in resource URI: ${String(raw)}`);
    const history = await loadHistory(address);
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: toJson(history) }] };
  },
);

// --- Prompt: a reusable "explain this wallet" template ------------------------

server.registerPrompt(
  'explain_wallet',
  {
    title: 'Explain a Pharos wallet in plain English',
    description:
      'Produces an instruction to run pharos_report for a wallet and explain it to a non-technical owner — ' +
      'respecting source labels, flagging risks, and never inventing numbers.',
    argsSchema: {
      address: z.string().optional().describe('Wallet to explain (0x…). Defaults to the configured wallet.'),
    },
  },
  ({ address }) => {
    const who = address?.trim() || DEFAULT_ADDRESS;
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Call the \`pharos_report\` tool for wallet ${who} on Pharos mainnet, then explain the result to a ` +
              `non-technical owner. Cover, in plain language: what they can act on (eligibility), when they can ` +
              `exit (maturity), their real yield after stripping unverified incentives (trueyield), their biggest ` +
              `risk (risk), and any depeg (nav).\n\n` +
              `Rules: trust each value according to its source label — [on-chain] and [api] are live, [static] is ` +
              `an off-chain hint. If a value is null, say it could not be verified; do NOT invent a number. ` +
              `Call out anything low-confidence or flagged.`,
          },
        },
      ],
    };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is the MCP JSON-RPC channel and must stay clean.
  console.error('pharos-rwa-analyzer MCP server ready on stdio (read-only).');
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
