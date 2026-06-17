/**
 * aa/safe.ts — the ERC-4337 smart account (Safe v1.4.1 + Safe4337Module v0.3.0).
 *
 * The provided key is only the OWNER of this Safe; the Safe holds the funds and
 * executes the DeFi calls. This module computes the Safe's counterfactual address,
 * builds the deploy-on-first-use `initCode`, and encodes the UserOp `callData` that
 * drives one action or an atomic batch.
 *
 * Honesty rule (same as the read side): we NEVER assume the Safe infrastructure is
 * present on Pharos — `verifyInfra()` reads eth_getCode for every required contract
 * and the actuator refuses to act if any is missing. The Safe proxy creation code
 * is READ LIVE from the factory (not hardcoded), so the address derivation is exact.
 */

import { ethers } from 'ethers';
import {
  MULTISEND_CALL_ONLY_ABI,
  SAFE_4337_MODULE_ABI,
  SAFE_ABI,
  SAFE_MODULE_SETUP_ABI,
  SAFE_PROXY_FACTORY_ABI,
} from '../abi.js';
import { AA } from '../config.js';
import { logRead, withRetry, type ReadCtx } from '../multicall.js';
import { getProvider } from '../rpc.js';

const FACTORY_IFACE = new ethers.Interface(SAFE_PROXY_FACTORY_ABI);
const SAFE_IFACE = new ethers.Interface(SAFE_ABI);
const MODULE_SETUP_IFACE = new ethers.Interface(SAFE_MODULE_SETUP_ABI);
const MODULE_IFACE = new ethers.Interface(SAFE_4337_MODULE_ABI);
const MULTISEND_IFACE = new ethers.Interface(MULTISEND_CALL_ONLY_ABI);

/** A single CALL the Safe will execute. `value` is native wei (0 for ERC-20/DeFi calls). */
export interface MetaTx {
  to: string;
  value: bigint;
  data: string;
  /** Human label for the plan output (e.g. "approve 100 USDC to OpenFi pool"). */
  label: string;
}

/** Which canonical AA contracts are present (or not) on the connected chain. */
export interface InfraStatus {
  allPresent: boolean;
  contracts: Array<{ name: string; address: string; deployed: boolean }>;
  missing: string[];
}

export class SafeAccount {
  readonly owner: string;
  private creationCodeCache: string | null = null;

  constructor(owner: string) {
    this.owner = ethers.getAddress(owner);
  }

  /** setup() initializer: 1-of-1 owner, module enabled + set as fallback handler. */
  buildInitializer(): string {
    const enableModules = MODULE_SETUP_IFACE.encodeFunctionData('enableModules', [[AA.safe.module4337]]);
    return SAFE_IFACE.encodeFunctionData('setup', [
      [this.owner], // _owners
      1n, //           _threshold
      AA.safe.moduleSetup, // to  (delegatecalled during setup)
      enableModules, //      data (enable the 4337 module)
      AA.safe.module4337, // fallbackHandler (routes validateUserOp/executeUserOp)
      ethers.ZeroAddress, // paymentToken
      0n, //                payment
      ethers.ZeroAddress, // paymentReceiver
    ]);
  }

  /** The factory's proxy creation code, read live once (no hardcoded bytecode). */
  async proxyCreationCode(ctx?: ReadCtx): Promise<string> {
    if (this.creationCodeCache) return this.creationCodeCache;
    const factory = new ethers.Contract(AA.safe.proxyFactory, SAFE_PROXY_FACTORY_ABI, getProvider());
    logRead(ctx, AA.safe.proxyFactory, FACTORY_IFACE.getFunction('proxyCreationCode')!.selector);
    const code = (await withRetry(
      () => factory.proxyCreationCode() as Promise<string>,
      'safe.proxyCreationCode',
    )) as string;
    this.creationCodeCache = code;
    return code;
  }

