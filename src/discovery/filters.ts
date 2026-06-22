/** Pure survivorship filter functions — each returns { passed, failure? }. */
import type { TokenInfo, HolderDistribution, SellabilityResult } from '../types/market.js';
import type { DiscoveryConfig } from '../types/config.js';

/** Result of a single filter check. */
export interface FilterResult {
  passed: boolean;
  failure?: string;
}

/**
 * Check liquidity floor: pool liquidity must meet minimum threshold.
 */
export function checkLiquidityFloor(token: TokenInfo, config: DiscoveryConfig): FilterResult {
  if (token.poolLiquidityUsd < config.minLiquidityUsd) {
    return { passed: false, failure: `liquidity ${token.poolLiquidityUsd} < ${config.minLiquidityUsd}` };
  }
  return { passed: true };
}

/**
 * Check LP burned or locked: LP tokens must be burned or locked to prevent rug pulls.
 */
export function checkLpBurnedOrLocked(token: TokenInfo): FilterResult {
  if (!token.lpBurnedOrLocked) {
    return { passed: false, failure: 'LP not burned or locked' };
  }
  return { passed: true };
}

/**
 * Check mint authority revoked: new tokens cannot be minted after revocation.
 */
export function checkMintAuthorityRevoked(token: TokenInfo): FilterResult {
  if (!token.mintAuthorityRevoked) {
    return { passed: false, failure: 'mint authority not revoked' };
  }
  return { passed: true };
}

/**
 * Check freeze authority revoked: tokens cannot be frozen after revocation.
 * Freeze authority = vault-freeze DoS / soft honeypot — non-negotiable filter.
 */
export function checkFreezeAuthorityRevoked(token: TokenInfo): FilterResult {
  if (!token.freezeAuthorityRevoked) {
    return { passed: false, failure: 'freeze authority not revoked' };
  }
  return { passed: true };
}

/**
 * Check sellability: token must be exitable at the intended size.
 */
export function checkSellability(result: SellabilityResult): FilterResult {
  if (!result.sellable) {
    return { passed: false, failure: `sellability: ${result.reason ?? 'unsellable'}` };
  }
  return { passed: true };
}

/**
 * Check top-holder concentration: top-10 holders must be below the cap.
 */
export function checkTopHolderConcentration(holders: HolderDistribution, config: DiscoveryConfig): FilterResult {
  if (holders.top10Concentration > config.maxTop10Concentration) {
    return { passed: false, failure: `top-10 concentration ${holders.top10Concentration} > ${config.maxTop10Concentration}` };
  }
  return { passed: true };
}

/**
 * Check minimum unique holders: enough holders to indicate real distribution.
 */
export function checkMinHolders(holders: HolderDistribution, config: DiscoveryConfig): FilterResult {
  if (holders.totalHolders < config.minUniqueHolders) {
    return { passed: false, failure: `holders ${holders.totalHolders} < ${config.minUniqueHolders}` };
  }
  return { passed: true };
}

/**
 * Check transaction velocity: enough transaction activity to indicate real flow.
 */
export function checkTxnVelocity(txnVelocity: number, config: DiscoveryConfig): FilterResult {
  if (txnVelocity < config.minTxnVelocity) {
    return { passed: false, failure: `txn velocity ${txnVelocity} < ${config.minTxnVelocity}` };
  }
  return { passed: true };
}

/**
 * Check deployer against ruggers blocklist: deny known-bad deployers.
 * Blocklist posture: immutable-set, deny the known-bad, admit the rest.
 */
export function checkDeployerBlocklist(token: TokenInfo, config: DiscoveryConfig): FilterResult {
  if (config.ruggersBlocklist.includes(token.deployer)) {
    return { passed: false, failure: `deployer ${token.deployer} on blocklist` };
  }
  return { passed: true };
}

/**
 * Run all survivorship filters. A candidate must pass ALL to be promoted.
 * Collects all failures — even if one fails, we check the rest for diagnostics.
 */
export function runAllFilters(
  token: TokenInfo,
  holders: HolderDistribution,
  txnVelocity: number,
  sellability: SellabilityResult,
  config: DiscoveryConfig,
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];

  const checks: Array<() => FilterResult> = [
    () => checkLiquidityFloor(token, config),
    () => checkLpBurnedOrLocked(token),
    () => checkMintAuthorityRevoked(token),
    () => checkFreezeAuthorityRevoked(token),
    () => checkSellability(sellability),
    () => checkTopHolderConcentration(holders, config),
    () => checkMinHolders(holders, config),
    () => checkTxnVelocity(txnVelocity, config),
    () => checkDeployerBlocklist(token, config),
  ];

  for (const check of checks) {
    const result = check();
    if (!result.passed && result.failure) {
      failures.push(result.failure);
    }
  }

  return { passed: failures.length === 0, failures };
}
