---
name: pharos-rwa-analyzer
description: Use this skill to analyze and, when explicitly requested, act on DeFi + real-world-asset (RWA) positions on Pharos mainnet (chain 1672). Read tools answer eligibility, maturity, true yield, risk, NAV/depeg, and diffs for OpenFi, ZonaLend, Tulipa, and pAlpha with live source-labeled data. The write actuator builds guarded Safe/ERC-4337 UserOperations for supply, withdraw, borrow, repay, collateral toggles, redeem, and rebalance. Dry-runs need no key; simulate/execute require PHAROS_SIGNER_KEY locally and funds in the derived Safe/EntryPoint path. Never accept a private key in chat or as a tool argument.
---

# Pharos RWA Position Analyzer + Actuator

Analyzer and guarded write actuator for DeFi + RWA positions on **Pharos mainnet
(chain 1672)**.

## Run it

```bash
cd pharos-rwa-analyzer && npm install
npm run analyze -- <command> [--address 0x..] [--json] [--allow-testnet]
npm run act -- <intent> [--owner 0x..] [--product OpenFi] [--asset USDC] [--amount 10]
```

## Read Commands

- `verify` — re-run live Step-0 checks (chain id, venue oracles, EntryPoint, Watch health).
- `eligibility` — per product: permissionless / gated / owned + actionable bool + reason.
- `maturity` — redemption limits / lockups; on-chain where ERC-4626 exposes it.
- `trueyield` — base APY (from `currentLiquidityRate`) vs RWA income (share-price drift)
  vs incentives (labeled, never folded in) → one comparable net number.
- `risk` — total USD exposure (oracle, 8-decimal), most fragile position
  (health-factor + % price-drop to liquidation), concentration warnings.
- `nav` — NAV/depeg via ERC-4626 share price + Pharos Watch (API key optional).
- `diff` — deltas vs the last saved snapshot. Pair with `snapshot` to seed it.
- `report` — all six in one view. `report --json` is the structured agent bridge.

## Write Command

```bash
npm run act -- supply --owner 0xOwner --product OpenFi --asset USDC --amount 10
npm run act -- repay --owner 0xOwner --product OpenFi --asset USDC --amount all --simulate
npm run act -- rebalance --owner 0xOwner --max-spend 100 --simulate
npm run act -- redeem --owner 0xOwner --amount all --execute
```

Supported intents:

- `supply`
- `withdraw`
- `borrow`
- `repay`
- `redeem`
- `rebalance`
- `set-collateral`, or `--enable-collateral` / `--disable-collateral`

Modes:

- default: dry-run only. Builds the Safe plan and UserOperation hash; no key needed.
- `--simulate`: reads `PHAROS_SIGNER_KEY`, signs the UserOperation, estimates
  `EntryPoint.handleOps`, and refuses if it reverts. No broadcast.
- `--execute`: runs simulation first, then submits via `PHAROS_BUNDLER_URL` if set,
  otherwise self-bundles through `EntryPoint.handleOps`.

Funding/key rule:

- Never provide the private key in chat or as a command argument.
- Put the owner key in local `.env` as `PHAROS_SIGNER_KEY`.
- The Safe address printed by dry-run is the account that must hold protocol funds
  for supply/repay/redeem/withdraw flows.
- If self-bundling, the owner EOA also needs native gas for `handleOps`.
- If a simulate/execute request needs a signer key and `.env` is missing, the
  tool returns a paste-ready `.env` snippet and tells you to retry the same
  request after filling it in locally.

## MCP Tools

- `pharos_report` — full source-labeled read report.
- `pharos_analyze_layer` — one read layer.
- `pharos_verify` — live infrastructure health check.
- `pharos_snapshot` — save local snapshot.
- `pharos_act` — dry-run, simulate, or execute guarded Safe/ERC-4337 actions.

## Rules this skill obeys

- **Mainnet only (1672).** Refuses other networks unless `--allow-testnet` (688688).
- **No mocks.** Every value is a live on-chain read or the real Pharos Watch API.
- **Source-labeled.** `[on-chain]` / `[api]` / `[static]`; degrades gracefully and
  omits (never fabricates) anything it can't source.
- **Explicit writes only.** Read/report tools never sign. The actuator signs only
  in `--simulate`/`--execute` or MCP `mode=simulate|execute`.
- **Scoped authority.** The key owns a Safe; protocol calls are Safe
  meta-transactions inside ERC-4337 UserOperations.
- **Guard rails.** Spend caps, health-factor floors, AA infrastructure checks,
  SafeOp digest cross-checks, and live simulation run before broadcast.

See `VERIFICATION.md` for live findings and actuator readiness, and `README.md`
for setup, confirmed-vs-degraded behavior, and examples.
