/**
 * config.ts — every address, URL and threshold the analyzer uses.
 *
 * Each address below was confirmed against LIVE Pharos mainnet on 2026-06-16
 * (see VERIFICATION.md). Addresses we resolve dynamically at runtime (oracles,
 * data providers, aTokens) are intentionally NOT hardcoded — we read them from
 * each venue's own AddressesProvider so ZonaLend ≠ OpenFi assumptions can't slip in.
 */

import 'dotenv/config';

export const PHAROS = {
  /** Pharos mainnet. Verified eth_chainId = 0x688. */
  mainnetChainId: 1672n,
  /** Pharos testnet — secondary convenience only, never the deliverable network. */
  testnetChainId: 688688n,
  rpcUrl: process.env.PHAROS_RPC_URL?.trim() || 'https://rpc.pharos.xyz',
} as const;

/** Tokens (all confirmed via getAllReservesTokens / asset() on mainnet). */
export const TOKENS = {
  USDC: { address: '0xC879C018dB60520F4355C26eD1a6D572cdAC1815', symbol: 'USDC', decimals: 6 },
  WETH: { address: '0x1f4b7011Ee3d53969bb67F59428a9ec0477856E9', symbol: 'WETH', decimals: 18 },
  WPROS: { address: '0x52C48d4213107b20bC583832b0d951FB9CA8F0B0', symbol: 'WPROS', decimals: 18 },
} as const;

/**
 * Lending venues (Aave-style). `pool` and `dataProvider`/`oracle` are confirmed,
 * but the analyzer also re-resolves oracle + data provider from each pool's
 * ADDRESSES_PROVIDER at runtime and prefers the live value if it differs.
 */
export const LENDING_VENUES = [
  {
    key: 'openfi',
    product: 'OpenFi',
    venue: 'OpenFi (Aave-style lending)',
    access: 'permissionless' as const,
    pool: '0x30b2e1411fd2ed9f1f46f59497e2186ce5be3b26',
    addressesProvider: '0x3078361290234F1269034e6f9aF90A7512159fb1',
    dataProvider: '0x3EF4724f0f2fabfA0ba96AfC711D64e6BE3367Fb',
    oracle: '0x878aF9E17C0168bBCdB4f33890Bf8CDE7592a6d1',
  },
  {
    key: 'zonalend',
    product: 'ZonaLend',
    venue: 'ZonaLend (Aave-style lending)',
    access: 'permissionless' as const,
    pool: '0xda464e68208a3083eb65fe5c522a72aed1c1372a',
    addressesProvider: '0x923f847549713650b7F66b0052B70d5D3216e41A',
    dataProvider: '0xA91424C666193C2b2fb684E25dEadf03B333f49A',
    oracle: '0x6bEDfCa244f29dD916fe7c50e1469C6188B873f9',
  },
] as const;

/** Tulipa Multi-RWA vault — confirmed ERC-4626 (asset = USDC, 6 decimals). */
export const TULIPA = {
  product: 'Tulipa',
  venue: 'Tulipa Multi-RWA Vault',
  address: '0xbae9272f71db2dc9d053e3c6c4840df65ae6aec5',
  /** Reads are standard ERC-4626; deposits are signature-gated (selector 0x50921b23). */
  access: 'gated-but-owned' as const,
} as const;

/**
 * pAlpha — gated institutional vault surfaced via AquaFlux. We have NO verified
 * on-chain address, so it is a READ-ONLY STATIC benchmark only: never treated as
 * actionable, never read on-chain, its ~14% APY labeled [static] / advertised.
 */
export const PALPHA = {
  product: 'pAlpha',
  venue: 'pAlpha (gated institutional vault, via AquaFlux)',
  access: 'gated' as const,
  advertisedApyPct: 14,
  note: 'Gated institutional vault. No verified on-chain address for this wallet; benchmark only.',
} as const;

/** ERC-4337 EntryPoint — confirmed deployed; Phase-2 prep only (this app signs nothing). */
export const ENTRYPOINT_ADDRESS = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

/** Pharos Watch NAV/depeg API. Data routes require X-API-Key; /api/health is exempt. */
export const PHAROS_WATCH = {
  baseUrl: 'https://api.pharos.watch',
  apiKey: process.env.PHAROS_WATCH_API_KEY?.trim() || '',
  /**
   * Global stablecoin IDs (ticker-issuer) used for the depeg reference of the
   * underlying issuers. Pharos-native vault tokens are NOT tracked by the API.
   */
  referenceStablecoinIds: ['usdc-circle'] as const,
} as const;

/** Default wallet to analyze (verified owner/demo wallet). CLI --address overrides. */
export const DEFAULT_ADDRESS =
  process.env.DEFAULT_ADDRESS?.trim() || '0x0Ac6bf160e208e67AF06d7F00c92AEfBbf089f95';

/** Tunable analysis thresholds. */
export const THRESHOLDS = {
  /** Flag a venue/product holding more than this share of total wallet value. */
  concentrationPct: 60,
  /** Health factor below this is flagged as fragile (Aave liquidation at HF<1). */
  fragileHealthFactor: 1.25,
  /** Flag a stablecoin/NAV as depegged if it drifts more than this from $1.00. */
  depegDriftPct: 1.0,
  /** Seconds per year used to annualize APR -> APY and share-price drift. */
  secondsPerYear: 31_536_000,
} as const;

export const RAY = 10n ** 27n; // Aave fixed-point base for interest rates
export const USD_BASE = 10n ** 8n; // Aave oracle base currency unit (verified 1e8)
