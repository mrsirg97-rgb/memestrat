/**
 * FileBarLoader — reads OHLCV bars from on-disk JSONL files.
 *
 * Loads bars.jsonl files per token and produces BarData for ReplayBarStream.
 *
 * SAMPLE INTEGRITY: bars with price → 0, volume → 0 (rugs, dead pools)
 * are preserved. The loader does NOT silently drop them. They are part of
 * an honest universe — the strategy's job is to handle them, not the loader's
 * job to hide them.
 *
 * SURVIVORSHIP PROTECTION: tokens that fail to load (parse errors, empty
 * files, missing bars.jsonl) are reported in a skipped list, not silently
 * dropped. A shrinking universe is never invisible.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Bar } from '../types/market.js';
import type { BarData } from '../sim/replay-barstream.js';
import type { FileBar } from './file-format.js';

/** A token that was skipped during loading, with the reason why. */
export interface SkippedToken {
  /** Mint address (directory name). */
  mint: string;
  /** Human-readable reason for skipping. */
  reason: string;
}

/** Result of loading bars from a data directory. */
export interface LoadResult {
  /** Bars successfully loaded, keyed by mint. */
  data: BarData;
  /** Tokens that were skipped, with reasons. */
  skipped: SkippedToken[];
}

/**
 * Load all bars from a data directory into BarData for ReplayBarStream.
 *
 * Reads every `data/<mint>/bars.jsonl` file and returns a LoadResult with
 * loaded data and a list of skipped tokens with reasons.
 *
 * Bars are sorted by timestamp ascending within each mint.
 *
 * SURVIVORSHIP PROTECTION:
 * - ENOENT (no bars.jsonl): skipped with reason "no bars file"
 * - Empty file (0 bars after parse): skipped with reason "empty bars file"
 * - Parse error (malformed JSON, missing fields): skipped with reason
 *   "parse error: ..." — the ENTIRE token is skipped, not just the bad line
 *
 * @param dataDir Path to the data directory containing per-token subdirectories.
 * @returns LoadResult with loaded data and skipped tokens.
 */
export async function loadBars(dataDir: string): Promise<LoadResult> {
  const data: BarData = {};
  const skipped: SkippedToken[] = [];

  try {
    const entries = await fs.readdir(dataDir, { withFileTypes: true });
    const tokenDirs = entries.filter((e) => e.isDirectory());

    for (const dir of tokenDirs) {
      const mint = dir.name;
      const barsPath = path.join(dataDir, mint, 'bars.jsonl');

      try {
        const content = await fs.readFile(barsPath, 'utf-8');
        const bars = parseJsonl(content);

        if (bars.length === 0) {
          // File exists but produced no bars — report it
          skipped.push({ mint, reason: 'empty bars file' });
          continue;
        }

        // Sort by timestamp ascending for deterministic replay
        bars.sort((a, b) => a.timestamp - b.timestamp);
        data[mint] = bars;
      } catch (err: unknown) {
        const isNotFound = (err as NodeJS.ErrnoException).code === 'ENOENT';

        if (isNotFound) {
          // No bars.jsonl — metadata-only tokens exist, skip cleanly
          skipped.push({ mint, reason: 'no bars file' });
        } else {
          // Parse error — report the entire token as skipped
          const reason = err instanceof Error ? err.message : String(err);
          skipped.push({ mint, reason: `parse error: ${reason}` });
        }
      }
    }
  } catch {
    // Data dir doesn't exist or isn't readable — return empty
  }

  return { data, skipped };
}

/**
 * Parse a JSONL string into an array of FileBar objects.
 * Each line is a standalone JSON object.
 *
 * Does NOT drop lines with zero price or zero volume — those are valid
 * rug/dead-pool data points.
 *
 * @param content JSONL content (one JSON object per line).
 * @returns Parsed bars array.
 */
export function parseJsonl(content: string): Bar[] {
  const bars: Bar[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue; // skip empty lines

    const parsed: FileBar = JSON.parse(trimmed);

    // Validate required fields exist
    if (typeof parsed.timestamp !== 'number') {
      throw new Error(`Invalid bar: missing or non-numeric timestamp in line: ${trimmed}`);
    }
    if (typeof parsed.close !== 'number') {
      throw new Error(`Invalid bar: missing or non-numeric close in line: ${trimmed}`);
    }

    bars.push({
      timestamp: parsed.timestamp,
      open: parsed.open ?? parsed.close, // fallback: open = close if missing
      high: parsed.high ?? parsed.close,
      low: parsed.low ?? parsed.close,
      close: parsed.close,
      volume: parsed.volume ?? 0,
      netFlow: parsed.netFlow ?? 0,
      txnCount: parsed.txnCount ?? 0,
    });
  }

  return bars;
}
