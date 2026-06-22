/**
 * Backtest CLI entrypoint — loads historical data from disk,
 * runs walk-forward simulation, prints the full metric block.
 *
 * Usage: npm run backtest -- <datadir>
 *
 * Loads all tokens from the data directory, wires scanner + sim +
 * BacktestRunner, runs runWalkForward(), and prints the full metric
 * block for in-sample AND out-of-sample.
 *
 * DETERMINISTIC: same data directory → identical metrics every run.
 */
import * as path from 'node:path';
import * as process from 'node:process';
import { FileTokenRepository, loadBars } from './data/index.js';
import { ReplayBarStream } from './sim/replay-barstream.js';
import { BacktestRunner } from './sim/backtest.js';
import { InMemoryScanner } from './discovery/scanner.js';
import { DEFAULT_CONFIG } from './types/config.js';
import type { StrategyConfig } from './types/config.js';
import type { PerformanceMetrics } from './types/signal.js';

/**
 * Format a performance metrics block for terminal output.
 * Uses the full TASK.md metric block format.
 */
function formatMetrics(label: string, metrics: PerformanceMetrics): string {
  const passFail = metrics.passed ? '✅ PASS' : '❌ FAIL';
  const lines: string[] = [
    `━━━ ${label} ${passFail} ━━━`,
    `  Expectancy:          ${metrics.expectancyR.toFixed(3)} R`,
    `  Profit Factor:       ${isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(2) : '∞'}`,
    `  Risk-Adj. Return:    ${isFinite(metrics.riskAdjustedReturn) ? metrics.riskAdjustedReturn.toFixed(2) : '∞'}`,
    `  Max Drawdown:        ${metrics.maxDrawdownR.toFixed(1)} R (${metrics.maxDrawdownPct.toFixed(1)}%)`,
    `  Tail Loss Fraction:  ${metrics.tailLossFraction.toFixed(3)}`,
    `  Worst Trade:         ${metrics.worstTradeR.toFixed(2)} R`,
    `  Total R:             ${metrics.totalR.toFixed(2)} R`,
    `  Total PnL:           $${metrics.totalPnlUsd.toFixed(2)}`,
    `  Total Trades:        ${metrics.totalTrades}`,
    `  Win Rate:            ${(metrics.winRate * 100).toFixed(1)}% (diagnostic)`,
    `  Max Single Exposure: ${metrics.maxSingleNameExposurePct.toFixed(1)}%`,
    `  Max Agg Exposure:    ${metrics.maxAggregateExposurePct.toFixed(1)}%`,
  ];

  if (metrics.failedTargets.length > 0) {
    lines.push(`  FAILED: ${metrics.failedTargets.join(', ')}`);
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dataDir = args[0];

  if (!dataDir) {
    console.error('Usage: npm run backtest -- <datadir>');
    console.error('');
    console.error('  <datadir>  Path to directory containing per-token subdirectories');
    console.error('              Each subdirectory must have meta.json and bars.jsonl');
    console.error('');
    console.error('Example:');
    console.error('  npm run backtest -- data/');
    process.exit(1);
  }

  const resolvedDir = path.resolve(dataDir);

  // 1. Load bars from disk
  console.error(`Loading bars from ${resolvedDir}...`);
  const barData = await loadBars(resolvedDir);
  const mints = Object.keys(barData);

  if (mints.length === 0) {
    console.error(`No token data found in ${resolvedDir}`);
    process.exit(1);
  }

  console.error(`Loaded ${mints.length} token(s) with ${mints.reduce((sum, m) => sum + barData[m].length, 0)} total bars`);

  // 2. Load token metadata and build repository
  const repository = new FileTokenRepository(resolvedDir);

  // 3. Build scanner with all known mints
  const config: StrategyConfig = { ...DEFAULT_CONFIG };
  const scanner = new InMemoryScanner(repository, config, mints);

  // 4. Build replay stream
  const stream = new ReplayBarStream(barData);

  // 5. Run walk-forward backtest
  const runner = new BacktestRunner(config, stream, scanner, 10_000); // $10k bankroll
  const result = await runner.runWalkForward();

  // 6. Print results
  console.log('');
  console.log(formatMetrics('IN-SAMPLE', result.inSample.metrics));
  console.log('');
  console.log(formatMetrics('OUT-OF-SAMPLE', result.outOfSample.metrics));
  console.log('');

  // Discovery stats
  console.log(`━━━ Discovery ━━━`);
  console.log(`  Tokens Scanned:  ${result.outOfSample.discoveryStats.tokensScanned}`);
  console.log(`  Tokens Promoted: ${result.outOfSample.discoveryStats.tokensPromoted}`);
  console.log(`  Tokens Filtered: ${result.outOfSample.discoveryStats.tokensFiltered}`);
  console.log('');

  // Trade log summary
  if (result.outOfSample.tradeLog.length > 0) {
    console.log(`━━━ Out-of-Sample Trade Log (${result.outOfSample.tradeLog.length} trades) ━━━`);
    for (const trade of result.outOfSample.tradeLog) {
      console.log(
        `  ${trade.mint.padEnd(12)} | entry: $${trade.entry.toFixed(4)} | exit: $${trade.exitPrice.toFixed(4)} | ${trade.exitReason.padEnd(14)} | ${trade.pnlR > 0 ? '+' : ''}${trade.pnlR.toFixed(2)}R | $${trade.pnlUsd > 0 ? '+' : ''}${trade.pnlUsd.toFixed(2)}`,
      );
    }
    console.log('');
  }

  // Exit code: 0 if out-of-sample passes, 1 if it fails
  process.exit(result.outOfSample.metrics.passed ? 0 : 1);
}

main().catch((err) => {
  console.error(`Backtest error: ${err.message}`);
  console.error(err.stack);
  process.exit(2);
});
