/** Data layer interfaces — the boundary between chain I/O and pure logic. */
import type { Bar, TokenInfo, TokenCandidate, HolderDistribution, LiquiditySnapshot, SellabilityResult } from '../types/market.js';

/** Read-only access to token metadata and on-chain state. */
export interface TokenRepository {
  /** Fetch token metadata by mint address. */
  getToken(mint: string): Promise<TokenInfo | null>;

  /** Fetch holder distribution for a token. */
  getHolderDistribution(mint: string): Promise<HolderDistribution>;

  /** Check sellability by simulating a sell of the given size. */
  checkSellability(mint: string, sizeUsd: number): Promise<SellabilityResult>;

  /** Get current liquidity snapshot. */
  getLiquidity(mint: string): Promise<LiquiditySnapshot>;

  /** Get transaction velocity (txns per hour) for a token. */
  getTxnVelocity(mint: string): Promise<number>;
}

/** Streaming access to bar data (real-time or replayed). */
export interface BarStream {
  /**
   * Subscribe to bars for a token. Returns an async iterator that yields bars
   * as they arrive. The caller is responsible for cleanup (breaking the loop).
   */
  subscribe(mint: string): AsyncIterable<Bar>;

  /**
   * Get historical bars for a token (used for warm-up and backtesting).
   * @param mint Token mint address.
   * @param from Start timestamp (epoch ms), inclusive.
   * @param to End timestamp (epoch ms), exclusive.
   * @param limit Maximum number of bars to return.
   */
  getHistoricalBars(mint: string, from: number, to: number, limit?: number): Promise<Bar[]>;
}

/** Token discovery — surfaces new tokens and scores them. */
export interface TokenScanner {
  /**
   * Stream newly discovered token candidates. Returns an async iterator
   * that yields candidates as they are discovered.
   * @param now Current timestamp (epoch ms) for deterministic scoring.
   *   Backtests must inject the bar timestamp here; live mode may omit it.
   */
  scan(now?: number): AsyncIterable<TokenCandidate>;

  /**
   * Force a scan of a specific token (for testing/ad-hoc use).
   * @param mint Token mint address to scan.
   * @param now Current timestamp (epoch ms) for deterministic scoring.
   */
  scanToken(mint: string, now?: number): Promise<TokenCandidate>;
}

/** Execution layer — simulates or places real orders. */
export interface ExecutionEngine {
  /**
   * Place a buy order. Returns the fill price or null if rejected.
   */
  buy(mint: string, sizeUsd: number, maxSlippageBps: number): Promise<number | null>;

  /**
   * Place a sell order. Returns the fill price or null if rejected.
   */
  sell(mint: string, sizeUsd: number, maxSlippageBps: number): Promise<number | null>;

  /**
   * Get current price for a token.
   */
  getPrice(mint: string): Promise<number>;
}

/** Risk governor — global circuit breaker and position limits. */
export interface RiskGovernor {
  /**
   * Check if a new trade is allowed. Returns true if the trade passes
   * all risk checks, false otherwise.
   */
  canOpen(mint: string, sizeUsd: number): boolean;

  /**
   * Record a trade outcome (updates daily PnL, circuit breaker state).
   */
  recordOutcome(pnlUsd: number, pnlR: number): void;

  /**
   * Get current circuit breaker state.
   */
  getState(): import('../types/signal.js').CircuitBreakerState;

  /**
   * Reset daily counters (called at day boundary).
   */
  resetDaily(): void;

  /**
   * Flatten all positions (emergency shutdown).
   */
  flattenAll(): Promise<void>;
}