  /**
   * The CREATE2 address the Safe will live at — exactly what
   * SafeProxyFactory.createProxyWithNonce(singleton, initializer, saltNonce) yields:
   *   salt = keccak256(keccak256(initializer) ++ saltNonce)
   *   addr = CREATE2(factory, salt, keccak256(proxyCreationCode ++ singleton))
   */
  async predictAddress(ctx?: ReadCtx): Promise<string> {
    const initializer = this.buildInitializer();
    const salt = ethers.keccak256(
      ethers.solidityPacked(['bytes32', 'uint256'], [ethers.keccak256(initializer), AA.saltNonce]),
    );
    const creationCode = await this.proxyCreationCode(ctx);
    const deploymentData = ethers.solidityPacked(
      ['bytes', 'uint256'],
      [creationCode, BigInt(AA.safe.singleton)],
    );
    return ethers.getCreate2Address(AA.safe.proxyFactory, salt, ethers.keccak256(deploymentData));
  }

  /** UserOp.initCode = factory ++ createProxyWithNonce(...). Empty once deployed. */
  buildInitCode(): string {
    const data = FACTORY_IFACE.encodeFunctionData('createProxyWithNonce', [
      AA.safe.singleton,
      this.buildInitializer(),
      AA.saltNonce,
    ]);
    return ethers.concat([AA.safe.proxyFactory, data]);
  }

  /** True once the Safe proxy exists on-chain (so the next UserOp omits initCode). */
  async isDeployed(ctx?: ReadCtx): Promise<boolean> {
    const addr = await this.predictAddress(ctx);
    const code = await withRetry(() => getProvider().getCode(addr), 'safe.getCode');
    return code !== '0x';
  }

  /**
   * Encode the UserOp `callData`: one CALL via executeUserOp, or an atomic batch
   * via a delegatecall to MultiSendCallOnly (operation = 1). MultiSendCallOnly can
   * only CALL (never delegatecall) the inner txs, so a batch can't be tricked into
   * delegatecalling a malicious target — a deliberate safety choice.
   */
  encodeCallData(metaTxs: MetaTx[]): string {
    if (metaTxs.length === 0) throw new Error('encodeCallData: no meta-transactions');
    if (metaTxs.length === 1) {
      const tx = metaTxs[0]!;
      return MODULE_IFACE.encodeFunctionData('executeUserOp', [tx.to, tx.value, tx.data, 0]);
    }
    const packed = ethers.concat(
      metaTxs.map((tx) =>
        ethers.solidityPacked(
          ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
          [0, tx.to, tx.value, ethers.dataLength(tx.data), tx.data], // 0 = CALL
        ),
      ),
    );
    const multiSend = MULTISEND_IFACE.encodeFunctionData('multiSend', [packed]);
    return MODULE_IFACE.encodeFunctionData('executeUserOp', [
      AA.safe.multiSendCallOnly,
      0n,
      multiSend,
      1, // 1 = DELEGATECALL into MultiSendCallOnly
    ]);
  }

  /** eth_getCode every required AA contract; the actuator refuses if any is missing. */
  async verifyInfra(): Promise<InfraStatus> {
    const required: Array<{ name: string; address: string }> = [
      { name: 'EntryPoint v0.7', address: AA.entryPoint },
      { name: 'SafeProxyFactory', address: AA.safe.proxyFactory },
      { name: 'Safe singleton (L2)', address: AA.safe.singleton },
      { name: 'Safe4337Module', address: AA.safe.module4337 },
      { name: 'SafeModuleSetup', address: AA.safe.moduleSetup },
      { name: 'MultiSendCallOnly', address: AA.safe.multiSendCallOnly },
    ];
    const provider = getProvider();
    const contracts = await Promise.all(
      required.map(async (c) => {
        const code = await withRetry(() => provider.getCode(c.address), `getCode ${c.name}`);
        return { name: c.name, address: c.address, deployed: code !== '0x' };
      }),
    );
    const missing = contracts.filter((c) => !c.deployed).map((c) => c.name);
    return { allPresent: missing.length === 0, contracts, missing };
  }
}
