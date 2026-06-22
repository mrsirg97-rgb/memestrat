/** TokenScanner concrete — composes filters + scoring with TokenRepository dependency. */
import { describe, it, expect } from 'vitest';
import { InMemoryScanner } from '../../src/discovery/scanner.js';
import type { TokenRepository } from '../../src/interfaces/data.js';
import type { TokenInfo, HolderDistribution, SellabilityResult, LiquiditySnapshot, TokenCandidate } from '../../src/types/market.js';
import type { StrategyConfig } from '../../src/types/config.js';
import { DEFAULT_CONFIG } from '../../src/types/config.js';

class FakeTokenRepository implements TokenRepository {
  constructor(
    private tokens: Map<string, TokenInfo>,
    private holders: Map<string, HolderDistribution>,
    private sellability: Map<string, SellabilityResult>,
    private liquidity: Map<string, LiquiditySnapshot>,
    private txnVelocity: Map<string, number>,
  ) {}

  getToken(mint: string): Promise<TokenInfo | null> {
    return Promise.resolve(this.tokens.get(mint) ?? null);
  }

  getHolderDistribution(mint: string): Promise<HolderDistribution> {
    return Promise.resolve(this.holders.get(mint) ?? {
      totalHolders: 0,
      top10Concentration: 1,
      top1Concentration: 1,
      giniCoefficient: 1,
    });
  }

  checkSellability(mint: string, _sizeUsd: number): Promise<SellabilityResult> {
    return Promise.resolve(this.sellability.get(mint) ?? {
      sellable: false,
      estimatedSlippageBps: 9999,
      estimatedFillTimeSeconds: 0,
      reason: 'unknown',
    });
  }

  getLiquidity(mint: string): Promise<LiquiditySnapshot> {
    return Promise.resolve(this.liquidity.get(mint) ?? {
      liquidityUsd: 0,
      timestamp: Date.now(),
    });
  }

  getTxnVelocity(mint: string): Promise<number> {
    return Promise.resolve(this.txnVelocity.get(mint) ?? 0);
  }
}

const makeGoodToken = (mint: string, createdAt?: number): TokenInfo => ({
  mint,
  symbol: 'GOOD',
  name: 'Good Token',
  decimals: 6,
  mintAuthorityRevoked: true,
  freezeAuthorityRevoked: true,
  lpBurnedOrLocked: true,
  poolLiquidityUsd: 50_000,
  deployer: 'goodDeployer',
  createdAt: createdAt ?? Date.now() - 7200_000, // 2 hours ago
});

const makeGoodHolders = (): HolderDistribution => ({
  totalHolders: 200,
  top10Concentration: 0.15,
  top1Concentration: 0.03,
  giniCoefficient: 0.4,
});

const makeGoodSellability = (): SellabilityResult => ({
  sellable: true,
  estimatedSlippageBps: 30,
  estimatedFillTimeSeconds: 3,
});

const makeGoodLiquidity = (): LiquiditySnapshot => ({
  liquidityUsd: 50_000,
  timestamp: Date.now(),
});

const makeConfig = (): StrategyConfig => ({
  ...DEFAULT_CONFIG,
  discovery: {
    ...DEFAULT_CONFIG.discovery,
    ruggersBlocklist: ['rugDeployer'],
  },
});

/**
 * Build a fully-populated fake repo for a "good" token.
 * All filters pass, all data present.
 */
function makeGoodRepo(mint: string, createdAt?: number): FakeTokenRepository {
  return new FakeTokenRepository(
    new Map([[mint, makeGoodToken(mint, createdAt)]]),
    new Map([[mint, makeGoodHolders()]]),
    new Map([[mint, makeGoodSellability()]]),
    new Map([[mint, makeGoodLiquidity()]]),
    new Map([[mint, 20]]), // 20 txns/hr — above 10 min
  );
}

