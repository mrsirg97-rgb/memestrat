/** Configuration types — the single source of truth for tunable parameters. */

/** Bar configuration: how long each bar is in seconds. */
export interface BarConfig {
  /** Bar duration in seconds (e.g., 15 for 15-second bars). */
  intervalSeconds: number;
}

/** EMA window sizes in bars. */
export interface EmaWindows {
  /** Short-term EMA period (default: 5). */
  short: number;
  /** Medium-term EMA period (default: 13). */
  medium: number;
  /** Long-term EMA period (default: 34). */
  long: number;
  /** Very long-term EMA period (default: 55). */
  veryLong: number;
}

/** Regime classification thresholds (price rate-of-change over the slope window). */
export interface RegimeThresholds {
  /** ROC > T_up → UPTREND. */
  tUp: number;
  /** ROC < -T_down → DOWNTREND. */
  tDown: number;
  /** Number of bars for the ROC window (default: 10). priceAtWindowStart = close windowBars bars ago. */
  windowBars: number;
}

/** Z-score band thresholds. */
export interface ZScoreThresholds {
  /** z > overbought → overbought band. */
  overbought: number;
  /** z < oversold → oversold band. */
  oversold: number;
}

/** Confirmation requirements for entry signals. */
export interface ConfirmationConfig {
  /** Minimum pool liquidity in USD. */
  minLiquidityUsd: number;
  /** Volume must exceed short EMA by this multiple. */
  volumeExpansionMultiple: number;
  /** Net taker flow must be positive over this many bars. */
  flowLookbackBars: number;
  /** Maximum acceptable slippage basis points for intended size. */
  maxSlippageBps: number;
}

/** Position exit parameters. */
export interface ExitConfig {
  /** Hard stop as a fraction of entry price (e.g., 0.03 = 3% below entry). */
  hardStopPct: number;
  /** Take-profit ladder: [target_pct_from_entry, size_fraction] pairs. */
  tpLadder: Array<{ targetPct: number; sizeFrac: number }>;
  /** Trailing stop distance as a fraction of price (e.g., 0.05 = 5% trailing). */
  trailDistPct: number;
  /** Maximum position age in bars before time-stop triggers. */
  maxAgeBars: number;
  /** Minimum price progress required to avoid time-stop (e.g., 1.01 = 1% gain required). */
  minProgress: number;
}

/** Sizing parameters. */
export interface SizingConfig {
  /** Per-trade risk as a fraction of bankroll (e.g., 0.01 = 1%). */
  perTradeRiskPct: number;
  /** Maximum position as a fraction of pool liquidity. */
  maxPoolFrac: number;
  /** Maximum concurrent positions. */
  maxConcurrentPositions: number;
}

/** Risk governor parameters. */
export interface RiskConfig {
  /** Daily loss limit as a fraction of bankroll — trips circuit breaker. */
  dailyLossLimitPct: number;
  /** Maximum bankroll fraction in a single name. */
  maxSingleNameExposurePct: number;
  /** Maximum aggregate exposure as fraction of bankroll. */
  maxAggregateExposurePct: number;
}

/** Discovery filter parameters. */
export interface DiscoveryConfig {
  /** Minimum LP depth in USD. */
  minLiquidityUsd: number;
  /** Maximum top-10 holder concentration (fraction of total supply). */
  maxTop10Concentration: number;
  /** Minimum unique holders. */
  minUniqueHolders: number;
  /** Minimum transaction velocity (txns per hour). */
  minTxnVelocity: number;
  /** Known ruggers blocklist (public keys). */
  ruggersBlocklist: string[];
}

/** Scoring weights and reference levels for candidate ranking. */
export interface ScoringConfig {
  /** Weight for liquidity score (0-1). */
  liquidityWeight: number;
  /** Weight for holder distribution score (0-1). */
  holderWeight: number;
  /** Weight for volume/velocity score (0-1). */
  velocityWeight: number;
  /** Weight for age/stability score (0-1). */
  ageWeight: number;
  /** Minimum composite score to promote to watchlist. */
  minPromotionScore: number;
  /** Reference liquidity for scoring normalization (USD). Full score at this level. */
  scoringLiquidityRef: number;
  /** Reference velocity for scoring normalization (txns/hour). Full score at this level. */
  scoringVelocityRef: number;
  /** Reference age for scoring normalization (seconds). Full score at this level. */
  scoringAgeRef: number;
}

