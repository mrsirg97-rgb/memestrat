/**
 * Adversarial fill model — fills are NOT at mid.
 *
 * Models the paper-to-live cliff: slippage vs. size/liquidity, stop gap-through,
 * LP drain between signal and fill, and fee/priority/MEV tax.
 * A strategy that only works at mid is a strategy that only works on paper.
 *
 * All functions are pure — same inputs → same outputs. Determinism via seed.
 */
import type { FillModelConfig, SimConfig } from '../types/config.js';

/** Fill parameters passed to fill computation. */
export interface FillParams {
  /** Buy or sell direction. */
  direction: 'buy' | 'sell';
  /** Mid price at time of order. */
  midPrice: number;
  /** Order size in USD. */
  sizeUsd: number;
  /** Current pool liquidity in USD. */
  liquidityUsd: number;
  /** Fill model config for slippage curve. */
  config: FillModelConfig;
}

/** Full fill parameters including entry/stop context for gap-through detection. */
export interface FullFillParams extends Omit<FillParams, 'config'> {
  /** Entry price (for gap-through comparison). */
  entryPrice: number;
  /** Stop price (for gap-through detection on sells). */
  stopPrice: number;
  /** Simulation config (fees + MEV). */
  simConfig: SimConfig;
  /** Fill model config (slippage curve, gap probability). */
  fillConfig: FillModelConfig;
  /** Deterministic seed for gap-through randomness. */
  seed: number;
}

/** Result of a fill computation. */
export interface FillResult {
  /** The actual fill price (after slippage). */
  fillPrice: number;
  /** Slippage in basis points. */
  slippageBps: number;
  /** Total fee + MEV tax in basis points. */
  totalTaxBps: number;
  /** Whether this fill gapped through the stop (realized worse than -1R). */
  isGapThrough: boolean;
  /** Whether the fill was rejected (null fillPrice in computeFillPrice). */
  rejected: boolean;
}

/**
 * Compute slippage in basis points as a function of order size vs. pool liquidity.
 * slippage = baseBps + (size / liquidity) * slopeBps
 *
 * @returns Slippage in basis points, or 0 if liquidity is 0 (no fill possible).
 */
export function computeSlippage(
  sizeUsd: number,
  liquidityUsd: number,
  config: FillModelConfig,
): number {
  if (liquidityUsd === 0) return 0;
  const ratio = sizeUsd / liquidityUsd;
  return config.baseSlippageBps + ratio * config.slippageSlopeBps;
}

/**
 * Compute the total fee + MEV tax in basis points.
 */
export function computeFeeTax(simConfig: SimConfig): number {
  return simConfig.exchangeFeeBps + simConfig.mevTaxBps;
}

/**
 * Simple deterministic PRNG (mulberry32) for reproducible gap-through simulation.
 * @returns Pseudo-random float in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s ^ (s >>> 15);
    t = (t * 0x3954a8c9) | 0;
    t = t ^ (t >>> 16);
    return (t >>> 0) / 4294967296;
  };
}

/**
 * Determine if a gap-through occurs on a stop hit.
 * Gap-through means the realized exit is worse than the stop price,
 * resulting in losses worse than -1R.
 *
 * @returns Gap-through fill price (below stop), or null if no gap-through.
 */
export function computeGapThrough(
  entryPrice: number,
  stopPrice: number,
  config: FillModelConfig,
  seed: number,
): number | null {
  const rng = mulberry32(seed);
  const roll = rng();

  if (roll >= config.gapThroughProb) {
    return null; // No gap-through
  }

  // Gap-through: fill is below the stop by gapThroughDistance fraction of stop distance
  const stopDistance = entryPrice - stopPrice;
  const gapExtra = stopDistance * config.gapThroughDistance;
  return stopPrice - gapExtra;
}

/**
 * Compute fill price from mid price, applying slippage.
 * Buys fill above mid, sells fill below mid.
 *
 * @returns Fill price, or null if liquidity is 0 (rejected).
 */
export function computeFillPrice(params: FillParams): { fillPrice: number; slippageBps: number } | null {
  if (params.liquidityUsd === 0) return null;

  const slippageBps = computeSlippage(params.sizeUsd, params.liquidityUsd, params.config);
  const slippageFactor = slippageBps / 10_000;

  let fillPrice: number;
  if (params.direction === 'buy') {
    fillPrice = params.midPrice * (1 + slippageFactor);
  } else {
    fillPrice = params.midPrice * (1 - slippageFactor);
  }

  return { fillPrice, slippageBps };
}

/**
 * Compute the full fill result: slippage + fees + gap-through detection.
 * This is the main entry point for the adversarial fill model.
 *
 * For buys: slippage pushes price up, fees apply.
 * For sells: slippage pushes price down, fees apply, gap-through possible if below stop.
 *
 * @returns Complete fill result with all cost components.
 */
export function computeFillResult(params: FullFillParams): FillResult {
  const fillPriceResult = computeFillPrice({
    direction: params.direction,
    midPrice: params.midPrice,
    sizeUsd: params.sizeUsd,
    liquidityUsd: params.liquidityUsd,
    config: params.fillConfig,
  });

  if (fillPriceResult === null) {
    return {
      fillPrice: 0,
      slippageBps: 0,
      totalTaxBps: 0,
      isGapThrough: false,
      rejected: true,
    };
  }

  const { fillPrice, slippageBps } = fillPriceResult;
  const totalTaxBps = computeFeeTax(params.simConfig);

  // Apply fee/MEV tax to fill price: buys pay more, sells receive less
  const tax = totalTaxBps / 10_000;
  let adjustedFillPrice: number;
  if (params.direction === 'buy') {
    adjustedFillPrice = fillPrice * (1 + tax);
  } else {
    adjustedFillPrice = fillPrice * (1 - tax);
  }

  // Gap-through: only relevant for sells (exits) where fill is below stop
  let isGapThrough = false;
  let finalFillPrice = adjustedFillPrice;

  if (params.direction === 'sell' && adjustedFillPrice <= params.stopPrice) {
    const gapPrice = computeGapThrough(params.entryPrice, params.stopPrice, params.fillConfig, params.seed);
    if (gapPrice !== null) {
      isGapThrough = true;
      finalFillPrice = gapPrice; // gap-through overrides fee-adjusted price
    }
  }

  return {
    fillPrice: finalFillPrice,
    slippageBps,
    totalTaxBps,
    isGapThrough,
    rejected: false,
  };
}

/**
 * Compute LP drain: liquidity degrades over time as bars pass.
 * lpDrainRatePerBar is a fraction of pool per bar.
 *
 * @returns Remaining liquidity after `barsElapsed` bars.
 */
export function computeLpDrain(
  initialLiquidity: number,
  barsElapsed: number,
  config: FillModelConfig,
): number {
  const drainFactor = Math.pow(1 - config.lpDrainRatePerBar, barsElapsed);
  return initialLiquidity * drainFactor;
}
