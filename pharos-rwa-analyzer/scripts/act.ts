/**
 * act.ts — shared actuator runner for CLI and MCP.
 *
 * Dry-run mode needs only an owner address. Simulate/execute require
 * PHAROS_SIGNER_KEY locally; the key is never accepted as an argument.
 */

import { ethers } from 'ethers';
import { DEFAULT_ADDRESS, SIGNER_KEY_ENV } from './config.js';
import { collectWalletScan } from './collect.js';
import { SafeAccount } from './aa/safe.js';
import type { InfraStatus } from './aa/safe.js';
import { buildUserOp, crossCheckDigest, safeOpDigest, send, signUserOp, simulate, userOpHash } from './aa/userop.js';
import { getProvider } from './rpc.js';
import { buildIntentPlan, type GuardOptions, type IntentRequest, type PlannedAction } from './plan.js';

export type ActMode = 'dry-run' | 'simulate' | 'execute';

export interface ActuatorRequest extends GuardOptions {
  intent: IntentRequest;
  owner?: string;
  ownerExplicit?: boolean;
  allowTestnet?: boolean;
  mode?: ActMode;
}

export interface ActuatorResult {
  owner: string;
  safe: string;
  safeDeployed: boolean;
  mode: ActMode | 'simulated' | 'executed';
  plan: PlannedAction;
  userOpHash: string;
  gasEstimate?: bigint | null;
  digestCheck?: Awaited<ReturnType<typeof crossCheckDigest>>;
  transaction?: Awaited<ReturnType<typeof send>>;
  infra: InfraStatus;
}

function signerEnvTemplate(): string {
  return [
    '# Add this to pharos-rwa-analyzer/.env and retry the same simulate/execute request.',
    'PHAROS_SIGNER_KEY=',
    '# optional if you use a private ERC-4337 bundler; otherwise self-bundling is used',
    'PHAROS_BUNDLER_URL=',
  ].join('\n');
}

export function missingSignerEnvMessage(mode: ActMode): string {
  return [
    `${SIGNER_KEY_ENV} is required for ${mode} but is not set in the local environment.`,
    'Never pass a private key in chat or as a tool argument.',
    '',
    'Create or update `pharos-rwa-analyzer/.env` with:',
    '```dotenv',
    signerEnvTemplate(),
    '```',
    '',
    `Then retry the same ${mode} request.`,
  ].join('\n');
}

export async function runActuator(req: ActuatorRequest): Promise<ActuatorResult> {
  const mode = req.mode ?? 'dry-run';
  const needsSigner = mode === 'simulate' || mode === 'execute';
  const signer = loadSigner(needsSigner ? mode : null);
  const owner = signer && !req.ownerExplicit ? await signer.getAddress() : req.owner ?? DEFAULT_ADDRESS;
  if (!ethers.isAddress(owner)) throw new Error(`Invalid owner address: ${owner}`);
  if (signer && ethers.getAddress(await signer.getAddress()) !== ethers.getAddress(owner)) {
    throw new Error(`PHAROS_SIGNER_KEY address does not match owner ${owner}. Pass owner with the signer address.`);
  }

  const safe = new SafeAccount(owner);
  const infra = await safe.verifyInfra();
  if (!infra.allPresent && mode !== 'dry-run') {
    throw new Error(`Missing AA infrastructure on this chain: ${infra.missing.join(', ')}`);
  }

  const safeAddress = await safe.predictAddress();
  const scan = await collectWalletScan(safeAddress, req.allowTestnet ?? false);
  const plan = await buildIntentPlan(scan, safeAddress, req.intent, {
    maxSpendUsd: req.maxSpendUsd,
    minHealthFactor: req.minHealthFactor,
  });
  const safeDeployed = await safe.isDeployed();
  const unsigned = await buildUserOp(safe, safe.encodeCallData(plan.metaTxs));

  if (mode === 'dry-run') {
    return {
      owner: ethers.getAddress(owner),
      safe: safeAddress,
      safeDeployed,
      mode,
      plan,
      userOpHash: await userOpHash(unsigned),
      infra,
    };
  }

  if (!signer) throw new Error(`${SIGNER_KEY_ENV} is required for ${mode}.`);
  const digest = safeOpDigest(unsigned, scan.network.chainId);
  const digestCheck = await crossCheckDigest(unsigned, digest);
  if ('matches' in digestCheck && !digestCheck.matches) {
    throw new Error(`SafeOp digest mismatch. local=${digest} onChain=${digestCheck.onChain}`);
  }

  const signed = await signUserOp(unsigned, signer, scan.network.chainId);
  const simulation = await simulate(signed, signer);
  if (!simulation.ok) throw new Error(`Simulation reverted: ${simulation.revertReason ?? 'unknown reason'}`);

  if (mode === 'simulate') {
    return {
      owner: ethers.getAddress(owner),
      safe: safeAddress,
      safeDeployed,
      mode: 'simulated',
      plan,
      userOpHash: await userOpHash(signed),
      gasEstimate: simulation.gasEstimate,
      digestCheck,
      infra,
    };
  }

  const transaction = await send(signed, signer);
  return {
    owner: ethers.getAddress(owner),
    safe: safeAddress,
    safeDeployed,
    mode: 'executed',
    plan,
    userOpHash: transaction.userOpHash,
    gasEstimate: simulation.gasEstimate,
    transaction,
    infra,
  };
}

function loadSigner(requiredMode: ActMode | null): ethers.Wallet | null {
  const key = process.env[SIGNER_KEY_ENV]?.trim();
  if (!key) {
    if (requiredMode) throw new Error(missingSignerEnvMessage(requiredMode));
    return null;
  }
  return new ethers.Wallet(key, getProvider());
}
