# VERIFICATION.md — Step 0 Live-Mainnet Results

Every line below was confirmed against **live Pharos mainnet (chain 1672)** and
the real Pharos Watch API. The read-layer evidence (§A–§F) was confirmed on
**2026-06-16**; the actuator evidence (§G) on **2026-06-17**. Nothing here is
assumed. Where a thing could not be confirmed, it is marked **DEGRADE** and the
analyzer omits or clearly labels it rather than guessing. Re-run `npm run verify`
(reads) and `npm run deploy:modules` (AA infra) to reproduce.

---

## A. RPC sanity — ✅ CONFIRMED

| Check | Method | Result |
| --- | --- | --- |
| RPC reachable | `https://rpc.pharos.xyz` | answers |
| Chain ID | `eth_chainId` | `0x688` = **1672** ✅ (mainnet) |
| Head block | `eth_blockNumber` | `0x9be1c0` ≈ **10,215,960** (live) |

The analyzer re-checks chain id on every run (`scripts/rpc.ts`) and **refuses to
run** if it is not 1672 (unless `--allow-testnet` is passed for the 688688
testnet convenience toggle). Mainnet is the default and the network of all
results.

---

## B. OpenFi (Aave-style lending) — ✅ CONFIRMED, full feature

| Item | Address / Value | Source |
| --- | --- | --- |
| Pool | `0x30b2e1411fd2ed9f1f46f59497e2186ce5be3b26` | given, reads OK |
| ADDRESSES_PROVIDER() | `0x3078361290234F1269034e6f9aF90A7512159fb1` | on-chain |
| getPriceOracle() | `0x878aF9E17C0168bBCdB4f33890Bf8CDE7592a6d1` | on-chain (matches expected) |
| getPoolDataProvider() | `0x3EF4724f0f2fabfA0ba96AfC711D64e6BE3367Fb` | on-chain |
| Reserves (`getAllReservesTokens`) | USDC, WETH, WPROS | on-chain |
| USDC | `0xC879C018dB60520F4355C26eD1a6D572cdAC1815`, 6 decimals | on-chain |
| WETH | `0x1f4b7011Ee3d53969bb67F59428a9ec0477856E9` | on-chain |
| WPROS | `0x52C48d4213107b20bC583832b0d951FB9CA8F0B0` | on-chain |

- `getReserveData(USDC)` returns the Aave V3 struct. The supply rate is field
  **`currentLiquidityRate`** (3rd field of the struct, *not* index 5 — the prompt's
  "index 5" referred to an older flat-array layout; we decode by **named struct
  fields** to be safe). Live value `9017859879489446740329543` ray ÷ 1e27 ×100 =
  **0.9018 % base supply APR**. Sane. ✅
- `getReserveConfigurationData(USDC)` (on the data provider): decimals 6,
  **LTV 7500 (75%)**, **liqThreshold 7800 (78%)**, liqBonus 10500, reserveFactor
  1000, collateral ✔, borrowing ✔, **isActive=true, isFrozen=false**. ✅
- Oracle `getAssetPrice(USDC)` = `99969492` ÷ 1e8 = **$0.999695**, and
  `BASE_CURRENCY_UNIT()` = `100000000` (1e8) confirms the **8-decimal** USD base. ✅

---

## C. ZonaLend (Aave-style lending) — ✅ CONFIRMED, full feature (own deployment)

ZonaLend is Aave-style but a **separate deployment** from OpenFi — its own
AddressesProvider, oracle, and data provider. We do **not** assume it equals
OpenFi byte-for-byte; we resolve each venue's oracle/data-provider from its own
AddressesProvider at runtime.

| Item | Address | Source |
| --- | --- | --- |
| USDC market / Pool | `0xda464e68208a3083eb65fe5c522a72aed1c1372a` | given, reads OK |
| PROS market | `0xb6e6826ad767f2323d2fa7af6144b6dfdf096c9f` | given |
| ADDRESSES_PROVIDER() | `0x923f847549713650b7F66b0052B70d5D3216e41A` | on-chain |
| getPriceOracle() | `0x6bEDfCa244f29dD916fe7c50e1469C6188B873f9` | on-chain |
| getPoolDataProvider() | `0xA91424C666193C2b2fb684E25dEadf03B333f49A` | on-chain |
| getPool() | `0xda464e68208A3083Eb65FE5c522a72AeD1C1372a` (== USDC market) | on-chain |
| Reserves | USDC, WETH, WPROS | on-chain |

