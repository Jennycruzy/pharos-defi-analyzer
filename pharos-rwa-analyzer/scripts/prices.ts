/**
 * prices.ts — reads asset USD prices from an Aave-style oracle.
 *
 * Verified: OpenFi oracle getAssetPrice(USDC) = 99969492 with BASE_CURRENCY_UNIT
 * = 1e8, i.e. $0.999695. We confirm the base unit per oracle rather than assuming
 * 1e8, and convert to a plain USD number for downstream USD math.
 */

import { ethers } from 'ethers';
import { ORACLE_ABI } from './abi.js';
import { USD_BASE } from './config.js';
import { logRead, withRetry, type ReadCtx } from './multicall.js';
import { getProvider } from './rpc.js';

const ORACLE_IFACE = new ethers.Interface(ORACLE_ABI);
const SEL = {
  getAssetPrice: ORACLE_IFACE.getFunction('getAssetPrice')!.selector,
  baseCurrencyUnit: ORACLE_IFACE.getFunction('BASE_CURRENCY_UNIT')!.selector,
} as const;

export class PriceOracle {
  private readonly contract: ethers.Contract;
  private baseUnit: bigint | null = null;

  constructor(public readonly oracleAddress: string) {
    this.contract = new ethers.Contract(oracleAddress, ORACLE_ABI, getProvider());
  }

  /** Reads (and caches) the oracle's USD base unit; falls back to verified 1e8. */
  private async getBaseUnit(ctx?: ReadCtx): Promise<bigint> {
    if (this.baseUnit !== null) return this.baseUnit;
    const overrides = ctx ? { blockTag: ctx.blockTag } : {};
    logRead(ctx, this.oracleAddress, SEL.baseCurrencyUnit);
    try {
      const unit = (await this.contract.BASE_CURRENCY_UNIT(overrides)) as bigint;
      this.baseUnit = unit > 0n ? unit : USD_BASE;
    } catch {
      // Some oracles don't expose BASE_CURRENCY_UNIT; the verified Pharos value is 1e8.
      this.baseUnit = USD_BASE;
    }
    return this.baseUnit;
  }

  /** USD price of one whole token, as a JS number. Throws on revert (caller degrades). */
  async getUsdPrice(assetAddress: string, ctx?: ReadCtx): Promise<number> {
    const overrides = ctx ? { blockTag: ctx.blockTag } : {};
    logRead(ctx, this.oracleAddress, SEL.getAssetPrice);
    const [raw, base] = await Promise.all([
      withRetry(() => this.contract.getAssetPrice(assetAddress, overrides) as Promise<bigint>, 'oracle.getAssetPrice'),
      this.getBaseUnit(ctx),
    ]);
    // Keep precision: divide as floating after scaling, base is 1e8 so safe in double.
    return Number(raw) / Number(base);
  }
}
