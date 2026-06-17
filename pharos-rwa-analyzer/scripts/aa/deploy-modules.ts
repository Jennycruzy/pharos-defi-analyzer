/**
 * aa/deploy-modules.ts — deploy the two missing Safe AA modules to Pharos at their
 * EXACT canonical addresses, deterministically.
 *
 * Pharos mainnet already has EntryPoint v0.7, the SafeProxyFactory, the Safe L2
 * singleton, MultiSendCallOnly and both deterministic-deployment factories. The
 * only gap for the actuator is Safe4337Module v0.3.0 and SafeModuleSetup v0.3.0.
 *
 * Because Safe deployed those two via the Arachnid Deterministic Deployment Proxy
 * (0x4e59…4956C) with a zero salt and a fixed creation code, replaying the SAME
 * creation code + salt through the SAME proxy reproduces the SAME CREATE2 address
 * on Pharos — so no config address ever changes. We capture that creation code in
 * scripts/aa/artifacts/*.json with full provenance (the byte-for-byte canonical
 * Ethereum-mainnet deployment), and this script re-derives the address and REFUSES
 * to broadcast unless it equals both the artifact's recorded canonical address and
 * the address the analyzer is configured to use.
 *
 * Honesty / safety rules (same spirit as the rest of the actuator):
 *   • Dry run by default — needs no key. It only reads chain state and asserts the
 *     deterministic math. Broadcasting requires --execute AND a funded deployer key
 *     in PHAROS_DEPLOYER_KEY (never passed as an argument).
 *   • Idempotent — if a module is already deployed it is skipped, and afterward we
 *     re-read eth_getCode and confirm the runtime is non-empty before claiming done.
 *   • Refuses on any mismatch: wrong predicted address, missing deploy proxy, or a
 *     configured address that does not equal the canonical one.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { AA } from '../config.js';
import { assertPharosNetwork, getProvider } from '../rpc.js';

const HERE = dirname(fileURLToPath(import.meta.url));

interface ModuleArtifact {
  contractName: string;
  version: string;
  canonicalAddress: string;
  factory: string;
  salt: string;
  constructorArgs: Record<string, string> | null;
  initCode: string;
  initCodeHash: string;
  source: string;
}

/** Each module the actuator needs, paired with the config address it must match. */
const MODULES: Array<{ file: string; configAddress: string }> = [
  { file: 'safe4337Module.v0.3.0.json', configAddress: AA.safe.module4337 },
  { file: 'safeModuleSetup.v0.3.0.json', configAddress: AA.safe.moduleSetup },
];

function loadArtifact(file: string): ModuleArtifact {
  const art = JSON.parse(readFileSync(join(HERE, 'artifacts', file), 'utf8')) as ModuleArtifact;
  // Re-derive the CREATE2 address from the raw init code; never trust the recorded
  // hash/address blindly.
  const computedHash = ethers.keccak256(art.initCode);
  if (computedHash.toLowerCase() !== art.initCodeHash.toLowerCase()) {
    throw new Error(`${art.contractName}: initCodeHash does not match initCode (artifact tampered?)`);
  }
  const predicted = ethers.getCreate2Address(art.factory, art.salt, computedHash);
  if (predicted.toLowerCase() !== art.canonicalAddress.toLowerCase()) {
    throw new Error(
      `${art.contractName}: CREATE2(${art.factory}, salt, initCode) = ${predicted} ` +
        `≠ recorded canonical ${art.canonicalAddress}. Refusing.`,
    );
  }
  return art;
}

export interface ModulePlan {
  contractName: string;
  canonicalAddress: string;
  configAddress: string;
  predicted: string;
  alreadyDeployed: boolean;
  matchesConfig: boolean;
}

export interface DeployReport {
  chainId: bigint;
  blockNumber: number;
  deployProxyPresent: boolean;
  modules: ModulePlan[];
  allDeployed: boolean;
}

/** Read-only: derive every address, check what is already on-chain. No key needed. */
export async function planDeployment(allowTestnet = false): Promise<DeployReport> {
  const net = await assertPharosNetwork(allowTestnet);
  const provider = getProvider();

  const proxyCode = await provider.getCode(AA.safe.deployProxy);
  const deployProxyPresent = proxyCode !== '0x';

  const modules: ModulePlan[] = [];
  for (const { file, configAddress } of MODULES) {
    const art = loadArtifact(file);
    const code = await provider.getCode(art.canonicalAddress);
    modules.push({
      contractName: art.contractName,
      canonicalAddress: art.canonicalAddress,
      configAddress,
      predicted: art.canonicalAddress, // already asserted equal in loadArtifact
      alreadyDeployed: code !== '0x',
      matchesConfig: ethers.getAddress(configAddress) === ethers.getAddress(art.canonicalAddress),
    });
  }
  return {
    chainId: net.chainId,
    blockNumber: net.blockNumber,
    deployProxyPresent,
    modules,
    allDeployed: modules.every((m) => m.alreadyDeployed),
  };
}

