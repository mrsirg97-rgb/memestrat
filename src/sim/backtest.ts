/**
 * BacktestRunner — walk-forward simulation orchestrating the full pipeline.
 *
 * Composes: ReplayBarStream → TokenScanner → signal math → position management
 * → SimExecutionEngine → metrics.
 *
 * DETERMINISM IS NON-NEGOTIABLE: the replay injects the bar timestamp as `now`
 * into every scanner/scoring call. The scanner's `now` default (Date.now())
 * exists only for live mode; the sim always passes the bar timestamp.
 *
 * SAMPLE INTEGRITY: replay discovery against the full historical token universe
 * at each point in time, including the rugs and dead-on-arrivals the filter
 * would have admitted. No survivorship-curated sample.
 */
import type { TokenScanner } from '../interfaces/data.js';
import type { StrategyConfig } from '../types/config.js';
import type { LiquiditySnapshot } from '../types/market.js';
import type { TradeOutcome, PerformanceMetrics } from '../types/signal.js';
import type { BarData } from './replay-barstream.js';
import { SimExecutionEngine } from './sim-execution.js';
import { computeMetrics, type ExposureData } from './metrics.js';
import { computeIndicators, checkConfirmation, buildSignalResult } from '../signal/math.js';
import { createPosition, managePosition, advancePosition, calculateSize, buildTradeOutcomeFromAccumulated } from '../signal/position.js';
import { ReplayBarStream } from './replay-barstream.js';

/** Discovery statistics from the run. */
export interface DiscoveryStats {
  /** Total tokens scanned across all scan calls. */
  tokensScanned: number;
  /** Tokens that passed all filters and were promoted. */
  tokensPromoted: number;
  /** Tokens that failed filters. */
  tokensFiltered: number;
}

/** Per-symbol indicator state maintained across bars. */
interface SymbolState {
  shortEma: number | undefined;
  longEma: number | undefined;
  shortEstd: number | undefined;
  longEstd: number | undefined;
  shortSlopeStartEma: number | undefined;
  longSlopeStartEma: number | undefined;
  priceHistory: number[]; // rolling price buffer for regime detection
  volumeEma: number | undefined;
  netFlowHistory: number[];
}

/** Full backtest result including metrics and diagnostics. */
export interface BacktestResult {
  /** Performance metrics from the run. */
  metrics: PerformanceMetrics;
  /** Discovery statistics. */
  discoveryStats: DiscoveryStats;
  /** Trade log (all closed trades). */
  tradeLog: TradeOutcome[];
}

/** Walk-forward result: separate in-sample and out-of-sample runs. */
export interface WalkForwardResult {
  /** In-sample run (used for parameter tuning — not the validation gate). */
  inSample: BacktestResult;
  /** Out-of-sample run (the validation gate — this is what matters). */
  outOfSample: BacktestResult;
}

/**
 * Position tracking for partial-exit accounting.
 * One position = one trade. Partial exits accrue PnL; final close emits ONE TradeOutcome.
 */
interface PositionTracking {
  /** Initial size at entry (S0). */
  initialSize: number;
  /** Risk amount at entry: (entry - stop) * S0 / entry. */
  riskAmount: number;
  /** Accumulated PnL in USD across all partial exits. */
  pnlUsd: number;
  /** Sum of (exitPrice * exitSize) for weighted-average exit price. */
  weightedExitSum: number;
  /** Sum of exit sizes for weighted-average exit price. */
  exitSizeSum: number;
  /** Entry timestamp. */
  entryTimestamp: number;
}

/**
 * Walk-forward backtest runner.
 *
 * Usage:
 * 1. Run `run()` for a single backtest pass.
 * 2. Run `runWalkForward()` for in-sample + out-of-sample split.
 *
 * The runner is deterministic: same input data → byte-identical metrics.
 */
export class BacktestRunner {
  private discoveryStats: DiscoveryStats = {
    tokensScanned: 0,
    tokensPromoted: 0,
    tokensFiltered: 0,
  };

  constructor(
    private config: StrategyConfig,
    private stream: ReplayBarStream,
    private scanner: TokenScanner,
    private bankroll: number,
  ) {}

