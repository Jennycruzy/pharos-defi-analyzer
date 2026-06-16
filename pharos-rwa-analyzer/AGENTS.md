# AGENTS.md — how an AI agent uses the Pharos RWA Position Analyzer

This file teaches an AI agent how to obtain and use this skill **in natural
language**. If you are an agent that has just discovered or downloaded this skill,
read this top to bottom — it is everything you need to call it correctly and
interpret what comes back.

## What this skill does

It is a **read-only** analyzer for a wallet's DeFi + real-world-asset (RWA)
positions on **Pharos mainnet (chain 1672)**. Given a wallet address, it tells you:

- **eligibility** — can this wallet actually act on each product, or is it gated?
- **maturity** — when can the wallet exit; how much is redeemable right now?
- **trueyield** — the real, comparable yield after stripping out unverified incentives.
- **risk** — total USD exposure, the most fragile position, concentration warnings.
- **nav** — is any token depegged / has a vault's NAV drifted?
- **diff** — what changed since the last saved snapshot.

It covers **OpenFi**, **ZonaLend**, the **Tulipa** RWA vault, and the **pAlpha**
benchmark. Every number is a live read, labeled by source, and **nothing is mocked**.

**It never signs, never holds a key, and never moves funds.** If a user asks you to
*execute* a transaction, this skill cannot do it — it only analyzes.

## When to use it

Invoke this skill whenever a user asks about a Pharos wallet's positions, yield,
risk, eligibility, lockups/redemption, NAV or depeg status, or wants a position
report — or whenever you (as a downstream agent) need structured, source-labeled
position data before reasoning or acting.

## How to download and set it up

```bash
# 1. Get the skill (clone or copy the project directory), then:
cd pharos-rwa-analyzer
npm install

# 2. (Optional) configure — sensible defaults are baked in, no keys required:
cp .env.example .env
```

Optional `.env` settings:
- `PHAROS_RPC_URL` — override the default `https://rpc.pharos.xyz`.
- `PHAROS_WATCH_API_KEY` — unlocks the live NAV/depeg API layer (see README "Pharos
  Watch API"). Without it, the `nav` layer still works on-chain and says so.
- `DEFAULT_ADDRESS` — the wallet to analyze when `--address` isn't given.

## How to run it

```bash
npm run analyze -- <command> [--address 0x..] [--json] [--allow-testnet]
```

Commands: `verify`, `eligibility`, `maturity`, `trueyield`, `risk`, `nav`, `diff`,
`snapshot`, `report`.

- Use `report` for the full picture, or a single command for one dimension.
- **Always prefer `--json` when you are an agent consuming the output** — it emits
  one structured object you can parse, instead of human text.
- `--address 0x…` targets a specific wallet (defaults to the configured wallet).
- `--allow-testnet` permits chain 688688; otherwise the tool refuses anything but
  mainnet. Mainnet is the default and the network of every result.

Examples in natural language → command:
- "Analyze wallet 0xABC on Pharos" → `npm run analyze -- report --address 0xABC --json`
- "What's the real yield here?" → `npm run analyze -- trueyield --address 0xABC --json`
- "Is anything depegged?" → `npm run analyze -- nav --json`
- "What changed since last time?" → first `snapshot`, later `diff`.

## How to read the output

Every value carries a **source label** — respect it:
- `[on-chain]` — read live from a Pharos mainnet contract this run. Trust it.
- `[api]` — from the Pharos Watch API this run. Trust it; note it's an external source.
- `[static]` — known/off-chain, NOT live-verifiable. Treat as a hint, not a fact.

A `null` value means the skill **could not source it and refused to guess** — do not
fabricate a replacement. Each value also has a `confidence` (`high`/`medium`/`low`)
and an optional `note` explaining caveats; surface low-confidence caveats to the user.

`report --json` is the **bridge for downstream agents**: it returns `meta` (address,
pinned block, `readOnly: true`), plus `eligibility`, `maturity`, `trueyield`, `risk`,
`nav`, `diff`, a reproducible `snapshot`, and any `errors`.

## Guarantees you can rely on

- **Mainnet only (1672).** It refuses other networks unless `--allow-testnet`.
- **No mocks.** Every value is a live on-chain read or the real Pharos Watch API.
- **Honest by construction.** Unsourceable data is omitted and labeled, never faked.
- **Read-only.** It cannot and will not sign or move funds.

For deeper detail: `README.md` (setup, the Pharos Watch API, confirmed-vs-degraded
table, real examples), `VERIFICATION.md` (live on-chain findings + Phase-2 signing
readiness), and `NON_TECHNICAL_SUMMARY.md` (plain-English owner guide).
