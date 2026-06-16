/**
 * lending.ts — per-venue adapter for Aave-style lending (OpenFi & ZonaLend).
 *
 * We treat each venue independently: oracle and data-provider addresses are
 * RE-RESOLVED from the pool's own ADDRESSES_PROVIDER at runtime (so ZonaLend is
 * never assumed equal to OpenFi). Rates are decoded from the named struct field
 * `currentLiquidityRate` (ray, 1e27) and annualized to both APR and compounded APY.
 */

import { ethers } from 'ethers';
import { ADDRESSES_PROVIDER_ABI, DATA_PROVIDER_ABI, POOL_ABI } from './abi.js';
import { LENDING_VENUES, RAY, THRESHOLDS } from './config.js';
import { PriceOracle } from './prices.js';
import { getProvider } from './rpc.js';

type VenueConfig = (typeof LENDING_VENUES)[number];

export interface ReserveInfo {
  symbol: string;
  address: string;
  decimals: number;
  supplyAprPct: number; // linear annual rate from currentLiquidityRate
  supplyApyPct: number; // compounded equivalent
  variableBorrowAprPct: number;
  ltvPct: number;
  liquidationThresholdPct: number;
  isActive: boolean;
  isFrozen: boolean;
}

export interface UserReservePosition {
  symbol: string;
  address: string;
  decimals: number;
  suppliedAmount: number; // human units of underlying (aToken balance ~ underlying)
  borrowedAmount: number; // human units (stable + variable debt)
  supplyAprPct: number;
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
  private dataProvider: ethers.Contract;
  private oracle: PriceOracle;

  constructor(private readonly cfg: VenueConfig) {
    const provider = getProvider();
    this.product = cfg.product;
    this.venue = cfg.venue;
    this.access = cfg.access;
    this.pool = new ethers.Contract(cfg.pool, POOL_ABI, provider);
    this.dataProvider = new ethers.Contract(cfg.dataProvider, DATA_PROVIDER_ABI, provider);
    this.oracle = new PriceOracle(cfg.oracle);
  }

  getOracle(): PriceOracle {
    return this.oracle;
  }

  /**
   * Re-resolve oracle + data provider from the live ADDRESSES_PROVIDER and adopt
   * them if they differ from the hardcoded config. Never assume; verify.
   */
  async refreshResolvedAddresses(): Promise<{ oracle: string; dataProvider: string }> {
    const ap = new ethers.Contract(this.cfg.addressesProvider, ADDRESSES_PROVIDER_ABI, getProvider());
    const [liveOracle, liveDp] = await Promise.all([
      ap.getPriceOracle() as Promise<string>,
      ap.getPoolDataProvider() as Promise<string>,
    ]);
    if (liveOracle && liveOracle.toLowerCase() !== this.cfg.oracle.toLowerCase()) {
      this.oracle = new PriceOracle(liveOracle);
    }
    if (liveDp && liveDp.toLowerCase() !== this.cfg.dataProvider.toLowerCase()) {
      this.dataProvider = new ethers.Contract(liveDp, DATA_PROVIDER_ABI, getProvider());
    }
    return { oracle: this.oracle.oracleAddress, dataProvider: await this.dataProvider.getAddress() };
  }

  /** All reserves with their rates and risk config (Aave struct, named fields). */
  async getReserves(): Promise<ReserveInfo[]> {
    const tokens = (await this.dataProvider.getAllReservesTokens()) as Array<{
      symbol: string;
      tokenAddress: string;
    }>;
    const reserves: ReserveInfo[] = [];
    for (const t of tokens) {
      const [rd, cfg] = await Promise.all([
        this.pool.getReserveData(t.tokenAddress),
        this.dataProvider.getReserveConfigurationData(t.tokenAddress),
      ]);
      reserves.push({
        symbol: t.symbol,
        address: t.tokenAddress,
        decimals: Number(cfg.decimals),
        supplyAprPct: rayToAprPct(rd.currentLiquidityRate as bigint),
        supplyApyPct: rayAprToApyPct(rd.currentLiquidityRate as bigint),
        variableBorrowAprPct: rayToAprPct(rd.currentVariableBorrowRate as bigint),
        ltvPct: Number(cfg.ltv) / 100,
        liquidationThresholdPct: Number(cfg.liquidationThreshold) / 100,
        isActive: Boolean(cfg.isActive),
        isFrozen: Boolean(cfg.isFrozen),
      });
    }
    return reserves;
  }

  /** The wallet's supplied/borrowed amount per reserve (only non-zero ones). */
  async getUserPositions(user: string, reserves: ReserveInfo[]): Promise<UserReservePosition[]> {
    const out: UserReservePosition[] = [];
    for (const r of reserves) {
      const d = await this.dataProvider.getUserReserveData(r.address, user);
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
        });
      }
    }
    return out;
  }

  /** Aggregate account health (8-decimal USD base; HF in 1e18). */
  async getUserAccount(user: string): Promise<UserAccount> {
    const a = await this.pool.getUserAccountData(user);
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