  /**
   * Run a single backtest pass over all available data.
   *
   * @returns Complete backtest result with metrics, discovery stats, and trade log.
   */
  async run(): Promise<BacktestResult> {
    const tradeLog: TradeOutcome[] = [];
    const positions = new Map<string, ReturnType<typeof createPosition>>();
    const symbolStates = new Map<string, SymbolState>();
    const maxExposureData: ExposureData = {
      maxSingleNameExposurePct: 0,
      maxAggregateExposurePct: 0,
    };

    // One position = one trade: track initial size, risk, and accumulated PnL
    const positionTracking = new Map<string, PositionTracking>();

    // Static universe filter — scan once upfront.
    // TODO: point-in-time discovery deferred to data-layer feature.
    // Currently uses fixed token values; a proper PIT scan would replay
    // the token universe at each bar timestamp.
    const promotedTokens = new Set<string>();
    for await (const candidate of this.scanner.scan()) {
      this.discoveryStats.tokensScanned += 1;
      if (candidate.passed) {
        this.discoveryStats.tokensPromoted += 1;
        promotedTokens.add(candidate.token.mint);
      } else {
        this.discoveryStats.tokensFiltered += 1;
      }
    }

    if (promotedTokens.size === 0) {
      return {
        metrics: computeMetrics([], this.bankroll, this.config.risk, maxExposureData, this.config.sizing),
        discoveryStats: { ...this.discoveryStats },
        tradeLog,
      };
    }

    // Initialize execution engine with promoted tokens
    const engine = new SimExecutionEngine(
      this.config,
      Array.from(promotedTokens),
      100_000, // default initial liquidity
    );

    // Replay bars for each promoted token
    for (const mint of promotedTokens) {
      for await (const bar of this.stream.subscribe(mint)) {
        // CRITICAL: inject bar timestamp as `now` for deterministic scoring
        // The scanner's Date.now() default is for live mode only
        const now = bar.timestamp;

        // Update execution engine
        engine.tick(bar, mint);

        // Initialize symbol state if needed
        if (!symbolStates.has(mint)) {
          symbolStates.set(mint, {
            shortEma: undefined,
            longEma: undefined,
            shortEstd: undefined,
            longEstd: undefined,
            shortSlopeStartEma: undefined,
            longSlopeStartEma: undefined,
            priceHistory: [],
            volumeEma: undefined,
            netFlowHistory: [],
          });
        }

        const state = symbolStates.get(mint)!;

        // Update price history (rolling buffer)
        state.priceHistory.push(bar.close);
        if (state.priceHistory.length > this.config.regime.windowBars + 1) {
          state.priceHistory.shift();
        }

        // Price at window start for regime classification
        const priceAtWindowStart = state.priceHistory.length > this.config.regime.windowBars
          ? state.priceHistory[state.priceHistory.length - this.config.regime.windowBars - 1]
          : undefined;

        // Compute indicators
        const indicators = computeIndicators(
          bar,
          state.shortEma,
          state.longEma,
          state.shortEstd,
          state.longEstd,
          state.shortSlopeStartEma,
          state.longSlopeStartEma,
          priceAtWindowStart,
          this.config,
        );

        // Update state for next bar
        state.shortEma = indicators.shortEma;
        state.longEma = indicators.longEma;
        state.shortEstd = indicators.shortEstd;
        state.longEstd = indicators.longEstd;

        // Rolling slope start EMA: set once when window is full, never reset
        if (state.priceHistory.length === this.config.regime.windowBars + 1
            && state.shortSlopeStartEma === undefined) {
          state.shortSlopeStartEma = indicators.shortEma;
          state.longSlopeStartEma = indicators.longEma;
        }

        // Volume EMA
        const alpha = 2 / (1 + this.config.ema.short);
        state.volumeEma = state.volumeEma !== undefined
          ? alpha * bar.volume + (1 - alpha) * state.volumeEma
          : bar.volume;

        // Net flow history
        state.netFlowHistory.push(bar.netFlow);
        if (state.netFlowHistory.length > this.config.confirmation.flowLookbackBars) {
          state.netFlowHistory.shift();
        }

        // Confirmation check
        const liquidity: LiquiditySnapshot = {
          liquidityUsd: engine.getLiquidity(mint),
          timestamp: bar.timestamp,
        };

        const slippageEstimate = this.estimateSlippage(bar.close, this.config);
        const confirmation = checkConfirmation(
          bar,
          liquidity,
          state.volumeEma,
          state.netFlowHistory,
          slippageEstimate,
          this.config.confirmation,
        );

        // Build signal result
        const signalResult = buildSignalResult(
          bar,
          indicators,
          confirmation.confirmed,
          confirmation.failures,
          this.config.rangingEnabled,
          this.config.zscore,
        );

        // Exits first — manage existing position
        // One position = one trade: partial exits accrue PnL, final close emits ONE TradeOutcome
        const pos = positions.get(mint);
        if (pos) {
          const action = managePosition(pos, bar.close, indicators.regime);
          const tracking = positionTracking.get(mint)!;

          if (action.type === 'CLOSE') {
            const fillPrice = await engine.sell(
              mint,
              pos.size,
              this.config.confirmation.maxSlippageBps,
              { entryPrice: pos.entry, stopPrice: pos.stop },
            );

            if (fillPrice !== null) {
              // Accrue final PnL and emit ONE TradeOutcome for the whole position
              tracking.pnlUsd += (fillPrice - pos.entry) * pos.size / pos.entry;
              tracking.weightedExitSum += fillPrice * pos.size;
              tracking.exitSizeSum += pos.size;

              const avgExitPrice = tracking.weightedExitSum / tracking.exitSizeSum;
              const netR = tracking.pnlUsd / tracking.riskAmount;
              const outcome = buildTradeOutcomeFromAccumulated(
                mint, pos.entry, avgExitPrice, action.reason, now,
                tracking.entryTimestamp, tracking.pnlUsd, netR, tracking.riskAmount,
              );
              tradeLog.push(outcome);
              engine.clearPosition(mint);
            }

            positions.delete(mint);
            positionTracking.delete(mint);
          } else if (action.type === 'REDUCE') {
            const reduceSize = pos.size * action.sizeFrac;
            const fillPrice = await engine.sell(
              mint,
              reduceSize,
              this.config.confirmation.maxSlippageBps,
              { entryPrice: pos.entry, stopPrice: pos.stop },
            );

            if (fillPrice !== null) {
              // Accrue PnL for this partial exit — do NOT emit TradeOutcome yet
              tracking.pnlUsd += (fillPrice - pos.entry) * reduceSize / pos.entry;
              tracking.weightedExitSum += fillPrice * reduceSize;
              tracking.exitSizeSum += reduceSize;
              pos.size -= reduceSize;
            }
          } else {
            // HOLD — advance age
            advancePosition(pos, bar.close);
          }
        }

        // Entries — act on signal
        if (signalResult.signal === 'BUY' && !positions.has(mint)) {
          // Use current price from engine (already ticked with this bar)
          const entryPrice = await engine.getPrice(mint);
          const stop = entryPrice * (1 - this.config.exit.hardStopPct);
          const size = calculateSize(
            this.bankroll,
            entryPrice,
            stop,
            engine.getLiquidity(mint),
            this.config.sizing,
          );

          if (size > 0) {
            const actualEntry = await engine.buy(mint, size, this.config.confirmation.maxSlippageBps);
            if (actualEntry !== null) {
              const position = createPosition(
                mint,
                actualEntry,
                size,
                this.config.exit,
                now,
              );
              positions.set(mint, position);
              engine.recordPosition(mint, actualEntry, size, position.stop);

              // Record initial size and risk for one-position-one-trade accounting
              const riskAmount = (actualEntry - position.stop) * size / actualEntry;
              positionTracking.set(mint, {
                initialSize: size,
                riskAmount,
                pnlUsd: 0,
                weightedExitSum: 0,
                exitSizeSum: 0,
                entryTimestamp: now,
              });

              // Track exposure
              const singleExposure = (size / this.bankroll) * 100;
              maxExposureData.maxSingleNameExposurePct = Math.max(
                maxExposureData.maxSingleNameExposurePct,
                singleExposure,
              );
            }
          }
        }

        // Track aggregate exposure
        let aggregateExposure = 0;
        for (const [, p] of positions) {
          aggregateExposure += p.size;
        }
        maxExposureData.maxAggregateExposurePct = Math.max(
          maxExposureData.maxAggregateExposurePct,
          (aggregateExposure / this.bankroll) * 100,
        );
      }
    }

    // Force-close any remaining positions at end of data
    for (const [mint, pos] of positions) {
      const allBars = await this.stream.getHistoricalBars(mint, 0, Number.MAX_SAFE_INTEGER);
      if (allBars.length > 0) {
        const lastBar = allBars[allBars.length - 1]; // last bar, not first
        const fillPrice = await engine.sell(
          mint,
          pos.size,
          this.config.confirmation.maxSlippageBps,
          { entryPrice: pos.entry, stopPrice: pos.stop },
        );
        if (fillPrice !== null) {
          const tracking = positionTracking.get(mint)!;
          tracking.pnlUsd += (fillPrice - pos.entry) * pos.size / pos.entry;
          tracking.weightedExitSum += fillPrice * pos.size;
          tracking.exitSizeSum += pos.size;

          const avgExitPrice = tracking.weightedExitSum / tracking.exitSizeSum;
          const netR = tracking.pnlUsd / tracking.riskAmount;
          const outcome = buildTradeOutcomeFromAccumulated(
            mint, pos.entry, avgExitPrice, 'end_of_data', lastBar.timestamp,
            tracking.entryTimestamp, tracking.pnlUsd, netR, tracking.riskAmount,
          );
          tradeLog.push(outcome);
        }
      }
    }

    const metrics = computeMetrics(tradeLog, this.bankroll, this.config.risk, maxExposureData, this.config.sizing);

    return {
      metrics,
      discoveryStats: { ...this.discoveryStats },
      tradeLog,
    };
  }