- `getReserveData(USDC)` works (same Aave struct). Live `currentLiquidityRate`
  = `78116995123006713467` ray ÷ 1e27 ×100 = **~0.0000078 % base supply APR** —
  i.e. **base yield ≈ 0**. This is the key honesty point: Zona's advertised
  ~210% is **not** in the base supply rate; it would come from incentive
  emissions, which are **not** exposed by this read. `trueyield` ranks on the
  verified base rate and labels any advertised total as unverified. ✅
- Calling the market as an ERC20 reverts (`"Fallback not allowed"`) — confirms
  the market address is a **Pool**, not a token. Reads go through the pool/data
  provider, exactly as built.

### On-chain incentive check (the "210%" question) — ✅ verified
The USDC aTokens expose `getIncentivesController()`:
- OpenFi aToken `0x9dcf…9D96` → controller **`0x74C03457F461DeF9837884de93223545b172F67d`**
- ZonaLend aToken `0x8439…23B8` → controller **`0xA9F4FEF0862efF443f3776eF359A2ff24896A80C`**

Both controllers are **deployed** (bytecode present) but
`getRewardsList()` and `getRewardsByAsset(aToken)` return **empty arrays** — i.e.
**no active on-chain reward emissions** for the USDC supply aToken. Conclusion:
the advertised ~210% does **not** originate from an on-chain RewardsController
emission we can verify. `trueyield` now reports this as a `[on-chain]` fact via
`scripts/incentives.ts`, and never folds unverifiable incentives into the
comparable number.

---

## D. Tulipa Multi-RWA Vault — ✅ ERC-4626 CONFIRMED

| Item | Value | Source |
| --- | --- | --- |
| Vault | `0xbae9272f71db2dc9d053e3c6c4840df65ae6aec5` | given |
| name / symbol / decimals | "Ember TulipaPRWA" / `tulPRWA` / **6** | on-chain |
| `asset()` | `0xC879…1815` = **USDC** | on-chain |
| `totalAssets()` | `509770951` = **509.77 USDC** | on-chain |
| `totalSupply()` | `509770951` shares | on-chain |
| `convertToAssets(1e6)` | `1000000` ⇒ **share price = 1.000000 USDC** | on-chain |
| `previewRedeem`, `maxWithdraw`, `maxRedeem` | all respond | on-chain |

**ERC-4626 confirmed** ⇒ maturity (layer 2), trueyield RWA-income (layer 3) and
nav share-price cross-check (layer 5) all read **on-chain**.

### Owner's real position (the wallet that deposited)
- The deposit tx `0x0a6c…b19d` was sent **from**
  `0x0Ac6bf160e208e67AF06d7F00c92AEfBbf089f95` — this is the **owner/demo wallet**
  the analyzer is tested against.
- On-chain now: `balanceOf(owner)=110000` (**0.11 tulPRWA**), `maxWithdraw=110000`
  (0.11 USDC redeemable), `maxRedeem=110000`. Wallet USDC balance `170772`
  (**0.170772 USDC**). Real, tiny, honest numbers — no rounding to look bigger.

### Deposit interface (Phase-2 relevant, NOT used by this read-only analyzer)
The deposit tx input decodes to selector **`0x50921b23`** with args:
`(uint256 amount=100000, address receiver=owner, uint256 deadline, uint8 v,
bytes32 r, bytes32 s)`. So **Tulipa deposits are signature-gated** (a permit /
allowlisted-signer style call), which is why "the owner deposited successfully,
so it's open to them" — they were issued a signature. **Reads are standard
ERC-4626**; only the *write* path needs the off-chain signature. The analyzer
never deposits.

---

## E. Pharos Watch (NAV / depeg API) — ✅ key-verified; response shapes confirmed

| Check | Result |
| --- | --- |
| Base URL | `https://api.pharos.watch` (confirmed JSON host) |
| `GET /api/health` (exempt, **no key**) | `200 {"status":"healthy",…}` — upstream provider **DefiLlama** |
| `GET /api/peg-summary` (no key) | **401** `"Unauthorized: valid X-API-Key required"` |
| `GET /api/peg-summary` (**with key**) | **200** — `{ coins: [...] }`, 371 coins |
| `GET /api/stablecoins` (**with key**) | **200** — `{ peggedAssets: [...] }`, 549 assets |
| OpenAPI catalogue | `https://pharos.watch/openapi.json` — 38 routes |

**Confirmed response shapes (with a live key — no longer guessed):**
- `/api/peg-summary` → `coins[]` with `currentDeviationBps`, `pegScore`,
  `activeDepeg`, `worstDeviationBps`, `priceConfidence`, `priceUpdatedAt`. Live
  `usdc-circle`: **−1 bps, pegScore 93/100, activeDepeg false.** ← the `nav` layer
  uses THIS as the depeg signal.
- `/api/stablecoins` → `peggedAssets[]` with `id, symbol, name, price, pegType`
  (`usdc-circle` ≈ $0.99975).
