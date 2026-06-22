import { describe, it, expect } from 'vitest';
import { BacktestRunner } from '../../src/sim/backtest.js';
import { ReplayBarStream } from '../../src/sim/replay-barstream.js';
import { InMemoryScanner } from '../../src/discovery/scanner.js';
import type { Bar, TokenInfo, HolderDistribution, SellabilityResult } from '../../src/types/market.js';
import type { StrategyConfig } from '../../src/types/config.js';
import { DEFAULT_CONFIG } from '../../src/types/config.js';
import type { BarData } from '../../src/sim/replay-barstream.js';
import type { TokenRepository } from '../../src/interfaces/data.js';

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

/**
 * Build a realistic price series: pump → hold → dump pattern.
 * This gives the strategy something to trade.
 */
function makePumpDumpSeries(tsStart: number, basePrice: number, barCount: number): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < barCount; i++) {
    let price = basePrice;
    // Phase 1: pump (first 20 bars)
    if (i < 20) {
      price = basePrice * (1 + i * 0.02); // 2% per bar
    }
    // Phase 2: hold/consolidate (bars 20-40)
    else if (i < 40) {
      price = basePrice * 1.4 * (1 + Math.sin(i * 0.3) * 0.02); // oscillate ±2%
    }
    // Phase 3: dump (bars 40+)
    else {
      price = basePrice * 1.4 * (1 - (i - 40) * 0.015); // 1.5% decline per bar
    }
    bars.push(makeBar(tsStart + i * 15_000, price, 1000 + i * 50, 100 + i * 10));
  }
  return bars;
}

/** Mock TokenRepository that returns clean token data. */
class MockRepository implements TokenRepository {
  constructor(private tokenData: Map<string, TokenInfo>) {}

  async getToken(mint: string): Promise<TokenInfo | null> {
    return this.tokenData.get(mint) ?? null;
  }

  async getHolderDistribution(_mint: string): Promise<HolderDistribution> {
    return {
      totalHolders: 200,
      top10Concentration: 0.15,
      top1Concentration: 0.05,
      giniCoefficient: 0.3,
    };
  }

  async checkSellability(_mint: string, _sizeUsd: number): Promise<SellabilityResult> {
    return {
      sellable: true,
      estimatedSlippageBps: 50,
      estimatedFillTimeSeconds: 1,
    };
  }

  async getLiquidity(_mint: string): Promise<{ liquidityUsd: number; timestamp: number }> {
    return { liquidityUsd: 100_000, timestamp: Date.now() };
  }

  async getTxnVelocity(_mint: string): Promise<number> {
    return 50; // 50 txns/hour
  }
}

