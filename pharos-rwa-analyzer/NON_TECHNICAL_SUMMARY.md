# Plain-English Guide — Pharos RWA Position Analyzer

This guide is for the **owner**, not a programmer. It explains, in everyday words,
what this tool does, what each command shows you, and what every number means. You
can demo the whole thing without reading any code.

---

## The one-sentence version

It's a **safe "read-only" health check for a crypto wallet** on the Pharos
network: it looks at where your money is parked, tells you whether you can pull it
out, what you're *really* earning, and where your risks are — **without ever
touching or moving your money.**

Think of it like a bank statement that also explains itself.

---

## The golden rules this tool follows

1. **It never moves money.** It can only *look*. It has no password to your
   wallet. (Moving money is a separate, later project — "Phase 2".)
2. **It never makes numbers up.** Every figure is pulled live from the blockchain
   or a real data service. If a number can't be sourced honestly, it's left out —
   never faked to look complete.
3. **It labels where each number comes from**, so you always know how much to
   trust it:
   - **`[on-chain]`** = read live, this second, straight from the blockchain. Most trustworthy.
   - **`[api]`** = from the Pharos Watch data service.
   - **`[static]`** = a known fact that can't be checked live right now (clearly flagged).

---

## How to run the demo

In a terminal, inside the project folder:

| You type | You get |
| --- | --- |
| `npm install` | one-time setup (downloads the tool's parts) |
| `npm run verify` | proves we're really connected to Pharos mainnet and everything is live |
| `npm run analyze -- report` | the full picture, all six sections below |
| `npm run analyze -- report --json` | the same picture as data, for the future Phase-2 robot |

To check a **different** wallet, add `--address 0x...` at the end.

---

## What each of the six sections tells you

### 1. ELIGIBILITY — "Can I actually use this?"
Some places let anyone in; others are invite-only. This tells you, per product,
whether **your** wallet is allowed to act.
- **OpenFi** and **ZonaLend**: open to everyone ("permissionless").
- **Tulipa**: invite-only for new deposits, **but you're already in** (you
  deposited successfully), so it's open *to you*.
- **pAlpha**: invite-only institutional product — shown only as a comparison
  benchmark, never as something this wallet can use.

### 2. MATURITY — "When can I get my money out?"
Some investments lock your money for a period. This shows what's **available to
withdraw right now**. For the Tulipa vault it reads the exact redeemable amount
live. If a product has a fixed end-date that isn't published on the blockchain,
the tool says so plainly rather than guessing a date.

### 3. TRUE YIELD — "What am I *really* earning?"
This is the headline feature. Advertised yields can be misleading — a flashy
"210%" is often mostly temporary bonus rewards, not real, durable interest. This
section **splits the yield into its honest pieces**:
- **Base APY** — the real, dependable interest rate (read live).
- **RWA income** — earnings from the real-world assets, measured by how the
  vault's value grows over time (needs two readings taken apart, see below).
- **Incentives** — bonus/marketing rewards. These are **clearly labeled and NOT
  added in**, because they can't be verified live and they fade over time.

So when Zona advertises ~210%, this tool shows you that the **verified base rate
is essentially 0%**, and the rest is unverified incentives. That's the honesty the
generic tools don't give you.

> "Needs ≥2 snapshots": to measure how fast the Tulipa vault is *actually*
> growing, the tool needs two readings over time. Run `npm run analyze -- snapshot`
> today and again in a few days, then it can show the real growth rate.

### 4. RISK — "Where could I get hurt?"
- **Total value**: everything added up in US dollars.
- **Most fragile position**: if you've borrowed against your assets, this is the
  one closest to being force-sold ("liquidated"), and how big a price drop would
  trigger it. (For the demo wallet there are no loans, so there's no such risk —
  and it says exactly that.)
- **Concentration warning**: if too much of your money is in one place. The demo
  wallet is 100% in Tulipa, so it flags that.

### 5. NAV / DEPEG — "Is each token still worth what it should be?"
A "stablecoin" like USDC should always be worth $1.00. A vault share should track
the value of what's inside it. This section flags **drift**:
- It checks the Tulipa vault's share price live (currently exactly 1.00 — healthy).
- It checks USDC's price live (currently $0.9997 — within a normal sliver of $1).
- The deeper Pharos Watch data service needs a free access key to unlock; without
  it, the tool still does the live on-chain checks and **tells you** the extra
  data needs a key, rather than pretending.

### 6. DIFF — "What changed since last time?"
The first time, there's nothing to compare to. After you save a snapshot, running
this later shows **what moved**: interest earned, anything that froze, how much
closer you are to a withdrawal date. This is what makes the tool useful *over
time*, not just once.

---

## What "Phase 2" means (the next project)

This tool only *looks*. The next project ("Phase 2") would be a robot agent that
can also *act* — for example, move money to a better-yielding spot — using the
honest data this tool produces (that's what the `--json` option is for). We've
already checked that the technical foundation for that exists on Pharos (the
"EntryPoint" is live), and noted what still needs confirming. **This tool itself
signs nothing and moves nothing.**

---

## If something looks off

The tool is built to **degrade gracefully**: if a data source is unavailable, it
says so and shows what it *can* verify, instead of failing or inventing a number.
If you ever see a number that seems wrong, run `npm run verify` first — it
confirms the live connection to Pharos mainnet and the key data sources.
