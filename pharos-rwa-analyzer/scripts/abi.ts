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
] as const;
