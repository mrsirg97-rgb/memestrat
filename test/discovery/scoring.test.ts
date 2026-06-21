/** Discovery scoring — pure scoring functions. */
import { describe, it, expect } from 'vitest';
import {
  scoreLiquidity,
  scoreHolderDistribution,
  scoreVelocity,
  scoreAge,
  computeCompositeScore,
} from '../../src/discovery/scoring.js';
import type { HolderDistribution } from '../../src/types/market.js';
import type { ScoringConfig } from '../../src/types/config.js';

const makeHolders = (overrides: Partial<HolderDistribution> = {}): HolderDistribution => ({
  totalHolders: 100,
  top10Concentration: 0.2,
  top1Concentration: 0.05,
  giniCoefficient: 0.5,
  ...overrides,
});

const defaultScoring: ScoringConfig = {
  liquidityWeight: 0.3,
  holderWeight: 0.25,
  velocityWeight: 0.25,
  ageWeight: 0.2,
  minPromotionScore: 0.5,
};

describe('scoreLiquidity', () => {
  it('scores 0 for zero liquidity', () => {
    expect(scoreLiquidity(0, 100_000)).toBeCloseTo(0, 4);
  });

  it('scores 1 when liquidity equals reference', () => {
    expect(scoreLiquidity(100_000, 100_000)).toBeCloseTo(1, 4);
  });

  it('scores capped at 1 when liquidity exceeds reference', () => {
    expect(scoreLiquidity(200_000, 100_000)).toBeCloseTo(1, 4);
  });

  it('scores proportionally below reference', () => {
    const score = scoreLiquidity(50_000, 100_000);
    expect(score).toBeCloseTo(0.5, 4);
  });

  it('scores 0 when reference is 0', () => {
    expect(scoreLiquidity(50_000, 0)).toBeCloseTo(0, 4);
  });
});

describe('scoreHolderDistribution', () => {
  it('scores 1 for perfect distribution (0 concentration)', () => {
    const holders = makeHolders({ top10Concentration: 0 });
    expect(scoreHolderDistribution(holders)).toBeCloseTo(1, 4);
  });

  it('scores 0 for worst distribution (100% concentration)', () => {
    const holders = makeHolders({ top10Concentration: 1.0 });
    expect(scoreHolderDistribution(holders)).toBeCloseTo(0, 4);
  });

  it('scores inversely with concentration', () => {
    const good = scoreHolderDistribution(makeHolders({ top10Concentration: 0.1 }));
    const bad = scoreHolderDistribution(makeHolders({ top10Concentration: 0.5 }));
    expect(good).toBeGreaterThan(bad);
  });

  it('scores 0.5 at 50% concentration', () => {
    const holders = makeHolders({ top10Concentration: 0.5 });
    expect(scoreHolderDistribution(holders)).toBeCloseTo(0.5, 4);
  });
});

describe('scoreVelocity', () => {
  it('scores 0 for zero velocity', () => {
    expect(scoreVelocity(0, 100)).toBeCloseTo(0, 4);
  });

  it('scores 1 when velocity equals reference', () => {
    expect(scoreVelocity(100, 100)).toBeCloseTo(1, 4);
  });

  it('scores capped at 1 when velocity exceeds reference', () => {
    expect(scoreVelocity(200, 100)).toBeCloseTo(1, 4);
  });

  it('scores proportionally below reference', () => {
    const score = scoreVelocity(25, 100);
    expect(score).toBeCloseTo(0.25, 4);
  });

  it('scores 0 when reference is 0', () => {
    expect(scoreVelocity(50, 0)).toBeCloseTo(0, 4);
  });
});

describe('scoreAge', () => {
  it('scores 0 for brand new token (0 age)', () => {
    expect(scoreAge(0, 3600)).toBeCloseTo(0, 4);
  });

  it('scores 1 when age equals reference', () => {
    expect(scoreAge(3600, 3600)).toBeCloseTo(1, 4);
  });

  it('scores capped at 1 when age exceeds reference', () => {
    expect(scoreAge(7200, 3600)).toBeCloseTo(1, 4);
  });

  it('scores proportionally below reference', () => {
    const score = scoreAge(1800, 3600);
    expect(score).toBeCloseTo(0.5, 4);
  });

  it('scores 0 when reference is 0', () => {
    expect(scoreAge(1800, 0)).toBeCloseTo(0, 4);
  });
});

describe('computeCompositeScore', () => {
  it('returns weighted sum of component scores', () => {
    const score = computeCompositeScore(
      1.0, // liquidity
      1.0, // holder
      1.0, // velocity
      1.0, // age
      defaultScoring,
    );
    expect(score).toBeCloseTo(1.0, 4);
  });

  it('returns 0 when all component scores are 0', () => {
    const score = computeCompositeScore(0, 0, 0, 0, defaultScoring);
    expect(score).toBeCloseTo(0, 4);
  });

  it('weights liquidity highest', () => {
    // Only liquidity = 1, rest = 0
    const score = computeCompositeScore(1.0, 0, 0, 0, defaultScoring);
    expect(score).toBeCloseTo(0.3, 4); // liquidityWeight
  });

  it('weights holder second', () => {
    const score = computeCompositeScore(0, 1.0, 0, 0, defaultScoring);
    expect(score).toBeCloseTo(0.25, 4); // holderWeight
  });

  it('is bounded between 0 and 1', () => {
    // Even with weird inputs, weights sum to 1 and scores are [0,1]
    const score = computeCompositeScore(0.5, 0.5, 0.5, 0.5, defaultScoring);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('handles partial scores correctly', () => {
    const score = computeCompositeScore(
      0.8, // liquidity
      0.6, // holder
      0.4, // velocity
      0.2, // age
      defaultScoring,
    );
    // 0.8*0.3 + 0.6*0.25 + 0.4*0.25 + 0.2*0.2 = 0.24 + 0.15 + 0.10 + 0.04 = 0.53
    expect(score).toBeCloseTo(0.53, 4);
  });
});
