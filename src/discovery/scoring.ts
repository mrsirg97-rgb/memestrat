/** Pure scoring functions — rank survivors by composite score (0-1). */
import type { HolderDistribution } from '../types/market.js';
import type { ScoringConfig } from '../types/config.js';

/**
 * Score liquidity on a 0-1 scale. Linear interpolation capped at 1.
 * Higher liquidity = higher score.
 * @param liquidityUsd Current pool liquidity in USD.
 * @param referenceUsd Reference liquidity level (full score at this level).
 */
export function scoreLiquidity(liquidityUsd: number, referenceUsd: number): number {
  if (referenceUsd === 0) return 0;
  return Math.min(liquidityUsd / referenceUsd, 1);
}

/**
 * Score holder distribution on a 0-1 scale.
 * Lower concentration = better distribution = higher score.
 * Score = 1 - top10Concentration (linear inversion).
 */
export function scoreHolderDistribution(holders: HolderDistribution): number {
  return Math.max(1 - holders.top10Concentration, 0);
}

/**
 * Score transaction velocity on a 0-1 scale. Linear interpolation capped at 1.
 * Higher velocity = more real two-sided flow = higher score.
 * @param velocity Transactions per hour.
 * @param reference Reference velocity level (full score at this level).
 */
export function scoreVelocity(velocity: number, reference: number): number {
  if (reference === 0) return 0;
  return Math.min(velocity / reference, 1);
}

/**
 * Score token age/stability on a 0-1 scale. Linear interpolation capped at 1.
 * Older tokens have had more time to prove stability = higher score.
 * @param ageSeconds Token age in seconds since creation.
 * @param referenceSeconds Reference age (full score at this level).
 */
export function scoreAge(ageSeconds: number, referenceSeconds: number): number {
  if (referenceSeconds === 0) return 0;
  return Math.min(ageSeconds / referenceSeconds, 1);
}

/**
 * Compute composite score from weighted component scores.
 * Weights must sum to 1 for a meaningful 0-1 composite.
 * @returns Composite score bounded to [0, 1].
 */
export function computeCompositeScore(
  liquidityScore: number,
  holderScore: number,
  velocityScore: number,
  ageScore: number,
  config: ScoringConfig,
): number {
  const composite =
    liquidityScore * config.liquidityWeight +
    holderScore * config.holderWeight +
    velocityScore * config.velocityWeight +
    ageScore * config.ageWeight;

  // Clamp to [0, 1] — defensive against weight misconfiguration
  return Math.max(0, Math.min(composite, 1));
}
