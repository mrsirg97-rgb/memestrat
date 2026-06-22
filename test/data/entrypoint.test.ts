import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadBars } from '../../src/data/file-bar-loader.js';
import { FileTokenRepository } from '../../src/data/file-token-repository.js';
import { ReplayBarStream } from '../../src/sim/replay-barstream.js';
import { BacktestRunner } from '../../src/sim/backtest.js';
import { InMemoryScanner } from '../../src/discovery/scanner.js';
import { DEFAULT_CONFIG } from '../../src/types/config.js';
import type { Bar } from '../../src/types/market.js';
import type { FileTokenMeta } from '../../src/data/file-format.js';
import type { StrategyConfig } from '../../src/types/config.js';

/** Create a temporary directory for test fixtures. */
async function createFixtureDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'memestrat-e2e-'));
}

/** Write a JSONL bars file for a token. */
async function writeBars(dataDir: string, mint: string, bars: Bar[]): Promise<void> {
  const tokenDir = path.join(dataDir, mint);
  await fs.mkdir(tokenDir, { recursive: true });
  const jsonl = bars.map((b) => JSON.stringify(b)).join('\n') + '\n';
  await fs.writeFile(path.join(tokenDir, 'bars.jsonl'), jsonl, 'utf-8');
}

/** Write a meta.json file for a token. */
async function writeMeta(dataDir: string, mint: string, meta: FileTokenMeta): Promise<void> {
  const tokenDir = path.join(dataDir, mint);
  await fs.mkdir(tokenDir, { recursive: true });
  await fs.writeFile(path.join(tokenDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

/** Build a pump→hold→dump price series that the strategy can trade. */
function makePumpDumpSeries(tsStart: number, basePrice: number, barCount: number): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < barCount; i++) {
    let price = basePrice;
    if (i < 20) {
      price = basePrice * (1 + i * 0.02); // 2% per bar pump
    } else if (i < 40) {
      price = basePrice * 1.4 * (1 + Math.sin(i * 0.3) * 0.02); // consolidate
    } else {
      price = basePrice * 1.4 * (1 - (i - 40) * 0.015); // dump
    }
    bars.push({
      timestamp: tsStart + i * 15_000,
      open: price,
      high: price * 1.01,
      low: price * 0.99,
      close: price,
      volume: 1000 + i * 50,
      netFlow: 100 + i * 10,
      txnCount: 10,
    });
  }
  return bars;
}

/** Build a rug series: price collapses to near-zero. */
function makeRugSeries(tsStart: number, basePrice: number, barCount: number): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < barCount; i++) {
    let price = basePrice;
    if (i < 10) {
      price = basePrice * (1 - i * 0.08); // 8% decline per bar
    } else {
      price = Math.max(0.001, basePrice * 0.2 * (1 - (i - 10) * 0.05));
    }
    bars.push({
      timestamp: tsStart + i * 15_000,
      open: price,
      high: price * 1.01,
      low: price * 0.99,
      close: price,
      volume: Math.max(0, 1000 - i * 100),
      netFlow: -Math.abs(100 + i * 20),
      txnCount: Math.max(0, 20 - i),
    });
  }
  return bars;
}

/** Standard "good" token metadata that passes all discovery filters. */
function makeGoodMeta(mint: string): FileTokenMeta {
  return {
    mint,
    symbol: mint,
    name: `${mint} Token`,
    decimals: 9,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    lpBurnedOrLocked: true,
    poolLiquidityUsd: 100_000,
    deployer: 'good_deployer',
    createdAt: 1_000_000_000_000,
    totalHolders: 200,
    top10Concentration: 0.15,
    top1Concentration: 0.05,
    giniCoefficient: 0.3,
    txnVelocity: 50,
    sellable: true,
    estimatedSlippageBps: 50,
    estimatedFillTimeSeconds: 1,
  };
}

