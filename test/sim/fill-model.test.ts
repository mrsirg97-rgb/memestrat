import { describe, it, expect } from 'vitest';
import { computeFillPrice, computeSlippage, computeGapThrough, computeFeeTax, computeFillResult } from '../../src/sim/fill-model.js';
import type { FillModelConfig, SimConfig } from '../../src/types/config.js';

const defaultFillConfig: FillModelConfig = {
  baseSlippageBps: 50,
  slippageSlopeBps: 5000,
  gapThroughProb: 0.15,
  gapThroughDistance: 0.5,
  lpDrainRatePerBar: 0.001,
};

const defaultSimConfig: SimConfig = {
  splitPoint: 0.8,
  priorityFeeLamports: 50_000,
  mevTaxBps: 10,
  exchangeFeeBps: 25,
};

describe('computeSlippage', () => {
  it('returns base slippage when size is zero', () => {
    const result = computeSlippage(0, 100_000, defaultFillConfig);
    expect(result).toBe(50); // baseSlippageBps only
  });

  it('adds size-based slippage proportional to size/liquidity ratio', () => {
    // size = $1000, liquidity = $100,000 → ratio = 0.01
    // slippage = 50 + 0.01 * 5000 = 50 + 50 = 100 bps
    const result = computeSlippage(1_000, 100_000, defaultFillConfig);
    expect(result).toBe(100);
  });

  it('slippage is large when size approaches liquidity', () => {
    // size = $50,000, liquidity = $100,000 → ratio = 0.5
    // slippage = 50 + 0.5 * 5000 = 50 + 2500 = 2550 bps
    const result = computeSlippage(50_000, 100_000, defaultFillConfig);
    expect(result).toBe(2550);
  });

  it('returns 0 when liquidity is 0 (no fill possible)', () => {
    const result = computeSlippage(100, 0, defaultFillConfig);
    expect(result).toBe(0);
  });
});

describe('computeFeeTax', () => {
  it('combines exchange fee and MEV tax in basis points', () => {
    const result = computeFeeTax(defaultSimConfig);
    expect(result).toBe(35); // 25 + 10
  });

  it('returns just exchange fee when MEV tax is zero', () => {
    const result = computeFeeTax({ ...defaultSimConfig, mevTaxBps: 0 });
    expect(result).toBe(25);
  });
});

describe('computeGapThrough', () => {
  it('returns null when no gap-through occurs', () => {
    // gapThroughProb = 0 means no gap
    const config: FillModelConfig = { ...defaultFillConfig, gapThroughProb: 0 };
    const result = computeGapThrough(100, 97, config, 42);
    expect(result).toBeNull();
  });

  it('returns gap-through price when triggered', () => {
    // gapThroughProb = 1 means always gap
    const config: FillModelConfig = { ...defaultFillConfig, gapThroughProb: 1 };
    const result = computeGapThrough(100, 97, config, 42);
    // stop = 97, entry = 100, stopDistance = 3
    // gapThroughDistance = 0.5 → extra 1.5 below stop
    // fillPrice = 97 - 1.5 = 95.5
    expect(result).toBe(95.5);
  });

  it('is deterministic for the same seed', () => {
    const config: FillModelConfig = { ...defaultFillConfig, gapThroughProb: 0.5 };
    const a = computeGapThrough(100, 97, config, 123);
    const b = computeGapThrough(100, 97, config, 123);
    expect(a).toEqual(b);
  });

  it('differs for different seeds when probability is between 0 and 1', () => {
    const config: FillModelConfig = { ...defaultFillConfig, gapThroughProb: 0.5 };
    const results = new Set();
    for (let seed = 0; seed < 100; seed++) {
      results.add(JSON.stringify(computeGapThrough(100, 97, config, seed)));
    }
    // With 50% probability over 100 trials, both outcomes should appear
    expect(results.size).toBeGreaterThan(1);
  });
});

describe('computeFillPrice (buy)', () => {
  it('applies slippage against mid price for buys', () => {
    const result = computeFillPrice({
      direction: 'buy',
      midPrice: 1.0,
      sizeUsd: 500,
      liquidityUsd: 100_000,
      config: defaultFillConfig,
    });
    // slippage = 50 + (500/100000)*5000 = 50 + 25 = 75 bps
    // buy fill = mid * (1 + slippage/10000) = 1.0 * 1.0075 = 1.0075
    expect(result.fillPrice).toBeCloseTo(1.0075);
    expect(result.slippageBps).toBeCloseTo(75);
  });

  it('applies slippage against mid price for sells', () => {
    const result = computeFillPrice({
      direction: 'sell',
      midPrice: 1.0,
      sizeUsd: 500,
      liquidityUsd: 100_000,
      config: defaultFillConfig,
    });
    // sell fill = mid * (1 - slippage/10000) = 1.0 * 0.9925 = 0.9925
    expect(result.fillPrice).toBeCloseTo(0.9925);
  });

  it('returns null when liquidity is zero', () => {
    const result = computeFillPrice({
      direction: 'buy',
      midPrice: 1.0,
      sizeUsd: 500,
      liquidityUsd: 0,
      config: defaultFillConfig,
    });
    expect(result).toBeNull();
  });
});

describe('computeFillResult (full fill with fees + gap-through)', () => {
  it('computes full fill with fees for a buy', () => {
    const result = computeFillResult({
      direction: 'buy',
      midPrice: 1.0,
      sizeUsd: 500,
      liquidityUsd: 100_000,
      entryPrice: 1.0, // same as mid for buy
      stopPrice: 0.97,
      simConfig: defaultSimConfig,
      fillConfig: defaultFillConfig,
      seed: 42,
    });

    expect(result.fillPrice).toBeGreaterThan(1.0); // slippage pushes buy up
    expect(result.totalTaxBps).toBe(35); // exchange + MEV
    expect(result.isGapThrough).toBe(false); // buy can't gap through stop
  });

  it('tags gap-through for sells worse than -1R', () => {
    const config: FillModelConfig = { ...defaultFillConfig, gapThroughProb: 1 };
    const result = computeFillResult({
      direction: 'sell',
      midPrice: 0.96, // below stop
      sizeUsd: 500,
      liquidityUsd: 100_000,
      entryPrice: 1.0,
      stopPrice: 0.97,
      simConfig: defaultSimConfig,
      fillConfig: config,
      seed: 42,
    });

    expect(result.isGapThrough).toBe(true);
    expect(result.fillPrice).toBeLessThan(0.97); // worse than stop
  });

  it('is deterministic for the same seed', () => {
    const params = {
      direction: 'sell' as const,
      midPrice: 0.96,
      sizeUsd: 500,
      liquidityUsd: 100_000,
      entryPrice: 1.0,
      stopPrice: 0.97,
      simConfig: defaultSimConfig,
      fillConfig: defaultFillConfig,
    };
    const a = computeFillResult({ ...params, seed: 99 });
    const b = computeFillResult({ ...params, seed: 99 });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});