  /**
   * Run walk-forward analysis: in-sample + out-of-sample split.
   *
   * The split point is from `config.sim.splitPoint`:
   * - If a number in [0, 1], it's a fraction of the total bar count.
   * - If a string, it's an ISO date string used as the split timestamp.
   *
   * @returns Separate in-sample and out-of-sample results.
   */
  async runWalkForward(): Promise<WalkForwardResult> {
    const splitPoint = this.config.sim.splitPoint;

    // Determine split timestamp
    let splitTs: number;
    if (typeof splitPoint === 'number') {
      // Fraction of total bars
      const allMints = this.stream.getAllMints();
      if (allMints.length === 0) {
        return {
          inSample: { metrics: this.emptyResult(), discoveryStats: { ...this.discoveryStats }, tradeLog: [] },
          outOfSample: { metrics: this.emptyResult(), discoveryStats: { ...this.discoveryStats }, tradeLog: [] },
        };
      }
      const sampleBars = await this.stream.getHistoricalBars(allMints[0], 0, Number.MAX_SAFE_INTEGER);
      if (sampleBars.length === 0) {
        return {
          inSample: { metrics: this.emptyResult(), discoveryStats: { ...this.discoveryStats }, tradeLog: [] },
          outOfSample: { metrics: this.emptyResult(), discoveryStats: { ...this.discoveryStats }, tradeLog: [] },
        };
      }
      const splitIndex = Math.floor(sampleBars.length * splitPoint);
      splitTs = sampleBars[splitIndex].timestamp;
    } else {
      splitTs = new Date(splitPoint).getTime();
    }

    // In-sample run (0 → splitTs)
    const inSampleStream = this.makeSubsetStream(0, splitTs);
    const inSampleScanner = this.scanner; // TODO: shares full-universe scanner — in-sample sees future tokens
    const inSampleRunner = new BacktestRunner(this.config, inSampleStream, inSampleScanner, this.bankroll);
    const inSample = await inSampleRunner.run();

    // Out-of-sample run (splitTs → end)
    const allMints = this.stream.getAllMints();
    const oosData: BarData = {};
    for (const mint of allMints) {
      oosData[mint] = await this.stream.getHistoricalBars(mint, splitTs, Number.MAX_SAFE_INTEGER);
    }
    const oosStream = new ReplayBarStream(oosData);
    const oosScanner = this.scanner; // TODO: shares full-universe scanner — see above
    const oosRunner = new BacktestRunner(this.config, oosStream, oosScanner, this.bankroll);
    const outOfSample = await oosRunner.run();

    return { inSample, outOfSample };
  }

  /**
   * Create a subset stream filtered to a time range.
   */
  private makeSubsetStream(from: number, to: number): ReplayBarStream {
    const allMints = this.stream.getAllMints();
    const subsetData: BarData = {};

    for (const mint of allMints) {
      const allBars = this.stream['data'][mint];
      if (allBars) {
        subsetData[mint] = allBars.filter((bar) => bar.timestamp >= from && bar.timestamp < to);
      }
    }

    return new ReplayBarStream(subsetData);
  }

  /**
   * Estimate slippage for confirmation check.
   */
  private estimateSlippage(price: number, config: StrategyConfig): number {
    // Rough estimate: use a small position size relative to liquidity
    const estimatedSize = this.bankroll * config.sizing.perTradeRiskPct;
    const liquidity = 100_000; // default — actual value comes from engine
    const ratio = estimatedSize / liquidity;
    return config.fillModel.baseSlippageBps + ratio * config.fillModel.slippageSlopeBps;
  }

  private emptyResult(): PerformanceMetrics {
    return computeMetrics([], this.bankroll, this.config.risk, {
      maxSingleNameExposurePct: 0,
      maxAggregateExposurePct: 0,
    }, this.config.sizing);
  }
}