/** Rug token metadata that fails discovery filters. */
function makeRugMeta(mint: string): FileTokenMeta {
  return {
    mint,
    symbol: mint,
    name: `${mint} Rug`,
    decimals: 9,
    mintAuthorityRevoked: false,
    freezeAuthorityRevoked: false,
    lpBurnedOrLocked: false,
    poolLiquidityUsd: 5_000,
    deployer: 'ruggers_wallet',
    createdAt: 1_000_000_000_000,
    totalHolders: 10,
    top10Concentration: 0.9,
    top1Concentration: 0.7,
    giniCoefficient: 0.9,
    txnVelocity: 2,
    sellable: false,
    estimatedSlippageBps: 500,
    estimatedFillTimeSeconds: 60,
    sellabilityReason: 'insufficient liquidity',
  };
}

describe('End-to-end backtest from file data', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createFixtureDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('runs a full backtest on synthetic fixture and produces metric block', async () => {
    // Set up fixture: one good token with a pump→hold→dump pattern
    const goodBars = makePumpDumpSeries(1_000_000_000_000, 1.0, 80);
    await writeBars(tmpDir, 'GOOD_TOKEN', goodBars);
    await writeMeta(tmpDir, 'GOOD_TOKEN', makeGoodMeta('GOOD_TOKEN'));

    // Load data
    const loadResult = await loadBars(tmpDir);
    const barData = loadResult.data;
    const repository = new FileTokenRepository(tmpDir);
    const mints = Object.keys(barData);

    const config: StrategyConfig = {
      ...DEFAULT_CONFIG,
      rangingEnabled: false,
      regime: { tUp: 0.1, tDown: 0.1, windowBars: 10 },
    };

    const scanner = new InMemoryScanner(repository, config, mints);
    const stream = new ReplayBarStream(barData);
    const runner = new BacktestRunner(config, stream, scanner, 10_000);

    const runResult = await runner.run();

    // Verify metric block is produced
    expect(runResult.metrics.totalTrades).toBeGreaterThanOrEqual(0);
    expect(runResult.metrics.expectancyR).toBeDefined();
    expect(runResult.metrics.profitFactor).toBeDefined();
    expect(runResult.metrics.maxDrawdownR).toBeGreaterThanOrEqual(0);
    expect(runResult.metrics.tailLossFraction).toBeDefined();
    expect(runResult.metrics.totalR).toBeDefined();
    expect(runResult.metrics.totalPnlUsd).toBeDefined();
    expect(runResult.metrics.winRate).toBeDefined();
    expect(runResult.metrics.passed).toBeDefined();

    // Discovery stats
    expect(runResult.discoveryStats.tokensScanned).toBeGreaterThanOrEqual(1);
  });

  it('walk-forward split produces both in-sample and out-of-sample', async () => {
    const goodBars = makePumpDumpSeries(1_000_000_000_000, 1.0, 100);
    await writeBars(tmpDir, 'GOOD_TOKEN', goodBars);
    await writeMeta(tmpDir, 'GOOD_TOKEN', makeGoodMeta('GOOD_TOKEN'));

    const loadResult = await loadBars(tmpDir);
    const barData = loadResult.data;
    const repository = new FileTokenRepository(tmpDir);
    const mints = Object.keys(barData);

    const config: StrategyConfig = {
      ...DEFAULT_CONFIG,
      rangingEnabled: false,
      regime: { tUp: 0.1, tDown: 0.1, windowBars: 10 },
      sim: { ...DEFAULT_CONFIG.sim, splitPoint: 0.7 },
    };

    const scanner = new InMemoryScanner(repository, config, mints);
    const stream = new ReplayBarStream(barData);
    const runner = new BacktestRunner(config, stream, scanner, 10_000);

    const wfResult = await runner.runWalkForward();

    expect(wfResult.inSample).toBeDefined();
    expect(wfResult.outOfSample).toBeDefined();
    expect(wfResult.inSample.metrics.totalTrades).toBeGreaterThanOrEqual(0);
    expect(wfResult.outOfSample.metrics.totalTrades).toBeGreaterThanOrEqual(0);
  });

  it('rug token is in universe but filtered by discovery', async () => {
    // Good token
    const goodBars = makePumpDumpSeries(1_000_000_000_000, 1.0, 60);
    await writeBars(tmpDir, 'GOOD_TOKEN', goodBars);
    await writeMeta(tmpDir, 'GOOD_TOKEN', makeGoodMeta('GOOD_TOKEN'));

    // Rug token — price collapses, fails all filters
    const rugBars = makeRugSeries(1_000_000_000_000, 1.0, 40);
    await writeBars(tmpDir, 'RUG_TOKEN', rugBars);
    await writeMeta(tmpDir, 'RUG_TOKEN', makeRugMeta('RUG_TOKEN'));

    const loadResult = await loadBars(tmpDir);
    const barData = loadResult.data;
    const repository = new FileTokenRepository(tmpDir);
    const mints = Object.keys(barData);

    // Both tokens are loaded
    expect(mints).toContain('GOOD_TOKEN');
    expect(mints).toContain('RUG_TOKEN');

    const config: StrategyConfig = {
      ...DEFAULT_CONFIG,
      rangingEnabled: false,
      regime: { tUp: 0.1, tDown: 0.1, windowBars: 10 },
    };

    const scanner = new InMemoryScanner(repository, config, mints);
    const stream = new ReplayBarStream(barData);
    const runner = new BacktestRunner(config, stream, scanner, 10_000);

    const runResult = await runner.run();

    // Both scanned, only good token promoted
    expect(runResult.discoveryStats.tokensScanned).toBe(2);
    expect(runResult.discoveryStats.tokensPromoted).toBeGreaterThanOrEqual(1);
    expect(runResult.discoveryStats.tokensFiltered).toBeGreaterThanOrEqual(1);

    // Rug bars are NOT silently dropped — they exist in the stream
    expect(barData['RUG_TOKEN']).toHaveLength(40);
    expect(barData['RUG_TOKEN'][39].close).toBeLessThan(0.1); // price collapsed
  });

  it('empty dataset produces zero metrics without crashing', async () => {
    // Write a token with no bars (meta only)
    await writeMeta(tmpDir, 'META_ONLY', makeGoodMeta('META_ONLY'));

    const loadResult = await loadBars(tmpDir);
    const barData = loadResult.data;
    const repository = new FileTokenRepository(tmpDir);
    const mints = Object.keys(barData);

    const config: StrategyConfig = { ...DEFAULT_CONFIG };
    const scanner = new InMemoryScanner(repository, config, mints);
    const stream = new ReplayBarStream(barData);
    const runner = new BacktestRunner(config, stream, scanner, 10_000);

    const runResult = await runner.run();

    expect(runResult.metrics.totalTrades).toBe(0);
    expect(runResult.metrics.expectancyR).toBe(0);
  });

  it('dead-on-arrival token preserved when price is zero from bar 1', async () => {
    // Dead-on-arrival: price is 0 from the start
    const deadBars: Bar[] = [
      { timestamp: 1_000_000_000_000, open: 0, high: 0, low: 0, close: 0, volume: 0, netFlow: 0, txnCount: 0 },
      { timestamp: 1_000_000_015_000, open: 0, high: 0, low: 0, close: 0, volume: 0, netFlow: 0, txnCount: 0 },
      { timestamp: 1_000_000_030_000, open: 0, high: 0, low: 0, close: 0, volume: 0, netFlow: 0, txnCount: 0 },
    ];
    await writeBars(tmpDir, 'DEAD_TOKEN', deadBars);
    await writeMeta(tmpDir, 'DEAD_TOKEN', makeRugMeta('DEAD_TOKEN'));

    const loadResult = await loadBars(tmpDir);
    const barData = loadResult.data;

    // Dead token bars are preserved
    expect(barData['DEAD_TOKEN']).toHaveLength(3);
    expect(barData['DEAD_TOKEN'][0].close).toBe(0);
    expect(barData['DEAD_TOKEN'][1].close).toBe(0);
    expect(barData['DEAD_TOKEN'][2].close).toBe(0);
  });
});

