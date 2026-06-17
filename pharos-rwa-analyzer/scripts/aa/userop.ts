/**
 * aa/userop.ts — build, sign, simulate and submit an ERC-4337 v0.7 UserOperation.
 *
 * Signing path (Safe4337Module v0.3.0): the owner key signs the EIP-712 `SafeOp`
 * digest whose domain is { chainId, verifyingContract: Safe4337Module }. The packed
 * Safe signature is `validAfter(6) ++ validUntil(6) ++ ownerECDSA(65)`.
 *
 * Two safety nets before anything is sent:
 *   1) we cross-check our locally-computed SafeOp digest against the module's
 *      on-chain `getOperationHash` (catches any encoding/typehash drift), and
 *   2) we SIMULATE via `eth_estimateGas` on `handleOps` — which runs the real
 *      validateUserOp (signature check) AND the execution against live state — and
 *      refuse to broadcast if it would revert.
 *
 * Default transport is self-bundling: the signer EOA calls EntryPoint.handleOps
 * directly (Pharos has no public bundler). A standards bundler is used iff
 * PHAROS_BUNDLER_URL is set.
 */

import { ethers } from 'ethers';
import { ENTRYPOINT_V07_ABI, SAFE_4337_MODULE_ABI } from '../abi.js';
import { AA } from '../config.js';
import { getProvider } from '../rpc.js';
import type { SafeAccount } from './safe.js';

/** ERC-4337 v0.7 packed UserOperation. */
export interface PackedUserOperation {
  sender: string;
  nonce: bigint;
  initCode: string;
  callData: string;
  accountGasLimits: string; // bytes32: verificationGasLimit(16) ++ callGasLimit(16)
  preVerificationGas: bigint;
  gasFees: string; // bytes32: maxPriorityFeePerGas(16) ++ maxFeePerGas(16)
  paymasterAndData: string;
  signature: string;
}