- `/api/stablecoin/{id}` → descriptive issuer metadata (no leading live price), so
  the client deliberately does **not** use it for pricing.

**What this means for layer 5 (nav):**
- The key lives only in the gitignored `.env` (`PHAROS_WATCH_API_KEY`); it is never
  committed. Without it the layer still runs on-chain-only and says so.
- Pharos Watch tracks **global stablecoin issuers** (e.g. `usdc-circle`), not the
  Pharos-native vault token `tulPRWA` — so vault NAV always comes from the on-chain
  ERC-4626 share price, and the API only adds the issuer-level peg reference.
- Live cross-check: API `usdc-circle` (−0.01%) agrees with the OpenFi oracle
  (−0.03%). Independent sources, both healthy, each labeled distinctly.

---

## F. Multicall3 — ✅ CONFIRMED deployed (read batching + block pinning)

| Item | Value | Source |
| --- | --- | --- |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | on-chain, 3,808 B bytecode |

The analyzer batches all reserve/user/oracle reads through Multicall3 at a single
**pinned block** (`scripts/multicall.ts` + `collect.ts`), so every value in one
report is internally consistent and a saved snapshot is reproducible. Transient RPC
errors retry with backoff; genuine reverts are never swallowed.

---

## Actuator readiness (AA predeploys)

The canonical Pharos AA predeploy table from `docs.pharos.xyz/llms-full.txt` was
cross-checked with `eth_getCode` on mainnet. **All six are deployed** (run
`npm run verify`):

| Contract | Address | Bytecode | Status |
| --- | --- | --- | --- |
| ERC-4337 EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | 16,035 B | ✅ deployed |
| ERC-4337 EntryPoint v0.6 | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` | 23,689 B | ✅ deployed |
| SenderCreator v0.7 | `0xEFC2c1444eBCC4Db75e7613d20C6a62fF67A167C` | 451 B | ✅ deployed |
| SenderCreator v0.6 | `0x7fc98430eAEdbb6070B35B39D798725049088348` | 528 B | ✅ deployed |
| SafeSingletonFactory | `0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7` | 69 B | ✅ deployed |
| CreateX | `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed` | 11,838 B | ✅ deployed |

| Probe | Result |
| --- | --- |
| **Bundler** | `eth_supportedEntryPoints` on `rpc.pharos.xyz` → not a bundler. The docs corpus (`docs.pharos.xyz/llms-full.txt`) contains **no public bundler URL**. The actuator supports `PHAROS_BUNDLER_URL` when one exists and otherwise self-bundles through `EntryPoint.handleOps`. |
| **Tulipa write path** | Signature-gated deposit `0x50921b23(amount,receiver,deadline,v,r,s)` — the actuator refuses vault deposits and only supports standard ERC-4626 redeem/withdraw paths. |

### Signing rails found in the Pharos docs (the "agent center" search)
- **Safe (Gnosis Safe) is officially supported** — the recommended scoped-wallet path:
  Safe UI `https://app.safe.global`, Transaction Service API
  `https://transaction.safe.pharosnetwork.xyz`. (The Tx Service host did not resolve
  from this sandbox — DNS-restricted environment; confirm from a normal network.)
- **Fordefi** — institutional **MPC** wallet infra; an alternative policy signer.
- **Pharos "agent" toolkit** — a `SKILL.md`-driven agent that signs via Foundry
  `--private-key` behind a mandatory 4-check pre-check.

The default path this skill implements is the **Safe scoped wallet + ERC-4337
UserOperation**, self-bundled through `EntryPoint.handleOps` (no public bundler
needed). §G below documents this working end-to-end.

---

## G. Safe4337 actuator — ✅ DEPLOYED & PROVEN END-TO-END (2026-06-17)

The full Safe v1.4.1 + Safe4337Module v0.3.0 stack was completed on Pharos and a
real action was signed, simulated, and executed.

### G.1 The gap and how it was closed
Six contracts are required for the Safe + 4337 path. On 2026-06-17 (block
10284615), four were already live but two were missing:

| Required contract | Address | Before | After |
| --- | --- | --- | --- |
| EntryPoint v0.7 | `0x0000…da032` | ✅ | ✅ |
| SafeProxyFactory v1.4.1 | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | ✅ | ✅ |
| Safe L2 singleton v1.4.1 | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` | ✅ | ✅ |
| MultiSendCallOnly v1.4.1 | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` | ✅ | ✅ |
| **Safe4337Module v0.3.0** | `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226` | ❌ missing | ✅ deployed |
| **SafeModuleSetup v0.3.0** | `0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47` | ❌ missing | ✅ deployed |

