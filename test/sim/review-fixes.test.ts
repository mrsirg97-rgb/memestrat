import { describe, it, expect } from 'vitest';
import { computeMetrics } from '../../src/sim/metrics.js';
import { computeFillResult } from '../../src/sim/fill-model.js';
import { BacktestRunner } from '../../src/sim/backtest.js';
import { ReplayBarStream } from '../../src/sim/replay-barstream.js';
import { InMemoryScanner } from '../../src/discovery/scanner.js';
import type { TradeOutcome } from '../../src/types/signal.js';
import type { RiskConfig, SizingConfig } from '../../src/types/config.js';
import type { Bar, TokenInfo, HolderDistribution, SellabilityResult } from '../../src/types/market.js';
import type { StrategyConfig } from '../../src/types/config.js';
import { DEFAULT_CONFIG } from '../../src/types/config.js';
import type { BarData } from '../../src/sim/replay-barstream.js';
import type { TokenRepository } from '../../src/interfaces/data.js';

// --- Helpers ---

function makeOutcome(pnlR: number, entryTimestamp: number, exitTimestamp: number): TradeOutcome {
  return {
    mint: 'TOKEN_A',
    entry: 1.0,
    exitPrice: pnlR > 0 ? 1.03 : 0.97,
    exitReason: pnlR > 0 ? 'tp' : 'stop',
    pnlR,
    riskAmount: 15,
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

const defaultSizingConfig: SizingConfig = {
  perTradeRiskPct: 0.015,
  maxPoolFrac: 0.02,
  maxConcurrentPositions: 5,
};

function makeConfig(overrides?: Partial<StrategyConfig>): StrategyConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function makeBar(ts: number, price: number, volume: number = 1000, netFlow: number = 50): Bar {
  return {
    timestamp: ts,
    open: price,
    high: price * 1.01,
    low: price * 0.99,
    close: price,
    volume,
    netFlow,
    txnCount: 10,
  };
}

class MockRepository implements TokenRepository {
  constructor(private tokenData: Map<string, TokenInfo>) {}
  async getToken(mint: string): Promise<TokenInfo | null> {
    return this.tokenData.get(mint) ?? null;
  }
  async getHolderDistribution(_mint: string): Promise<HolderDistribution> {
    return { totalHolders: 200, top10Concentration: 0.15, top1Concentration: 0.05, giniCoefficient: 0.3 };
  }
  async checkSellability(_mint: string, _sizeUsd: number): Promise<SellabilityResult> {
    return { sellable: true, estimatedSlippageBps: 50, estimatedFillTimeSeconds: 1 };
  }
  async getLiquidity(_mint: string): Promise<{ liquidityUsd: number; timestamp: number }> {
    return { liquidityUsd: 100_000, timestamp: Date.now() };
  }
  async getTxnVelocity(_mint: string): Promise<number> {
    return 50;
  }
}

// --- (a) Partial exits: one position through full TP ladder → exactly ONE TradeOutcome ---

describe('FIX: partial exits produce one blended TradeOutcome', () => {
  it('one position through a full TP ladder emits exactly ONE TradeOutcome with correct blended R', async () => {
    const tokenA: TokenInfo = {
      mint: 'TOKEN_A',
      symbol: 'A',
      name: 'Token A',
      decimals: 9,
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      lpBurnedOrLocked: true,
      poolLiquidityUsd: 100_000,
      deployer: 'deployer1',
      createdAt: 0,
    };

    const config = makeConfig({
      rangingEnabled: false,
      regime: { tUp: 0.001, tDown: 0.001, windowBars: 5 },
      exit: {
        hardStopPct: 0.03,
        tpLadder: [
          { targetPct: 0.03, sizeFrac: 0.5 },
          { targetPct: 0.06, sizeFrac: 0.3 },
          { targetPct: 0.10, sizeFrac: 0.2 },
        ],
        trailDistPct: 0.10, // wide trail so it does not interfere with TP ladder
        maxAgeBars: 200,
        minProgress: 1.0,
      },
      confirmation: {
        minLiquidityUsd: 1_000,
        volumeExpansionMultiple: 0.5,
        flowLookbackBars: 2,
        maxSlippageBps: 200,
      },
    });

    // Price series: strong uptrend → pullback (BUY trigger) → recovery through TP levels
    // Uptrend steep enough that 5-bar ROC stays positive during pullback → regime stays UPTREND
    // Pullback sharp enough to push price below short EMA → shortZ <= 0 → BUY signal
    const bars: Bar[] = [];
    const tsStart = 1_000_000_000_000;

    // Phase 1: strong uptrend (bars 0-24) — 1.5% per bar, establishes UPTREND regime
    for (let i = 0; i < 25; i++) {
      bars.push(makeBar(tsStart + i * 15_000, 1.0 + i * 0.015, 1000, 100));
    }

    // Phase 2: pullback (bars 25-26) — price drops below short EMA but 5-bar ROC stays positive
    // Bar 24 price = 1.36, bar 20 price = 1.30 → ROC at bar 26 still > 0.1% threshold
    bars.push(makeBar(tsStart + 25 * 15_000, 1.34, 1000, 100)); // dip below short EMA
    bars.push(makeBar(tsStart + 26 * 15_000, 1.33, 1000, 100)); // further dip, shortZ < 0

    // Phase 3: immediate recovery through TP levels (bars 27-70)
    // Recovery starts above the pullback low with steep enough moves to keep 5-bar ROC positive
    for (let i = 0; i < 44; i++) {
      bars.push(makeBar(tsStart + (27 + i) * 15_000, 1.345 + i * 0.012, 1000, 100));
    }

    const barData: BarData = { 'TOKEN_A': bars };
    const stream = new ReplayBarStream(barData);
    const repo = new MockRepository(new Map([['TOKEN_A', tokenA]]));
    const scanner = new InMemoryScanner(repo, config, ['TOKEN_A']);
    const runner = new BacktestRunner(config, stream, scanner, 10_000);

    const result = await runner.run();

    // Verify trades were made
    expect(result.tradeLog.length).toBeGreaterThan(0);

    // For each unique mint in the trade log, there should be exactly ONE outcome
    const mints = new Set(result.tradeLog.map((t) => t.mint));
    for (const mint of mints) {
      const mintTrades = result.tradeLog.filter((t) => t.mint === mint);
      // Each position should produce exactly one outcome (even if it had partial exits)
      expect(mintTrades.length).toBe(1);
      const trade = mintTrades[0];
      // The blended R should be > 0 (net winner through TP ladder)
      expect(trade.pnlR).toBeGreaterThan(0);
    }

    // Verify blended R math for a position that hit all 3 TP levels:
    // Entry at E, S0 initial size, R0 = (E - stop) * S0 / E
    // TP1: 50% at +3%  → pnl1 = 0.03 * S0 * 0.5
    // TP2: 30% at +6%  → pnl2 = 0.06 * S0 * 0.3
    // TP3: 20% at +10% → pnl3 = 0.10 * S0 * 0.2
    // netPnl = S0 * (0.015 + 0.018 + 0.020) = S0 * 0.053
    // R0 = 0.03 * S0
    // expectedR = 0.053 / 0.03 ≈ 1.767
    for (const trade of result.tradeLog) {
      if (trade.pnlR > 0) {
        // Allow some tolerance for slippage/fees shifting the exact fill prices
        expect(trade.pnlR).toBeGreaterThan(1.0);
        expect(trade.pnlR).toBeLessThan(5.0);
      }
    }
  });
});

// --- (b) Fees visibly move the fill ---

describe('FIX: fees applied to fill price', () => {
  it('fees move fill price: buy higher, sell lower than slippage alone', () => {
    const fillConfig = {
      baseSlippageBps: 50,
      slippageSlopeBps: 5000,
      gapThroughProb: 0,
      gapThroughDistance: 0.5,
      lpDrainRatePerBar: 0,
    };

    const simConfig = {
      splitPoint: 0.8,
      priorityFeeLamports: 50_000,
      mevTaxBps: 10,
      exchangeFeeBps: 25,
    };

    // BUY: fill price should be HIGHER than slippage-only price
    const buyResult = computeFillResult({
      direction: 'buy',
      midPrice: 1.0,
      sizeUsd: 500,
      liquidityUsd: 100_000,
      entryPrice: 1.0,
      stopPrice: 0.97,
      simConfig,
      fillConfig,
      seed: 42,
    });

    // Slippage-only buy: 1.0 * (1 + 75/10000) = 1.0075
    // With fees (35 bps): 1.0075 * (1 + 35/10000) = 1.0075 * 1.0035 ≈ 1.0110
    expect(buyResult.fillPrice).toBeGreaterThan(1.0075);
    expect(buyResult.fillPrice).toBeCloseTo(1.011, 3);
    expect(buyResult.totalTaxBps).toBe(35);

    // SELL: fill price should be LOWER than slippage-only price
    const sellResult = computeFillResult({
      direction: 'sell',
      midPrice: 1.0,
      sizeUsd: 500,
      liquidityUsd: 100_000,
      entryPrice: 1.0,
      stopPrice: 0.97,
      simConfig,
      fillConfig,
      seed: 42,
    });

    // Slippage-only sell: 1.0 * (1 - 75/10000) = 0.9925
    // With fees (35 bps): 0.9925 * (1 - 35/10000) = 0.9925 * 0.9965 ≈ 0.9890
    expect(sellResult.fillPrice).toBeLessThan(0.9925);
    expect(sellResult.fillPrice).toBeCloseTo(0.989, 3);
  });

  it('zero fees → fill price unchanged from slippage-only', () => {
    const fillConfig = {
      baseSlippageBps: 50,
      slippageSlopeBps: 5000,
      gapThroughProb: 0,
      gapThroughDistance: 0.5,
      lpDrainRatePerBar: 0,
    };

    const simConfig = {
      splitPoint: 0.8,
      priorityFeeLamports: 50_000,
      mevTaxBps: 0,
      exchangeFeeBps: 0,
    };

    const buyResult = computeFillResult({
      direction: 'buy',
      midPrice: 1.0,
      sizeUsd: 500,
      liquidityUsd: 100_000,
      entryPrice: 1.0,
      stopPrice: 0.97,
      simConfig,
      fillConfig,
      seed: 42,
    });

    // With zero fees, fill price = slippage-only price
    expect(buyResult.fillPrice).toBeCloseTo(1.0075);
    expect(buyResult.totalTaxBps).toBe(0);
  });
});

// --- (c) Zero-drawdown positive run passes RAR gate ---

describe('FIX: RAR edge — zero drawdown with positive R passes', () => {
  it('a flawless run (all winners, zero drawdown) passes the RAR gate', () => {
    // All winners → cumulative R monotonically increasing → maxDrawdownR = 0
    const outcomes: TradeOutcome[] = [
      makeOutcome(2.0, 100, 200),
      makeOutcome(1.5, 200, 300),
      makeOutcome(3.0, 300, 400),
    ];

    const metrics = computeMetrics(
      outcomes,
      1000,
      defaultRiskConfig,
      { maxSingleNameExposurePct: 0.03, maxAggregateExposurePct: 0.15 },
      defaultSizingConfig,
    );

    // Total R = 6.5, maxDrawdownR = 0 → RAR should be Infinity (pass)
    expect(metrics.maxDrawdownR).toBe(0);
    expect(metrics.totalR).toBeGreaterThan(0);
    expect(metrics.riskAdjustedReturn).toBe(Infinity);
    expect(metrics.passed).toBe(true);
    expect(metrics.failedTargets).not.toContain('riskAdjustedReturn');
  });

  it('zero drawdown with zero total R → RAR = 0 (not Infinity)', () => {
    // No trades → totalR = 0, maxDrawdownR = 0 → RAR = 0
    const outcomes: TradeOutcome[] = [];

    const metrics = computeMetrics(
      outcomes,
      1000,
      defaultRiskConfig,
      { maxSingleNameExposurePct: 0, maxAggregateExposurePct: 0 },
      defaultSizingConfig,
    );

    expect(metrics.riskAdjustedReturn).toBe(0);
  });
});

// --- (d) Determinism holds ---

describe('FIX: determinism — same input → identical metrics', () => {
  it('determinism holds after fixes: same outcomes → byte-identical metrics', () => {
    const outcomes: TradeOutcome[] = [
      makeOutcome(2.0, 100, 200),
      makeOutcome(-1.0, 200, 300),
      makeOutcome(3.0, 300, 400),
      makeOutcome(-0.5, 400, 500),
      makeOutcome(1.5, 500, 600),
    ];

    const exposure = { maxSingleNameExposurePct: 0.03, maxAggregateExposurePct: 0.15 };
    const a = computeMetrics(outcomes, 1000, defaultRiskConfig, exposure, defaultSizingConfig);
    const b = computeMetrics(outcomes, 1000, defaultRiskConfig, exposure, defaultSizingConfig);

    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('determinism holds for fill model with fees', () => {
    const params = {
      direction: 'sell' as const,
      midPrice: 1.0,
      sizeUsd: 500,
      liquidityUsd: 100_000,
      entryPrice: 1.0,
      stopPrice: 0.97,
      simConfig: {
        splitPoint: 0.8,
        priorityFeeLamports: 50_000,
        mevTaxBps: 10,
        exchangeFeeBps: 25,
      },
      fillConfig: {
        baseSlippageBps: 50,
        slippageSlopeBps: 5000,
        gapThroughProb: 0.15,
        gapThroughDistance: 0.5,
        lpDrainRatePerBar: 0.001,
      },
    };

    const a = computeFillResult({ ...params, seed: 99 });
    const b = computeFillResult({ ...params, seed: 99 });

    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});
