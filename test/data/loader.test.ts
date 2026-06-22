import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseJsonl, loadBars } from '../../src/data/file-bar-loader.js';
import { FileTokenRepository } from '../../src/data/file-token-repository.js';
import type { FileTokenMeta } from '../../src/data/file-format.js';
import type { Bar } from '../../src/types/market.js';

/** Create a temporary directory for test fixtures. */
async function createFixtureDir(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memestrat-test-'));
  return tmpDir;
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

describe('parseJsonl', () => {
  it('parses valid bars', () => {
    const jsonl = `{"timestamp": 1000, "open": 1.0, "high": 1.1, "low": 0.9, "close": 1.05, "volume": 1000, "netFlow": 50, "txnCount": 10}
{"timestamp": 2000, "open": 1.05, "high": 1.2, "low": 1.0, "close": 1.15, "volume": 2000, "netFlow": 100, "txnCount": 20}
`;
    const bars = parseJsonl(jsonl);
    expect(bars).toHaveLength(2);
    expect(bars[0].timestamp).toBe(1000);
    expect(bars[0].close).toBe(1.05);
    expect(bars[1].close).toBe(1.15);
  });

  it('handles empty lines', () => {
    const jsonl = `{"timestamp": 1000, "open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0, "volume": 100, "netFlow": 0, "txnCount": 1}

{"timestamp": 2000, "open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0, "volume": 100, "netFlow": 0, "txnCount": 1}
`;
    const bars = parseJsonl(jsonl);
    expect(bars).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(parseJsonl('')).toHaveLength(0);
    expect(parseJsonl('\n\n')).toHaveLength(0);
  });

  it('throws on missing timestamp', () => {
    expect(() => parseJsonl('{"close": 1.0}')).toThrow(/timestamp/);
  });

  it('throws on non-numeric timestamp', () => {
    expect(() => parseJsonl('{"timestamp": "abc", "close": 1.0}')).toThrow(/timestamp/);
  });

  it('throws on missing close', () => {
    expect(() => parseJsonl('{"timestamp": 1000}')).toThrow(/close/);
  });

  it('defaults missing optional fields to 0 or close', () => {
    const jsonl = `{"timestamp": 1000, "close": 1.0}`;
    const bars = parseJsonl(jsonl);
    expect(bars).toHaveLength(1);
    expect(bars[0].open).toBe(1.0); // defaults to close
    expect(bars[0].high).toBe(1.0);
    expect(bars[0].low).toBe(1.0);
    expect(bars[0].volume).toBe(0);
    expect(bars[0].netFlow).toBe(0);
    expect(bars[0].txnCount).toBe(0);
  });

  it('preserves rug bars (price → 0, volume → 0)', () => {
    // A rug: price collapses to near-zero, volume dries up
    const jsonl = `{"timestamp": 1000, "open": 1.0, "high": 1.0, "low": 0.001, "close": 0.001, "volume": 200, "netFlow": -190, "txnCount": 3}
{"timestamp": 2000, "open": 0.001, "high": 0.001, "low": 0.001, "close": 0.001, "volume": 0, "netFlow": 0, "txnCount": 0}
`;
    const bars = parseJsonl(jsonl);
    expect(bars).toHaveLength(2);
    // The loader does NOT drop rug bars
    expect(bars[0].close).toBe(0.001);
    expect(bars[1].close).toBe(0.001);
    expect(bars[1].volume).toBe(0);
    expect(bars[1].txnCount).toBe(0);
  });

  it('preserves dead-on-arrival bars (close = 0)', () => {
    const jsonl = `{"timestamp": 1000, "open": 0, "high": 0, "low": 0, "close": 0, "volume": 0, "netFlow": 0, "txnCount": 0}`;
    const bars = parseJsonl(jsonl);
    expect(bars).toHaveLength(1);
    expect(bars[0].close).toBe(0);
  });
});

describe('loadBars', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createFixtureDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('loads bars from data directory', async () => {
    const bars: Bar[] = [
      { timestamp: 1000, open: 1.0, high: 1.1, low: 0.9, close: 1.05, volume: 1000, netFlow: 50, txnCount: 10 },
      { timestamp: 2000, open: 1.05, high: 1.2, low: 1.0, close: 1.15, volume: 2000, netFlow: 100, txnCount: 20 },
    ];
    await writeBars(tmpDir, 'TOKEN_A', bars);

    const result = await loadBars(tmpDir);
    expect(Object.keys(result.data)).toContain('TOKEN_A');
    expect(result.data['TOKEN_A']).toHaveLength(2);
    expect(result.data['TOKEN_A'][0].close).toBe(1.05);
    expect(result.skipped).toHaveLength(0);
  });

  it('sorts bars by timestamp ascending', async () => {
    const bars: Bar[] = [
      { timestamp: 3000, open: 1.3, high: 1.4, low: 1.2, close: 1.35, volume: 1000, netFlow: 50, txnCount: 10 },
      { timestamp: 1000, open: 1.0, high: 1.1, low: 0.9, close: 1.05, volume: 1000, netFlow: 50, txnCount: 10 },
      { timestamp: 2000, open: 1.05, high: 1.2, low: 1.0, close: 1.15, volume: 2000, netFlow: 100, txnCount: 20 },
    ];
    await writeBars(tmpDir, 'TOKEN_A', bars);

    const result = await loadBars(tmpDir);
    expect(result.data['TOKEN_A'][0].timestamp).toBe(1000);
    expect(result.data['TOKEN_A'][1].timestamp).toBe(2000);
    expect(result.data['TOKEN_A'][2].timestamp).toBe(3000);
  });

  it('does NOT drop rug bars', async () => {
    // A rug token: price collapses, volume dries to 0
    const bars: Bar[] = [
      { timestamp: 1000, open: 1.0, high: 1.0, low: 0.5, close: 0.55, volume: 5000, netFlow: -4000, txnCount: 30 },
      { timestamp: 2000, open: 0.55, high: 0.55, low: 0.001, close: 0.001, volume: 200, netFlow: -190, txnCount: 3 },
      { timestamp: 3000, open: 0.001, high: 0.001, low: 0.001, close: 0.001, volume: 0, netFlow: 0, txnCount: 0 },
    ];
    await writeBars(tmpDir, 'RUG_TOKEN', bars);

    const result = await loadBars(tmpDir);
    expect(result.data['RUG_TOKEN']).toHaveLength(3);
    expect(result.data['RUG_TOKEN'][2].close).toBe(0.001);
    expect(result.data['RUG_TOKEN'][2].volume).toBe(0);
  });

  it('handles multiple tokens', async () => {
    const barsA: Bar[] = [
      { timestamp: 1000, open: 1.0, high: 1.1, low: 0.9, close: 1.05, volume: 1000, netFlow: 50, txnCount: 10 },
    ];
    const barsB: Bar[] = [
      { timestamp: 1000, open: 2.0, high: 2.1, low: 1.9, close: 2.05, volume: 2000, netFlow: 100, txnCount: 20 },
    ];
    await writeBars(tmpDir, 'TOKEN_A', barsA);
    await writeBars(tmpDir, 'TOKEN_B', barsB);

    const result = await loadBars(tmpDir);
    expect(Object.keys(result.data)).toContain('TOKEN_A');
    expect(Object.keys(result.data)).toContain('TOKEN_B');
    expect(result.data['TOKEN_A']).toHaveLength(1);
    expect(result.data['TOKEN_B']).toHaveLength(1);
  });

  it('returns empty for non-existent directory', async () => {
    const result = await loadBars(path.join(tmpDir, 'nonexistent'));
    expect(Object.keys(result.data)).toHaveLength(0);
  });

  it('skips tokens without bars.jsonl', async () => {
    // Write meta only, no bars
    await writeMeta(tmpDir, 'META_ONLY', {
      mint: 'META_ONLY',
      symbol: 'M',
      name: 'Meta Only',
      decimals: 9,
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      lpBurnedOrLocked: true,
      poolLiquidityUsd: 50000,
      deployer: 'deployer1',
      createdAt: 1000,
      totalHolders: 100,
      top10Concentration: 0.1,
      top1Concentration: 0.05,
      giniCoefficient: 0.3,
      txnVelocity: 20,
      sellable: true,
      estimatedSlippageBps: 50,
      estimatedFillTimeSeconds: 1,
    });

    const result = await loadBars(tmpDir);
    expect(Object.keys(result.data)).toHaveLength(0);
    // META_ONLY should be in skipped list (no bars file)
    const skipped = result.skipped.find((s) => s.mint === 'META_ONLY');
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toContain('no bars');
  });
});

