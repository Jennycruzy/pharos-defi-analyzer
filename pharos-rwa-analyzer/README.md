# Pharos RWA Position Analyzer (Phase 1)

A **read-only** skill that gives a wallet a complete, honest picture of its DeFi
+ real-world-asset (RWA) positions on **Pharos mainnet (chain 1672)**. It answers
the questions generic analyzers don't: *can I act on this, when does it unlock,
what's my REAL yield after incentives/fees, and where is my hidden risk?*

It **never signs, never holds a key, never moves funds.** Signing is Phase 2.

Every number it prints comes from a **real live read** of Pharos mainnet or the
real Pharos Watch API. There are **no mocks, no fakes, no example numbers.** Each
value is tagged with its source: `[on-chain]`, `[api]`, or `[static]`.

---

## Contents

- [What it analyzes](#what-it-analyzes-verified-on-mainnet-2026-06-16--see-verificationmd)
- [The six layers](#the-six-layers-each-a-command)
- [Data sources & integrations](#data-sources--integrations)
- [Setup](#setup)
- [Usage (CLI)](#usage)
- [Use it as an MCP server (for agents)](#use-it-as-an-mcp-server-for-agents)
- [Use it as a library](#use-it-as-a-library-programmatic-api)
- [Pharos Watch API](#pharos-watch-api-the-api-data-source)
- [Real example output](#real-example-output-default-owner-wallet-live-mainnet)
- [Output for agents (`--json` shape)](#output-for-agents---json-shape)
- [Confirmed vs Degraded](#confirmed-vs-degraded-per-layer)
- [Phase-2 signing readiness](#phase-2-signing-readiness-from-verificationmd--this-app-signs-nothing)
- [Tests](#tests)
- [Architecture](#architecture)

---

## What it analyzes (verified on mainnet 2026-06-16 — see `VERIFICATION.md`)

| Product | What it is | Address | Status |
| --- | --- | --- | --- |
| **OpenFi** | Aave-style lending | `0x30b2…3b26` | ✅ permissionless, full reads |
| **ZonaLend** | Aave-style lending (own deployment) | `0xda46…372a` | ✅ permissionless, full reads |
| **Tulipa** | Multi-RWA ERC-4626 vault | `0xbae9…aec5` | ✅ ERC-4626 confirmed |
| **pAlpha** | Gated institutional vault (AquaFlux) | n/a | ⚠ static benchmark only |

---

## The six layers (each a command)

| # | Command | What it tells you | Confidence |
| --- | --- | --- | --- |
| 1 | `eligibility` | Per product: can THIS wallet act (permissionless), or is it gated? | ✅ on-chain |
| 2 | `maturity` | The time dimension: redemption limits / lockups / what's redeemable now | ✅ on-chain (off-chain dates labeled `[static]`) |
| 3 | `trueyield` | Yield split into base interest vs RWA income vs incentives, net of fees, into one comparable number | ✅ on-chain |
| 4 | `risk` | Total USD exposure, most fragile position (liquidation distance), concentration warnings | ✅ on-chain |
| 5 | `nav` | NAV-drift / depeg flags via ERC-4626 share price + Pharos Watch | ⚠ on-chain always; API needs a key |
| 6 | `diff` | What changed vs a saved snapshot (yield accrued, status, redemption capacity) | ✅ on-chain + local JSON |

`report` runs all six. `report --json` emits one structured object — **the bridge
to the Phase-2 agent.** `verify` re-runs the Step-0 live checks. `snapshot` saves
the current state so `diff` has something to compare against later.

---

## Data sources & integrations

The analyzer pulls from three live sources and nothing else — no database, no
cached fixtures, no third-party indexers:

| Source | Endpoint / address | Used for | Auth |
| --- | --- | --- | --- |
| **Pharos mainnet RPC** | `https://rpc.pharos.xyz` (chain **1672**) | all on-chain reads (lending, vault, oracle, incentives, AA predeploys) | none |
| **Multicall3** | `0xcA11bde05977b3631167028862bE2a173976CA11` | batches every read into one call at a **pinned block** | none |
| **Pharos Watch API** | `https://api.pharos.watch` | independent NAV / stablecoin-depeg reference (the `[api]` source) | `X-API-Key` (optional) |

The RPC and Multicall3 are mandatory; the Pharos Watch API is optional and the
`nav` layer degrades to on-chain-only without it. See [Pharos Watch API](#pharos-watch-api-the-api-data-source).

---

## Setup

```bash
cd pharos-rwa-analyzer
npm install
cp .env.example .env        # optional — sensible defaults are baked in
npm run typecheck           # strict TS, should print nothing (clean)
```

No keys are required. Optional `.env` settings:
- `PHAROS_RPC_URL` — override the default `https://rpc.pharos.xyz`.
- `PHAROS_WATCH_API_KEY` — unlocks the live NAV/depeg API layer (request a
  self-serve key at https://pharos.watch/api/). Without it the `nav` layer still
  works using on-chain drift and clearly says the API portion is unavailable.
- `DEFAULT_ADDRESS` — the wallet to analyze when `--address` isn't given.

---

## Usage

```bash
npm run analyze -- <command> [--address 0x..] [--json] [--allow-testnet]

# examples
npm run analyze -- report                       # full picture, default wallet
npm run analyze -- trueyield --address 0xABC…    # one layer, a specific wallet
npm run analyze -- report --json                 # machine-readable (Phase-2 bridge)
npm run verify                                   # re-run Step-0 live verification
```

Flags: `--address` (defaults to the verified owner wallet), `--json` (structured
output), `--allow-testnet` (permit chain 688688; **mainnet is the default and the
network of all results**).

---

## Use it as an MCP server (for agents)

This skill ships a **Model Context Protocol** server so any MCP-capable agent
(Claude Desktop, IDE assistants, custom agents) can call it **in natural language**.
The tools are **read-only** and return the exact same structured JSON as the CLI
(shared via `scripts/api.ts`, so they can never drift). The server signs nothing
and holds no key.

**Start it:**

```bash
npm run mcp          # stdio transport; logs "MCP server ready" to stderr
```

**Register it** with an MCP client. Example `claude_desktop_config.json` (or any
client's `mcpServers` block):

```jsonc
{
  "mcpServers": {
    "pharos-rwa-analyzer": {
      "command": "npx",
      "args": ["tsx", "scripts/mcp.ts"],
      "cwd": "/absolute/path/to/pharos-rwa-analyzer",
      "env": {
        "PHAROS_WATCH_API_KEY": "…optional, unlocks the [api] NAV layer…"
      }
    }
  }
}
```

**Tools exposed:**

| Tool | What it does | Arguments |
| --- | --- | --- |
| `pharos_report` | Full six-layer report for a wallet | `address?`, `allowTestnet?` |
| `pharos_analyze_layer` | One layer only | `layer` (`eligibility`/`maturity`/`trueyield`/`risk`/`nav`/`diff`), `address?`, `allowTestnet?` |
| `pharos_verify` | Live infra health (chain id, venue oracles, AA predeploys, Watch) | `allowTestnet?` |
| `pharos_snapshot` | Save a snapshot so a later `diff` has a baseline (writes local JSON only) | `address?`, `allowTestnet?` |

`address` defaults to the configured wallet; everything is mainnet (1672) unless
`allowTestnet` is set. See **`AGENTS.md`** for the natural-language usage guide an
agent should read (what to say, how to interpret the source labels and `null`s).

**Natural-language → tool, examples an agent will map automatically:**
- "Give me a full position report for 0xABC on Pharos" → `pharos_report { address: "0xABC" }`
- "What's the real yield on this wallet?" → `pharos_analyze_layer { layer: "trueyield" }`
- "Is anything depegged right now?" → `pharos_analyze_layer { layer: "nav" }`
- "Is Pharos infra healthy?" → `pharos_verify {}`
- "Save the current state so we can compare later" → `pharos_snapshot {}`

---

## Use it as a library (programmatic API)

Other TypeScript agents can import the analyzer directly instead of shelling out:

```ts
import { getReport, getLayer, getVerify } from './scripts/api.js';

const report = await getReport('0xABC…');          // full structured report
const risk   = await getLayer('risk', '0xABC…');   // one layer
const health = await getVerify();                  // infra check
```

These are the same functions the CLI and MCP server use — one source of truth for
the output shape.

---

## Pharos Watch API (the `[api]` data source)

The `nav` layer uses [**Pharos Watch**](https://pharos.watch) — Pharos's NAV/depeg
analytics service (repo `TokenBrice/pharos-watch`, upstream data from DefiLlama) —
as an **independent, off-chain peg reference** that cross-checks the on-chain
signals. It is wrapped by `scripts/pharoswatch.ts`. All response shapes below were
**confirmed against the live API with a real key** (see `VERIFICATION.md` §E), not
guessed.

**Base URL:** `https://api.pharos.watch`
**Auth:** every data route requires an `X-API-Key` header; `/api/health` is exempt.

**Get a key:** request a self-serve key at <https://pharos.watch/api/>, then put it
in `.env` as `PHAROS_WATCH_API_KEY`. The key lives **only** in the gitignored `.env`
and is never committed or logged.

**Endpoints this skill calls:**

| Endpoint | Key? | What we read | Where it shows up |
| --- | --- | --- | --- |
| `GET /api/health` | no | `status`, upstream provider (DefiLlama) | `verify` "Pharos Watch" line; reachability gate |
| `GET /api/peg-summary` | yes | `coins[]` → `currentDeviationBps`, `pegScore`, `activeDepeg`, `worstDeviationBps`, `priceConfidence`, `priceUpdatedAt` | `nav` layer `[api]` peg flag (e.g. `usdc-circle`) |

The client fetches `peg-summary` **once per run** (cached) and resolves the
reference stablecoin id `usdc-circle` from it. A coin is flagged depegged if
Pharos Watch reports `activeDepeg: true` **or** its deviation exceeds the configured
`depegDriftPct` threshold.

**What we deliberately do *not* use:** `/api/stablecoin/{id}` returns descriptive
issuer metadata with no leading live price, so it is never used for pricing. Pharos
Watch tracks **global stablecoin issuers** (e.g. `usdc-circle`), **not** the
Pharos-native vault token `tulPRWA` — so Tulipa's NAV always comes from the on-chain
ERC-4626 share price, and the API only adds an issuer-level peg reference beside it.
(The full catalogue is at <https://pharos.watch/openapi.json> — 38 routes; this skill
intentionally consumes only the two above.)

**Graceful degradation:** with no key (or if the API is unreachable), the `nav`
layer still runs entirely on-chain — share-price drift for the vault and oracle-price
drift for USDC — and the output explicitly says the API portion is unavailable.
Nothing is faked to fill the gap.

---

## Real example output (default owner wallet, live mainnet)

`npm run verify`:

```
STEP-0 LIVE VERIFICATION
Network         : chainId 1672 (Pharos mainnet ✓) block 10217138
OpenFi          : oracle 0x878aF9…a6d1  dataProvider 0x3EF472…67Fb
ZonaLend        : oracle 0x6bEDfC…73f9  dataProvider 0xA91424…f49A
EntryPoint      : ✓ deployed (16035 bytes) — Phase-2 prep
Pharos Watch    : health ✓ status=healthy upstream=DefiLlama key=not set
```

`npm run analyze -- report` (abridged — these are **real** values for
`0x0Ac6bf160e208e67AF06d7F00c92AEfBbf089f95`):

```
1) ELIGIBILITY
• OpenFi     ACTIONABLE [permissionless]  3/3 reserves active & not frozen [on-chain]
• ZonaLend   ACTIONABLE [permissionless]  2/3 active; Frozen: WETH [on-chain]
• Tulipa     ACTIONABLE [gated-but-owned] holds 0.11 tulPRWA; deposits signature-gated [on-chain]
• pAlpha     not actionable [gated]       benchmark only [static]

2) MATURITY
• Tulipa tulPRWA: Fully redeemable now (maxRedeem covers full 0.11 balance) [on-chain]

3) TRUE YIELD (one comparable number, verified components only)
• OpenFi USDC    base APY 0.905864 [on-chain]; incentives not on-chain verified [static]
• ZonaLend USDC  base APY 0.000008 [on-chain]; advertised ~210% incl. incentives NOT verified [static]
• Tulipa tulPRWA RWA income — needs ≥2 snapshots to measure [on-chain]

4) RISK
• Total wallet value: $0.109966 [on-chain]
• Most fragile: no borrowed positions — no liquidation risk [on-chain]
• ⚠ 100% concentrated in Tulipa (> 60% threshold)

5) NAV / DEPEG
• API: reachable (health OK) but data routes need a key — on-chain signals shown
• Tulipa (tulPRWA) share price 1.0 [on-chain] | drift 0% [ok]
• USDC @ OpenFi oracle price 0.999695 [on-chain] | drift -0.03% [ok]

6) DIFF
• No prior snapshot — run `snapshot` now, then `diff` later.
```

> Note: these are tiny, real balances (the owner deposited 0.1 USDC into Tulipa).
> Nothing is rounded up to look bigger — honesty over impressiveness.

---

## Output for agents (`--json` shape)

`report --json` emits one structured, source-labeled object — the bridge a
downstream (Phase-2) agent consumes. Top-level shape:

```jsonc
{
  "meta": {
    "generatedAt": 1718539200,           // unix seconds
    "address": "0x0Ac6…9f95",
    "network": { "chainId": "1672", "block": 10228494 },  // the pinned block
    "readOnly": true                      // this skill never signs
  },
  "snapshot":   { /* reproducible position snapshot at the pinned block */ },
  "eligibility":{ "layer": "eligibility", "entries": [ … ] },
  "maturity":   { "layer": "maturity",    "entries": [ … ] },
  "trueyield":  { "layer": "trueyield",   "entries": [ … ] },
  "risk":       { "layer": "risk", "totalUsd": { … }, "perPosition": [ … ],
                  "mostFragile": { … }, "concentrationWarnings": [ … ] },
  "nav":        { "layer": "nav", "apiAvailable": false, "apiNote": "…", "flags": [ … ] },
  "diff":       { "layer": "diff", "hasPrevious": false, "changes": [ … ], "summary": { … } },
  "errors":     [ /* any per-venue degraded reads, never silently dropped */ ]
}
```

Every leaf value that the skill reports is a `Sourced<T>`:

```jsonc
{ "value": 1.131317, "source": "on-chain", "confidence": "high", "note": "…optional…" }
```

**Contract for consumers:** trust `value` according to `source`
(`on-chain`/`api` = live, `static` = off-chain hint) and `confidence`; a `null`
`value` means it could not be sourced — **do not fabricate a replacement.** Single
commands (e.g. `trueyield --json`) emit `{ address, <layer> }` with the same shapes.

---

## Confirmed vs Degraded (per layer)

| Layer | Status | Detail |
| --- | --- | --- |
| eligibility | ✅ Confirmed | reserve active/frozen flags + access map, all on-chain |
| maturity | ✅ / ⚠ | ERC-4626 redemption limits on-chain; lending "redeemable now" bounded by real pool liquidity (`min(supplied, aToken underlying balance)`); off-chain maturity dates labeled `[static]`, none fabricated |
| trueyield | ✅ Confirmed | base APY from `currentLiquidityRate`; RWA income from share-price snapshots (min 3-day interval enforced; implausible annualized figures flagged low-confidence); incentives labeled, never folded into the number |
| risk | ✅ Confirmed | oracle USD pricing (8-decimal); aggregate **and per-collateral** liquidation distance; concentration; total degrades to `[static]`/low if any price can't be sourced |
| nav | ✅ Confirmed | on-chain share-price/oracle drift always; with `PHAROS_WATCH_API_KEY` set, adds verified `[api]` peg from `/api/peg-summary` (deviation bps + pegScore) |
| diff | ✅ Confirmed | local JSON snapshots under `./snapshots`, pure reads |

---

## Phase-2 signing readiness (from `VERIFICATION.md` — this app signs nothing)

All account-abstraction predeploys below are **confirmed deployed on mainnet**
(`npm run verify` checks them live):

- **ERC-4337 EntryPoint v0.7** `0x0000…da032` and **v0.6** `0x5FF1…2789` — both deployed.
- **SenderCreator v0.7 / v0.6** — both deployed.
- **SafeSingletonFactory** `0x914d…43d7` and **CreateX** `0xba5E…ba5Ed` — both deployed.
- **Bundler**: still **not found** (no public URL in the docs corpus) — Phase 2 must
  self-host one (Rundler/Alto/Skandha) or obtain it from the team for the 4337 path.
- **Signing rails (from the docs):** **Safe** is officially supported — UI
  `app.safe.global` + Transaction Service `transaction.safe.pharosnetwork.xyz`;
  **Fordefi** (MPC) is available; and Pharos ships an **agent toolkit** that signs via
  Foundry `--private-key` behind a mandatory 4-check pre-check.
- **Tulipa write path**: deposits are signature-gated (`0x50921b23(amount,
  receiver, deadline, v, r, s)`) — Phase 2 needs the allowlisted signer.
- **Recommendation**: default Phase 2 to the **Safe scoped-wallet + policy** path
  (factory deployed + Tx Service documented, **no bundler required**). ERC-4337
  session keys are viable once a bundler is sourced — the on-chain infra is present.

## Tests

```bash
npm test   # live integration tests against mainnet (no mocks)
```

21 checks total. The **live** checks assert real on-chain invariants that catch
the classic failure modes (wrong network, wrong decimals, unscaled ray APY, wrong
oracle base unit, broken source-labeling, withdrawable-exceeds-liquidity), plus the
shared `api.getReport`/`getLayer` shape the MCP server serves. The **pure-logic**
checks (`tests/unit.test.ts`) verify the diff engine and the per-collateral
liquidation math with hand-built inputs — needed because the demo wallet carries no
debt, so the liquidation path can't be triggered live. A key-gated test exercises
the Pharos Watch `[api]` branch when `PHAROS_WATCH_API_KEY` is set, and self-skips
(never fakes) when it isn't. No mocked chain data anywhere.

---

## Architecture

```
scripts/
  config.ts      network, verified addresses, Pharos Watch base, thresholds
  abi.ts         Aave-style + ERC-4626 + ERC20 ABIs (all exercised live)
  rpc.ts         provider + hard chain-id (1672) sanity gate
  multicall.ts   Multicall3 batch reader + retry/backoff + pinned-block ReadCtx
  prices.ts      Aave oracle getAssetPrice reader (8-decimal, base-unit checked)
  lending.ts     OpenFi + ZonaLend reserve/user reads (per-venue adapters)
  vault.ts       Tulipa ERC-4626 reads (share price, redemption limits)
  pharoswatch.ts Pharos Watch API client (key-gated, degrades gracefully)
  snapshot.ts    local JSON snapshots for diff
  collect.ts     one-pass collector feeding all layers (one pinned block)
  types.ts       Sourced<T> — structural enforcement of source labeling
  layers/        eligibility · maturity · trueyield · risk · nav · diff
  api.ts         programmatic API — one source of truth for the report shape
  cli.ts         CLI commands + --json + --address (uses api.ts)
  mcp.ts         Model Context Protocol server for agents (uses api.ts)
```

**Consistency & performance.** Every read in a run is batched through Multicall3
(`0xcA11…CA11`, verified deployed on Pharos) at a single **pinned block**, so all
numbers in one report — and any saved snapshot — are internally consistent and
reproducible. Transient RPC errors are retried with backoff; a genuine revert is
never papered over. CI (`.github/workflows/ci.yml`) runs the strict typecheck and
the live test suite on every push/PR.

Built with strict TypeScript (`strict: true`), ethers v6, real error handling.
Run `npm run typecheck` to confirm a clean compile.
