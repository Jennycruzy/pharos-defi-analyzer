/**
 * incentives.ts — reads on-chain reward emissions for an Aave-style aToken.
 *
 * Why this exists: products like ZonaLend advertise very high totals (~210%) that
 * are mostly *incentives*, not base interest. This module checks the venue's
 * on-chain RewardsController to report — as a VERIFIED [on-chain] fact — whether
 * any reward streams are actually active for a given supply aToken.
 *
 * Verified on mainnet (2026-06-16): both OpenFi (controller 0x74C0…F67d) and
 * ZonaLend (controller 0xA9F4…A80C) are deployed but return an EMPTY rewards list
 * for the USDC aToken — i.e. no active on-chain emissions. So the advertised total
 * does NOT originate from an on-chain RewardsController emission we can verify.
 */

import { ethers } from 'ethers';
import { ATOKEN_ABI, REWARDS_CONTROLLER_ABI } from './abi.js';
import { withRetry, type ReadCtx } from './multicall.js';
import { getProvider } from './rpc.js';

const ZERO = '0x0000000000000000000000000000000000000000';

export interface RewardStream {
  rewardToken: string;
  emissionPerSecond: string; // raw, as string (token-decimals unknown without extra reads)
  distributionEnd: number; // unix seconds
  active: boolean; // distributionEnd in the future and emission > 0
}

export interface IncentiveInfo {
  /** RewardsController address, or null if the aToken exposes none. */
  controller: string | null;
  rewardStreams: RewardStream[];
  /** True only if at least one stream is currently emitting. */
  hasActiveRewards: boolean;
  note: string;
}

/** Reads the incentive configuration for one aToken. Never throws — degrades to null controller. */
export async function readIncentives(
  aTokenAddress: string,
  nowSeconds: number,
  ctx?: ReadCtx,
): Promise<IncentiveInfo> {
  const provider = getProvider();
  const aToken = new ethers.Contract(aTokenAddress, ATOKEN_ABI, provider);
  const overrides = ctx ? { blockTag: ctx.blockTag } : {};

  let controller: string;
  try {
    controller = (await withRetry(
      () => aToken.getIncentivesController(overrides) as Promise<string>,
      'aToken.getIncentivesController',
    )) as string;
  } catch {
    return {
      controller: null,
      rewardStreams: [],
      hasActiveRewards: false,
      note: 'aToken exposes no incentives controller (no on-chain rewards possible here).',
    };
  }
  if (!controller || controller === ZERO) {
    return {
      controller: null,
      rewardStreams: [],
      hasActiveRewards: false,
      note: 'No incentives controller set — no on-chain reward emissions.',
    };
  }

  const rc = new ethers.Contract(controller, REWARDS_CONTROLLER_ABI, provider);
  let rewardTokens: string[];
  try {
    rewardTokens = (await rc.getRewardsByAsset(aTokenAddress, overrides)) as string[];
  } catch {
    return {
      controller,
      rewardStreams: [],
      hasActiveRewards: false,
      note: `Incentives controller ${controller} present but rewards list unreadable.`,
    };
  }

  const streams: RewardStream[] = [];
  for (const reward of rewardTokens) {
    try {
      const data = await rc.getRewardsData(aTokenAddress, reward, overrides);
      const emission = data.emissionPerSecond as bigint;
      const end = Number(data.distributionEnd as bigint);
      streams.push({
        rewardToken: reward,
        emissionPerSecond: emission.toString(),
        distributionEnd: end,
        active: emission > 0n && end > nowSeconds,
      });
    } catch {
      streams.push({ rewardToken: reward, emissionPerSecond: '0', distributionEnd: 0, active: false });
    }
  }

  const hasActiveRewards = streams.some((s) => s.active);
  const note = hasActiveRewards
    ? `${streams.filter((s) => s.active).length} active on-chain reward stream(s) via controller ${controller}.`
    : `Incentives controller ${controller} is deployed but lists 0 active reward streams for this aToken — ` +
      `any advertised "bonus" APY is NOT an on-chain emission we can verify.`;

  return { controller, rewardStreams: streams, hasActiveRewards, note };
}
