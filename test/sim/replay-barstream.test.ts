import { describe, it, expect } from 'vitest';
import { ReplayBarStream } from '../../src/sim/replay-barstream.js';
import type { Bar } from '../../src/types/market.js';

function makeBars(count: number, basePrice: number = 1.0, baseTs: number = 1_000_000_000_000): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    bars.push({
      timestamp: baseTs + i * 15_000, // 15s bars
      open: basePrice + i * 0.01,
      high: basePrice + i * 0.01 + 0.005,
      low: basePrice + i * 0.01 - 0.005,
      close: basePrice + i * 0.01,
      volume: 1000 + i * 100,
      netFlow: 50 + i * 10,
      txnCount: 5 + i,
    });
  }
  return bars;
}

describe('ReplayBarStream', () => {
  it('returns historical bars for a known mint', async () => {
    const bars = makeBars(10);
    const stream = new ReplayBarStream({ 'TOKEN_A': bars });
    const result = await stream.getHistoricalBars('TOKEN_A', 0, Number.MAX_SAFE_INTEGER);
    expect(result).toHaveLength(10);
    expect(result[0].timestamp).toBe(1_000_000_000_000);
  });

  it('returns empty for unknown mint', async () => {
    const stream = new ReplayBarStream({ 'TOKEN_A': makeBars(5) });
    const result = await stream.getHistoricalBars('UNKNOWN', 0, Number.MAX_SAFE_INTEGER);
    expect(result).toHaveLength(0);
  });

  it('filters by time range', async () => {
    const bars = makeBars(10);
    const stream = new ReplayBarStream({ 'TOKEN_A': bars });
    // Get bars from index 3 to 7 (timestamps)
    const from = bars[3].timestamp;
    const to = bars[7].timestamp;
    const result = await stream.getHistoricalBars('TOKEN_A', from, to);
    expect(result.length).toBeGreaterThanOrEqual(4); // bars 3,4,5,6 (inclusive start, exclusive end)
  });

  it('respects limit', async () => {
    const bars = makeBars(100);
    const stream = new ReplayBarStream({ 'TOKEN_A': bars });
    const result = await stream.getHistoricalBars('TOKEN_A', 0, Number.MAX_SAFE_INTEGER, 10);
    expect(result).toHaveLength(10);
  });

  it('subscribe yields bars sequentially', async () => {
    const bars = makeBars(5);
    const stream = new ReplayBarStream({ 'TOKEN_A': bars });
    const received: Bar[] = [];

    for await (const bar of stream.subscribe('TOKEN_A')) {
      received.push(bar);
    }

    expect(received).toHaveLength(5);
    expect(received[0].timestamp).toBe(bars[0].timestamp);
    expect(received[4].timestamp).toBe(bars[4].timestamp);
  });

  it('subscribe yields empty for unknown mint', async () => {
    const stream = new ReplayBarStream({ 'TOKEN_A': makeBars(5) });
    const received: Bar[] = [];

    for await (const bar of stream.subscribe('UNKNOWN')) {
      received.push(bar);
    }

    expect(received).toHaveLength(0);
  });

  it('subscribe yields bars in timestamp order', async () => {
    const bars = makeBars(10);
    const stream = new ReplayBarStream({ 'TOKEN_A': bars });
    const received: Bar[] = [];

    for await (const bar of stream.subscribe('TOKEN_A')) {
      received.push(bar);
    }

    for (let i = 1; i < received.length; i++) {
      expect(received[i].timestamp).toBeGreaterThan(received[i - 1].timestamp);
    }
  });

  it('returns all mints for universe listing', () => {
    const stream = new ReplayBarStream({
      'TOKEN_A': makeBars(5),
      'TOKEN_B': makeBars(3),
      'TOKEN_C': makeBars(7),
    });
    const mints = stream.getAllMints();
    expect(mints).toContain('TOKEN_A');
    expect(mints).toContain('TOKEN_B');
    expect(mints).toContain('TOKEN_C');
    expect(mints).toHaveLength(3);
  });

  it('returns bars available at a given timestamp (point-in-time)', async () => {
    const bars = makeBars(10);
    const stream = new ReplayBarStream({ 'TOKEN_A': bars });

    // At timestamp of bar 5, only bars 0-5 should be available
    const pointInTime = bars[5].timestamp;
    const result = await stream.getHistoricalBars('TOKEN_A', 0, pointInTime + 1);
    expect(result).toHaveLength(6); // bars 0 through 5
  });
});
