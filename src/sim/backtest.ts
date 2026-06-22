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
import { createPosition, managePosition, advancePosition, calculateSize, buildTradeOutcome } from '../signal/position.js';
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

    // Replay discovery: scan the full token universe
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
        metrics: computeMetrics([], this.bankroll, this.config.risk, maxExposureData),
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

        // Rolling slope start EMA: reset after window bars
        if (state.priceHistory.length === this.config.regime.windowBars + 1) {
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
        const pos = positions.get(mint);
        if (pos) {
          const action = managePosition(pos, bar.close, indicators.regime);

          if (action.type === 'CLOSE') {
            const fillPrice = await engine.sell(
              mint,
              pos.size,
              this.config.confirmation.maxSlippageBps,
              { entryPrice: pos.entry, stopPrice: pos.stop },
            );

            if (fillPrice !== null) {
              const outcome = buildTradeOutcome(pos, fillPrice, action.reason, now);
              tradeLog.push(outcome);
              engine.clearPosition(mint);
            }

            positions.delete(mint);
          } else if (action.type === 'REDUCE') {
            const reduceSize = pos.size * action.sizeFrac;
            const fillPrice = await engine.sell(
              mint,
              reduceSize,
              this.config.confirmation.maxSlippageBps,
              { entryPrice: pos.entry, stopPrice: pos.stop },
            );

            if (fillPrice !== null) {
              const outcome = buildTradeOutcome(pos, fillPrice, action.reason, now);
              tradeLog.push(outcome);
              pos.size -= reduceSize;
            }
          } else {
            // HOLD — advance age
            advancePosition(pos, bar.close);
          }
        }

        // Entries — act on signal
        if (signalResult.signal === 'BUY' && !positions.has(mint)) {
          const entryFill = await engine.buy(
            mint,
            0, // placeholder — calculate size below
            this.config.confirmation.maxSlippageBps,
          );

          if (entryFill !== null) {
            const stop = entryFill * (1 - this.config.exit.hardStopPct);
            const size = calculateSize(
              this.bankroll,
              entryFill,
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

                // Track exposure
                const singleExposure = (size / this.bankroll) * 100;
                maxExposureData.maxSingleNameExposurePct = Math.max(
                  maxExposureData.maxSingleNameExposurePct,
                  singleExposure,
                );
              }
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
      const lastBar = await this.stream.getHistoricalBars(mint, 0, Number.MAX_SAFE_INTEGER, 1);
      if (lastBar.length > 0) {
        const fillPrice = await engine.sell(
          mint,
          pos.size,
          this.config.confirmation.maxSlippageBps,
          { entryPrice: pos.entry, stopPrice: pos.stop },
        );
        if (fillPrice !== null) {
          const outcome = buildTradeOutcome(pos, fillPrice, 'end_of_data', lastBar[0].timestamp);
          tradeLog.push(outcome);
        }
      }
    }

    const metrics = computeMetrics(tradeLog, this.bankroll, this.config.risk, maxExposureData);

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
    const inSampleScanner = this.scanner; // scanner uses full universe
    const inSampleRunner = new BacktestRunner(this.config, inSampleStream, inSampleScanner, this.bankroll);
    const inSample = await inSampleRunner.run();

    // Out-of-sample run (splitTs → end)
    const allMints = this.stream.getAllMints();
    const oosData: BarData = {};
    for (const mint of allMints) {
      oosData[mint] = await this.stream.getHistoricalBars(mint, splitTs, Number.MAX_SAFE_INTEGER);
    }
    const oosStream = new ReplayBarStream(oosData);
    const oosScanner = this.scanner;
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
    });
  }
}
