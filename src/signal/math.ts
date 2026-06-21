/** Pure signal math — inputs to outputs, zero I/O or state. */
import type { Bar, LiquiditySnapshot } from '../types/market.js';
import type {
  EmaWindows,
  RegimeThresholds,
  ZScoreThresholds,
  ConfirmationConfig,
} from '../types/config.js';
import type { Indicators, Regime, Signal, SignalResult, ZBand } from '../types/signal.js';

/**
 * Compute exponential moving average.
 * @param price Current price.
 * @param prevEma Previous EMA value (undefined for first call).
 * @param period EMA period in bars.
 * @returns Updated EMA value.
 */
export function ema(price: number, prevEma: number | undefined, period: number): number {
  const alpha = 2 / (1 + period);
  if (prevEma === undefined) return price;
  return alpha * price + (1 - alpha) * prevEma;
}

/**
 * Compute deviation from EMA.
 */
export function deviation(price: number, emaValue: number): number {
  return price - emaValue;
}

/**
 * Compute exponential standard deviation.
 * @param price Current price.
 * @param emaValue Current EMA value.
 * @param prevEstd Previous ESTD value (undefined for first call).
 * @param period EMA period (determines alpha).
 * @returns Updated ESTD value.
 */
export function estd(price: number, emaValue: number, prevEstd: number | undefined, period: number): number {
  const alpha = 2 / (1 + period);
  const dev = deviation(price, emaValue);
  const devSq = dev * dev;
  if (prevEstd === undefined) return Math.sqrt(devSq);
  return Math.sqrt(alpha * devSq + (1 - alpha) * prevEstd * prevEstd);
}

/**
 * Compute slope (rate of change) of an EMA series.
 * @param currentEma Current EMA value.
 * @param startEma EMA value at the start of the slope window.
 * @param barCount Number of bars between start and current.
 * @returns Slope as price change per bar.
 */
export function slope(currentEma: number, startEma: number, barCount: number): number {
  if (barCount === 0) return 0;
  return (currentEma - startEma) / barCount;
}

/** Minimum ESTD before z-score is considered defined. Below this, z is undefined → NOOP. */
export const ZSCORE_EPSILON = 1e-9;

/**
 * Compute z-score from price, EMA, and ESTD.
 * @returns z-score, or `undefined` when ESTD < epsilon (warmup / flat bars — fail closed).
 */
export function zScore(price: number, emaValue: number, estdValue: number): number | undefined {
  if (estdValue < ZSCORE_EPSILON) return undefined;
  return deviation(price, emaValue) / estdValue;
}

/**
 * Classify z-score into a band.
 * @param z z-score value, or undefined (when ESTD < epsilon).
 * @returns band classification; undefined z degrades to 'rich' (neutral — no signal).
 */
export function classifyBand(z: number | undefined, thresholds: ZScoreThresholds): ZBand | undefined {
  if (z === undefined) return undefined;
  if (z > thresholds.overbought) return 'overbought';
  if (z >= 0) return 'rich';
  if (z >= thresholds.oversold) return 'cheap';
  return 'oversold';
}

/** Minimum price at window start before ROC is considered valid. Below this, refuse to classify. */
const ROC_EPSILON = 1e-9;

/**
 * Classify regime from rate-of-change over the slope window.
 * Uses price ROC (not EMA slope) for faster regime detection — critical for memecoins
 * where EMA slope is a lagging instrument. A 20%+ move in the window = trend.
 * See TASK.md: "consider a faster regime proxy (EMA cross, rate-of-change percentile)".
 */
export function classifyRegime(
  currentPrice: number,
  priceAtWindowStart: number | undefined,
  thresholds: RegimeThresholds,
): Regime {
  if (priceAtWindowStart === undefined || priceAtWindowStart <= ROC_EPSILON) {
    return 'RANGING';
  }
  const roc = (currentPrice - priceAtWindowStart) / priceAtWindowStart;
  if (roc > thresholds.tUp) return 'UPTREND';
  if (roc < -thresholds.tDown) return 'DOWNTREND';
  return 'RANGING';
}

/**
 * Compute full indicator set from a bar and previous state.
 * Uses a rolling buffer approach: caller maintains EMA/ESTD/slope state + price history.
 */
