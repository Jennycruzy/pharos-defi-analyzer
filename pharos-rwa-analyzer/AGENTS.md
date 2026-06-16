# AGENTS.md — Pharos RWA Position Analyzer

Read-only DeFi/RWA position analyzer for **Pharos mainnet (chain 1672)**. This
file orients any coding agent working in this repo.

## Non-negotiable rules (HARD RULES)

0. **Mainnet only (1672).** Mainnet is the default and the network of every
   result. A `--allow-testnet` (688688) toggle exists only as a convenience.
1. **Never assume — verify on-chain.** Every address/ABI/decimal/field must be
   confirmed against live mainnet (or the named API) before relying on it. If you
   can't verify, document it and degrade gracefully.
2. **No mocks, no fakes.** Every printed value is a real on-chain read or the real
   Pharos Watch API. Can't source it? Omit it and say why. Never fabricate.
3. **Strict TypeScript, ethers v6.** `npm run typecheck` must stay clean. Small
   focused modules, real error handling, no `any` without a justifying comment.
4. **Self-correct.** After changes, run the command live against a real wallet and
   `npm run typecheck`. A nonsense number (e.g. 4,000,000% APY) means wrong
   address/ABI/decimals/network/ray-scaling — diagnose and fix.
5. **Honesty in output.** Each value is labeled `[on-chain]` / `[api]` / `[static]`.
6. **Read-only.** This project signs nothing. Signing belongs to Phase 2.

## Layout

- `scripts/config.ts` — verified addresses, thresholds, Pharos Watch base URL.
- `scripts/{abi,rpc,prices}.ts` — ABIs, provider + chain-id gate, oracle reader.
- `scripts/{lending,vault,pharoswatch,snapshot}.ts` — data adapters.
- `scripts/collect.ts` — one-pass live collector → `WalletScan`.
- `scripts/layers/*.ts` — six pure layer functions over a `WalletScan`.
- `scripts/cli.ts` — command surface (`verify|eligibility|maturity|trueyield|risk|nav|diff|snapshot|report`, `--json`, `--address`).
- `scripts/types.ts` — `Sourced<T>` structurally enforces source labeling.

## Verify / test

```bash
npm run typecheck                 # strict tsc, must be clean
npm test                          # LIVE integration tests (no mocks) — 9 invariant checks
npm run verify                    # live Step-0 checks (incl. AA predeploys)
npm run analyze -- report         # full live report, default owner wallet
npm run analyze -- report --json  # structured output (Phase-2 bridge)
```

## Ground truth

`VERIFICATION.md` records the live Step-0 results and the Phase-2 signing-readiness
findings (EntryPoint confirmed; bundler/factory still to confirm from docs). Re-run
`npm run verify` before trusting any hardcoded address — re-resolution of oracle /
data-provider happens at runtime per venue.

## Not done yet / open items (honest status)

Phase 1 is complete and all six layers run live. These are the known gaps and
the deliberate degradations — fix or confirm before relying on them:

- ✅ **RESOLVED — ZonaLend incentive source is now read on-chain.** `incentives.ts`
  reads each aToken's `getIncentivesController()` → `getRewardsByAsset`/`getRewardsData`.
  Verified: both OpenFi (`0x74C0…F67d`) and ZonaLend (`0xA9F4…A80C`) controllers are
  deployed but list **0 active reward streams** for the USDC aToken. So `trueyield`'s
  incentive note is now a `[on-chain]` high-confidence fact, not a guess. If a stream
  ever becomes active, extend `incentives.ts` to price `emissionPerSecond` (needs the
  reward token's decimals + USD price + aToken `totalSupply`) and surface an APY.
- **Pharos Watch NAV API is still locked by default.** Data routes need
  `PHAROS_WATCH_API_KEY` (self-serve at https://pharos.watch/api/). Until a key is
  set, the `nav` layer uses on-chain drift only. Note from the OpenAPI doc: the
  **peg/stablecoin routes are typed as opaque `JsonValue`** (no documented field
  shape), so price extraction in `pharoswatch.ts` stays defensive/best-effort —
  re-verify field names once a key exists. The **yield routes ARE documented**
  (`YieldRanking.apyBase`/`apyReward`), so a future key-gated `trueyield` enrichment
  can be schema-aligned.
- **trueyield RWA-income needs ≥2 snapshots** (by design). It measures Tulipa
  share-price growth between snapshots; on the very first run it reports `—`. Run
  `snapshot`, wait, then `report`. ERC-4626 exposes no share-price history to shortcut this.
- **Tulipa true maturity date is not sourced.** ERC-4626 redemption limits are
  on-chain; any fixed off-chain maturity date is intentionally **omitted** (not
  faked). Add it as `[static]` only once a published date is confirmed.
- **pAlpha has no verified on-chain address** for this wallet — it is a `[static]`
  benchmark only, never read on-chain. Add reads only if a real address is verified.
- ✅ **MOSTLY RESOLVED — Phase-2 AA infra confirmed.** The docs predeploy table was
  cross-checked on-chain: **EntryPoint v0.6 + v0.7, both SenderCreators,
  SafeSingletonFactory, and CreateX are all deployed** (see `config.ts` `AA_PREDEPLOYS`,
  checked by `npm run verify` and the test suite). A **Safe scoped-wallet path is
  deployable today**; ERC-4337 session keys are viable too. The **only remaining gap
  is a public bundler URL** — not in the docs corpus; Phase 2 must self-host or obtain
  one. Smart-account factory is no longer a blocker (SafeSingletonFactory/CreateX).
- ✅ **RESOLVED — automated test suite added.** `tests/live.test.ts` (run `npm test`)
  is a LIVE integration suite (no mocks) asserting invariants that catch the classic
  bugs: chain 1672, USDC decimals=6, ray-scaled APY < 100% (the "4,000,000%" guard),
  oracle USDC near $1 (base-unit guard), Tulipa ERC-4626/asset, on-chain incentive
  reads, all AA predeploys deployed, and the source-label honesty invariant. 9 tests,
  all passing. It exercises the real modules — it does not introduce mocks.

## Commit conventions

Use commit author **jennycruzy**; do **not** add AI attribution lines
(no `Co-Authored-By`, no "Generated with Claude Code").
