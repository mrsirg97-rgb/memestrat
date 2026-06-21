import { describe, it, expect } from 'vitest';
import {
  createPosition,
  managePosition,
  advancePosition,
  calculateSize,
  calculatePnlR,
  buildTradeOutcome,
} from '../../src/signal/position.js';
import { DEFAULT_CONFIG } from '../../src/types/config.js';

describe('createPosition', () => {
  const exitConfig = DEFAULT_CONFIG.exit;

  it('creates a position with correct stop price', () => {
    const pos = createPosition('mint1', 100, 1000, exitConfig, Date.now());
    expect(pos.stop).toBeCloseTo(100 * (1 - exitConfig.hardStopPct));
    expect(pos.stop).toBeCloseTo(97); // 3% stop
  });

  it('creates TP ladder from config', () => {
    const pos = createPosition('mint1', 100, 1000, exitConfig, Date.now());
    expect(pos.tpLadder).toHaveLength(3);
    expect(pos.tpLadder[0].target).toBeCloseTo(100 * 1.03);
    expect(pos.tpLadder[1].target).toBeCloseTo(100 * 1.06);
    expect(pos.tpLadder[2].target).toBeCloseTo(100 * 1.10);
  });

  it('starts trail at hard stop', () => {
    const pos = createPosition('mint1', 100, 1000, exitConfig, Date.now());
    expect(pos.trail).toBeCloseTo(pos.stop);
  });

  it('starts with age 0', () => {
    const pos = createPosition('mint1', 100, 1000, exitConfig, Date.now());
    expect(pos.ageBars).toBe(0);
  });
});

describe('managePosition', () => {
  const exitConfig = DEFAULT_CONFIG.exit;

  function makePosition(price: number = 100) {
    return createPosition('mint1', price, 1000, exitConfig, Date.now());
  }

  it('closes on hard stop', () => {
    const pos = makePosition(100);
    const action = managePosition(pos, 96.9, 'UPTREND');
    expect(action.type).toBe('CLOSE');
    expect(action.type === 'CLOSE' ? action.reason : undefined).toBe('stop');
  });

  it('hits TP ladder and reduces', () => {
    const pos = makePosition(100);
    const action = managePosition(pos, 103.1, 'UPTREND');
    expect(action.type).toBe('REDUCE');
    expect(action.type === 'REDUCE' ? action.sizeFrac : undefined).toBe(0.5);
  });

  it('closes on trailing stop after price goes up then down', () => {
    const pos = makePosition(100);
    // Price goes up — trail should arm
    managePosition(pos, 110, 'UPTREND');
    expect(pos.trail).toBeGreaterThan(pos.stop);

    // Price drops below trail
    const action = managePosition(pos, 105, 'UPTREND');
    expect(action.type).toBe('CLOSE');
    if (action.type === 'CLOSE') expect(action.reason).toBe('trail');
  });

  it('closes on time stop when position is stagnant', () => {
    const pos = makePosition(100);
    pos.ageBars = exitConfig.maxAgeBars; // force max age
    const action = managePosition(pos, 100, 'RANGING'); // no progress
    expect(action.type).toBe('CLOSE');
    if (action.type === 'CLOSE') expect(action.reason).toBe('time');
  });

  it('does NOT close on time stop when position has progressed', () => {
    const pos = makePosition(100);
    pos.ageBars = exitConfig.maxAgeBars;
    const action = managePosition(pos, 100.1, 'RANGING'); // minProgress = 1.0, so 100.1 > 100 * 1.0
    expect(action.type).toBe('HOLD');
  });

  it('closes on regime flip to downtrend', () => {
    const pos = makePosition(100);
    const action = managePosition(pos, 101, 'DOWNTREND');
    expect(action.type).toBe('CLOSE');
    if (action.type === 'CLOSE') expect(action.reason).toBe('regime');
  });

  it('holds when no exit condition is met', () => {
    const pos = makePosition(100);
    const action = managePosition(pos, 102, 'UPTREND');
    expect(action.type).toBe('HOLD');
  });

  it('hard stop takes priority over TP', () => {
    const pos = makePosition(100);
    // Price is below stop — should close on stop, not TP
    const action = managePosition(pos, 96.9, 'UPTREND');
    expect(action.type).toBe('CLOSE');
    if (action.type === 'CLOSE') expect(action.reason).toBe('stop');
  });
});

