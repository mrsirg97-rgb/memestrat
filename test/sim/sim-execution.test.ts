import { describe, it, expect } from 'vitest';
import { SimExecutionEngine } from '../../src/sim/sim-execution.js';
import type { Bar } from '../../src/types/market.js';
import type { StrategyConfig } from '../../src/types/config.js';
import { DEFAULT_CONFIG } from '../../src/types/config.js';

function makeConfig(overrides?: Partial<StrategyConfig>): StrategyConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function makeBar(ts: number, price: number, volume: number = 1000): Bar {
  return {
    timestamp: ts,
    open: price,
    high: price * 1.01,
    low: price * 0.99,
    close: price,
    volume,
    netFlow: 50,
    txnCount: 10,
  };
}

describe('SimExecutionEngine', () => {
  it('returns current price after tick', async () => {
    const engine = new SimExecutionEngine(makeConfig(), ['TOKEN_A'], 100_000);
    engine.tick(makeBar(1_000, 1.0), 'TOKEN_A');
    const price = await engine.getPrice('TOKEN_A');
    expect(price).toBe(1.0);
  });

  it('buy applies slippage above mid', async () => {
    const engine = new SimExecutionEngine(makeConfig(), ['TOKEN_A'], 100_000);
    engine.tick(makeBar(1_000, 1.0), 'TOKEN_A');
    const fillPrice = await engine.buy('TOKEN_A', 500, 100);
    expect(fillPrice).toBeGreaterThan(1.0); // slippage pushes buy up
    // With baseSlippageBps=50 and size/liquidity ratio, fill should be above mid
  });

  it('sell applies slippage below mid', async () => {
    const engine = new SimExecutionEngine(makeConfig(), ['TOKEN_A'], 100_000);
    engine.tick(makeBar(1_000, 1.0), 'TOKEN_A');
    const fillPrice = await engine.sell('TOKEN_A', 500, 100);
    expect(fillPrice).toBeLessThan(1.0); // slippage pushes sell down
  });

  it('rejects buy when liquidity is drained to zero', async () => {
    const config = makeConfig({
      fillModel: {
        ...DEFAULT_CONFIG.fillModel,
        lpDrainRatePerBar: 1.0, // 100% drain per bar
      },
    });
    const engine = new SimExecutionEngine(config, ['TOKEN_A'], 100_000);
    engine.tick(makeBar(1_000, 1.0), 'TOKEN_A');
    engine.tick(makeBar(1_015, 1.0), 'TOKEN_A'); // drain all liquidity
    const fillPrice = await engine.buy('TOKEN_A', 500, 100);
    expect(fillPrice).toBeNull();
  });

  it('tracks liquidity drain over bars', async () => {
    const engine = new SimExecutionEngine(makeConfig(), ['TOKEN_A'], 100_000);
    const initialLiq = engine.getLiquidity('TOKEN_A');
    expect(initialLiq).toBe(100_000);

    engine.tick(makeBar(1_000, 1.0), 'TOKEN_A');
    engine.tick(makeBar(1_015, 1.0), 'TOKEN_A');
    engine.tick(makeBar(1_030, 1.0), 'TOKEN_A');

    const drained = engine.getLiquidity('TOKEN_A');
    // lpDrainRatePerBar = 0.001, after 3 bars: 100_000 * (0.999)^3 ≈ 99_700
    expect(drained).toBeLessThan(100_000);
    expect(drained).toBeCloseTo(100_000 * Math.pow(0.999, 3), 2);
  });

  it('is deterministic for the same tick sequence', async () => {
    const bars = [
      makeBar(1_000, 1.0),
      makeBar(1_015, 1.02),
      makeBar(1_030, 0.98),
    ];

    const engine1 = new SimExecutionEngine(makeConfig(), ['TOKEN_A'], 100_000);
    for (const bar of bars) engine1.tick(bar, 'TOKEN_A');
    const buy1 = await engine1.buy('TOKEN_A', 500, 100);
    const sell1 = await engine1.sell('TOKEN_A', 500, 100);

    const engine2 = new SimExecutionEngine(makeConfig(), ['TOKEN_A'], 100_000);
    for (const bar of bars) engine2.tick(bar, 'TOKEN_A');
    const buy2 = await engine2.buy('TOKEN_A', 500, 100);
    const sell2 = await engine2.sell('TOKEN_A', 500, 100);

    expect(buy1).toBe(buy2);
    expect(sell1).toBe(sell2);
  });

  it('throws for unknown mint price', async () => {
    const engine = new SimExecutionEngine(makeConfig(), ['TOKEN_A'], 100_000);
    await expect(engine.getPrice('UNKNOWN')).rejects.toThrow('No price available');
  });

  it('sells at gap-through price when price drops below stop', async () => {
    const config = makeConfig({
      fillModel: {
        ...DEFAULT_CONFIG.fillModel,
        gapThroughProb: 1.0, // always gap through
        gapThroughDistance: 0.5,
      },
    });
    const engine = new SimExecutionEngine(config, ['TOKEN_A'], 100_000);

    // Entry at 1.0, stop at 0.97
    engine.tick(makeBar(1_000, 1.0), 'TOKEN_A');
    const entryPrice = await engine.buy('TOKEN_A', 500, 100);
    expect(entryPrice).toBeGreaterThan(0);

    // Record the position for gap-through tracking
    engine.recordPosition('TOKEN_A', entryPrice ?? 1.0, 500, 0.97);

    // Price drops below stop
    engine.tick(makeBar(1_015, 0.95), 'TOKEN_A');
    const sellPrice = await engine.sell('TOKEN_A', 500, 100, { entryPrice: 1.0, stopPrice: 0.97 });

    // Gap-through: fill should be worse than stop (0.97)
    // stopDistance = 0.03, gapExtra = 0.015, gapPrice = 0.97 - 0.015 = 0.955
    // But slippage also applies, so it should be below 0.97
    expect(sellPrice).toBeLessThan(0.97);
  });

  it('resets state for a new run', () => {
    const engine = new SimExecutionEngine(makeConfig(), ['TOKEN_A'], 100_000);
    engine.tick(makeBar(1_000, 1.0), 'TOKEN_A');
    engine.tick(makeBar(1_015, 1.02), 'TOKEN_A');

    engine.reset();
    expect(engine.getLiquidity('TOKEN_A')).toBe(100_000);
  });
});
