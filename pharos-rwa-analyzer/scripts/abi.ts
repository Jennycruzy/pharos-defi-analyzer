/**
 * abi.ts — minimal, human-readable ABIs for exactly the methods we call.
 *
 * Every fragment here was exercised against live Pharos mainnet during Step 0
 * (see VERIFICATION.md). We decode Aave's getReserveData by NAMED struct fields
 * so we never rely on a brittle positional index.
 */

/** Aave-style Pool. */
export const POOL_ABI = [
  'function ADDRESSES_PROVIDER() view returns (address)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
] as const;

/** Aave-style PoolAddressesProvider — used to resolve oracle + data provider per venue. */
export const ADDRESSES_PROVIDER_ABI = [
  'function getPriceOracle() view returns (address)',
  'function getPoolDataProvider() view returns (address)',
  'function getPool() view returns (address)',
] as const;

/** Aave-style ProtocolDataProvider — reserve config + per-user reserve data. */
export const DATA_PROVIDER_ABI = [
  'function getAllReservesTokens() view returns (tuple(string symbol, address tokenAddress)[])',
  'function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
  'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
] as const;

/** Aave-style price oracle (USD base, verified 8-decimal). */
export const ORACLE_ABI = [
  'function getAssetPrice(address asset) view returns (uint256)',
  'function BASE_CURRENCY_UNIT() view returns (uint256)',
] as const;

/** ERC-4626 vault (Tulipa) — reads only. */
export const ERC4626_ABI = [
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
  'function maxWithdraw(address owner) view returns (uint256)',
  'function maxRedeem(address owner) view returns (uint256)',
] as const;

/** Aave-style aToken — only the incentives hook we read. */
export const ATOKEN_ABI = [
  'function getIncentivesController() view returns (address)',
  'function totalSupply() view returns (uint256)',
] as const;

/**
 * Aave-style RewardsController (incentives). Verified deployed on both OpenFi and
 * ZonaLend; both currently return an EMPTY rewards list for the USDC aToken.
 */
export const REWARDS_CONTROLLER_ABI = [
  'function getRewardsByAsset(address asset) view returns (address[])',
  'function getRewardsData(address asset, address reward) view returns (uint256 index, uint256 emissionPerSecond, uint256 lastUpdateTimestamp, uint256 distributionEnd)',
] as const;

export const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function balanceOf(address owner) view returns (uint256)',
  // --- write (actuator skill) ---
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
] as const;

/* ────────────────────────────────────────────────────────────────────────────
 * WRITE-SIDE ABIs — used ONLY by the actuator skill (scripts/aa, actions, plan).
 * These are the exact mutating fragments the smart account will execute. They are
 * kept separate from the read ABIs above so the read-only analyzer never imports
 * a state-changing selector by accident. Every fragment is the canonical Aave v3
 * / ERC-4626 / ERC-4337 v0.7 / Safe v1.4.1 signature.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Aave-style Pool — mutating methods the actuator drives via the smart account. */
export const POOL_WRITE_ABI = [
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',
  'function setUserUseReserveAsCollateral(address asset, bool useAsCollateral)',
] as const;

/** ERC-4626 vault — mutating methods (deposit is intentionally omitted: gated). */
export const ERC4626_WRITE_ABI = [
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256)',
] as const;

/**
 * ERC-4337 EntryPoint v0.7. `PackedUserOperation` is the v0.7 packed struct
 * (accountGasLimits / gasFees are two uint128 packed into a bytes32 each).
 */
export const ENTRYPOINT_V07_ABI = [
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'function getUserOpHash(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp) view returns (bytes32)',
  'function handleOps(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address beneficiary)',
  'function balanceOf(address account) view returns (uint256)',
  'function depositTo(address account) payable',
] as const;

/** Safe v1.4.1 ProxyFactory — deterministic CREATE2 deployment of the smart account. */
export const SAFE_PROXY_FACTORY_ABI = [
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'function proxyCreationCode() view returns (bytes)',
] as const;

/** Safe v1.4.1 singleton — setup() initializer + read helpers for verification. */
export const SAFE_ABI = [
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function isModuleEnabled(address module) view returns (bool)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function VERSION() view returns (string)',
] as const;

/** SafeModuleSetup — delegatecalled during setup() to enable the 4337 module. */
export const SAFE_MODULE_SETUP_ABI = [
  'function enableModules(address[] modules)',
] as const;

/**
 * Safe4337Module v0.3.0 (EntryPoint v0.7). Registered as BOTH the Safe's fallback
 * handler (routes validateUserOp/executeUserOp) AND an enabled module (so it may
 * call execTransactionFromModule). `getOperationHash` lets us cross-check our
 * locally-computed SafeOp EIP-712 digest against the on-chain module before signing.
 */
export const SAFE_4337_MODULE_ABI = [
  'function executeUserOp(address to, uint256 value, bytes data, uint8 operation)',
  'function getOperationHash(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp) view returns (bytes32)',
] as const;

/** MultiSendCallOnly v1.4.1 — batch multiple CALLs atomically (reverts on delegatecall). */
export const MULTISEND_CALL_ONLY_ABI = [
  'function multiSend(bytes transactions) payable',
] as const;
