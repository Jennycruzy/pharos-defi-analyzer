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
npm run verify                    # live Step-0 checks
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

- **Pharos Watch NAV API is locked by default.** Data routes need
  `PHAROS_WATCH_API_KEY` (self-serve at https://pharos.watch/api/). Until a key is
  set, the `nav` layer uses on-chain drift only. The exact JSON shape of the
  key-gated routes was **not shape-verified** (no key during Step 0), so price
  extraction in `pharoswatch.ts` is defensive/best-effort and labeled medium
  confidence — re-verify field names once a key exists.
- **trueyield RWA-income is empty on first run.** It needs **≥2 snapshots** to
  measure Tulipa share-price growth. Run `snapshot`, wait, then `report`.
- **Tulipa true maturity date is not sourced.** ERC-4626 redemption limits are
  on-chain; any fixed off-chain maturity date is intentionally **omitted** (not
  faked). Add it as `[static]` only once a published date is confirmed.
- **ZonaLend's advertised ~210% has no verified on-chain incentive source.** No
  emissions/rewards contract was located, so incentive APY is labeled and **never
  folded into** the comparable number. If a rewards contract is found, wire it in
  `trueyield.ts` and label it `[on-chain]`.
- **pAlpha has no verified on-chain address** for this wallet — it is a `[static]`
  benchmark only, never read on-chain. Add reads only if a real address is verified.
- **Phase-2 signing prerequisites unconfirmed:** EntryPoint is deployed, but the
  **bundler URL** and a **smart-account factory** are not yet identified (probing
  failed; need docs.pharos.xyz). See `VERIFICATION.md` → "Phase-2 signing readiness".
- **No automated test suite.** Verification today is live (`npm run verify`) plus
  `npm run typecheck`. A recorded-fixture or mainnet-fork test harness is a TODO
  (must not introduce mocks into the analyzer's own output path).

## Commit conventions

Use commit author **jennycruzy**; do **not** add AI attribution lines
(no `Co-Authored-By`, no "Generated with Claude Code").