describe('advancePosition', () => {
  const exitConfig = DEFAULT_CONFIG.exit;

  it('increments age by 1', () => {
    const pos = createPosition('mint1', 100, 1000, exitConfig, Date.now());
    advancePosition(pos, 100);
    expect(pos.ageBars).toBe(1);
  });

  it('marks TP levels as hit when price passes them', () => {
    const pos = createPosition('mint1', 100, 1000, exitConfig, Date.now());
    advancePosition(pos, 105); // above first TP at 103
    expect(pos.tpLadder[0].hit).toBe(true);
    expect(pos.tpLadder[1].hit).toBe(false); // below second TP at 106
  });
});

describe('calculateSize', () => {
  const sizingConfig = DEFAULT_CONFIG.sizing;

  it('sizes by risk when liquidity is not binding', () => {
    const size = calculateSize(10_000, 100, 97, 1_000_000, sizingConfig);
    // riskBudget = 10000 * 0.015 = 150
    // stopDistance / entry = 3 / 100 = 0.03
    // sizeByRisk = 150 / 0.03 = 5000
    // sizeByLiq = 1_000_000 * 0.02 = 20_000
    // min = 5000
    expect(size).toBeCloseTo(5000);
  });

  it('sizes by liquidity when it is binding', () => {
    const size = calculateSize(10_000, 100, 97, 10_000, sizingConfig);
    // sizeByRisk = 5000 (as above)
    // sizeByLiq = 10_000 * 0.02 = 200
    // min = 200
    expect(size).toBeCloseTo(200);
  });

  it('returns 0 when stop distance is zero or negative', () => {
    const size = calculateSize(10_000, 100, 100, 1_000_000, sizingConfig);
    expect(size).toBe(0);
  });
});

describe('calculatePnlR', () => {
  it('returns -1R for a stop hit', () => {
    const result = calculatePnlR(100, 97, 97, 1000);
    expect(result.pnlR).toBeCloseTo(-1);
  });

  it('returns +3R for a 3:1 winner', () => {
    // entry=100, stop=97, risk=3 per share
    // exit=109, gain=9 per share → 9/3 = 3R
    const result = calculatePnlR(100, 109, 97, 1000);
    expect(result.pnlR).toBeCloseTo(3);
  });

  it('returns 0 for breakeven', () => {
    const result = calculatePnlR(100, 100, 97, 1000);
    expect(result.pnlR).toBeCloseTo(0);
  });

  it('calculates correct USD PnL', () => {
    const result = calculatePnlR(100, 103, 97, 1000);
    // gain = 3/100 * 1000 = 30 USD
    expect(result.pnlUsd).toBeCloseTo(30);
    // risk = 3/100 * 1000 = 30 USD
    expect(result.riskAmount).toBeCloseTo(30);
  });

  it('handles gap-through stop (worse than -1R)', () => {
    // exit below stop
    const result = calculatePnlR(100, 95, 97, 1000);
    expect(result.pnlR).toBeLessThan(-1);
    expect(result.pnlR).toBeCloseTo(-1.667, 2);
  });
});

describe('buildTradeOutcome', () => {
  const exitConfig = DEFAULT_CONFIG.exit;

  it('builds a complete trade outcome', () => {
    const pos = createPosition('mint1', 100, 1000, exitConfig, Date.now());
    const outcome = buildTradeOutcome(pos, 103, 'tp', Date.now());

    expect(outcome.mint).toBe('mint1');
    expect(outcome.entry).toBe(100);
    expect(outcome.exitPrice).toBe(103);
    expect(outcome.exitReason).toBe('tp');
    expect(outcome.closed).toBe(true);
    expect(outcome.pnlR).toBeGreaterThan(0);
  });

  it('records stop loss correctly', () => {
    const pos = createPosition('mint1', 100, 1000, exitConfig, Date.now());
    const outcome = buildTradeOutcome(pos, 97, 'stop', Date.now());

    expect(outcome.pnlR).toBeCloseTo(-1);
    expect(outcome.exitReason).toBe('stop');
  });
});
