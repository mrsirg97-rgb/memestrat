/** Signal and position types — the core state machine of the strategy. */

/** Regime classification. */
export type Regime = 'UPTREND' | 'DOWNTREND' | 'RANGING';

/** Signal direction. */
export type Signal = 'BUY' | 'SELL' | 'NOOP';

/** Position action from manage_position(). */
export type PositionAction =
  | { type: 'CLOSE'; reason: string }
  | { type: 'REDUCE'; sizeFrac: number; reason: string }
  | { type: 'HOLD' };

/** Z-score band classification. */
export type ZBand = 'overbought' | 'rich' | 'cheap' | 'oversold';

/** Technical indicators computed per bar. */
export interface Indicators {
  /** Short-term EMA. */
  shortEma: number;
  /** Long-term EMA. */
  longEma: number;
  /** Short-term exponential standard deviation. */
  shortEstd: number;
  /** Long-term exponential standard deviation. */
  longEstd: number;
  /** Short-term slope (rate of change of short EMA). */
  shortSlope: number;
  /** Long-term slope (rate of change of long EMA). */
  longSlope: number;
  /** Short-term z-score. */
  shortZ: number;
  /** Long-term z-score. */
  longZ: number;
  /** Short-term z-score band. */
  shortBand: ZBand;
  /** Long-term z-score band. */
  longBand: ZBand;
  /** Normalized long-term slope (slope / ESTD). */
  slopeNorm: number;
  /** Current regime classification. */
  regime: Regime;
}

/** Signal generation result. */
export interface SignalResult {
  signal: Signal;
  indicators: Indicators;
  /** Whether confirmation checks passed. */
  confirmed: boolean;
  /** Confirmation failure reasons (empty if confirmed). */
  confirmationFailures: string[];
  /** Timestamp of this signal (epoch ms). */
  timestamp: number;
}

/** Open position. */
export interface Position {
  /** Token mint address. */
  mint: string;
  /** Entry price (USD). */
  entry: number;
  /** Position size in USD. */
  size: number;
  /** Hard stop price (never widened). */
  stop: number;
  /** Take-profit ladder levels. */
  tpLadder: Array<{ target: number; sizeFrac: number; hit: boolean }>;
  /** Trailing stop price (arms once in profit). */
  trail: number;
  /** Trailing stop distance. */
  trailDist: number;
  /** Position age in bars. */
  ageBars: number;
  /** Maximum position age before time-stop. */
  maxAgeBars: number;
  /** Minimum price progress to avoid time-stop. */
  minProgress: number;
  /** Entry timestamp (epoch ms). */
  entryTimestamp: number;
}

/** Trade outcome in R multiples. */
export interface TradeOutcome {
  /** Token mint. */
  mint: string;
  /** Entry price. */
  entry: number;
  /** Exit price (or current price if still open). */
  exitPrice: number;
  /** Exit reason. */
  exitReason: string;
  /** PnL in R multiples (e.g., -1 for stop hit, +3 for 3:1 winner). */
  pnlR: number;
  /** Risk amount (entry - stop) * size. */
  riskAmount: number;
  /** Realized PnL in USD. */
  pnlUsd: number;
  /** Entry timestamp. */
  entryTimestamp: number;
  /** Exit timestamp. */
  exitTimestamp: number;
  /** Whether this trade is closed. */
  closed: boolean;
}

/** Performance metrics from a backtest run. */
export interface PerformanceMetrics {
  /** Mean R per trade (expectancy). */
  expectancyR: number;
  /** Profit factor (gross +R / gross -R). */
  profitFactor: number;
  /** Total R captured / max drawdown in R. */
  riskAdjustedReturn: number;
  /** Maximum drawdown in R. */
  maxDrawdownR: number;
  /** Maximum drawdown as % of bankroll. */
  maxDrawdownPct: number;
  /** Fraction of trades worse than -1R (gap/slip/unsellable). */
  tailLossFraction: number;
  /** Worst single-trade R. */
  worstTradeR: number;
  /** Total trades. */
  totalTrades: number;
  /** Win rate (derived diagnostic, not a target). */
  winRate: number;
  /** Total R captured. */
  totalR: number;
  /** Total PnL in USD. */
  totalPnlUsd: number;
  /** Maximum single-name exposure as % of bankroll. */
  maxSingleNameExposurePct: number;
  /** Maximum aggregate exposure as % of bankroll. */
  maxAggregateExposurePct: number;
  /** Whether all performance targets were met. */
  passed: boolean;
  /** List of failed targets. */
  failedTargets: string[];
}

/** Circuit breaker state. */
export interface CircuitBreakerState {
  /** Whether the circuit breaker is tripped (all trading halted). */
  tripped: boolean;
  /** Daily PnL in R. */
  dailyPnlR: number;
  /** Daily PnL in USD. */
  dailyPnlUsd: number;
  /** Number of open positions. */
  openPositions: number;
  /** Current aggregate exposure as % of bankroll. */
  aggregateExposurePct: number;
  /** Trip reason (if tripped). */
  tripReason?: string;
}