No alternative official deployment exists on Pharos — these are deterministic
addresses, so an official deploy *is* these addresses. We reproduced them exactly
rather than inventing new ones.

### G.2 Bytecode provenance (no guessed addresses, no unaudited code)
- Safe deployed both modules via the **Arachnid Deterministic Deployment Proxy**
  `0x4e59b44847b379578588920cA78FbF26c0B4956C` (verified present on Pharos, 69 B),
  **not** the Safe Singleton Factory — confirmed from the canonical Ethereum-mainnet
  creation tx `0x2807658b…ad95ad32` (its `to` is the Arachnid proxy; salt = zero).
- The official `@safe-global/safe-4337@0.3.0-1` creation code was byte-compared to
  the canonical mainnet deployment: the **runtime differs only in the metadata tail
  and the 6 `entryPoint`-immutable slots** (Safe4337Module) and is **byte-identical**
  (SafeModuleSetup). `CREATE2(Arachnid, salt=0, initCode)` reproduces
  `0x75cf…c226` and `0x2dd6…5b47` **exactly**.
- That verified creation code is committed under `scripts/aa/artifacts/*.json` with
  provenance. `scripts/aa/deploy-modules.ts` re-asserts
  `CREATE2 == canonical == configured address` and refuses on any mismatch.

### G.3 Deployment transactions (Pharos mainnet)
| Module | Deployed at | Runtime | Tx |
| --- | --- | --- | --- |
| Safe4337Module v0.3.0 | `0x75cf…c226` | 8,373 B (= mainnet) | `0x54e6415c189094bc6f4e542a2dbb0f1db47fa09b614aea819cd48f104b0e29be` |
| SafeModuleSetup v0.3.0 | `0x2dd6…5b47` | 547 B (= mainnet) | `0x5ea999520a3c1bd5c2580d882908cff22825656f476432e2716c9c5cb9cdb058` |

Deployer: owner EOA `0x0Ac6bf16…089f95`. After deploy, the actuator's
`verifyInfra()` returns `allPresent: true, missing: []`.

### G.4 Live action proof — supply 0.1 USDC to OpenFi
- Derived Safe (salt 0): `0xBb9F1C5aEB8BD688e32B6F9a98dF7B63C6902790`.
- Funded from the owner EOA with 0.5 PROS (gas prefund) + 0.15 USDC.
- `--simulate` passed: the locally-computed `SafeOp` EIP-712 digest **matched the
  deployed module's on-chain `getOperationHash`** (`matches: true`), and
  `handleOps` gas-estimated cleanly (~1.02M).
- `--execute` UserOp tx **`0xb92e807dc85df89cf6e424189ee8be80d6ce782f7fa52ffe755bcb5b746abcea`**,
  status **1**, block 10286968. The Safe **deployed on first use** via `initCode`
  and the atomic approve+supply ran.
- On-chain result: Safe holds **0.1 bUSDC** (OpenFi aToken `0x9dcf…9D96`), 0.05 USDC
  and 0.44 PROS remaining. Verified by reading `aToken.balanceOf(safe)`.

### G.5 Bug found and fixed during execution
The first two `--execute` attempts reverted (`status 0`, ~400k gas). Root cause:
self-bundling relied on ethers' **auto gas estimation** for the outer `handleOps`
tx, which under-estimates a **deploy-on-first-use** UserOp — the EVM **63/64 rule**
means EntryPoint must hold more than `verificationGasLimit` to forward it to
`validateUserOp` (which deploys the Safe), so a tight estimate starves the inner
call and reverts as a `FailedOp`. Fixed in `scripts/aa/userop.ts` by setting the
outer `gasLimit` explicitly from the UserOp's declared limits + ~12.5% headroom.
The successful tx used 633,363 gas, well within the explicit budget.

**Actuator status:** complete. Read analysis stays read-only; `act --simulate` /
`act --execute` work against the live, fully-deployed Safe + 4337 stack.

---

## Confirmed-vs-Degraded summary

| Layer | Status | Why |
| --- | --- | --- |
| eligibility | ✅ Confirmed | reserve active/frozen + access map, all on-chain |
| maturity | ✅/⚠️ On-chain limits; off-chain dates labeled | ERC-4626 `maxWithdraw`/`maxRedeem` live; true maturity dates not on-chain |
| trueyield | ✅ Confirmed | base APR from `currentLiquidityRate`; RWA income from share-price snapshots; incentives labeled unverified |
| risk | ✅ Confirmed | oracle USD pricing (8-dp) + HF/liquidation + concentration |
| nav | ✅ Confirmed | on-chain drift always; with a key, adds verified `[api]` peg from `/api/peg-summary` (shapes confirmed live) |
| diff | ✅ Confirmed | local JSON snapshots, pure reads |