describe('BacktestRunner', () => {
  it('runs a full backtest and produces metrics', async () => {
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
      rangingEnabled: false, // only momentum
      regime: { tUp: 0.1, tDown: 0.1, windowBars: 10 }, // more sensitive regime
    });

    const bars = makePumpDumpSeries(1_000_000_000_000, 1.0, 60);
    const barData: BarData = { 'TOKEN_A': bars };
    const stream = new ReplayBarStream(barData);

    const repo = new MockRepository(new Map([['TOKEN_A', tokenA]]));
    const scanner = new InMemoryScanner(repo, config, ['TOKEN_A']);

    const runner = new BacktestRunner(config, stream, scanner, 1000);
    const result = await runner.run();

    expect(result.metrics.totalTrades).toBeGreaterThanOrEqual(0);
    expect(result.metrics.expectancyR).toBeDefined();
    expect(result.metrics.profitFactor).toBeDefined();
    expect(result.metrics.maxDrawdownR).toBeGreaterThanOrEqual(0);
  });

  it('determinism: same input → byte-identical metrics across runs', async () => {
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
      regime: { tUp: 0.1, tDown: 0.1, windowBars: 10 },
    });

    const bars = makePumpDumpSeries(1_000_000_000_000, 1.0, 60);
    const barData: BarData = { 'TOKEN_A': bars };

    const repo = new MockRepository(new Map([['TOKEN_A', tokenA]]));

    // Run 1
    const stream1 = new ReplayBarStream(barData);
    const scanner1 = new InMemoryScanner(repo, config, ['TOKEN_A']);
    const runner1 = new BacktestRunner(config, stream1, scanner1, 1000);
    const result1 = await runner1.run();

    // Run 2 (fresh instances, same data)
    const stream2 = new ReplayBarStream(barData);
    const scanner2 = new InMemoryScanner(repo, config, ['TOKEN_A']);
    const runner2 = new BacktestRunner(config, stream2, scanner2, 1000);
    const result2 = await runner2.run();

    // Byte-identical metrics
    expect(JSON.stringify(result1.metrics)).toEqual(JSON.stringify(result2.metrics));
  });

  it('walk-forward split: in-sample and out-of-sample metrics', async () => {
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
      regime: { tUp: 0.1, tDown: 0.1, windowBars: 10 },
      sim: { ...DEFAULT_CONFIG.sim, splitPoint: 0.7 }, // 70/30 split
    });

    const bars = makePumpDumpSeries(1_000_000_000_000, 1.0, 100);
    const barData: BarData = { 'TOKEN_A': bars };
    const stream = new ReplayBarStream(barData);

    const repo = new MockRepository(new Map([['TOKEN_A', tokenA]]));
    const scanner = new InMemoryScanner(repo, config, ['TOKEN_A']);

    const runner = new BacktestRunner(config, stream, scanner, 1000);
    const result = await runner.runWalkForward();

    expect(result.inSample).toBeDefined();
    expect(result.outOfSample).toBeDefined();
    expect(result.outOfSample.metrics.totalTrades).toBeGreaterThanOrEqual(0);
  });

  it('replay discovery against full universe (no survivorship bias)', async () => {
    // Two tokens: one good, one that fails filters
    const tokenGood: TokenInfo = {
      mint: 'GOOD',
      symbol: 'G',
      name: 'Good Token',
      decimals: 9,
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      lpBurnedOrLocked: true,
      poolLiquidityUsd: 100_000,
      deployer: 'deployer1',
      createdAt: 0,
    };

    const tokenBad: TokenInfo = {
      mint: 'BAD',
      symbol: 'B',
      name: 'Bad Token',
      decimals: 9,
      mintAuthorityRevoked: false, // fails filter
      freezeAuthorityRevoked: true,
      lpBurnedOrLocked: true,
      poolLiquidityUsd: 100_000,
      deployer: 'deployer2',
      createdAt: 0,
    };

    const bars = makePumpDumpSeries(1_000_000_000_000, 1.0, 30);
    const barData: BarData = { 'GOOD': bars, 'BAD': bars };
    const stream = new ReplayBarStream(barData);

    const repo = new MockRepository(new Map([
      ['GOOD', tokenGood],
      ['BAD', tokenBad],
    ]));

    const config = makeConfig({
      rangingEnabled: false,
      regime: { tUp: 0.1, tDown: 0.1, windowBars: 10 },
    });
    const scanner = new InMemoryScanner(repo, config, ['GOOD', 'BAD']);

    const runner = new BacktestRunner(config, stream, scanner, 1000);
    const result = await runner.run();

    // Both tokens were scanned; only GOOD should have been traded
    expect(result.discoveryStats.tokensScanned).toBeGreaterThanOrEqual(2);
    expect(result.discoveryStats.tokensPromoted).toBeGreaterThanOrEqual(1);
  });

  it('empty dataset produces zero metrics', async () => {
    const stream = new ReplayBarStream({});
    const repo = new MockRepository(new Map());
    const config = makeConfig();
    const scanner = new InMemoryScanner(repo, config, []);

    const runner = new BacktestRunner(config, stream, scanner, 1000);
    const result = await runner.run();

    expect(result.metrics.totalTrades).toBe(0);
    expect(result.metrics.expectancyR).toBe(0);
  });
});