export interface DeployedModule extends ModulePlan {
  action: 'skipped-present' | 'deployed';
  txHash?: string;
  gasUsed?: string;
  runtimeBytes?: number;
}

/**
 * Broadcast the missing modules from a funded deployer EOA. Each tx is just
 * `salt ++ initCode` sent to the deterministic-deployment proxy, which CREATE2s
 * the contract. We estimate gas first (a revert here aborts before broadcast) and
 * re-read eth_getCode afterward to confirm the runtime landed.
 */
export async function executeDeployment(allowTestnet = false): Promise<DeployedModule[]> {
  const key = process.env.PHAROS_DEPLOYER_KEY?.trim();
  if (!key) {
    throw new Error(
      'PHAROS_DEPLOYER_KEY is not set. Add a funded deployer key to .env (native gas required); ' +
        'never pass a private key as a CLI argument.',
    );
  }
  const report = await planDeployment(allowTestnet);
  if (!report.deployProxyPresent) {
    throw new Error(
      `Deterministic-deployment proxy ${AA.safe.deployProxy} is not on this chain; ` +
        'cannot reproduce the canonical module addresses. Refusing.',
    );
  }
  for (const m of report.modules) {
    if (!m.matchesConfig) {
      throw new Error(`${m.contractName}: configured address ${m.configAddress} ≠ canonical ${m.canonicalAddress}.`);
    }
  }

  const wallet = new ethers.Wallet(key, getProvider());
  const results: DeployedModule[] = [];

  for (const { file } of MODULES) {
    const art = loadArtifact(file);
    const plan = report.modules.find((m) => m.contractName === art.contractName)!;

    if (plan.alreadyDeployed) {
      results.push({ ...plan, action: 'skipped-present' });
      continue;
    }

    // Arachnid proxy convention: calldata = 32-byte salt ++ init code.
    const data = ethers.concat([art.salt, art.initCode]);
    const txReq = { to: art.factory, data };
    // Estimate first: a revert means the deploy would fail, so we never broadcast it.
    await wallet.estimateGas(txReq);

    const tx = await wallet.sendTransaction(txReq);
    const receipt = await tx.wait();

    const code = await getProvider().getCode(art.canonicalAddress);
    if (code === '0x') {
      throw new Error(`${art.contractName}: tx ${tx.hash} mined but no code at ${art.canonicalAddress}.`);
    }
    results.push({
      ...plan,
      action: 'deployed',
      alreadyDeployed: true,
      txHash: tx.hash,
      gasUsed: receipt?.gasUsed?.toString(),
      runtimeBytes: (code.length - 2) / 2,
    });
  }
  return results;
}

/** CLI: `tsx scripts/aa/deploy-modules.ts [--execute] [--allow-testnet]`. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes('--execute');
  const allowTestnet = argv.includes('--allow-testnet');

  const report = await planDeployment(allowTestnet);
  console.log(`Pharos chain ${report.chainId} @ block ${report.blockNumber}`);
  console.log(
    `Deterministic-deployment proxy ${AA.safe.deployProxy}: ${report.deployProxyPresent ? 'present ✓' : 'MISSING ✗'}`,
  );
  for (const m of report.modules) {
    const cfg = m.matchesConfig ? 'config ✓' : 'CONFIG MISMATCH ✗';
    console.log(
      `  ${m.contractName.padEnd(16)} ${m.canonicalAddress}  ` +
        `${m.alreadyDeployed ? 'deployed ✓' : 'not deployed'}  (${cfg})`,
    );
  }

  if (report.allDeployed) {
    console.log('\nAll modules already present — the actuator infra is complete. Nothing to do.');
    return;
  }
  if (!execute) {
    console.log(
      '\nDRY RUN. Re-run with --execute and a funded PHAROS_DEPLOYER_KEY in .env to deploy the missing modules\n' +
        'to the exact canonical addresses above (deterministic CREATE2, no config change).',
    );
    return;
  }

  console.log('\nDeploying missing modules…');
  const results = await executeDeployment(allowTestnet);
  for (const r of results) {
    if (r.action === 'skipped-present') {
      console.log(`  ${r.contractName.padEnd(16)} already present — skipped`);
    } else {
      console.log(
        `  ${r.contractName.padEnd(16)} deployed at ${r.canonicalAddress} ` +
          `(${r.runtimeBytes} bytes) tx ${r.txHash} gas ${r.gasUsed}`,
      );
    }
  }
  console.log('\nDone. Re-run `npm run act -- <intent>` to dry-run an action against the now-complete infra.');
}

// Only run as a script, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
