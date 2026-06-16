/**
 * rpc.ts — the single Pharos provider, with a hard chain-id sanity gate.
 *
 * HARD RULE #0: mainnet (1672) only. We refuse to produce results on any other
 * network unless the caller explicitly opts into the 688688 testnet toggle.
 */

import { ethers } from 'ethers';
import { PHAROS } from './config.js';

let cached: ethers.JsonRpcProvider | null = null;

/** Returns a singleton provider. staticNetwork avoids a redundant chainId probe per call. */
export function getProvider(): ethers.JsonRpcProvider {
  if (cached) return cached;
  cached = new ethers.JsonRpcProvider(PHAROS.rpcUrl, undefined, { staticNetwork: true });
  return cached;
}

export interface NetworkCheck {
  chainId: bigint;
  blockNumber: number;
  isMainnet: boolean;
  rpcUrl: string;
}

/**
 * Verifies the RPC actually answers and is on Pharos mainnet (1672).
 * Throws unless mainnet, or testnet (688688) when `allowTestnet` is true.
 */
export async function assertPharosNetwork(allowTestnet = false): Promise<NetworkCheck> {
  const provider = getProvider();
  let net: ethers.Network;
  let blockNumber: number;
  try {
    [net, blockNumber] = await Promise.all([provider.getNetwork(), provider.getBlockNumber()]);
  } catch (err) {
    throw new Error(
      `Could not reach Pharos RPC at ${PHAROS.rpcUrl}. ` +
        `Set PHAROS_RPC_URL to a working mainnet endpoint. Underlying error: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }

  const isMainnet = net.chainId === PHAROS.mainnetChainId;
  const isTestnet = net.chainId === PHAROS.testnetChainId;

  if (!isMainnet && !(allowTestnet && isTestnet)) {
    throw new Error(
      `Refusing to run: connected chain id is ${net.chainId}, expected Pharos mainnet ` +
        `${PHAROS.mainnetChainId}. (Pass --allow-testnet only for the ${PHAROS.testnetChainId} convenience toggle.)`,
    );
  }

  return { chainId: net.chainId, blockNumber, isMainnet, rpcUrl: PHAROS.rpcUrl };
}