describe('Determinism: same dataset → identical metrics', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createFixtureDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('two runs on same data produce byte-identical metrics', async () => {
    // Set up fixture
    const goodBars = makePumpDumpSeries(1_000_000_000_000, 1.0, 80);
    await writeBars(tmpDir, 'GOOD_TOKEN', goodBars);
    await writeMeta(tmpDir, 'GOOD_TOKEN', makeGoodMeta('GOOD_TOKEN'));

    const rugBars = makeRugSeries(1_000_000_000_000, 1.0, 40);
    await writeBars(tmpDir, 'RUG_TOKEN', rugBars);
    await writeMeta(tmpDir, 'RUG_TOKEN', makeRugMeta('RUG_TOKEN'));

    const config: StrategyConfig = {
      ...DEFAULT_CONFIG,
      rangingEnabled: false,
      regime: { tUp: 0.1, tDown: 0.1, windowBars: 10 },
    };

    // Run 1
    const load1 = await loadBars(tmpDir);
    const repo1 = new FileTokenRepository(tmpDir);
    const mints1 = Object.keys(load1.data);
    const scanner1 = new InMemoryScanner(repo1, config, mints1);
    const stream1 = new ReplayBarStream(load1.data);
    const runner1 = new BacktestRunner(config, stream1, scanner1, 10_000);
    const result1 = await runner1.run();

    // Run 2 — fresh instances, same data
    const load2 = await loadBars(tmpDir);
    const repo2 = new FileTokenRepository(tmpDir);
    const mints2 = Object.keys(load2.data);
    const scanner2 = new InMemoryScanner(repo2, config, mints2);
    const stream2 = new ReplayBarStream(load2.data);
    const runner2 = new BacktestRunner(config, stream2, scanner2, 10_000);
    const result2 = await runner2.run();

    // Byte-identical metrics
    expect(JSON.stringify(result1.metrics)).toEqual(JSON.stringify(result2.metrics));

    // Identical trade logs
    expect(result1.tradeLog.length).toBe(result2.tradeLog.length);
    for (let i = 0; i < result1.tradeLog.length; i++) {
      expect(result1.tradeLog[i].pnlR).toBe(result2.tradeLog[i].pnlR);
      expect(result1.tradeLog[i].pnlUsd).toBe(result2.tradeLog[i].pnlUsd);
      expect(result1.tradeLog[i].exitReason).toBe(result2.tradeLog[i].exitReason);
    }
  });

  it('walk-forward is also deterministic', async () => {
    const goodBars = makePumpDumpSeries(1_000_000_000_000, 1.0, 100);
    await writeBars(tmpDir, 'GOOD_TOKEN', goodBars);
    await writeMeta(tmpDir, 'GOOD_TOKEN', makeGoodMeta('GOOD_TOKEN'));

    const config: StrategyConfig = {
      ...DEFAULT_CONFIG,
      rangingEnabled: false,
      regime: { tUp: 0.1, tDown: 0.1, windowBars: 10 },
      sim: { ...DEFAULT_CONFIG.sim, splitPoint: 0.7 },
    };

    // Run 1
    const load1 = await loadBars(tmpDir);
    const repo1 = new FileTokenRepository(tmpDir);
    const scanner1 = new InMemoryScanner(repo1, config, Object.keys(load1.data));
    const stream1 = new ReplayBarStream(load1.data);
    const runner1 = new BacktestRunner(config, stream1, scanner1, 10_000);
    const wf1 = await runner1.runWalkForward();

    // Run 2
    const load2 = await loadBars(tmpDir);
    const repo2 = new FileTokenRepository(tmpDir);
    const scanner2 = new InMemoryScanner(repo2, config, Object.keys(load2.data));
    const stream2 = new ReplayBarStream(load2.data);
    const runner2 = new BacktestRunner(config, stream2, scanner2, 10_000);
    const wf2 = await runner2.runWalkForward();

    expect(JSON.stringify(wf1.inSample.metrics)).toEqual(JSON.stringify(wf2.inSample.metrics));
    expect(JSON.stringify(wf1.outOfSample.metrics)).toEqual(JSON.stringify(wf2.outOfSample.metrics));
  });
});
