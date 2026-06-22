/** Concrete TokenScanner — composes filters + scoring with TokenRepository dependency. */
import type { TokenRepository, TokenScanner } from '../interfaces/data.js';
import type { StrategyConfig } from '../types/config.js';
import type { TokenCandidate, TokenInfo, HolderDistribution } from '../types/market.js';
import { runAllFilters } from './filters.js';
import {
  computeCompositeScore,
  scoreLiquidity,
  scoreHolderDistribution,
  scoreVelocity,
  scoreAge,
} from './scoring.js';

/** Reference liquidity level for scoring normalization (USD). */
const SCORING_LIQUIDITY_REF = 50_000;

/** Reference velocity for scoring normalization (txns/hour). */
const SCORING_VELOCITY_REF = 100;

/** Reference age for scoring normalization (seconds — 2 hours). */
const SCORING_AGE_REF = 7200;

/**
 * In-memory scanner that depends on TokenRepository for data.
 * Implements TokenScanner interface — swappable at composition root.
 *
 * For the `scan()` async iterator: iterates over a provided list of known mints
 * (injected via constructor). In a live implementation, this would poll/stream
 * new token events from the chain.
 *
 * All public methods accept an optional `now` timestamp (epoch ms) for
 * deterministic age computation. Backtests must inject the bar timestamp;
 * live mode may omit it (defaults to Date.now()).
 */
export class InMemoryScanner implements TokenScanner {
  private knownMints: string[];

  constructor(
    private repository: TokenRepository,
    private config: StrategyConfig,
    knownMints?: string[],
  ) {
    this.knownMints = knownMints ?? [];
  }

  /**
   * Set known mints (for testing or live updates).
   */
  setKnownMints(mints: string[]): void {
    this.knownMints = mints;
  }

  /**
   * Stream newly discovered token candidates.
   * Yields candidates sorted by score descending.
   * @param now Current timestamp (epoch ms) for deterministic scoring. Defaults to Date.now().
   */
  async *scan(now?: number): AsyncIterable<TokenCandidate> {
    const candidates: TokenCandidate[] = [];

    for (const mint of this.knownMints) {
      try {
        const candidate = await this.scanToken(mint, now);
        candidates.push(candidate);
      } catch {
        // Skip tokens that error during scanning — don't break the stream
      }
    }

    // Sort by score descending — highest scored candidates first
    candidates.sort((a, b) => b.score - a.score);

    for (const candidate of candidates) {
      yield candidate;
    }
  }

  /**
   * Force a scan of a specific token.
   * Fetches all data from repository, runs filters, computes score.
   * @param mint Token mint address to scan.
   * @param now Current timestamp (epoch ms) for deterministic age computation.
   *   Defaults to Date.now() when not provided (live mode).
   */
  async scanToken(mint: string, now?: number): Promise<TokenCandidate> {
    const currentTime = now ?? Date.now();

    // Fetch token info
    const token = await this.repository.getToken(mint);
    if (!token) {
      return {
        token: this.emptyToken(mint),
        holders: this.emptyHolders(),
        txnVelocity: 0,
        score: 0,
        passed: false,
        failures: ['token not found'],
      };
    }

    // Fetch holder distribution
    const holders = await this.repository.getHolderDistribution(mint);

    // Check sellability (use a default size for discovery — actual sizing happens at entry)
    const sellability = await this.repository.checkSellability(mint, 100);

    // Estimate txn velocity from token creation time
    // In a live implementation, this would come from recent bar data or RPC
    const txnVelocity = this.estimateTxnVelocity(token, currentTime);

    // Run all survivorship filters
    const { passed, failures } = runAllFilters(token, holders, txnVelocity, sellability, this.config.discovery);

    // Compute score (even for failed candidates — useful for diagnostics)
    const score = this.computeScore(token, holders, txnVelocity, currentTime);

    return {
      token,
      holders,
      txnVelocity,
      score,
      passed,
      failures,
    };
  }

  /**
   * Compute composite score from token data.
   * @param now Current timestamp (epoch ms) for age computation.
   */
  private computeScore(token: TokenInfo, holders: HolderDistribution, txnVelocity: number, now: number): number {
    const ageSeconds = (now - token.createdAt) / 1000;

    const liquidityScore = scoreLiquidity(token.poolLiquidityUsd, SCORING_LIQUIDITY_REF);
    const holderScore = scoreHolderDistribution(holders);
    const velocityScore = scoreVelocity(txnVelocity, SCORING_VELOCITY_REF);
    const ageScore = scoreAge(ageSeconds, SCORING_AGE_REF);

    return computeCompositeScore(
      liquidityScore,
      holderScore,
      velocityScore,
      ageScore,
      this.config.scoring,
    );
  }

  /**
   * Estimate transaction velocity from token metadata.
   * In a live implementation, this would query recent block data.
   * For the in-memory scanner, we derive a rough estimate from token age.
   */
  private estimateTxnVelocity(token: TokenInfo, now: number): number {
    const ageSeconds = (now - token.createdAt) / 1000;
    if (ageSeconds === 0) return 0;

    // Rough heuristic: newer tokens with more liquidity tend to have higher velocity
    // This is a placeholder — live implementation will use actual txn data from RPC
    const liquidityFactor = Math.min(token.poolLiquidityUsd / SCORING_LIQUIDITY_REF, 2);
    const ageFactor = Math.max(1 - ageSeconds / (24 * 3600), 0.1); // decay over 24 hours
    return Math.round(liquidityFactor * 50 * ageFactor);
  }

  private emptyToken(mint: string): TokenInfo {
    return {
      mint,
      symbol: '',
      name: '',
      decimals: 0,
      mintAuthorityRevoked: false,
      freezeAuthorityRevoked: false,
      lpBurnedOrLocked: false,
      poolLiquidityUsd: 0,
      deployer: '',
      createdAt: 0,
    };
  }

  private emptyHolders() {
    return {
      totalHolders: 0,
      top10Concentration: 1,
      top1Concentration: 1,
      giniCoefficient: 1,
    };
  }
}
