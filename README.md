# Pharos RWA Position Analyzer

A skill that gives a wallet a complete, honest picture of its DeFi +
real-world-asset (RWA) positions on **Pharos mainnet (chain 1672)**, then can
explicitly build guarded Safe/ERC-4337 actions when asked. It answers the
questions generic analyzers don't: *can I act on this, when does it unlock,
what's my REAL yield after incentives/fees, where is my hidden risk, and what
action would be safe to prepare?*

Read/report commands **never sign, hold a key, or move funds**. The `act`
surface signs only in `--simulate` or `--execute`, reads the owner key from
local `.env` as `PHAROS_SIGNER_KEY`, and sends protocol calls through a Safe
smart account.

Every number it prints comes from a **real live read** of Pharos mainnet or the
real Pharos Watch API. There are **no mocks, no fakes, no example numbers.** Each
value is tagged with its source: `[on-chain]`, `[api]`, or `[static]`.

Use it three ways — a **CLI**, an **MCP server** for other agents, and an importable
**TypeScript library** — and every report carries a **replayable proof** (pinned
block + hash + the exact reads performed) so anyone can reproduce it.

> **Project layout.** The app lives in [`pharos-rwa-analyzer/`](./pharos-rwa-analyzer/).
> Every `npm …` command and every `scripts/…`, `tests/…`, and sibling-doc path below
> (e.g. `VERIFICATION.md`, `AGENTS.md`, `NON_TECHNICAL_SUMMARY.md`) is **relative to
> that directory** — the Setup block `cd`s into it first. The CI workflow
> (`.github/workflows/ci.yml`) is at the repo root.

---

## Contents