export interface GasOverrides {
  verificationGasLimit?: bigint;
  callGasLimit?: bigint;
  preVerificationGas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

const DEFAULT_GAS = {
  verificationGasLimitDeployed: 250_000n,
  verificationGasLimitWithDeploy: 1_000_000n, // Safe proxy deploy + module enable is heavy
  callGasLimit: 800_000n, // generous: covers an approve+supply / withdraw+supply batch
  preVerificationGas: 120_000n,
  fallbackFeeWei: ethers.parseUnits('1', 'gwei'),
} as const;

/** Pack two uint128 into a bytes32 (high ++ low), the v0.7 layout. */
function packUint128Pair(high: bigint, low: bigint): string {
  return ethers.solidityPacked(['uint128', 'uint128'], [high, low]);
}

/** Split a bytes32 into its two uint128 halves (high, low). */
function unpackUint128Pair(packed: string): { high: bigint; low: bigint } {
  const hex = packed.startsWith('0x') ? packed.slice(2) : packed;
  return { high: BigInt('0x' + hex.slice(0, 32)), low: BigInt('0x' + hex.slice(32, 64)) };
}

/** Build an unsigned UserOp for the given Safe + callData (adds initCode if undeployed). */
export async function buildUserOp(
  safe: SafeAccount,
  callData: string,
  overrides: GasOverrides = {},
): Promise<PackedUserOperation> {
  const provider = getProvider();
  const sender = await safe.predictAddress();
  const deployed = await safe.isDeployed();
  const initCode = deployed ? '0x' : safe.buildInitCode();

  const entryPoint = new ethers.Contract(AA.entryPoint, ENTRYPOINT_V07_ABI, provider);
  const nonce = (await entryPoint.getNonce(sender, 0n)) as bigint;

  const feeData = await provider.getFeeData();
  const maxFeePerGas =
    overrides.maxFeePerGas ?? feeData.maxFeePerGas ?? feeData.gasPrice ?? DEFAULT_GAS.fallbackFeeWei;
  const maxPriorityFeePerGas =
    overrides.maxPriorityFeePerGas ?? feeData.maxPriorityFeePerGas ?? maxFeePerGas;

  const verificationGasLimit =
    overrides.verificationGasLimit ??
    (deployed ? DEFAULT_GAS.verificationGasLimitDeployed : DEFAULT_GAS.verificationGasLimitWithDeploy);
  const callGasLimit = overrides.callGasLimit ?? DEFAULT_GAS.callGasLimit;
  const preVerificationGas = overrides.preVerificationGas ?? DEFAULT_GAS.preVerificationGas;

  return {
    sender,
    nonce,
    initCode,
    callData,
    accountGasLimits: packUint128Pair(verificationGasLimit, callGasLimit),
    preVerificationGas,
    gasFees: packUint128Pair(maxPriorityFeePerGas, maxFeePerGas),
    paymasterAndData: '0x',
    signature: '0x',
  };
}

/** The EIP-712 SafeOp digest the owner must sign (Safe4337Module domain). */
export function safeOpDigest(op: PackedUserOperation, chainId: bigint): string {
  const { high: verificationGasLimit, low: callGasLimit } = unpackUint128Pair(op.accountGasLimits);
  const { high: maxPriorityFeePerGas, low: maxFeePerGas } = unpackUint128Pair(op.gasFees);

  const domain = { chainId, verifyingContract: AA.safe.module4337 };
  const types = {
    SafeOp: [
      { name: 'safe', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'initCode', type: 'bytes' },
      { name: 'callData', type: 'bytes' },
      { name: 'verificationGasLimit', type: 'uint128' },
      { name: 'callGasLimit', type: 'uint128' },
      { name: 'preVerificationGas', type: 'uint256' },
      { name: 'maxPriorityFeePerGas', type: 'uint128' },
      { name: 'maxFeePerGas', type: 'uint128' },
      { name: 'paymasterAndData', type: 'bytes' },
      { name: 'validAfter', type: 'uint48' },
      { name: 'validUntil', type: 'uint48' },
      { name: 'entryPoint', type: 'address' },
    ],
  };
  const value = {
    safe: op.sender,
    nonce: op.nonce,
    initCode: op.initCode,
    callData: op.callData,
    verificationGasLimit,
    callGasLimit,
    preVerificationGas: op.preVerificationGas,
    maxPriorityFeePerGas,
    maxFeePerGas,
    paymasterAndData: op.paymasterAndData,
    validAfter: 0,
    validUntil: 0,
    entryPoint: AA.entryPoint,
  };
  return ethers.TypedDataEncoder.hash(domain, types, value);
}

/**
 * Cross-check our local SafeOp digest against the module's on-chain getOperationHash.
 * Returns `{ matches, onChain }`, or `{ skipped }` if the module can't be queried
 * (e.g. not deployed). A definite MISMATCH must abort signing upstream.
 */
export async function crossCheckDigest(
  op: PackedUserOperation,
  localDigest: string,
): Promise<{ matches: boolean; onChain: string } | { skipped: string }> {
  try {
    const module = new ethers.Contract(AA.safe.module4337, SAFE_4337_MODULE_ABI, getProvider());
    // getOperationHash parses validAfter/validUntil from the first 12 sig bytes.
    const probe = { ...op, signature: ethers.solidityPacked(['uint48', 'uint48'], [0, 0]) };
    const onChain = (await module.getOperationHash(toTuple(probe))) as string;
    return { matches: onChain.toLowerCase() === localDigest.toLowerCase(), onChain };
  } catch (err) {
    return { skipped: err instanceof Error ? err.message : String(err) };
  }
}

/** Sign the UserOp with the owner key and return a new op carrying the packed signature. */
export async function signUserOp(
  op: PackedUserOperation,
  signer: ethers.Wallet,
  chainId: bigint,
): Promise<PackedUserOperation> {
  const digest = safeOpDigest(op, chainId);
  // Raw ECDSA over the 32-byte digest (NOT personal_sign): v stays 27/28 so the
  // Safe takes the ecrecover path on the EIP-712 hash directly.
  const sig = signer.signingKey.sign(digest);
  const packed = ethers.solidityPacked(['uint48', 'uint48', 'bytes'], [0, 0, sig.serialized]);
  return { ...op, signature: packed };
}

/** Ordered tuple for ethers (handleOps / getUserOpHash / getOperationHash). */
export function toTuple(op: PackedUserOperation): unknown[] {
  return [
    op.sender,
    op.nonce,
    op.initCode,
    op.callData,
    op.accountGasLimits,
    op.preVerificationGas,
    op.gasFees,
    op.paymasterAndData,
    op.signature,
  ];
}

/** Compute the EntryPoint userOpHash (on-chain) for receipts/proof. */
export async function userOpHash(op: PackedUserOperation): Promise<string> {
  const entryPoint = new ethers.Contract(AA.entryPoint, ENTRYPOINT_V07_ABI, getProvider());
  return (await entryPoint.getUserOpHash(toTuple(op))) as string;
}

export interface SimulationResult {
  ok: boolean;
  gasEstimate: bigint | null;
  revertReason: string | null;
}

/**
 * Simulate by estimating gas on handleOps from the signer EOA. This executes the
 * full validation + the action against current state without sending a tx, so a
 * revert here means the action would fail (bad signature, insufficient funds,
 * health-factor breach in the protocol, etc.).
 */
export async function simulate(op: PackedUserOperation, signer: ethers.Wallet): Promise<SimulationResult> {
  const entryPoint = new ethers.Contract(AA.entryPoint, ENTRYPOINT_V07_ABI, signer);
  try {
    const gas = (await entryPoint.handleOps.estimateGas(
      [toTuple(op)],
      await signer.getAddress(),
    )) as bigint;
    return { ok: true, gasEstimate: gas, revertReason: null };
  } catch (err) {
    return { ok: false, gasEstimate: null, revertReason: decodeRevert(err) };
  }
}

export interface SendResult {
  userOpHash: string;
  txHash: string;
  blockNumber: number | null;
  gasUsed: string | null;
  via: 'handleOps' | 'bundler';
}

/** Submit the signed UserOp. Self-bundles via handleOps unless a bundler URL is set. */
export async function send(op: PackedUserOperation, signer: ethers.Wallet): Promise<SendResult> {
  const opHash = await userOpHash(op);
  if (AA.bundlerUrl) return sendViaBundler(op, opHash);
  return sendViaHandleOps(op, signer, opHash);
}

async function sendViaHandleOps(
  op: PackedUserOperation,
  signer: ethers.Wallet,
  opHash: string,
): Promise<SendResult> {
  const entryPoint = new ethers.Contract(AA.entryPoint, ENTRYPOINT_V07_ABI, signer);
  const tx = await entryPoint.handleOps([toTuple(op)], await signer.getAddress());
  const receipt = await tx.wait();
  return {
    userOpHash: opHash,
    txHash: tx.hash,
    blockNumber: receipt?.blockNumber ?? null,
    gasUsed: receipt?.gasUsed != null ? receipt.gasUsed.toString() : null,
    via: 'handleOps',
  };
}

/** Standards bundler path (eth_sendUserOperation). v0.7 expects the UNPACKED shape. */
async function sendViaBundler(op: PackedUserOperation, opHash: string): Promise<SendResult> {
  const { high: verificationGasLimit, low: callGasLimit } = unpackUint128Pair(op.accountGasLimits);
  const { high: maxPriorityFeePerGas, low: maxFeePerGas } = unpackUint128Pair(op.gasFees);
  const hex = (v: bigint): string => '0x' + v.toString(16);
  const unpacked: Record<string, string> = {
    sender: op.sender,
    nonce: hex(op.nonce),
    callData: op.callData,
    callGasLimit: hex(callGasLimit),
    verificationGasLimit: hex(verificationGasLimit),
    preVerificationGas: hex(op.preVerificationGas),
    maxFeePerGas: hex(maxFeePerGas),
    maxPriorityFeePerGas: hex(maxPriorityFeePerGas),
    signature: op.signature,
  };
  if (op.initCode && op.initCode !== '0x') {
    unpacked['factory'] = ethers.getAddress(op.initCode.slice(0, 42));
    unpacked['factoryData'] = '0x' + op.initCode.slice(42);
  }
  const sent = await bundlerRpc<string>('eth_sendUserOperation', [unpacked, AA.entryPoint]);
  // Poll for the receipt.
  for (let i = 0; i < 30; i++) {
    const r = await bundlerRpc<{ receipt?: { transactionHash?: string; blockNumber?: string } } | null>(
      'eth_getUserOperationReceipt',
      [sent],
    );
    if (r && r.receipt) {
      return {
        userOpHash: sent,
        txHash: r.receipt.transactionHash ?? '',
        blockNumber: r.receipt.blockNumber ? Number(r.receipt.blockNumber) : null,
        gasUsed: null,
        via: 'bundler',
      };
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  return { userOpHash: opHash, txHash: '', blockNumber: null, gasUsed: null, via: 'bundler' };
}

async function bundlerRpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(AA.bundlerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(`bundler ${method}: ${json.error.message ?? 'unknown error'}`);
  return json.result as T;
}

/** Best-effort decode of a revert reason from an ethers/RPC error. */
function decodeRevert(err: unknown): string {
  const e = err as { shortMessage?: string; reason?: string; info?: { error?: { message?: string } } };
  return (
    e?.reason ??
    e?.shortMessage ??
    e?.info?.error?.message ??
    (err instanceof Error ? err.message : String(err))
  );
}