describe('FileTokenRepository', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createFixtureDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reads token metadata', async () => {
    const meta: FileTokenMeta = {
      mint: 'TOKEN_A',
      symbol: 'A',
      name: 'Token A',
      decimals: 9,
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      lpBurnedOrLocked: true,
      poolLiquidityUsd: 100_000,
      deployer: 'deployer1',
      createdAt: 1_000_000,
      totalHolders: 200,
      top10Concentration: 0.15,
      top1Concentration: 0.05,
      giniCoefficient: 0.3,
      txnVelocity: 50,
      sellable: true,
      estimatedSlippageBps: 50,
      estimatedFillTimeSeconds: 1,
    };
    await writeMeta(tmpDir, 'TOKEN_A', meta);

    const repo = new FileTokenRepository(tmpDir);
    const token = await repo.getToken('TOKEN_A');
    expect(token).not.toBeNull();
    expect(token!.mint).toBe('TOKEN_A');
    expect(token!.poolLiquidityUsd).toBe(100_000);
    expect(token!.mintAuthorityRevoked).toBe(true);
  });

  it('returns null for unknown token', async () => {
    const repo = new FileTokenRepository(tmpDir);
    const token = await repo.getToken('UNKNOWN');
    expect(token).toBeNull();
  });

  it('reads holder distribution', async () => {
    const meta: FileTokenMeta = {
      mint: 'TOKEN_A',
      symbol: 'A',
      name: 'Token A',
      decimals: 9,
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      lpBurnedOrLocked: true,
      poolLiquidityUsd: 100_000,
      deployer: 'deployer1',
      createdAt: 1_000_000,
      totalHolders: 200,
      top10Concentration: 0.15,
      top1Concentration: 0.05,
      giniCoefficient: 0.3,
      txnVelocity: 50,
      sellable: true,
      estimatedSlippageBps: 50,
      estimatedFillTimeSeconds: 1,
    };
    await writeMeta(tmpDir, 'TOKEN_A', meta);

    const repo = new FileTokenRepository(tmpDir);
    const holders = await repo.getHolderDistribution('TOKEN_A');
    expect(holders.totalHolders).toBe(200);
    expect(holders.top10Concentration).toBe(0.15);
  });

  it('reads sellability', async () => {
    const meta: FileTokenMeta = {
      mint: 'TOKEN_A',
      symbol: 'A',
      name: 'Token A',
      decimals: 9,
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      lpBurnedOrLocked: true,
      poolLiquidityUsd: 100_000,
      deployer: 'deployer1',
      createdAt: 1_000_000,
      totalHolders: 200,
      top10Concentration: 0.15,
      top1Concentration: 0.05,
      giniCoefficient: 0.3,
      txnVelocity: 50,
      sellable: false,
      estimatedSlippageBps: 500,
      estimatedFillTimeSeconds: 60,
      sellabilityReason: 'insufficient liquidity',
    };
    await writeMeta(tmpDir, 'TOKEN_A', meta);

    const repo = new FileTokenRepository(tmpDir);
    const sellability = await repo.checkSellability('TOKEN_A', 100);
    expect(sellability.sellable).toBe(false);
    expect(sellability.reason).toBe('insufficient liquidity');
  });

  it('reads transaction velocity', async () => {
    const meta: FileTokenMeta = {
      mint: 'TOKEN_A',
      symbol: 'A',
      name: 'Token A',
      decimals: 9,
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      lpBurnedOrLocked: true,
      poolLiquidityUsd: 100_000,
      deployer: 'deployer1',
      createdAt: 1_000_000,
      totalHolders: 200,
      top10Concentration: 0.15,
      top1Concentration: 0.05,
      giniCoefficient: 0.3,
      txnVelocity: 75,
      sellable: true,
      estimatedSlippageBps: 50,
      estimatedFillTimeSeconds: 1,
    };
    await writeMeta(tmpDir, 'TOKEN_A', meta);

    const repo = new FileTokenRepository(tmpDir);
    const velocity = await repo.getTxnVelocity('TOKEN_A');
    expect(velocity).toBe(75);
  });

  it('lists all mints', async () => {
    const metaA: FileTokenMeta = {
      mint: 'TOKEN_A', symbol: 'A', name: 'A', decimals: 9,
      mintAuthorityRevoked: true, freezeAuthorityRevoked: true, lpBurnedOrLocked: true,
      poolLiquidityUsd: 100_000, deployer: 'd1', createdAt: 1_000_000,
      totalHolders: 200, top10Concentration: 0.15, top1Concentration: 0.05, giniCoefficient: 0.3,
      txnVelocity: 50, sellable: true, estimatedSlippageBps: 50, estimatedFillTimeSeconds: 1,
    };
    const metaB: FileTokenMeta = {
      mint: 'TOKEN_B', symbol: 'B', name: 'B', decimals: 9,
      mintAuthorityRevoked: true, freezeAuthorityRevoked: true, lpBurnedOrLocked: true,
      poolLiquidityUsd: 50_000, deployer: 'd2', createdAt: 2_000_000,
      totalHolders: 100, top10Concentration: 0.2, top1Concentration: 0.1, giniCoefficient: 0.4,
      txnVelocity: 30, sellable: true, estimatedSlippageBps: 75, estimatedFillTimeSeconds: 2,
    };
    await writeMeta(tmpDir, 'TOKEN_A', metaA);
    await writeMeta(tmpDir, 'TOKEN_B', metaB);

    const repo = new FileTokenRepository(tmpDir);
    const mints = await repo.listMints();
    expect(mints).toEqual(['TOKEN_A', 'TOKEN_B']);
  });

  it('correctly represents a rug token (lpBurnedOrLocked = false)', async () => {
    const rugMeta: FileTokenMeta = {
      mint: 'RUG_TOKEN',
      symbol: 'RUG',
      name: 'Rug Token',
      decimals: 9,
      mintAuthorityRevoked: false, // not revoked — can mint more
      freezeAuthorityRevoked: false, // not revoked — can freeze wallets
      lpBurnedOrLocked: false, // LP can be pulled
      poolLiquidityUsd: 5_000, // low liquidity
      deployer: 'ruggers_wallet',
      createdAt: 1_000_000,
      totalHolders: 10,
      top10Concentration: 0.9, // extremely concentrated
      top1Concentration: 0.7,
      giniCoefficient: 0.9,
      txnVelocity: 2,
      sellable: false,
      estimatedSlippageBps: 500,
      estimatedFillTimeSeconds: 60,
      sellabilityReason: 'insufficient liquidity',
    };
    await writeMeta(tmpDir, 'RUG_TOKEN', rugMeta);

    const repo = new FileTokenRepository(tmpDir);
    const token = await repo.getToken('RUG_TOKEN');
    expect(token).not.toBeNull();
    expect(token!.lpBurnedOrLocked).toBe(false);
    expect(token!.mintAuthorityRevoked).toBe(false);
    expect(token!.freezeAuthorityRevoked).toBe(false);
    expect(token!.poolLiquidityUsd).toBe(5_000);

    const sellability = await repo.checkSellability('RUG_TOKEN', 100);
    expect(sellability.sellable).toBe(false);
  });

  it('caches metadata after first load', async () => {
    const meta: FileTokenMeta = {
      mint: 'TOKEN_A', symbol: 'A', name: 'A', decimals: 9,
      mintAuthorityRevoked: true, freezeAuthorityRevoked: true, lpBurnedOrLocked: true,
      poolLiquidityUsd: 100_000, deployer: 'd1', createdAt: 1_000_000,
      totalHolders: 200, top10Concentration: 0.15, top1Concentration: 0.05, giniCoefficient: 0.3,
      txnVelocity: 50, sellable: true, estimatedSlippageBps: 50, estimatedFillTimeSeconds: 1,
    };
    await writeMeta(tmpDir, 'TOKEN_A', meta);

    const repo = new FileTokenRepository(tmpDir);
    const token1 = await repo.getToken('TOKEN_A');
    const token2 = await repo.getToken('TOKEN_A');
    expect(token1).toEqual(token2);
  });
});