- [Highlights](#highlights)
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
- [Actuator readiness](#actuator-readiness-from-verificationmd)
- [Tests](#tests)
- [Continuous integration](#continuous-integration)
- [Architecture](#architecture)

---

## Highlights

- **Six layers, one comparable answer each** — eligibility, maturity, trueyield,
  risk, nav, diff. `report` runs all six; `report --json` is the agent bridge.
- **Honest by construction** — every value is a `[on-chain]`/`[api]`/`[static]`
  `Sourced<T>`; unsourceable data is `null` + explained, never fabricated.
- **Liquidity-aware** — lending "redeemable now" is bounded by real pool liquidity,
  not just your balance.
- **Real risk math** — aggregate **and per-collateral** liquidation distance; the
  USD total degrades to `[static]`/low-confidence if any price can't be sourced.
- **Noise-resistant yield** — Tulipa RWA APY needs a ≥3-day snapshot gap and flags
  implausible annualized figures instead of printing them as headline yield.
- **Fast & consistent** — all reads batched through **Multicall3** at a single
  **pinned block**, with retry/backoff; one report is internally consistent.
- **Replayable proof** — `meta.proof` pins block + hash + the exact
  `(contract, selector)` reads, so a third party can reproduce byte-identical values.
- **Reusable by agents** — ships an **MCP server** (read tools, `pharos_act`, a
  snapshot **resource**, and an `explain_wallet` **prompt**) and an importable
  **library API**.
- **Guarded actuator** — dry-run Safe/ERC-4337 plans need no key; simulation and
  execution require `PHAROS_SIGNER_KEY`, spend caps, health-factor floors, SafeOp
  digest checks, and live UserOperation simulation before broadcast.
- **Guarded** — 23 tests (live + a **golden-snapshot** regression + pure-logic),
  strict TypeScript, and CI on every push/PR.
- **Explicit writes only** — analysis remains read-only; write actions are only
  built through `act` / `pharos_act` and only broadcast with `--execute`.

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

No keys are required for read reports. Optional `.env` settings:
- `PHAROS_RPC_URL` — override the default `https://rpc.pharos.xyz`.
- `PHAROS_WATCH_API_KEY` — unlocks the live NAV/depeg API layer (request a
  self-serve key at https://pharos.watch/api/). Without it the `nav` layer still
  works using on-chain drift and clearly says the API portion is unavailable.
- `DEFAULT_ADDRESS` — the wallet to analyze when `--address` isn't given.
- `PHAROS_SIGNER_KEY` — owner EOA key for `act --simulate` / `act --execute`
  only. Never pass this key as a CLI argument or chat message.
- `PHAROS_BUNDLER_URL` — optional ERC-4337 bundler; empty means self-bundle
  through `EntryPoint.handleOps`.

---

## Usage

```bash
npm run analyze -- <command> [--address 0x..] [--json] [--allow-testnet]
npm run act -- <intent> [--owner 0x..] [--product OpenFi] [--asset USDC] [--amount 10]

# examples
npm run analyze -- report                       # full picture, default wallet
npm run analyze -- trueyield --address 0xABC…    # one layer, a specific wallet
npm run analyze -- report --json                 # machine-readable read report
npm run verify                                   # re-run Step-0 live verification
npm run act -- rebalance --owner 0xABC…          # dry-run plan, no key needed
npm run act -- repay --owner 0xABC… --product OpenFi --asset USDC --amount all --simulate
```

Flags: `--address` (defaults to the verified owner wallet), `--json` (structured
output), `--allow-testnet` (permit chain 688688; **mainnet is the default and the
network of all results**).

Actuator intents: `supply`, `withdraw`, `borrow`, `repay`, `redeem`,
`rebalance`, and `set-collateral` (or `--enable-collateral` /
`--disable-collateral`). Dry-run prints the derived Safe address; fund that Safe
with the token being supplied/repaid/redeemed before simulation or execution.
If self-bundling, the owner EOA also needs native gas for `handleOps`.

---

## Use it as an MCP server (for agents)

This skill ships a **Model Context Protocol** server so any MCP-capable agent
(Claude Desktop, IDE assistants, custom agents) can call it **in natural language**.
Read tools return the exact same structured JSON as the CLI (shared via
`scripts/api.ts`, so they can never drift). The `pharos_act` tool is the explicit
write surface: dry-run needs no key, while simulate/execute read
`PHAROS_SIGNER_KEY` from local environment only.

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

**Resources & prompts (not just tools):**

- **Resource** `pharos://snapshot/{address}` — the full saved snapshot history for a
  wallet, as JSON. An agent can *read prior state* (to explain what changed) without
  triggering a new scan. The server enumerates wallets that have snapshots so clients
  can browse them.
- **Prompt** `explain_wallet` (arg: `address?`) — a reusable template that tells the
  agent to run `pharos_report` and explain the result to a non-technical owner while
  respecting source labels and never inventing numbers.

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
    "readOnly": true,                     // this skill never signs
    "proof": {                            // replayable anchor (see below)
      "blockNumber": 10228494,
      "blockHash": "0x…",                 // pin to an exact, immutable block
      "chainId": "1672",
      "multicall3": "0xcA11…CA11",
      "contracts": { "venues": [ … ], "vault": "0xbae9…aec5" },
      "reads": [ { "target": "0x…", "selector": "0x70a08231", "count": 2 }, … ],
      "replay": "Re-run getReport pinned to blockNumber against an archive RPC; …"
    }
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

### Reproducible proof (`meta.proof`)

Every report is **replayable**. All reads run at one pinned block, and `meta.proof`
records that block's number **and hash**, the chain id, the resolved contracts, and
the exact `(target, selector)` reads performed. Anyone can re-run the report against
an archive RPC pinned to that block and get **byte-identical** on-chain values:

```ts
import { getReport } from './scripts/api.js';
const replay = await getReport(address, false, /* pinBlock */ 10228494);
```

Turns "trust me" into "verify me." (Pharos Watch `[api]` values are live and not
block-bound, so they're excluded from the deterministic guarantee.)

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

## Actuator readiness (from `VERIFICATION.md`)

All account-abstraction predeploys below are **confirmed deployed on mainnet**
(`npm run verify` checks them live):

- **ERC-4337 EntryPoint v0.7** `0x0000…da032` and **v0.6** `0x5FF1…2789` — both deployed.
- **SenderCreator v0.7 / v0.6** — both deployed.
- **SafeSingletonFactory** `0x914d…43d7` and **CreateX** `0xba5E…ba5Ed` — both deployed.
- **Bundler**: still **not found** (no public URL in the docs corpus). The
  actuator can use `PHAROS_BUNDLER_URL` when one exists; otherwise it self-bundles
  through `EntryPoint.handleOps`.
- **Safe4337 module stack**: dry-run on June 17, 2026 found `Safe4337Module`
  `0x75cf…c226` and `SafeModuleSetup` `0x2dd6…5b47` missing on the connected
  Pharos RPC. Planning works, but simulation/execution are intentionally blocked
  until those module contracts are deployed, replaced with Pharos-deployed
  equivalents, or the actuator switches to the Safe Transaction Service path.
- **Signing rails (from the docs):** **Safe** is officially supported — UI
  `app.safe.global` + Transaction Service `transaction.safe.pharosnetwork.xyz`;
  **Fordefi** (MPC) is available; and Pharos ships an **agent toolkit** that signs via
  Foundry `--private-key` behind a mandatory 4-check pre-check.
- **Tulipa write path**: deposits are signature-gated (`0x50921b23(amount,
  receiver, deadline, v, r, s)`), so the actuator refuses vault deposits and only
  supports standard ERC-4626 redeem/withdraw paths.
- **Default path**: Safe scoped wallet + ERC-4337 UserOperation, with direct
  `handleOps` self-bundling when no public bundler is configured.

## Tests

```bash
npm test   # live integration tests against mainnet (no mocks)
```

23 checks total. The **live** checks assert real on-chain invariants that catch
the classic failure modes (wrong network, wrong decimals, unscaled ray APY, wrong
oracle base unit, broken source-labeling, withdrawable-exceeds-liquidity), plus the
shared `api.getReport`/`getLayer` shape the MCP server serves. A **golden-snapshot**
test (`tests/golden.test.ts`) pins a fixed historical block and asserts the report
still matches a committed JSON (modulo wall-clock + live `[api]`) — catching silent
numeric drift that ordinary live tests miss. The **pure-logic** checks
(`tests/unit.test.ts`) verify the diff engine and the per-collateral liquidation math
with hand-built inputs — needed because the demo wallet carries no debt, so the
liquidation path can't be triggered live. A key-gated test exercises the Pharos Watch
`[api]` branch when `PHAROS_WATCH_API_KEY` is set, and self-skips (never fakes) when
it isn't. No mocked chain data anywhere.

```bash
npm test              # all 23 checks (live + golden + pure-logic)
npm run golden:gen    # regenerate the golden after an intentional shape change
```

---

## Continuous integration

`.github/workflows/ci.yml` runs the strict typecheck and the full test suite
(live + golden + pure-logic) on every push and PR to `main`. It needs network
access to `rpc.pharos.xyz` (GitHub runners have it).

**Optional secret — `PHAROS_WATCH_API_KEY`.** The Pharos Watch `[api]` nav test
self-**skips** (it never fails and never fakes) unless a real key is present. To
exercise that branch in CI, add the secret once:

```bash
gh secret set PHAROS_WATCH_API_KEY      # paste your key when prompted
```

Or via the UI: **repo → Settings → Secrets and variables → Actions → New repository
secret**, name `PHAROS_WATCH_API_KEY`, value = your key from
<https://pharos.watch/api/>. The workflow reads it into the job env
(`PHAROS_WATCH_API_KEY: ${{ secrets.PHAROS_WATCH_API_KEY }}`) and prints only whether
it is set — never the value. Without the secret, CI still passes (the `[api]` test
just skips). The secret is never committed; locally it lives only in the gitignored
`.env`.

---

## Architecture

```
pharos-rwa-analyzer/scripts/
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
