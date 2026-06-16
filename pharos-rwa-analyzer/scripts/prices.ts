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
import { getProvider } from './rpc.js';

export class PriceOracle {
  private readonly contract: ethers.Contract;
  private baseUnit: bigint | null = null;

  constructor(public readonly oracleAddress: string) {
    this.contract = new ethers.Contract(oracleAddress, ORACLE_ABI, getProvider());
  }

  /** Reads (and caches) the oracle's USD base unit; falls back to verified 1e8. */
  private async getBaseUnit(): Promise<bigint> {
    if (this.baseUnit !== null) return this.baseUnit;
    try {
      const unit = (await this.contract.BASE_CURRENCY_UNIT()) as bigint;
      this.baseUnit = unit > 0n ? unit : USD_BASE;
    } catch {
      // Some oracles don't expose BASE_CURRENCY_UNIT; the verified Pharos value is 1e8.
      this.baseUnit = USD_BASE;
    }
    return this.baseUnit;
  }

  /** USD price of one whole token, as a JS number. Throws on revert (caller degrades). */
  async getUsdPrice(assetAddress: string): Promise<number> {
    const [raw, base] = await Promise.all([
      this.contract.getAssetPrice(assetAddress) as Promise<bigint>,
      this.getBaseUnit(),
    ]);
    // Keep precision: divide as floating after scaling, base is 1e8 so safe in double.
    return Number(raw) / Number(base);
  }
}
