/**
 * SimExecutionEngine — simulated execution with adversarial fill model.
 *
 * Implements ExecutionEngine: buy/sell/getPrice with full adversarial fills
 * (slippage curve, gap-through, LP drain, fees + MEV tax).
 *
 * Tracks per-mint state: current price, liquidity (draining over time),
 * and open positions for gap-through detection on exits.
 */
import type { ExecutionEngine } from '../interfaces/data.js';
import type { Bar } from '../types/market.js';
import type { StrategyConfig } from '../types/config.js';
import { computeFillResult, computeLpDrain } from './fill-model.js';

/** Optional context for sell orders (used for gap-through detection). */
export interface SellContext {
  /** Entry price for this position. */
  entryPrice: number;
  /** Stop price for this position. */
  stopPrice: number;
}

/** Per-mint state tracked by the sim engine. */
interface MintState {
  /** Current mid price (from latest bar). */
  currentPrice: number;
  /** Initial pool liquidity. */
  initialLiquidity: number;
  /** Number of bars elapsed since first bar (for LP drain). */
  barsElapsed: number;
  /** Entry price of current open position (for gap-through). */
  entryPrice: number | null;
  /** Stop price of current open position. */
  stopPrice: number | null;
  /** Deterministic seed counter (incremented per fill for gap-through). */
  seedCounter: number;
}

/**
 * Simulated execution engine with adversarial fills.
 *
 * Usage:
 * 1. Call tick(bar) for each bar in sequence.
 * 2. Call buy/sell/getPrice as the strategy would.
 * 3. Fills include slippage, fees, MEV, and gap-through.
 */
export class SimExecutionEngine implements ExecutionEngine {
  private state: Map<string, MintState> = new Map();

  constructor(
    private config: StrategyConfig,
    initialMints: string[],
    initialLiquidity: number,
  ) {
    for (const mint of initialMints) {
      this.state.set(mint, {
        currentPrice: 0,
        initialLiquidity,
        barsElapsed: 0,
        entryPrice: null,
        stopPrice: null,
        seedCounter: 0,
      });
    }
  }

  /**
   * Tick the engine with a new bar. Updates price and advances LP drain.
   * Must be called for each bar in sequence before trading.
   */
  tick(bar: Bar, mint: string): void {
    const state = this.state.get(mint);
    if (!state) return;

    state.currentPrice = bar.close;
    state.barsElapsed += 1;
  }

  /**
   * Record an open position for gap-through tracking on exits.
   * Called after a successful buy to track the entry/stop for future sells.
   */
  recordPosition(mint: string, entryPrice: number, _sizeUsd: number, stopPrice: number): void {
    const state = this.state.get(mint);
    if (!state) return;

    state.entryPrice = entryPrice;
    state.stopPrice = stopPrice;
  }

  /**
   * Clear the position record (called after a successful exit).
   */
  clearPosition(mint: string): void {
    const state = this.state.get(mint);
    if (!state) return;

    state.entryPrice = null;
    state.stopPrice = null;
  }

  /**
   * Get current liquidity for a mint (after drain).
   */
  getLiquidity(mint: string): number {
    const state = this.state.get(mint);
    if (!state) return 0;
    return computeLpDrain(state.initialLiquidity, state.barsElapsed, this.config.fillModel);
  }

  /**
   * Place a buy order. Returns the fill price or null if rejected.
   * Buy fills above mid due to slippage.
   */
  async buy(mint: string, sizeUsd: number, _maxSlippageBps: number): Promise<number | null> {
    const state = this.state.get(mint);
    if (!state || state.currentPrice === 0) return null;

    const liquidity = this.getLiquidity(mint);
    if (liquidity === 0) return null;

    state.seedCounter += 1;
    const result = computeFillResult({
      direction: 'buy',
      midPrice: state.currentPrice,
      sizeUsd,
      liquidityUsd: liquidity,
      entryPrice: state.currentPrice,
      stopPrice: 0,
      simConfig: this.config.sim,
      fillConfig: this.config.fillModel,
      seed: state.seedCounter,
    });

    if (result.rejected) return null;
    return result.fillPrice;
  }

  /**
   * Place a sell order. Returns the fill price or null if rejected.
   * Sell fills below mid due to slippage, with gap-through possible.
   *
   * @param context Optional entry/stop context for gap-through detection.
   *   If not provided, uses the recorded position from recordPosition().
   */
  async sell(
    mint: string,
    sizeUsd: number,
    _maxSlippageBps: number,
    context?: SellContext,
  ): Promise<number | null> {
    const state = this.state.get(mint);
    if (!state || state.currentPrice === 0) return null;

    const liquidity = this.getLiquidity(mint);
    if (liquidity === 0) return null;

    const entryPrice = context?.entryPrice ?? state.entryPrice ?? state.currentPrice;
    const stopPrice = context?.stopPrice ?? state.stopPrice ?? state.currentPrice;

    state.seedCounter += 1;
    const result = computeFillResult({
      direction: 'sell',
      midPrice: state.currentPrice,
      sizeUsd,
      liquidityUsd: liquidity,
      entryPrice,
      stopPrice,
      simConfig: this.config.sim,
      fillConfig: this.config.fillModel,
      seed: state.seedCounter,
    });

    if (result.rejected) return null;
    return result.fillPrice;
  }

  /**
   * Get current price for a token.
   * Throws if the mint is unknown or no bar has been ticked yet (fail closed).
   */
  async getPrice(mint: string): Promise<number> {
    const state = this.state.get(mint);
    if (!state || state.currentPrice === 0) {
      throw new Error(`No price available for ${mint}`);
    }
    return state.currentPrice;
  }

  /**
   * Reset engine state for a new run (walk-forward split).
   */
  reset(): void {
    for (const state of this.state.values()) {
      state.currentPrice = 0;
      state.barsElapsed = 0;
      state.entryPrice = null;
      state.stopPrice = null;
      state.seedCounter = 0;
    }
  }
}
