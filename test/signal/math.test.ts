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
  ZSCORE_EPSILON,
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

  it('returns undefined when ESTD is 0 (fail closed)', () => {
    expect(zScore(105, 100, 0)).toBeUndefined();
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
    expect(result.shortZ).toBeUndefined(); // no ESTD history on first bar → undefined
    expect(result.longZ).toBeUndefined();
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

// ---- FIX 2: Division-by-zero guards, fail closed ----

describe('zScore ESTD-below-epsilon guard', () => {
  it('returns undefined when ESTD is exactly 0', () => {
    expect(zScore(105, 100, 0)).toBeUndefined();
  });

  it('returns undefined when ESTD < epsilon (flat pre-pump bars)', () => {
    expect(zScore(105, 100, ZSCORE_EPSILON / 2)).toBeUndefined();
  });

  it('returns defined z when ESTD >= epsilon', () => {
    const result = zScore(105, 100, ZSCORE_EPSILON);
    expect(result).toBeDefined();
    expect(typeof result).toBe('number');
  });

  it('returns correct z when ESTD is well above epsilon', () => {
    expect(zScore(105, 100, 2.5)).toBe(2);
  });

  it('returns undefined for negative deviation with zero ESTD', () => {
    expect(zScore(95, 100, 0)).toBeUndefined();
  });
});

describe('classifyBand with undefined z', () => {
  const thresholds = DEFAULT_CONFIG.zscore;

  it('returns undefined when z is undefined', () => {
    expect(classifyBand(undefined, thresholds)).toBeUndefined();
  });

  it('still classifies normally when z is defined', () => {
    expect(classifyBand(2, thresholds)).toBe('overbought');
    expect(classifyBand(1, thresholds)).toBe('rich');
    expect(classifyBand(-1, thresholds)).toBe('cheap');
    expect(classifyBand(-2, thresholds)).toBe('oversold');
  });
});

describe('warmup period — insufficient bars', () => {
  it('classifyRegime returns RANGING when no price history', () => {
    expect(classifyRegime(100, undefined, DEFAULT_CONFIG.regime)).toBe('RANGING');
  });

  it('computeIndicators returns undefined z on first bar (no ESTD history)', () => {
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
    expect(result.shortZ).toBeUndefined();
    expect(result.longZ).toBeUndefined();
    expect(result.regime).toBe('RANGING');
  });

  it('generateSignal returns NOOP when z is undefined (warmup)', () => {
    // UPTREND regime but undefined z → fail closed
    expect(generateSignal(100, 'UPTREND', undefined, undefined, 0.1, true, false)).toBe('NOOP');
    // RANGING regime with ranging enabled but undefined z → fail closed
    expect(generateSignal(100, 'RANGING', undefined, undefined, 0.1, true, true)).toBe('NOOP');
  });
});

describe('ESTD-below-epsilon ⇒ NOOP', () => {
  it('zScore returns undefined for tiny ESTD', () => {
    const tinyEstd = 1e-15; // far below epsilon
    expect(zScore(100.001, 100, tinyEstd)).toBeUndefined();
  });

  it('computeIndicators propagates undefined z when ESTD < epsilon', () => {
    const bar = makeBar(100);
    // Simulate a state where ESTD has converged to near-zero (flat price)
    const result = computeIndicators(
      bar,
      100, 100, // EMAs at price
      1e-15, 1e-15, // ESTDs near zero
      undefined, undefined,
      100, // priceAtWindowStart
      10,
      DEFAULT_CONFIG.ema,
      DEFAULT_CONFIG.regime,
      DEFAULT_CONFIG.zscore,
    );
    expect(result.shortZ).toBeUndefined();
    expect(result.longZ).toBeUndefined();
  });

  it('signal degrades to NOOP when shortZ undefined in UPTREND', () => {
    const signal = generateSignal(100, 'UPTREND', undefined, 1.0, 0.5, true, false);
    expect(signal).toBe('NOOP');
  });

  it('signal degrades to NOOP when either z undefined in RANGING', () => {
    expect(generateSignal(100, 'RANGING', undefined, -2.0, 0, true, true)).toBe('NOOP');
    expect(generateSignal(100, 'RANGING', -2.0, undefined, 0, true, true)).toBe('NOOP');
  });
});

describe('ROC denominator guard', () => {
  it('returns RANGING when priceAtWindowStart is 0', () => {
    expect(classifyRegime(100, 0, DEFAULT_CONFIG.regime)).toBe('RANGING');
  });

  it('returns RANGING when priceAtWindowStart is near-zero', () => {
    expect(classifyRegime(100, 1e-10, DEFAULT_CONFIG.regime)).toBe('RANGING');
  });

  it('returns RANGING when priceAtWindowStart is undefined', () => {
    expect(classifyRegime(100, undefined, DEFAULT_CONFIG.regime)).toBe('RANGING');
  });

  it('classifies normally when priceAtWindowStart is well above epsilon', () => {
    expect(classifyRegime(160, 100, DEFAULT_CONFIG.regime)).toBe('UPTREND');
    expect(classifyRegime(40, 100, DEFAULT_CONFIG.regime)).toBe('DOWNTREND');
  });
});

describe('regime boundary conditions at ±T', () => {
  const thresholds = DEFAULT_CONFIG.regime; // tUp = 0.5, tDown = 0.5

  it('ROC exactly at +T_up → RANGING (strictly greater required)', () => {
    // roc = (150 - 100) / 100 = 0.5 = T_up exactly → RANGING
    expect(classifyRegime(150, 100, thresholds)).toBe('RANGING');
  });

  it('ROC exactly at -T_down → RANGING (strictly less required)', () => {
    // roc = (50 - 100) / 100 = -0.5 = -T_down exactly → RANGING
    expect(classifyRegime(50, 100, thresholds)).toBe('RANGING');
  });

  it('ROC just above +T_up → UPTREND', () => {
    // roc = 0.5001 > 0.5
    expect(classifyRegime(150.01, 100, thresholds)).toBe('UPTREND');
  });

  it('ROC just below -T_down → DOWNTREND', () => {
    // roc = -0.5001 < -0.5
    expect(classifyRegime(49.99, 100, thresholds)).toBe('DOWNTREND');
  });

  it('ROC at 0 → RANGING', () => {
    expect(classifyRegime(100, 100, thresholds)).toBe('RANGING');
  });

  it('ROC slightly positive but below T_up → RANGING', () => {
    expect(classifyRegime(110, 100, thresholds)).toBe('RANGING');
  });

  it('ROC slightly negative but above -T_down → RANGING', () => {
    expect(classifyRegime(90, 100, thresholds)).toBe('RANGING');
  });
});

// ---- FIX 4: Property tests for invariants ----

describe('invariant: generateSignal always returns a valid Signal', () => {
  const validSignals = ['BUY', 'SELL', 'NOOP'] as const;

  it.each([
    ['UPTREND', 0, 0, 0, true, false],
    ['UPTREND', -1, 0, 0.1, true, false],
    ['UPTREND', 2, 1.5, 0.1, true, false],
    ['UPTREND', undefined, undefined, 0.1, true, false],
    ['DOWNTREND', -2, -1, -0.5, true, false],
    ['DOWNTREND', 2, 1, 0.5, true, false],
    ['DOWNTREND', undefined, undefined, 0, false, false],
    ['RANGING', -2, -1, 0, true, true],
    ['RANGING', 2, 1, 0, true, true],
    ['RANGING', undefined, undefined, 0, true, true],
    ['RANGING', -2, -1, 0, true, false],
  ])('(%s, shortZ=%s, longZ=%s, shortSlope=%s, confirmed=%s, ranging=%s) → valid signal',
    (regime, shortZ, longZ, shortSlope, confirmed, ranging) => {
      const signal = generateSignal(100, regime, shortZ, longZ, shortSlope, confirmed, ranging);
      expect(validSignals).toContain(signal);
    },
  );
});

describe('invariant: DOWNTREND always → NOOP regardless of z/slope', () => {
  it.each([
    [-2, -1, -0.5, true],
    [2, 1, 0.5, true],
    [0, 0, 0, false],
    [undefined, undefined, 0, true],
    [100, -100, 1000, true],
  ])('shortZ=%s, longZ=%s, shortSlope=%s, confirmed=%s → NOOP',
    (shortZ, longZ, shortSlope, confirmed) => {
      expect(generateSignal(100, 'DOWNTREND', shortZ, longZ, shortSlope, confirmed, false)).toBe('NOOP');
    },
  );
});

describe('invariant: classifyRegime always returns a valid Regime', () => {
  const validRegimes = ['UPTREND', 'DOWNTREND', 'RANGING'] as const;

  it.each([
    [0, 100],
    [100, 100],
    [200, 100],
    [50, 100],
    [0.001, 100],
    [1000, 100],
    [100, 0],
    [100, 0.001],
    [100, undefined as any],
  ])('currentPrice=%s, priceAtWindowStart=%s → valid regime',
    (currentPrice, priceAtWindowStart) => {
      const regime = classifyRegime(currentPrice, priceAtWindowStart, DEFAULT_CONFIG.regime);
      expect(validRegimes).toContain(regime);
    },
  );
});

describe('invariant: zScore magnitude relates to deviation', () => {
  it('when z is defined, |z| * estd ≈ |deviation|', () => {
    const price = 105;
    const emaVal = 100;
    const estdVal = 2.5;
    const z = zScore(price, emaVal, estdVal);

    expect(z).toBeDefined();
    if (z !== undefined) {
      const dev = Math.abs(deviation(price, emaVal));
      const reconstructed = Math.abs(z) * estdVal;
      expect(reconstructed).toBeCloseTo(dev, 10);
    }
  });

  it('negative deviation produces negative z', () => {
    const z = zScore(95, 100, 2.5);
    expect(z).toBeDefined();
    expect(z).toBeLessThan(0);
  });

  it('positive deviation produces positive z', () => {
    const z = zScore(105, 100, 2.5);
    expect(z).toBeDefined();
    expect(z).toBeGreaterThan(0);
  });

  it('zero deviation produces z = 0', () => {
    const z = zScore(100, 100, 2.5);
    expect(z).toBe(0);
  });
});

describe('invariant: UPTREND only fires BUY on pullback with positive slope', () => {
  it('BUY requires shortZ <= 0 AND shortSlope > 0 AND confirmed', () => {
    // All conditions met
    expect(generateSignal(100, 'UPTREND', -0.5, 0.5, 0.1, true, false)).toBe('BUY');

    // shortZ > 0 → NOOP
    expect(generateSignal(100, 'UPTREND', 0.5, 0.5, 0.1, true, false)).toBe('NOOP');

    // shortSlope <= 0 → NOOP
    expect(generateSignal(100, 'UPTREND', -0.5, 0.5, 0, true, false)).toBe('NOOP');
    expect(generateSignal(100, 'UPTREND', -0.5, 0.5, -0.1, true, false)).toBe('NOOP');

    // unconfirmed → NOOP
    expect(generateSignal(100, 'UPTREND', -0.5, 0.5, 0.1, false, false)).toBe('NOOP');
  });

  it('does NOT sell on overbought in UPTREND (trend working)', () => {
    expect(generateSignal(100, 'UPTREND', 3, 2, 0.1, true, false)).toBe('NOOP');
  });
});
