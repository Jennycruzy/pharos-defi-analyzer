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

## Confirmed vs Degraded (per layer)

| Layer | Status | Detail |
| --- | --- | --- |
| eligibility | ✅ Confirmed | reserve active/frozen flags + access map, all on-chain |
| maturity | ✅ / ⚠ | ERC-4626 redemption limits on-chain; true off-chain maturity dates labeled `[static]` and only shown if actually known (none fabricated) |
| trueyield | ✅ Confirmed | base APY from `currentLiquidityRate`; RWA income from share-price snapshots; incentives labeled, never folded into the number |
| risk | ✅ Confirmed | oracle USD pricing (8-decimal) + health-factor/liquidation distance + concentration |
| nav | ⚠ Partial | on-chain share-price/oracle drift always works; Pharos Watch data API requires `PHAROS_WATCH_API_KEY` |
| diff | ✅ Confirmed | local JSON snapshots under `./snapshots`, pure reads |

---

## Phase-2 signing readiness (from `VERIFICATION.md` — this app signs nothing)

All account-abstraction predeploys below are **confirmed deployed on mainnet**
(`npm run verify` checks them live):

- **ERC-4337 EntryPoint v0.7** `0x0000…da032` and **v0.6** `0x5FF1…2789` — both deployed.
- **SenderCreator v0.7 / v0.6** — both deployed.
- **SafeSingletonFactory** `0x914d…43d7` and **CreateX** `0xba5E…ba5Ed` — both deployed.
- **Bundler**: still **not found** (no public URL in the docs corpus) — Phase 2 must
  self-host one or obtain it from the team.
- **Tulipa write path**: deposits are signature-gated (`0x50921b23(amount,
  receiver, deadline, v, r, s)`) — Phase 2 needs the allowlisted signer.
- **Recommendation**: default Phase 2 to a **Safe scoped-wallet + policy** path
  (deployable today via SafeSingletonFactory, no bundler required). ERC-4337 session
  keys are viable once a bundler is sourced — the on-chain infra is already present.

## Tests

```bash
npm test   # live integration tests against mainnet (no mocks)
```

9 checks assert real on-chain invariants that catch the classic failure modes
(wrong network, wrong decimals, unscaled ray APY, wrong oracle base unit, broken
source-labeling). They exercise the real modules — no mocked data is introduced.

---

## Architecture

```
scripts/
  config.ts      network, verified addresses, Pharos Watch base, thresholds
  abi.ts         Aave-style + ERC-4626 + ERC20 ABIs (all exercised live)
  rpc.ts         provider + hard chain-id (1672) sanity gate
  prices.ts      Aave oracle getAssetPrice reader (8-decimal, base-unit checked)
  lending.ts     OpenFi + ZonaLend reserve/user reads (per-venue adapters)
  vault.ts       Tulipa ERC-4626 reads (share price, redemption limits)
  pharoswatch.ts Pharos Watch API client (key-gated, degrades gracefully)
  snapshot.ts    local JSON snapshots for diff
  collect.ts     one-pass collector feeding all layers
  types.ts       Sourced<T> — structural enforcement of source labeling
  layers/        eligibility · maturity · trueyield · risk · nav · diff
  cli.ts         commands + --json + --address
```

Built with strict TypeScript (`strict: true`), ethers v6, real error handling.
Run `npm run typecheck` to confirm a clean compile.
