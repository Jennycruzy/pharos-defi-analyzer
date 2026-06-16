# pharos-defi-analyzer

Tooling for understanding DeFi + real-world-asset (RWA) positions on **Pharos
mainnet (chain 1672)** — read-only, live on-chain data, no mocks.

## Contents

- **[`pharos-rwa-analyzer/`](./pharos-rwa-analyzer/)** — Phase 1: the RWA Position
  Analyzer. A read-only CLI that gives a wallet an honest picture of its positions
  across OpenFi, ZonaLend, the Tulipa ERC-4626 vault, and the pAlpha benchmark.
  Six layers — `eligibility`, `maturity`, `trueyield`, `risk`, `nav`, `diff` — each
  value tagged with its source (`[on-chain]`, `[api]`, or `[static]`). It never
  signs, never holds a key, never moves funds.

  Usable three ways: a **CLI**, an **MCP server** (so other agents can call it in
  natural language), and an importable **TypeScript library**.

  See **[`pharos-rwa-analyzer/README.md`](./pharos-rwa-analyzer/README.md)** for full
  documentation, setup, MCP configuration, and example output.

## Quick start

```bash
cd pharos-rwa-analyzer
npm install
npm run verify                  # live Step-0 verification against mainnet
npm run analyze -- report       # full six-layer picture for the default wallet
npm run mcp                     # start the MCP server for agents (read-only)
```

No API keys are required. See the subproject README for optional `.env` settings
and the Phase-2 signing-readiness notes.
