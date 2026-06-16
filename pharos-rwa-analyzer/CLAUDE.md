# CLAUDE.md

Guidance for Claude Code when working in this repo. The full agent brief is in
**[AGENTS.md](./AGENTS.md)** — read it first; the hard rules there are binding.

## TL;DR

Read-only DeFi/RWA position analyzer for **Pharos mainnet (chain 1672)**. Six
layers (eligibility, maturity, trueyield, risk, nav, diff) over OpenFi, ZonaLend,
the Tulipa ERC-4626 vault, and the pAlpha benchmark. Strict TypeScript + ethers v6.

## Must-obey

- **Mainnet only (1672); no mocks; never assume — verify on-chain; read-only (no signing).**
- Every output value is labeled `[on-chain]` / `[api]` / `[static]`. Can't source it → omit + explain.
- Keep `npm run typecheck` clean. Self-correct against a live wallet after changes.

## Commands

```bash
npm run typecheck
npm run verify
npm run analyze -- report [--address 0x..] [--json]
```

## Where things are

`scripts/config.ts` (verified addresses), `scripts/layers/*` (the six layers),
`scripts/collect.ts` (one-pass live read), `scripts/cli.ts` (commands).
Ground truth + Phase-2 signing readiness: **VERIFICATION.md**.

## Commits

Author **jennycruzy**; no AI attribution trailers.