export function computeIndicators(
  bar: Bar,
  prevShortEma: number | undefined,
  prevLongEma: number | undefined,
  prevShortEstd: number | undefined,
  prevLongEstd: number | undefined,
  shortSlopeStartEma: number | undefined,
  longSlopeStartEma: number | undefined,
  priceAtWindowStart: number | undefined,
  slopeWindowBars: number,
  emaWindows: EmaWindows,
  regimeThresholds: RegimeThresholds,
  zscoreThresholds: ZScoreThresholds,
): Indicators {
  const shortEma = ema(bar.close, prevShortEma, emaWindows.short);
  const longEma = ema(bar.close, prevLongEma, emaWindows.long);
  const shortEstd = estd(bar.close, shortEma, prevShortEstd, emaWindows.short);
  const longEstd = estd(bar.close, longEma, prevLongEstd, emaWindows.long);

  // Slope: rate of change over the slope window
  const shortSlope = shortSlopeStartEma !== undefined
    ? slope(shortEma, shortSlopeStartEma, slopeWindowBars)
    : 0;
  const longSlope = longSlopeStartEma !== undefined
    ? slope(longEma, longSlopeStartEma, slopeWindowBars)
    : 0;

  const shortZ = zScore(bar.close, shortEma, shortEstd);
  const longZ = zScore(bar.close, longEma, longEstd);
  const shortBand = classifyBand(shortZ, zscoreThresholds);
  const longBand = classifyBand(longZ, zscoreThresholds);

  // Regime: rate-of-change over the slope window (faster than EMA slope)
  const regime = classifyRegime(bar.close, priceAtWindowStart, regimeThresholds);

  return {
    shortEma,
    longEma,
    shortEstd,
    longEstd,
    shortSlope,
    longSlope,
    shortZ,
    longZ,
    shortBand,
    longBand,
    slopeNorm: priceAtWindowStart !== undefined && priceAtWindowStart !== 0
      ? (bar.close - priceAtWindowStart) / priceAtWindowStart
      : 0,
    regime,
  };
}

/**
 * Check confirmation conditions for an entry signal.
 * @returns { confirmed: boolean, failures: string[] }
 */
export function checkConfirmation(
  bar: Bar,
  liquidity: LiquiditySnapshot,
  volumeEma: number,
  netFlowHistory: number[],
  slippageBps: number,
  config: ConfirmationConfig,
): { confirmed: boolean; failures: string[] } {
  const failures: string[] = [];

  // Liquidity floor
  if (liquidity.liquidityUsd < config.minLiquidityUsd) {
    failures.push(`liquidity ${liquidity.liquidityUsd} < ${config.minLiquidityUsd}`);
  }

  // Volume expansion: current volume > short EMA by config multiple
  if (bar.volume < volumeEma * config.volumeExpansionMultiple) {
    failures.push(`volume ${bar.volume} < ${volumeEma * config.volumeExpansionMultiple} (expanded EMA)`);
  }

  // Buy pressure: net taker flow positive over lookback bars
  const recentFlow = netFlowHistory.slice(-config.flowLookbackBars);
  const netFlow = recentFlow.reduce((sum, f) => sum + f, 0);
  if (netFlow <= 0) {
    failures.push(`net flow ${netFlow} over ${config.flowLookbackBars} bars not positive`);
  }

  // Executable spread: simulated slippage under cap
  if (slippageBps > config.maxSlippageBps) {
    failures.push(`slippage ${slippageBps}bps > ${config.maxSlippageBps}bps cap`);
  }

  return { confirmed: failures.length === 0, failures };
}

/**
 * Generate a signal from indicators and confirmation.
 * Implements the STRAT.md signal logic exactly.
 * When z-scores are undefined (ESTD < epsilon), signal degrades to NOOP — fail closed.
 */
export function generateSignal(
  price: number,
  regime: Regime,
  shortZ: number | undefined,
  longZ: number | undefined,
  shortSlope: number,
  confirmed: boolean,
  rangingEnabled: boolean,
): Signal {
  // DOWNTREND: hard veto on all longs
  if (regime === 'DOWNTREND') {
    return 'NOOP';
  }

  // RANGING: mean-revert (on probation — disabled by default)
  if (regime === 'RANGING') {
    if (!rangingEnabled) {
      return 'NOOP';
    }
    // Fail closed: undefined z → NOOP
    if (shortZ === undefined || longZ === undefined) {
      return 'NOOP';
    }
    if (shortZ < -1.5 && longZ <= 0 && confirmed) {
      return 'BUY';
    }
    if (shortZ > 1.5) {
      return 'SELL';
    }
    return 'NOOP';
  }

  // UPTREND: momentum — ride it, don't fade it
  if (regime === 'UPTREND') {
    // Fail closed: undefined shortZ → NOOP
    if (shortZ === undefined) {
      return 'NOOP';
    }
    // Enter on a confirmed continuation: shallow pullback toward short EMA that resumes upward
    if (shortZ <= 0 && shortSlope > 0 && confirmed) {
      return 'BUY';
    }
    // Do NOT sell on "overbought" in uptrend — exits owned by trailing stop
    return 'NOOP';
  }

  return 'NOOP';
}

/**
 * Build a complete signal result from a bar, indicators, and confirmation.
 */
export function buildSignalResult(
  bar: Bar,
  indicators: Indicators,
  confirmed: boolean,
  confirmationFailures: string[],
  rangingEnabled: boolean,
): SignalResult {
  const signal = generateSignal(
    bar.close,
    indicators.regime,
    indicators.shortZ,
    indicators.longZ,
    indicators.shortSlope,
    confirmed,
    rangingEnabled,
  );

  return {
    signal,
    indicators,
    confirmed,
    confirmationFailures,
    timestamp: bar.timestamp,
  };
}