/** Simulation / backtest configuration. */
export interface SimConfig {
  /** In-sample / out-of-sample split point (ISO date string or fraction 0-1). */
  splitPoint: string | number;
  /** Priority fee in lamports per compute unit. */
  priorityFeeLamports: number;
  /** MEV tax in basis points. */
  mevTaxBps: number;
  /** Exchange fee in basis points. */
  exchangeFeeBps: number;
}

/** Adversarial fill model parameters. */
export interface FillModelConfig {
  /** Slippage curve: slippage = baseBps + (size / liquidity) * slopeBps. */
  baseSlippageBps: number;
  slippageSlopeBps: number;
  /** Probability of gap-through on stop hits (0-1). */
  gapThroughProb: number;
  /** Expected gap-through distance as fraction of stop distance. */
  gapThroughDistance: number;
  /** LP drain rate per bar as fraction of pool (0-1). */
  lpDrainRatePerBar: number;
}

/** Complete strategy configuration. */
export interface StrategyConfig {
  bar: BarConfig;
  ema: EmaWindows;
  regime: RegimeThresholds;
  zscore: ZScoreThresholds;
  confirmation: ConfirmationConfig;
  exit: ExitConfig;
  sizing: SizingConfig;
  risk: RiskConfig;
  discovery: DiscoveryConfig;
  scoring: ScoringConfig;
  sim: SimConfig;
  fillModel: FillModelConfig;
  /** Whether mean-reversion in ranging regime is enabled (default: false — on probation). */
  rangingEnabled: boolean;
  /** Whether live trading is enabled (default: false — paper/sim only). */
  liveEnabled: boolean;
}

/** Default configuration — sensible starting point for memecoin scalping. */
export const DEFAULT_CONFIG: StrategyConfig = {
  bar: { intervalSeconds: 15 },
  ema: { short: 5, medium: 13, long: 34, veryLong: 55 },
  regime: { tUp: 0.5, tDown: 0.5, windowBars: 10 },
  zscore: { overbought: 1.5, oversold: -1.5 },
  confirmation: {
    minLiquidityUsd: 10_000,
    volumeExpansionMultiple: 1.5,
    flowLookbackBars: 5,
    maxSlippageBps: 100,
  },
  exit: {
    hardStopPct: 0.03,
    tpLadder: [
      { targetPct: 0.03, sizeFrac: 0.5 },
      { targetPct: 0.06, sizeFrac: 0.3 },
      { targetPct: 0.10, sizeFrac: 0.2 },
    ],
    trailDistPct: 0.04,
    maxAgeBars: 20,
    minProgress: 1.0,
  },
  sizing: {
    perTradeRiskPct: 0.015,
    maxPoolFrac: 0.02,
    maxConcurrentPositions: 5,
  },
  risk: {
    dailyLossLimitPct: 0.05,
    maxSingleNameExposurePct: 0.05,
    maxAggregateExposurePct: 0.25,
  },
  discovery: {
    minLiquidityUsd: 10_000,
    maxTop10Concentration: 0.3,
    minUniqueHolders: 50,
    minTxnVelocity: 10,
    ruggersBlocklist: [],
  },
  scoring: {
    liquidityWeight: 0.3,
    holderWeight: 0.25,
    velocityWeight: 0.25,
    ageWeight: 0.2,
    minPromotionScore: 0.5,
    scoringLiquidityRef: 50_000,
    scoringVelocityRef: 100,
    scoringAgeRef: 7200,
  },
  sim: {
    splitPoint: 0.8,
    priorityFeeLamports: 50_000,
    mevTaxBps: 10,
    exchangeFeeBps: 25,
  },
  fillModel: {
    baseSlippageBps: 50,
    slippageSlopeBps: 5000,
    gapThroughProb: 0.15,
    gapThroughDistance: 0.5,
    lpDrainRatePerBar: 0.001,
  },
  rangingEnabled: false,
  liveEnabled: false,
};
