/**
 * FileTokenRepository — reads token metadata from on-disk JSON files.
 *
 * Implements TokenRepository: getToken, getHolderDistribution, checkSellability,
 * getLiquidity, getTxnVelocity — all backed by the meta.json file per token.
 *
 * Directory layout: data/<mint>/meta.json
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { TokenRepository } from '../interfaces/data.js';
import type {
  TokenInfo,
  HolderDistribution,
  SellabilityResult,
  LiquiditySnapshot,
} from '../types/market.js';
import type { FileTokenMeta } from './file-format.js';

/**
 * File-backed TokenRepository for historical backtesting.
 *
 * All data is loaded from the on-disk format. No network calls.
 * Deterministic: same files → same data every time.
 */
export class FileTokenRepository implements TokenRepository {
  private cache = new Map<string, FileTokenMeta>();

  constructor(private dataDir: string) {}

  /**
   * Load metadata for a single token from disk.
   * Cached after first load.
   */
  private async loadMeta(mint: string): Promise<FileTokenMeta | null> {
    if (this.cache.has(mint)) {
      return this.cache.get(mint) ?? null;
    }

    const metaPath = path.join(this.dataDir, mint, 'meta.json');
    try {
      const raw = await fs.readFile(metaPath, 'utf-8');
      const meta: FileTokenMeta = JSON.parse(raw);
      this.cache.set(mint, meta);
      return meta;
    } catch {
      return null;
    }
  }

  /**
   * List all token mints available in the data directory.
   * Each subdirectory is a mint.
   */
  async listMints(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.dataDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Fetch token metadata by mint address.
   */
  async getToken(mint: string): Promise<TokenInfo | null> {
    const meta = await this.loadMeta(mint);
    if (!meta) return null;

    return {
      mint: meta.mint,
      symbol: meta.symbol,
      name: meta.name,
      decimals: meta.decimals,
      mintAuthorityRevoked: meta.mintAuthorityRevoked,
      freezeAuthorityRevoked: meta.freezeAuthorityRevoked,
      lpBurnedOrLocked: meta.lpBurnedOrLocked,
      poolAddress: meta.poolAddress,
      poolLiquidityUsd: meta.poolLiquidityUsd,
      deployer: meta.deployer,
      createdAt: meta.createdAt,
    };
  }

  /**
   * Fetch holder distribution for a token.
   */
  async getHolderDistribution(mint: string): Promise<HolderDistribution> {
    const meta = await this.loadMeta(mint);
    if (!meta) {
      return {
        totalHolders: 0,
        top10Concentration: 1,
        top1Concentration: 1,
        giniCoefficient: 1,
      };
    }

    return {
      totalHolders: meta.totalHolders,
      top10Concentration: meta.top10Concentration,
      top1Concentration: meta.top1Concentration,
      giniCoefficient: meta.giniCoefficient,
    };
  }

  /**
   * Check sellability by reading the pre-computed result from meta.
   */
  async checkSellability(mint: string, _sizeUsd: number): Promise<SellabilityResult> {
    const meta = await this.loadMeta(mint);
    if (!meta) {
      return {
        sellable: false,
        estimatedSlippageBps: 0,
        estimatedFillTimeSeconds: 0,
        reason: 'no metadata',
      };
    }

    return {
      sellable: meta.sellable,
      estimatedSlippageBps: meta.estimatedSlippageBps,
      estimatedFillTimeSeconds: meta.estimatedFillTimeSeconds,
      reason: meta.sellabilityReason,
    };
  }

  /**
   * Get current liquidity snapshot.
   * For historical data, returns the pool liquidity from meta.json.
   * The actual liquidity during replay is tracked by SimExecutionEngine
   * (LP drain over time), so this is the initial value.
   */
  async getLiquidity(mint: string): Promise<LiquiditySnapshot> {
    const meta = await this.loadMeta(mint);
    if (!meta) {
      return { liquidityUsd: 0, timestamp: 0 };
    }

    return {
      liquidityUsd: meta.poolLiquidityUsd,
      timestamp: meta.createdAt,
    };
  }

  /**
   * Get transaction velocity from the pre-computed value in meta.
   */
  async getTxnVelocity(mint: string): Promise<number> {
    const meta = await this.loadMeta(mint);
    if (!meta) return 0;
    return meta.txnVelocity;
  }
}
