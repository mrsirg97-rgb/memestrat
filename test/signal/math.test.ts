import { describe, it, expect } from 'vitest';
import {
  ema,
  deviation,
  estd,
  slope,
  zScore,
  classifyBand,
  classifyRegime,
  computeIndicators,
  checkConfirmation,
  generateSignal,
  buildSignalResult,
} from '../../src/signal/math.js';
import type { Bar } from '../../src/types/market.js';
import { DEFAULT_CONFIG } from '../../src/types/config.js';

function makeBar(close: number, volume: number = 1000, netFlow: number = 100, timestamp: number = Date.now()): Bar {
  return {
    timestamp,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume,
    netFlow,
    txnCount: 10,
  };
}

describe('ema', () => {
  it('returns price on first call (no previous EMA)', () => {
    expect(ema(100, undefined, 5)).toBe(100);
  });

  it('smooths toward new price with correct alpha', () => {
    const alpha = 2 / (1 + 5); // 0.333...
    const result = ema(105, 100, 5);
    expect(result).toBeCloseTo(alpha * 105 + (1 - alpha) * 100, 5);
  });

  it('reacts faster with shorter period', () => {
    const short = ema(110, 100, 3); // alpha = 0.5
    const long = ema(110, 100, 10); // alpha = 0.1818...
    expect(short).toBeGreaterThan(long);
  });
});

describe('deviation', () => {
  it('returns price minus EMA', () => {
    expect(deviation(105, 100)).toBe(5);
    expect(deviation(98, 100)).toBe(-2);
  });
});

describe('estd', () => {
  it('returns absolute deviation on first call', () => {
    expect(estd(105, 100, undefined, 5)).toBeCloseTo(5);
    expect(estd(95, 100, undefined, 5)).toBeCloseTo(5);
  });

  it('smooths toward new deviation squared', () => {
    const result = estd(105, 100, 3, 5);
    // alpha = 0.333, dev = 5, devSq = 25, prevEstd = 3
    // sqrt(0.333 * 25 + 0.667 * 9) = sqrt(8.33 + 6) = sqrt(14.33) ≈ 3.786
    expect(result).toBeGreaterThan(3);
    expect(result).toBeLessThan(5);
  });
});

describe('slope', () => {
  it('returns rate of change per bar', () => {
    expect(slope(105, 100, 10)).toBe(0.5);
    expect(slope(95, 100, 5)).toBe(-1);
  });

  it('returns 0 when bar count is 0', () => {
    expect(slope(105, 100, 0)).toBe(0);
  });
});

describe('zScore', () => {
  it('returns deviation divided by ESTD', () => {
    expect(zScore(105, 100, 2.5)).toBe(2);
    expect(zScore(98, 100, 1)).toBe(-2);
  });

  it('returns 0 when ESTD is 0', () => {
    expect(zScore(105, 100, 0)).toBe(0);
  });
});

describe('classifyBand', () => {
  const thresholds = DEFAULT_CONFIG.zscore;

  it('classifies overbought above threshold', () => {
    expect(classifyBand(2, thresholds)).toBe('overbought');
  });

  it('classifies rich between 0 and overbought', () => {
    expect(classifyBand(1, thresholds)).toBe('rich');
    expect(classifyBand(0, thresholds)).toBe('rich');
  });

  it('classifies cheap between oversold and 0', () => {
    expect(classifyBand(-1, thresholds)).toBe('cheap');
  });

  it('classifies oversold below threshold', () => {
    expect(classifyBand(-2, thresholds)).toBe('oversold');
  });
});

describe('classifyRegime', () => {
  const thresholds = DEFAULT_CONFIG.regime;

  it('classifies uptrend when ROC > T_up', () => {
    expect(classifyRegime(160, 100, thresholds)).toBe('UPTREND'); // 60% up > 50% threshold
    expect(classifyRegime(200, 100, thresholds)).toBe('UPTREND'); // 100% up
  });

  it('classifies downtrend when ROC < -T_down', () => {
    expect(classifyRegime(40, 100, thresholds)).toBe('DOWNTREND'); // 60% down < -50% threshold
    expect(classifyRegime(30, 100, thresholds)).toBe('DOWNTREND'); // 70% down
  });

  it('classifies ranging when between thresholds', () => {
    expect(classifyRegime(100, 100, thresholds)).toBe('RANGING');
    expect(classifyRegime(110, 100, thresholds)).toBe('RANGING'); // 10% up
    expect(classifyRegime(90, 100, thresholds)).toBe('RANGING'); // 10% down
  });

  it('returns RANGING when no historical price', () => {
    expect(classifyRegime(120, undefined, thresholds)).toBe('RANGING');
    expect(classifyRegime(120, 0, thresholds)).toBe('RANGING');
  });
});

