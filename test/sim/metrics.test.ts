import { describe, it, expect } from 'vitest';
import { computeMetrics } from '../../src/sim/metrics.js';
import type { TradeOutcome } from '../../src/types/signal.js';
import type { RiskConfig } from '../../src/types/config.js';

function makeOutcome(pnlR: number, entryTimestamp: number, exitTimestamp: number): TradeOutcome {
  return {
    mint: 'TOKEN_A',
    entry: 1.0,
    exitPrice: pnlR > 0 ? 1.03 : 0.97,
    exitReason: pnlR > 0 ? 'tp' : 'stop',
    pnlR,
    riskAmount: 15, // 1.5% of $1000 bankroll
    pnlUsd: pnlR * 15,
    entryTimestamp,
    exitTimestamp,
    closed: true,
  };
}

const defaultRiskConfig: RiskConfig = {
  dailyLossLimitPct: 0.05,
  maxSingleNameExposurePct: 0.05,
  maxAggregateExposurePct: 0.25,
};

describe('computeMetrics', () => {
  it('computes positive expectancy for winning book', () => {
    const outcomes: TradeOutcome[] = [
      makeOutcome(2.0, 100, 200),
      makeOutcome(-1.0, 200, 300),
      makeOutcome(3.0, 300, 400),
      makeOutcome(-1.0, 400, 500),
      makeOutcome(1.5, 500, 600),
    ];

    const metrics = computeMetrics(outcomes, 1000, defaultRiskConfig, {
      maxSingleNameExposurePct: 0.03,
      maxAggregateExposurePct: 0.15,
    });

    expect(metrics.expectancyR).toBeGreaterThan(0);
    expect(metrics.totalTrades).toBe(5);
    expect(metrics.profitFactor).toBeGreaterThan(1);
  });

  it('computes negative expectancy for losing book', () => {
    const outcomes: TradeOutcome[] = [
      makeOutcome(-1.0, 100, 200),
      makeOutcome(-1.0, 200, 300),
      makeOutcome(0.5, 300, 400),
      makeOutcome(-1.0, 400, 500),
    ];

    const metrics = computeMetrics(outcomes, 1000, defaultRiskConfig, {
      maxSingleNameExposurePct: 0.02,
      maxAggregateExposurePct: 0.1,
    });

    expect(metrics.expectancyR).toBeLessThan(0);
    expect(metrics.passed).toBe(false);
  });

  it('computes max drawdown correctly', () => {
    // Sequence: +2R, -1R, -1R, -1R, +3R
    // Cumulative R: 2, 1, 0, -1, 2
    // Peak = 2, trough = -1, drawdown = 3R
    const outcomes: TradeOutcome[] = [
      makeOutcome(2.0, 100, 200),
      makeOutcome(-1.0, 200, 300),
      makeOutcome(-1.0, 300, 400),
      makeOutcome(-1.0, 400, 500),
      makeOutcome(3.0, 500, 600),
    ];

    const metrics = computeMetrics(outcomes, 1000, defaultRiskConfig, {
      maxSingleNameExposurePct: 0.03,
      maxAggregateExposurePct: 0.15,
    });

    expect(metrics.maxDrawdownR).toBeCloseTo(3, 1);
  });

  it('computes tail loss fraction for gap-through trades', () => {
    const outcomes: TradeOutcome[] = [
      makeOutcome(-1.0, 100, 200),  // exactly -1R, NOT tail
      makeOutcome(-1.5, 200, 300),  // worse than -1R, IS tail
      makeOutcome(2.0, 300, 400),
      makeOutcome(-2.0, 400, 500),  // worse than -1R, IS tail
      makeOutcome(-1.0, 500, 600),  // exactly -1R, NOT tail
    ];

    const metrics = computeMetrics(outcomes, 1000, defaultRiskConfig, {
      maxSingleNameExposurePct: 0.03,
      maxAggregateExposurePct: 0.15,
    });

    // 2 out of 5 trades are worse than -1R
    expect(metrics.tailLossFraction).toBeCloseTo(0.4, 2);
    expect(metrics.worstTradeR).toBe(-2.0);
  });

  it('reports win rate as derived diagnostic', () => {
    const outcomes: TradeOutcome[] = [
      makeOutcome(2.0, 100, 200),  // win
      makeOutcome(-1.0, 200, 300),  // loss
      makeOutcome(1.0, 300, 400),   // win
      makeOutcome(-1.0, 400, 500),  // loss
    ];

    const metrics = computeMetrics(outcomes, 1000, defaultRiskConfig, {
      maxSingleNameExposurePct: 0.03,
      maxAggregateExposurePct: 0.15,
    });

    expect(metrics.winRate).toBe(0.5);
  });

  it('fails when drawdown exceeds cap', () => {
    // Massive drawdown: -5R in a row
    const outcomes: TradeOutcome[] = Array(5).fill(null).map((_, i) =>
      makeOutcome(-5.0, i * 100, i * 100 + 50)
    );

    const metrics = computeMetrics(outcomes, 1000, defaultRiskConfig, {
      maxSingleNameExposurePct: 0.03,
      maxAggregateExposurePct: 0.15,
    });

    expect(metrics.passed).toBe(false);
    expect(metrics.failedTargets).toContain('maxDrawdownR');
  });

  it('fails when tail fraction is too high', () => {
    // All trades worse than -1R
    const outcomes: TradeOutcome[] = [
      makeOutcome(-2.0, 100, 200),
      makeOutcome(-1.5, 200, 300),
      makeOutcome(-3.0, 300, 400),
    ];

    const metrics = computeMetrics(outcomes, 1000, defaultRiskConfig, {
      maxSingleNameExposurePct: 0.03,
      maxAggregateExposurePct: 0.15,
    });

    expect(metrics.tailLossFraction).toBe(1.0);
    expect(metrics.passed).toBe(false);
    expect(metrics.failedTargets).toContain('tailLossFraction');
  });

  it('fails when exposure exceeds caps', () => {
    const outcomes: TradeOutcome[] = [
      makeOutcome(2.0, 100, 200),
      makeOutcome(3.0, 300, 400),
    ];

    const metrics = computeMetrics(outcomes, 1000, defaultRiskConfig, {
      maxSingleNameExposurePct: 0.06, // exceeds 5% cap
      maxAggregateExposurePct: 0.15,
    });

    expect(metrics.passed).toBe(false);
    expect(metrics.failedTargets).toContain('maxSingleNameExposurePct');
  });

  it('returns zero metrics for empty outcomes', () => {
    const metrics = computeMetrics([], 1000, defaultRiskConfig, {
      maxSingleNameExposurePct: 0,
      maxAggregateExposurePct: 0,
    });

    expect(metrics.totalTrades).toBe(0);
    expect(metrics.expectancyR).toBe(0);
    expect(metrics.profitFactor).toBe(0);
    expect(metrics.passed).toBe(false);
  });

  it('computes risk-adjusted return correctly', () => {
    // Total R = 5, max DD = 2 → risk-adjusted = 2.5
    const outcomes: TradeOutcome[] = [
      makeOutcome(3.0, 100, 200),
      makeOutcome(-1.0, 200, 300),
      makeOutcome(-1.0, 300, 400),
      makeOutcome(4.0, 400, 500),
    ];

    const metrics = computeMetrics(outcomes, 1000, defaultRiskConfig, {
      maxSingleNameExposurePct: 0.03,
      maxAggregateExposurePct: 0.15,
    });

    expect(metrics.riskAdjustedReturn).toBeGreaterThan(0);
  });

  it('profit factor is gross winners / gross losers', () => {
    // Winners: +2R, +3R → gross +R = 5
    // Losers: -1R, -1R → gross -R = 2
    // PF = 5/2 = 2.5
    const outcomes: TradeOutcome[] = [
      makeOutcome(2.0, 100, 200),
      makeOutcome(-1.0, 200, 300),
      makeOutcome(3.0, 300, 400),
      makeOutcome(-1.0, 400, 500),
    ];

    const metrics = computeMetrics(outcomes, 1000, defaultRiskConfig, {
      maxSingleNameExposurePct: 0.03,
      maxAggregateExposurePct: 0.15,
    });

    expect(metrics.profitFactor).toBeCloseTo(2.5, 2);
  });

  it('is deterministic — same outcomes → same metrics', () => {
    const outcomes: TradeOutcome[] = [
      makeOutcome(2.0, 100, 200),
      makeOutcome(-1.0, 200, 300),
      makeOutcome(3.0, 300, 400),
    ];

    const a = computeMetrics(outcomes, 1000, defaultRiskConfig, {
      maxSingleNameExposurePct: 0.03,
      maxAggregateExposurePct: 0.15,
    });
    const b = computeMetrics(outcomes, 1000, defaultRiskConfig, {
      maxSingleNameExposurePct: 0.03,
      maxAggregateExposurePct: 0.15,
    });

    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});
