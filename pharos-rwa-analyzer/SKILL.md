---
name: pharos-rwa-analyzer
description: Use this READ-ONLY skill to analyze any wallet's DeFi + real-world-asset (RWA) positions on Pharos mainnet (chain 1672). It answers what generic analyzers can't — can this wallet ACT on a position (eligibility), WHEN can it exit (maturity), what is the REAL yield after stripping out unverified incentives (trueyield), where is the hidden RISK (liquidation distance + concentration), is any token DEPEGGED (nav), and what CHANGED since last time (diff). Covers OpenFi, ZonaLend, Tulipa RWA vault, and pAlpha. Every value is live and source-labeled [on-chain]/[api]/[static]; nothing is mocked. Emits structured JSON for downstream agents. Never signs, never moves funds. Invoke whenever someone asks about a Pharos wallet's positions, yield, risk, eligibility, lockups, NAV/depeg, or wants a Pharos position report.
---

# Pharos RWA Position Analyzer

Read-only analyzer for DeFi + RWA positions on **Pharos mainnet (chain 1672)**.

## Run it

```bash
cd pharos-rwa-analyzer && npm install
npm run analyze -- <command> [--address 0x..] [--json] [--allow-testnet]
```

## Commands

- `verify` — re-run live Step-0 checks (chain id, venue oracles, EntryPoint, Watch health).
- `eligibility` — per product: permissionless / gated / owned + actionable bool + reason.
- `maturity` — redemption limits / lockups; on-chain where ERC-4626 exposes it.
- `trueyield` — base APY (from `currentLiquidityRate`) vs RWA income (share-price drift)
  vs incentives (labeled, never folded in) → one comparable net number.
- `risk` — total USD exposure (oracle, 8-decimal), most fragile position
  (health-factor + % price-drop to liquidation), concentration warnings.
- `nav` — NAV/depeg via ERC-4626 share price + Pharos Watch (API key optional).
- `diff` — deltas vs the last saved snapshot. Pair with `snapshot` to seed it.
- `report` — all six in one view. `report --json` is the structured Phase-2 bridge.

## Rules this skill obeys

- **Mainnet only (1672).** Refuses other networks unless `--allow-testnet` (688688).
- **No mocks.** Every value is a live on-chain read or the real Pharos Watch API.
- **Source-labeled.** `[on-chain]` / `[api]` / `[static]`; degrades gracefully and
  omits (never fabricates) anything it can't source.
- **Read-only.** Never signs, never holds a key, never moves funds.

See `VERIFICATION.md` (live findings + Phase-2 signing readiness), `README.md`
(setup, confirmed-vs-degraded table, real examples), and `NON_TECHNICAL_SUMMARY.md`
(plain-English owner guide).
