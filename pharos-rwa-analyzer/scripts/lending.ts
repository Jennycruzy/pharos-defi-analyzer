/**
 * lending.ts — per-venue adapter for Aave-style lending (OpenFi & ZonaLend).
 *
 * We treat each venue independently: oracle and data-provider addresses are
 * RE-RESOLVED from the pool's own ADDRESSES_PROVIDER at runtime (so ZonaLend is
 * never assumed equal to OpenFi). Rates are decoded from the named struct field
 * `currentLiquidityRate` (ray, 1e27) and annualized to both APR and compounded APY.
 *
 * All reserve/user reads go through Multicall3 at a PINNED block (one eth_call,
 * one consistent block) instead of N sequential round-trips. Available pool
 * liquidity (the underlying balance held by the aToken) is read so callers can
 * report true on-demand withdrawability, not just the supplied amount.
 */

import { ethers } from 'ethers';
import { ADDRESSES_PROVIDER_ABI, DATA_PROVIDER_ABI, ERC20_ABI, POOL_ABI } from './abi.js';
import { LENDING_VENUES, RAY, THRESHOLDS } from './config.js';
import { aggregate3, withRetry, type Call3, type ReadCtx } from './multicall.js';
import { PriceOracle } from './prices.js';
import { getProvider } from './rpc.js';

type VenueConfig = (typeof LENDING_VENUES)[number];

export interface ReserveInfo {
  symbol: string;
  address: string;
  aTokenAddress: string;
  decimals: number;
  supplyAprPct: number; // linear annual rate from currentLiquidityRate
  supplyApyPct: number; // compounded equivalent
  variableBorrowAprPct: number;
  ltvPct: number;
  liquidationThresholdPct: number;
  isActive: boolean;
  isFrozen: boolean;
  /** Underlying units currently available in the pool (aToken's underlying balance). */
  availableLiquidity: number;
}

export interface UserReservePosition {
  symbol: string;
  address: string;
  decimals: number;
  suppliedAmount: number; // human units of underlying (aToken balance ~ underlying)
  borrowedAmount: number; // human units (stable + variable debt)
  supplyAprPct: number;
  liquidationThresholdPct: number;
  usageAsCollateral: boolean;
  /** Underlying units redeemable on demand right now = min(supplied, pool liquidity). */
  withdrawableNow: number;
}

export interface UserAccount {
  totalCollateralUsd: number;
  totalDebtUsd: number;
  ltvPct: number;
  liquidationThresholdPct: number;
  /** ethers returns 2^256-1 (treated here as Infinity) when there is no debt. */
  healthFactor: number;
}

const MAX_UINT = (1n << 256n) - 1n;

const POOL_IFACE = new ethers.Interface(POOL_ABI);
const DATA_PROVIDER_IFACE = new ethers.Interface(DATA_PROVIDER_ABI);
const ERC20_IFACE = new ethers.Interface(ERC20_ABI);

/** APR (ray) -> compounded APY %, matching Aave's per-second compounding model. */
function rayAprToApyPct(rateRay: bigint): number {
  const apr = Number(rateRay) / Number(RAY);
  const apy = (1 + apr / THRESHOLDS.secondsPerYear) ** THRESHOLDS.secondsPerYear - 1;
  return apy * 100;
}

function rayToAprPct(rateRay: bigint): number {
  return (Number(rateRay) / Number(RAY)) * 100;
}

export class LendingVenueAdapter {
  readonly product: string;
  readonly venue: string;
  readonly access: VenueConfig['access'];
  private readonly pool: ethers.Contract;
  private dataProviderAddress: string;
  private oracle: PriceOracle;

  constructor(private readonly cfg: VenueConfig) {
    const provider = getProvider();
    this.product = cfg.product;
    this.venue = cfg.venue;
    this.access = cfg.access;
    this.pool = new ethers.Contract(cfg.pool, POOL_ABI, provider);
    this.dataProviderAddress = cfg.dataProvider;
    this.oracle = new PriceOracle(cfg.oracle);
  }

  getOracle(): PriceOracle {
    return this.oracle;
  }

  /**
   * Re-resolve oracle + data provider from the live ADDRESSES_PROVIDER and adopt
   * them if they differ from the hardcoded config. Never assume; verify.
   */
  async refreshResolvedAddresses(ctx?: ReadCtx): Promise<{ oracle: string; dataProvider: string }> {
    const ap = new ethers.Contract(this.cfg.addressesProvider, ADDRESSES_PROVIDER_ABI, getProvider());
    const overrides = ctx ? { blockTag: ctx.blockTag } : {};
    const [liveOracle, liveDp] = await Promise.all([
      withRetry(() => ap.getPriceOracle(overrides) as Promise<string>, `${this.product}.getPriceOracle`),
      withRetry(() => ap.getPoolDataProvider(overrides) as Promise<string>, `${this.product}.getPoolDataProvider`),
    ]);
    if (liveOracle && liveOracle.toLowerCase() !== this.cfg.oracle.toLowerCase()) {
      this.oracle = new PriceOracle(liveOracle);
    }
    if (liveDp && liveDp.toLowerCase() !== this.dataProviderAddress.toLowerCase()) {
      this.dataProviderAddress = liveDp;
    }
    return { oracle: this.oracle.oracleAddress, dataProvider: this.dataProviderAddress };
  }