describe('computeIndicators', () => {
  it('computes all indicators from a bar', () => {
    const bar = makeBar(100);
    const result = computeIndicators(
      bar,
      undefined, undefined, undefined, undefined,
      undefined, undefined,
      undefined, // priceAtWindowStart
      10,
      DEFAULT_CONFIG.ema,
      DEFAULT_CONFIG.regime,
      DEFAULT_CONFIG.zscore,
    );

    expect(result.shortEma).toBe(100); // first bar, EMA = price
    expect(result.longEma).toBe(100);
    expect(result.shortZ).toBe(0); // no deviation on first bar
    expect(result.longZ).toBe(0);
    expect(result.regime).toBe('RANGING'); // no price history
  });

  it('detects uptrend after a sharp price jump (memecoin pump pattern)', () => {
    const emaWindows = DEFAULT_CONFIG.ema;
    const regimeThresholds = DEFAULT_CONFIG.regime;
    const zscoreThresholds = DEFAULT_CONFIG.zscore;

    // Simulate a flat period followed by a sharp pump (the memecoin pattern).
    let shortEma: number | undefined;
    let longEma: number | undefined;
    let shortEstd: number | undefined;
    let longEstd: number | undefined;
    const slopeWindow = 10;
    const longEmaHistory: number[] = [];
    const priceHistory: number[] = [];

    for (let i = 0; i < 60; i++) {
      // Flat for 30 bars, then 10% jump per bar (pump)
      const price = i < 30 ? 100 : 100 * Math.pow(1.10, i - 30);
      const bar = makeBar(price);

      const longSlopeStart = longEmaHistory.length >= slopeWindow ? longEmaHistory[longEmaHistory.length - slopeWindow] : undefined;
      const priceAtWindowStart = priceHistory.length >= slopeWindow ? priceHistory[priceHistory.length - slopeWindow] : undefined;

      const result = computeIndicators(
        bar,
        shortEma, longEma, shortEstd, longEstd,
        undefined, longSlopeStart,
        priceAtWindowStart,
        slopeWindow,
        emaWindows, regimeThresholds, zscoreThresholds,
      );

      shortEma = result.shortEma;
      longEma = result.longEma;
      shortEstd = result.shortEstd;
      longEstd = result.longEstd;
      longEmaHistory.push(result.longEma);
      priceHistory.push(price);

      if (i >= 35 && i <= 45) {
        // After the pump starts, ROC should spike above threshold
        expect(result.regime).toBe('UPTREND');
        break;
      }
    }
  });
});

