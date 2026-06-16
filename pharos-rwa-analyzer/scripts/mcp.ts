#!/usr/bin/env -S npx tsx
/**
 * mcp.ts — Model Context Protocol server exposing the Pharos RWA Analyzer as
 * tools any MCP-capable agent (Claude Desktop, IDE assistants, custom agents) can
 * call in natural language.
 *
 * Transport: stdio. Tools are READ-ONLY — they collect a live Pharos mainnet scan
 * and return the same structured, source-labeled JSON the CLI emits (shared via
 * api.ts, so MCP and CLI never drift). The server signs nothing and holds no key.
 *
 * Run:  npm run mcp     (or:  npx tsx scripts/mcp.ts)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ethers } from 'ethers';
import { DEFAULT_ADDRESS } from './config.js';
import { getLayer, getReport, getVerify, saveWalletSnapshot, toJson, type LayerName } from './api.js';

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
