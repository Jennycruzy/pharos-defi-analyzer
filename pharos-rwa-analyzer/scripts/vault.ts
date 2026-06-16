/**
 * vault.ts — Tulipa Multi-RWA vault reads (ERC-4626, confirmed on mainnet).
 *
 * Share price = convertToAssets(1 whole share). Verified live: decimals 6,
 * asset = USDC, share price 1.000000. Redemption capacity = maxWithdraw /
 * maxRedeem. All reads; the analyzer never deposits or redeems.
 */

import { ethers } from 'ethers';
import { ERC4626_ABI } from './abi.js';
import { TULIPA } from './config.js';
import { logRead, type ReadCtx } from './multicall.js';
import { getProvider } from './rpc.js';

const VAULT_IFACE = new ethers.Interface(ERC4626_ABI);
const sel = (name: string): string => VAULT_IFACE.getFunction(name)!.selector;
const INFO_SELECTORS = ['name', 'symbol', 'decimals', 'asset', 'convertToAssets', 'totalAssets', 'totalSupply'].map(sel);
const POSITION_SELECTORS = ['balanceOf', 'maxWithdraw', 'maxRedeem'].map(sel);

export interface VaultInfo {
  product: string;
  venue: string;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  assetAddress: string;
  /** Underlying-asset value of ONE whole share (e.g. 1.0 USDC per tulPRWA share). */
  sharePrice: number;
  totalAssets: number;
  totalSupply: number;
}

export interface VaultPosition {
  shares: number; // human units of the share token
  redeemableAssets: number; // maxWithdraw in underlying units
  maxRedeemShares: number; // maxRedeem in share units
  /** True when the wallet can withdraw its full share-implied value right now. */
  fullyLiquid: boolean;
}

export class TulipaVault {
  private readonly c: ethers.Contract;
  constructor(public readonly address: string = TULIPA.address) {
    this.c = new ethers.Contract(this.address, ERC4626_ABI, getProvider());
  }

  /** Confirms ERC-4626 by reading asset(); returns null if the vault isn't 4626. */
  async getInfo(ctx?: ReadCtx): Promise<VaultInfo | null> {
    const overrides = ctx ? { blockTag: ctx.blockTag } : {};
    for (const s of INFO_SELECTORS) logRead(ctx, this.address, s);
    try {
      const [name, symbol, decimalsRaw, assetAddress] = await Promise.all([
        this.c.name(overrides) as Promise<string>,
        this.c.symbol(overrides) as Promise<string>,
        this.c.decimals(overrides) as Promise<bigint>,
        this.c.asset(overrides) as Promise<string>,
      ]);
      const decimals = Number(decimalsRaw);
      const oneShare = 10n ** BigInt(decimals);
      const [assetsPerShare, totalAssetsRaw, totalSupplyRaw] = await Promise.all([
        this.c.convertToAssets(oneShare, overrides) as Promise<bigint>,
        this.c.totalAssets(overrides) as Promise<bigint>,
        this.c.totalSupply(overrides) as Promise<bigint>,
      ]);
      return {
        product: TULIPA.product,
        venue: TULIPA.venue,
        address: this.address,
        name,
        symbol,
        decimals,
        assetAddress,
        // asset and share share the same decimals here (both 6); format by decimals.
        sharePrice: Number(ethers.formatUnits(assetsPerShare, decimals)),
        totalAssets: Number(ethers.formatUnits(totalAssetsRaw, decimals)),
        totalSupply: Number(ethers.formatUnits(totalSupplyRaw, decimals)),
      };
    } catch {
      return null; // Not ERC-4626 / revert — caller degrades gracefully.
    }
  }

  /** The wallet's vault position and redemption capacity. */
  async getPosition(user: string, info: VaultInfo, ctx?: ReadCtx): Promise<VaultPosition> {
    const overrides = ctx ? { blockTag: ctx.blockTag } : {};
    for (const s of POSITION_SELECTORS) logRead(ctx, this.address, s);
    const [sharesRaw, maxWithdrawRaw, maxRedeemRaw] = await Promise.all([
      this.c.balanceOf(user, overrides) as Promise<bigint>,
      this.c.maxWithdraw(user, overrides) as Promise<bigint>,
      this.c.maxRedeem(user, overrides) as Promise<bigint>,
    ]);
    const shares = Number(ethers.formatUnits(sharesRaw, info.decimals));
    const redeemableAssets = Number(ethers.formatUnits(maxWithdrawRaw, info.decimals));
    const maxRedeemShares = Number(ethers.formatUnits(maxRedeemRaw, info.decimals));
    // Fully liquid if you can redeem essentially all your shares right now.
    const fullyLiquid = shares === 0 || maxRedeemShares >= shares - 1e-9;
    return { shares, redeemableAssets, maxRedeemShares, fullyLiquid };
  }
}