describe('checkConfirmation', () => {
  const config = DEFAULT_CONFIG.confirmation;

  it('passes when all conditions are met', () => {
    const bar = makeBar(100, 2000, 500);
    const liquidity = { liquidityUsd: 50_000, timestamp: Date.now() };
    const volumeEma = 1000;
    const netFlowHistory = [100, 200, 300, 400, 500];
    const slippageBps = 50;

    const result = checkConfirmation(bar, liquidity, volumeEma, netFlowHistory, slippageBps, config);
    expect(result.confirmed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('fails when liquidity is below floor', () => {
    const bar = makeBar(100, 2000, 500);
    const liquidity = { liquidityUsd: 5_000, timestamp: Date.now() };
    const volumeEma = 1000;
    const netFlowHistory = [100, 200, 300, 400, 500];
    const slippageBps = 50;

    const result = checkConfirmation(bar, liquidity, volumeEma, netFlowHistory, slippageBps, config);
    expect(result.confirmed).toBe(false);
    expect(result.failures.some((f) => f.includes('liquidity'))).toBe(true);
  });

  it('fails when volume does not expand', () => {
    const bar = makeBar(100, 500, 500); // volume 500 < 1000 * 1.5 = 1500
    const liquidity = { liquidityUsd: 50_000, timestamp: Date.now() };
    const volumeEma = 1000;
    const netFlowHistory = [100, 200, 300, 400, 500];
    const slippageBps = 50;

    const result = checkConfirmation(bar, liquidity, volumeEma, netFlowHistory, slippageBps, config);
    expect(result.confirmed).toBe(false);
    expect(result.failures.some((f) => f.includes('volume'))).toBe(true);
  });

  it('fails when net flow is negative', () => {
    const bar = makeBar(100, 2000, -100);
    const liquidity = { liquidityUsd: 50_000, timestamp: Date.now() };
    const volumeEma = 1000;
    const netFlowHistory = [-100, -200, -300, -400, -500];
    const slippageBps = 50;

    const result = checkConfirmation(bar, liquidity, volumeEma, netFlowHistory, slippageBps, config);
    expect(result.confirmed).toBe(false);
    expect(result.failures.some((f) => f.includes('flow'))).toBe(true);
  });

  it('fails when slippage exceeds cap', () => {
    const bar = makeBar(100, 2000, 500);
    const liquidity = { liquidityUsd: 50_000, timestamp: Date.now() };
    const volumeEma = 1000;
    const netFlowHistory = [100, 200, 300, 400, 500];
    const slippageBps = 200; // > 100 cap

    const result = checkConfirmation(bar, liquidity, volumeEma, netFlowHistory, slippageBps, config);
    expect(result.confirmed).toBe(false);
    expect(result.failures.some((f) => f.includes('slippage'))).toBe(true);
  });
});

describe('generateSignal', () => {
  it('returns NOOP in downtrend (hard veto)', () => {
    expect(generateSignal(100, 'DOWNTREND', -2, -1, -0.5, true, false)).toBe('NOOP');
    expect(generateSignal(100, 'DOWNTREND', -2, -1, -0.5, false, false)).toBe('NOOP');
  });

  it('returns NOOP in ranging when ranging is disabled', () => {
    expect(generateSignal(100, 'RANGING', -2, -1, 0, true, false)).toBe('NOOP');
  });

  it('returns BUY in ranging when oversold and confirmed (ranging enabled)', () => {
    expect(generateSignal(100, 'RANGING', -2, -1, 0, true, true)).toBe('BUY');
  });

  it('returns SELL in ranging when overbought (ranging enabled)', () => {
    expect(generateSignal(100, 'RANGING', 2, 1, 0, true, true)).toBe('SELL');
  });

  it('returns BUY in uptrend on pullback with positive slope and confirmed', () => {
    expect(generateSignal(100, 'UPTREND', -0.5, 0.5, 0.1, true, false)).toBe('BUY');
  });

  it('returns NOOP in uptrend when not on pullback', () => {
    expect(generateSignal(100, 'UPTREND', 2, 1.5, 0.1, true, false)).toBe('NOOP');
  });

  it('returns NOOP in uptrend when unconfirmed', () => {
    expect(generateSignal(100, 'UPTREND', -0.5, 0.5, 0.1, false, false)).toBe('NOOP');
  });

  it('does NOT sell on overbought in uptrend (trend working)', () => {
    expect(generateSignal(100, 'UPTREND', 2, 1.5, 0.1, true, false)).toBe('NOOP');
  });
});

describe('buildSignalResult', () => {
  it('builds a complete signal result', () => {
    const bar = makeBar(100);
    const indicators = computeIndicators(
      bar,
      undefined, undefined, undefined, undefined,
      undefined, undefined,
      undefined, // priceAtWindowStart
      10,
      DEFAULT_CONFIG.ema,
      DEFAULT_CONFIG.regime,
      DEFAULT_CONFIG.zscore,
    );

    const result = buildSignalResult(bar, indicators, true, [], false);

    expect(result.signal).toBe('NOOP'); // first bar, ranging, disabled
    expect(result.confirmed).toBe(true);
    expect(result.confirmationFailures).toHaveLength(0);
    expect(result.timestamp).toBe(bar.timestamp);
    expect(result.indicators).toBe(indicators);
  });
});
