/**
 * R-based performance metrics — the validation gate.
 *
 * Computes the full metric block per TASK.md:
 * expectancy, profit factor, risk-adjusted return, max drawdown,
 * tail loss fraction, exposure discipline, and pass/fail gates.
 *
 * A run that nails expectancy but blows the drawdown or tail cap is a FAIL.
 * Win rate is a derived diagnostic — reported but never optimized.
 */
import type { TradeOutcome, PerformanceMetrics } from '../types/signal.js';
import type { RiskConfig, SizingConfig } from '../types/config.js';

/** Exposure tracking data from the backtest run. */
export interface ExposureData {
  /** Maximum single-name exposure observed as % of bankroll. */
  maxSingleNameExposurePct: number;
  /** Maximum aggregate exposure observed as % of bankroll. */
  maxAggregateExposurePct: number;
}

/**
 * Performance target thresholds.
 * All must hold on out-of-sample for the run to PASS.
 */
export interface PerformanceTargets {
  /** Minimum profit factor (gross +R / gross -R). Default: 1.5. */
  minProfitFactor: number;
  /** Maximum drawdown in R. Default: 10R. */
  maxDrawdownR: number;
  /** Maximum tail loss fraction (trades worse than -1R). Default: 0.1. */
  maxTailLossFraction: number;
  /** Minimum risk-adjusted return (total R / max DD R). Default: 0.5. */
  minRiskAdjustedReturn: number;
}

/** Default performance targets per TASK.md. */
const DEFAULT_TARGETS: PerformanceTargets = {
  minProfitFactor: 1.5,
  maxDrawdownR: 10,
  maxTailLossFraction: 0.1,
  minRiskAdjustedReturn: 0.5,
};

/**
 * Compute the full R-based performance metrics block from trade outcomes.
 *
 * @param outcomes Closed trade outcomes in chronological order.
 * @param bankroll Initial bankroll in USD.
 * @param riskConfig Risk configuration for exposure caps.
 * @param exposure Observed exposure data from the run.
 * @param targets Performance targets (defaults to TASK.md thresholds).
 * @returns Complete performance metrics with pass/fail determination.
 */
export function computeMetrics(
  outcomes: TradeOutcome[],
  bankroll: number,
  _riskConfig: RiskConfig,
  exposure: ExposureData,
  sizing: SizingConfig,
  targets: PerformanceTargets = DEFAULT_TARGETS,
): PerformanceMetrics {
  if (outcomes.length === 0) {
    return emptyMetrics(exposure);
  }

  // Basic stats
  const totalTrades = outcomes.length;
  const wins = outcomes.filter((o) => o.pnlR > 0);
  const losses = outcomes.filter((o) => o.pnlR <= 0);

  // R-based metrics
  const totalR = outcomes.reduce((sum, o) => sum + o.pnlR, 0);
  const grossPlusR = wins.reduce((sum, o) => sum + o.pnlR, 0);
  const grossMinusR = Math.abs(losses.reduce((sum, o) => sum + o.pnlR, 0));

  const expectancyR = totalR / totalTrades;
  const profitFactor = grossMinusR === 0 ? Infinity : grossPlusR / grossMinusR;
  const winRate = wins.length / totalTrades;

  // Max drawdown in R (peak-to-trough of cumulative R series)
  const { maxDrawdownR } = computeMaxDrawdown(outcomes);
  const maxDrawdownPct = (maxDrawdownR * sizing.perTradeRiskPct) * 100; // drawdownR × risk-per-trade = % of bankroll

  // Risk-adjusted return: total R captured / max drawdown R
  // Edge: flawless run (zero drawdown, positive R) → Infinity (pass)
  const riskAdjustedReturn = maxDrawdownR === 0
    ? totalR > 0 ? Infinity : 0
    : totalR / maxDrawdownR;

  // Tail loss: fraction of trades worse than -1R
  const tailLosses = outcomes.filter((o) => o.pnlR < -1);
  const tailLossFraction = tailLosses.length / totalTrades;
  const worstTradeR = Math.min(...outcomes.map((o) => o.pnlR));

  // Total PnL in USD
  const totalPnlUsd = outcomes.reduce((sum, o) => sum + o.pnlUsd, 0);

  // Pass/fail gates
  const failedTargets: string[] = [];

  if (expectancyR <= 0) {
    failedTargets.push('expectancyR');
  }
  if (profitFactor < targets.minProfitFactor) {
    failedTargets.push('profitFactor');
  }
  if (maxDrawdownR > targets.maxDrawdownR) {
    failedTargets.push('maxDrawdownR');
  }
  if (tailLossFraction > targets.maxTailLossFraction) {
    failedTargets.push('tailLossFraction');
  }
  if (riskAdjustedReturn < targets.minRiskAdjustedReturn) {
    failedTargets.push('riskAdjustedReturn');
  }
  if (exposure.maxSingleNameExposurePct > _riskConfig.maxSingleNameExposurePct) {
    failedTargets.push('maxSingleNameExposurePct');
  }
  if (exposure.maxAggregateExposurePct > _riskConfig.maxAggregateExposurePct) {
    failedTargets.push('maxAggregateExposurePct');
  }

  return {
    expectancyR,
    profitFactor,
    riskAdjustedReturn,
    maxDrawdownR,
    maxDrawdownPct,
    tailLossFraction,
    worstTradeR,
    totalTrades,
    winRate,
    totalR,
    totalPnlUsd,
    maxSingleNameExposurePct: exposure.maxSingleNameExposurePct,
    maxAggregateExposurePct: exposure.maxAggregateExposurePct,
    passed: failedTargets.length === 0,
    failedTargets,
  };
}

/**
 * Compute max drawdown from a sequence of trade outcomes.
 * Uses cumulative R series: peak-to-trough maximum decline.
 */
function computeMaxDrawdown(outcomes: TradeOutcome[]): { maxDrawdownR: number } {
  let peak = 0;
  let cumulative = 0;
  let maxDrawdown = 0;

  for (const outcome of outcomes) {
    cumulative += outcome.pnlR;
    if (cumulative > peak) {
      peak = cumulative;
    }
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  return { maxDrawdownR: maxDrawdown };
}

function emptyMetrics(exposure: ExposureData): PerformanceMetrics {
  return {
    expectancyR: 0,
    profitFactor: 0,
    riskAdjustedReturn: 0,
    maxDrawdownR: 0,
    maxDrawdownPct: 0,
    tailLossFraction: 0,
    worstTradeR: 0,
    totalTrades: 0,
    winRate: 0,
    totalR: 0,
    totalPnlUsd: 0,
    maxSingleNameExposurePct: exposure.maxSingleNameExposurePct,
    maxAggregateExposurePct: exposure.maxAggregateExposurePct,
    passed: false,
    failedTargets: ['expectancyR', 'profitFactor'],
  };
}