  /** All reserves with rates, risk config, and available liquidity (batched via Multicall3). */
  async getReserves(ctx?: ReadCtx): Promise<ReserveInfo[]> {
    const dp = new ethers.Contract(this.dataProviderAddress, DATA_PROVIDER_ABI, getProvider());
    const overrides = ctx ? { blockTag: ctx.blockTag } : {};
    const tokens = (await withRetry(
      () => dp.getAllReservesTokens(overrides),
      `${this.product}.getAllReservesTokens`,
    )) as Array<{ symbol: string; tokenAddress: string }>;

    // Round 1: reserve data (pool) + configuration (data provider), one batch.
    const round1: Call3[] = [];
    for (const t of tokens) {
      round1.push({
        target: this.cfg.pool,
        allowFailure: false,
        callData: POOL_IFACE.encodeFunctionData('getReserveData', [t.tokenAddress]),
      });
      round1.push({
        target: this.dataProviderAddress,
        allowFailure: false,
        callData: DATA_PROVIDER_IFACE.encodeFunctionData('getReserveConfigurationData', [t.tokenAddress]),
      });
    }
    const r1 = await aggregate3(round1, ctx);

    // Round 2: available liquidity = underlying balanceOf(aToken), one batch.
    const decoded = tokens.map((t, i) => {
      const rd = POOL_IFACE.decodeFunctionResult('getReserveData', r1[i * 2]!.returnData)[0];
      const cfg = DATA_PROVIDER_IFACE.decodeFunctionResult('getReserveConfigurationData', r1[i * 2 + 1]!.returnData);
      return { token: t, rd, cfg };
    });
    const round2: Call3[] = decoded.map((d) => ({
      target: d.token.tokenAddress,
      allowFailure: true, // a non-standard token shouldn't sink the whole scan
      callData: ERC20_IFACE.encodeFunctionData('balanceOf', [d.rd.aTokenAddress as string]),
    }));
    const r2 = await aggregate3(round2, ctx);

    return decoded.map((d, i) => {
      const decimals = Number(d.cfg.decimals);
      let availableLiquidity = 0;
      const res = r2[i];
      if (res && res.success) {
        const bal = ERC20_IFACE.decodeFunctionResult('balanceOf', res.returnData)[0] as bigint;
        availableLiquidity = Number(ethers.formatUnits(bal, decimals));
      }
      return {
        symbol: d.token.symbol,
        address: d.token.tokenAddress,
        aTokenAddress: d.rd.aTokenAddress as string,
        decimals,
        supplyAprPct: rayToAprPct(d.rd.currentLiquidityRate as bigint),
        supplyApyPct: rayAprToApyPct(d.rd.currentLiquidityRate as bigint),
        variableBorrowAprPct: rayToAprPct(d.rd.currentVariableBorrowRate as bigint),
        ltvPct: Number(d.cfg.ltv) / 100,
        liquidationThresholdPct: Number(d.cfg.liquidationThreshold) / 100,
        isActive: Boolean(d.cfg.isActive),
        isFrozen: Boolean(d.cfg.isFrozen),
        availableLiquidity,
      };
    });
  }

  /** The wallet's supplied/borrowed amount per reserve (only non-zero ones), batched. */
  async getUserPositions(user: string, reserves: ReserveInfo[], ctx?: ReadCtx): Promise<UserReservePosition[]> {
    const calls: Call3[] = reserves.map((r) => ({
      target: this.dataProviderAddress,
      allowFailure: false,
      callData: DATA_PROVIDER_IFACE.encodeFunctionData('getUserReserveData', [r.address, user]),
    }));
    const results = await aggregate3(calls, ctx);

    const out: UserReservePosition[] = [];
    reserves.forEach((r, i) => {
      const d = DATA_PROVIDER_IFACE.decodeFunctionResult('getUserReserveData', results[i]!.returnData);
      const supplied = Number(ethers.formatUnits(d.currentATokenBalance as bigint, r.decimals));
      const debt =
        Number(ethers.formatUnits(d.currentStableDebt as bigint, r.decimals)) +
        Number(ethers.formatUnits(d.currentVariableDebt as bigint, r.decimals));
      if (supplied > 0 || debt > 0) {
        out.push({
          symbol: r.symbol,
          address: r.address,
          decimals: r.decimals,
          suppliedAmount: supplied,
          borrowedAmount: debt,
          supplyAprPct: r.supplyAprPct,
          liquidationThresholdPct: r.liquidationThresholdPct,
          usageAsCollateral: Boolean(d.usageAsCollateralEnabled),
          // Real on-demand withdrawability is bounded by what the pool actually holds.
          withdrawableNow: Math.min(supplied, r.availableLiquidity),
        });
      }
    });
    return out;
  }

  /** Aggregate account health (8-decimal USD base; HF in 1e18). */
  async getUserAccount(user: string, ctx?: ReadCtx): Promise<UserAccount> {
    const overrides = ctx ? { blockTag: ctx.blockTag } : {};
    const a = await withRetry(
      () => this.pool.getUserAccountData(user, overrides),
      `${this.product}.getUserAccountData`,
    );
    const hfRaw = a.healthFactor as bigint;
    return {
      totalCollateralUsd: Number(a.totalCollateralBase) / 1e8,
      totalDebtUsd: Number(a.totalDebtBase) / 1e8,
      ltvPct: Number(a.ltv) / 100,
      liquidationThresholdPct: Number(a.currentLiquidationThreshold) / 100,
      healthFactor: hfRaw >= MAX_UINT ? Number.POSITIVE_INFINITY : Number(ethers.formatUnits(hfRaw, 18)),
    };
  }
}

export function getLendingAdapters(): LendingVenueAdapter[] {
  return LENDING_VENUES.map((v) => new LendingVenueAdapter(v));
}