describe('InMemoryScanner', () => {
  it('implements TokenScanner interface', () => {
    const repo = new FakeTokenRepository(new Map(), new Map(), new Map(), new Map(), new Map());
    const scanner = new InMemoryScanner(repo, makeConfig());
    expect(scanner.scan).toBeDefined();
    expect(scanner.scanToken).toBeDefined();
  });

  describe('scanToken', () => {
    it('returns passed candidate when all filters clear', async () => {
      const mint = 'goodMint';
      const repo = makeGoodRepo(mint);
      const scanner = new InMemoryScanner(repo, makeConfig());

      const candidate = await scanner.scanToken(mint);
      expect(candidate.passed).toBe(true);
      expect(candidate.failures).toEqual([]);
      expect(candidate.score).toBeGreaterThan(0);
      expect(candidate.token.mint).toBe(mint);
    });

    it('returns failed candidate with specific failures for low liquidity', async () => {
      const mint = 'lowLiqMint';
      const token = { ...makeGoodToken(mint), poolLiquidityUsd: 1_000 };
      const repo = new FakeTokenRepository(
        new Map([[mint, token]]),
        new Map([[mint, makeGoodHolders()]]),
        new Map([[mint, makeGoodSellability()]]),
        new Map([[mint, { liquidityUsd: 1_000, timestamp: Date.now() }]]),
        new Map([[mint, 20]]),
      );
      const scanner = new InMemoryScanner(repo, makeConfig());

      const candidate = await scanner.scanToken(mint);
      expect(candidate.passed).toBe(false);
      expect(candidate.failures.some((f: string) => f.includes('liquidity'))).toBe(true);
    });

    it('returns failed candidate when LP not burned', async () => {
      const mint = 'noLpBurnMint';
      const token = { ...makeGoodToken(mint), lpBurnedOrLocked: false };
      const repo = new FakeTokenRepository(
        new Map([[mint, token]]),
        new Map([[mint, makeGoodHolders()]]),
        new Map([[mint, makeGoodSellability()]]),
        new Map([[mint, makeGoodLiquidity()]]),
        new Map([[mint, 20]]),
      );
      const scanner = new InMemoryScanner(repo, makeConfig());

      const candidate = await scanner.scanToken(mint);
      expect(candidate.passed).toBe(false);
      expect(candidate.failures.some((f: string) => f.includes('LP'))).toBe(true);
    });

    it('returns failed candidate when mint authority not revoked', async () => {
      const mint = 'noMintRevokeMint';
      const token = { ...makeGoodToken(mint), mintAuthorityRevoked: false };
      const repo = new FakeTokenRepository(
        new Map([[mint, token]]),
        new Map([[mint, makeGoodHolders()]]),
        new Map([[mint, makeGoodSellability()]]),
        new Map([[mint, makeGoodLiquidity()]]),
        new Map([[mint, 20]]),
      );
      const scanner = new InMemoryScanner(repo, makeConfig());

      const candidate = await scanner.scanToken(mint);
      expect(candidate.passed).toBe(false);
      expect(candidate.failures.some((f: string) => f.includes('mint'))).toBe(true);
    });

    it('returns failed candidate when freeze authority not revoked', async () => {
      const mint = 'noFreezeRevokeMint';
      const token = { ...makeGoodToken(mint), freezeAuthorityRevoked: false };
      const repo = new FakeTokenRepository(
        new Map([[mint, token]]),
        new Map([[mint, makeGoodHolders()]]),
        new Map([[mint, makeGoodSellability()]]),
        new Map([[mint, makeGoodLiquidity()]]),
        new Map([[mint, 20]]),
      );
      const scanner = new InMemoryScanner(repo, makeConfig());

      const candidate = await scanner.scanToken(mint);
      expect(candidate.passed).toBe(false);
      expect(candidate.failures.some((f: string) => f.includes('freeze'))).toBe(true);
    });

    it('returns failed candidate when not sellable', async () => {
      const mint = 'unsellableMint';
      const token = makeGoodToken(mint);
      const repo = new FakeTokenRepository(
        new Map([[mint, token]]),
        new Map([[mint, makeGoodHolders()]]),
        new Map([[mint, { sellable: false, estimatedSlippageBps: 9999, estimatedFillTimeSeconds: 0, reason: 'honeypot' }]]),
        new Map([[mint, makeGoodLiquidity()]]),
        new Map([[mint, 20]]),
      );
      const scanner = new InMemoryScanner(repo, makeConfig());

      const candidate = await scanner.scanToken(mint);
      expect(candidate.passed).toBe(false);
      expect(candidate.failures.some((f: string) => f.includes('sellability'))).toBe(true);
    });

    it('returns failed candidate when top-10 concentration too high', async () => {
      const mint = 'concMint';
      const token = makeGoodToken(mint);
      const holders = { ...makeGoodHolders(), top10Concentration: 0.6 }; // exceeds 0.3 cap
      const repo = new FakeTokenRepository(
        new Map([[mint, token]]),
        new Map([[mint, holders]]),
        new Map([[mint, makeGoodSellability()]]),
        new Map([[mint, makeGoodLiquidity()]]),
        new Map([[mint, 20]]),
      );
      const scanner = new InMemoryScanner(repo, makeConfig());

      const candidate = await scanner.scanToken(mint);
      expect(candidate.passed).toBe(false);
      expect(candidate.failures.some((f: string) => f.includes('concentration'))).toBe(true);
    });

    it('returns failed candidate when holder count too low', async () => {
      const mint = 'fewHoldersMint';
      const token = makeGoodToken(mint);
      const holders = { ...makeGoodHolders(), totalHolders: 10 }; // below 50 min
      const repo = new FakeTokenRepository(
        new Map([[mint, token]]),
        new Map([[mint, holders]]),
        new Map([[mint, makeGoodSellability()]]),
        new Map([[mint, makeGoodLiquidity()]]),
        new Map([[mint, 20]]),
      );
      const scanner = new InMemoryScanner(repo, makeConfig());

      const candidate = await scanner.scanToken(mint);
      expect(candidate.passed).toBe(false);
      expect(candidate.failures.some((f: string) => f.includes('holders'))).toBe(true);
    });

    it('returns failed candidate when txn velocity too low', async () => {
      const mint = 'lowVelMint';
      const token = makeGoodToken(mint);
      const repo = new FakeTokenRepository(
        new Map([[mint, token]]),
        new Map([[mint, makeGoodHolders()]]),
        new Map([[mint, makeGoodSellability()]]),
        new Map([[mint, makeGoodLiquidity()]]),
        new Map([[mint, 5]]), // below 10 min velocity
      );
      const scanner = new InMemoryScanner(repo, makeConfig());

      const candidate = await scanner.scanToken(mint);
      expect(candidate.passed).toBe(false);
      expect(candidate.failures.some((f: string) => f.includes('velocity'))).toBe(true);
    });

    it('returns failed candidate when deployer is on blocklist', async () => {
      const mint = 'rugMint';
      const token = { ...makeGoodToken(mint), deployer: 'rugDeployer' };
      const repo = new FakeTokenRepository(
        new Map([[mint, token]]),
        new Map([[mint, makeGoodHolders()]]),
        new Map([[mint, makeGoodSellability()]]),
        new Map([[mint, makeGoodLiquidity()]]),
        new Map([[mint, 20]]),
      );
      const scanner = new InMemoryScanner(repo, makeConfig());

      const candidate = await scanner.scanToken(mint);
      expect(candidate.passed).toBe(false);
      expect(candidate.failures.some((f: string) => f.includes('blocklist'))).toBe(true);
    });

    it('returns null token as failed candidate', async () => {
      const mint = 'unknownMint';
      const repo = new FakeTokenRepository(
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
      );
      const scanner = new InMemoryScanner(repo, makeConfig());

      const candidate = await scanner.scanToken(mint);
      expect(candidate.passed).toBe(false);
      expect(candidate.failures.length).toBeGreaterThan(0);
    });

    it('uses velocity from repository, not synthesized', async () => {
      const mint = 'velMint';
      const repo = new FakeTokenRepository(
        new Map([[mint, makeGoodToken(mint)]]),
        new Map([[mint, makeGoodHolders()]]),
        new Map([[mint, makeGoodSellability()]]),
        new Map([[mint, makeGoodLiquidity()]]),
        new Map([[mint, 42]]), // exact velocity from repo
      );
      const scanner = new InMemoryScanner(repo, makeConfig());

      const candidate = await scanner.scanToken(mint);
      expect(candidate.txnVelocity).toBe(42);
    });

    it('deterministic: same injected clock produces same score', async () => {
      const mint = 'detMint';
      const fixedNow = 1_000_000_000_000; // epoch ms
      const createdAt = fixedNow - 7200_000; // 2 hours before fixedNow
      const repo = new FakeTokenRepository(
        new Map([[mint, makeGoodToken(mint, createdAt)]]),
        new Map([[mint, makeGoodHolders()]]),
        new Map([[mint, makeGoodSellability()]]),
        new Map([[mint, makeGoodLiquidity()]]),
        new Map([[mint, 20]]),
      );
      const scanner = new InMemoryScanner(repo, makeConfig());

      // Run scanToken twice with the same fixed clock
      const candidate1 = await scanner.scanToken(mint, fixedNow);
      const candidate2 = await scanner.scanToken(mint, fixedNow);

      // Same input → same score (deterministic, no Date.now() leak)
      expect(candidate1.score).toBeCloseTo(candidate2.score, 6);
      expect(candidate1.score).toBeGreaterThan(0);
    });

    it('different injected clock changes age-dependent score', async () => {
      const mint = 'ageMint';
      const createdAt = 1_000_000_000_000;
      const repo = new FakeTokenRepository(
        new Map([[mint, makeGoodToken(mint, createdAt)]]),
        new Map([[mint, makeGoodHolders()]]),
        new Map([[mint, makeGoodSellability()]]),
        new Map([[mint, makeGoodLiquidity()]]),
        new Map([[mint, 20]]),
      );
      const scanner = new InMemoryScanner(repo, makeConfig());

      // Token just created (age = 0) → lower age score
      const fresh = await scanner.scanToken(mint, createdAt);
      // Token 2 hours old (age = 7200s) → higher age score
      const aged = await scanner.scanToken(mint, createdAt + 7200_000);

      expect(aged.score).toBeGreaterThan(fresh.score);
    });
  });

  describe('scan', () => {
    it('yields candidates for all known tokens', async () => {
      const mint1 = 'mint1';
      const mint2 = 'mint2';
      const repo = new FakeTokenRepository(
        new Map([
          [mint1, makeGoodToken(mint1)],
          [mint2, makeGoodToken(mint2)],
        ]),
        new Map([
          [mint1, makeGoodHolders()],
          [mint2, makeGoodHolders()],
        ]),
        new Map([
          [mint1, makeGoodSellability()],
          [mint2, makeGoodSellability()],
        ]),
        new Map([
          [mint1, makeGoodLiquidity()],
          [mint2, makeGoodLiquidity()],
        ]),
        new Map([
          [mint1, 20],
          [mint2, 20],
        ]),
      );
      const scanner = new InMemoryScanner(repo, makeConfig(), [mint1, mint2]);

      const candidates: TokenCandidate[] = [];
      for await (const candidate of scanner.scan()) {
        candidates.push(candidate);
      }

      expect(candidates.length).toBe(2);
      expect(candidates.every((c) => c.passed)).toBe(true);
    });

    it('yields candidates sorted by score descending', async () => {
      const mint1 = 'mint1';
      const mint2 = 'mint2';
      const token1 = { ...makeGoodToken(mint1), poolLiquidityUsd: 100_000 };
      const token2 = { ...makeGoodToken(mint2), poolLiquidityUsd: 20_000 };
      const repo = new FakeTokenRepository(
        new Map([
          [mint1, token1],
          [mint2, token2],
        ]),
        new Map([
          [mint1, makeGoodHolders()],
          [mint2, makeGoodHolders()],
        ]),
        new Map([
          [mint1, makeGoodSellability()],
          [mint2, makeGoodSellability()],
        ]),
        new Map([
          [mint1, { liquidityUsd: 100_000, timestamp: Date.now() }],
          [mint2, { liquidityUsd: 20_000, timestamp: Date.now() }],
        ]),
        new Map([
          [mint1, 20],
          [mint2, 20],
        ]),
      );
      const scanner = new InMemoryScanner(repo, makeConfig(), [mint1, mint2]);

      const candidates: TokenCandidate[] = [];
      for await (const candidate of scanner.scan()) {
        candidates.push(candidate);
      }

      expect(candidates.length).toBe(2);
      expect(candidates[0].score).toBeGreaterThanOrEqual(candidates[1].score);
    });
  });
});
