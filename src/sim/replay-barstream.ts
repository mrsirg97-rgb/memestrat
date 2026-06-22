/**
 * ReplayBarStream — deterministic bar replay for backtesting.
 *
 * Implements BarStream: subscribes yield bars sequentially from a pre-loaded
 * historical dataset. The replay is fully deterministic — same data → same sequence.
 *
 * Critical for simulation: the bar timestamp is injected as `now` into scanner/scoring
 * calls so the sim path is fully reproducible. The scanner's `now` default (Date.now())
 * exists only for live mode; the sim always passes the bar timestamp.
 */
import type { BarStream } from '../interfaces/data.js';
import type { Bar } from '../types/market.js';

/**
 * Pre-loaded bar data keyed by mint address.
 * Bars must be sorted by timestamp ascending within each mint.
 */
export interface BarData {
  [mint: string]: Bar[];
}

/**
 * Deterministic replay of historical bars.
 *
 * The replay injects the bar timestamp as `now` into every scanner/scoring call,
 * ensuring the sim path is fully reproducible.
 */
export class ReplayBarStream implements BarStream {
  constructor(private data: BarData) {
    // Sort bars by timestamp for deterministic replay
    for (const mint of Object.keys(this.data)) {
      this.data[mint].sort((a, b) => a.timestamp - b.timestamp);
    }
  }

  /**
   * Get all mint addresses in the replay dataset.
   * Used for walk-forward discovery: replay the full token universe at each point in time.
   */
  getAllMints(): string[] {
    return Object.keys(this.data);
  }

  /**
   * Subscribe to bars for a token. Yields bars sequentially in timestamp order.
   * Deterministic — same data → same sequence every time.
   */
  async *subscribe(mint: string): AsyncIterable<Bar> {
    const bars = this.data[mint];
    if (!bars) return;

    for (const bar of bars) {
      yield bar;
    }
  }

  /**
   * Get historical bars for a token within a time range.
   * Used for warm-up and point-in-time discovery replay.
   */
  async getHistoricalBars(
    mint: string,
    from: number,
    to: number,
    limit?: number,
  ): Promise<Bar[]> {
    const bars = this.data[mint];
    if (!bars) return [];

    const filtered = bars.filter((bar) => bar.timestamp >= from && bar.timestamp < to);

    if (limit !== undefined) {
      return filtered.slice(0, limit);
    }

    return filtered;
  }
}
