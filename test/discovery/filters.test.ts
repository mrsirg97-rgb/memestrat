/** Discovery filters — pure survivorship checks. */
import { describe, it, expect } from 'vitest';
import {
  checkLiquidityFloor,
  checkLpBurnedOrLocked,
  checkMintAuthorityRevoked,
  checkFreezeAuthorityRevoked,
  checkSellability,
  checkTopHolderConcentration,
  checkMinHolders,
  checkTxnVelocity,
  checkDeployerBlocklist,
  runAllFilters,
} from '../../src/discovery/filters.js';
import type { TokenInfo, HolderDistribution, SellabilityResult } from '../../src/types/market.js';
import type { DiscoveryConfig } from '../../src/types/config.js';

const makeToken = (overrides: Partial<TokenInfo> = {}): TokenInfo => ({
  mint: 'testMint',
  symbol: 'TEST',
  name: 'Test Token',
  decimals: 6,
  mintAuthorityRevoked: true,
  freezeAuthorityRevoked: true,
  lpBurnedOrLocked: true,
  poolLiquidityUsd: 50_000,
  deployer: 'deployer123',
  createdAt: Date.now(),
  ...overrides,
});

const makeHolders = (overrides: Partial<HolderDistribution> = {}): HolderDistribution => ({
  totalHolders: 100,
  top10Concentration: 0.2,
  top1Concentration: 0.05,
  giniCoefficient: 0.5,
  ...overrides,
});

const makeSellability = (overrides: Partial<SellabilityResult> = {}): SellabilityResult => ({
  sellable: true,
  estimatedSlippageBps: 50,
  estimatedFillTimeSeconds: 5,
  ...overrides,
});

const defaultConfig: DiscoveryConfig = {
  minLiquidityUsd: 10_000,
  maxTop10Concentration: 0.3,
  minUniqueHolders: 50,
  minTxnVelocity: 10,
  ruggersBlocklist: ['knownRug1', 'knownRug2'],
};

describe('checkLiquidityFloor', () => {
  it('passes when liquidity meets floor', () => {
    const token = makeToken({ poolLiquidityUsd: 10_000 });
    expect(checkLiquidityFloor(token, defaultConfig)).toEqual({ passed: true, failure: undefined });
  });

  it('passes when liquidity exceeds floor', () => {
    const token = makeToken({ poolLiquidityUsd: 100_000 });
    expect(checkLiquidityFloor(token, defaultConfig)).toEqual({ passed: true, failure: undefined });
  });

  it('fails when liquidity is below floor', () => {
    const token = makeToken({ poolLiquidityUsd: 5_000 });
    const result = checkLiquidityFloor(token, defaultConfig);
    expect(result.passed).toBe(false);
    expect(result.failure).toMatch(/liquidity/);
  });

  it('fails when liquidity is zero', () => {
    const token = makeToken({ poolLiquidityUsd: 0 });
    expect(checkLiquidityFloor(token, defaultConfig).passed).toBe(false);
  });
});

describe('checkLpBurnedOrLocked', () => {
  it('passes when LP is burned or locked', () => {
    const token = makeToken({ lpBurnedOrLocked: true });
    expect(checkLpBurnedOrLocked(token)).toEqual({ passed: true, failure: undefined });
  });

  it('fails when LP is not burned or locked', () => {
    const token = makeToken({ lpBurnedOrLocked: false });
    const result = checkLpBurnedOrLocked(token);
    expect(result.passed).toBe(false);
    expect(result.failure).toMatch(/LP/);
  });
});

describe('checkMintAuthorityRevoked', () => {
  it('passes when mint authority is revoked', () => {
    const token = makeToken({ mintAuthorityRevoked: true });
    expect(checkMintAuthorityRevoked(token)).toEqual({ passed: true, failure: undefined });
  });

  it('fails when mint authority is not revoked', () => {
    const token = makeToken({ mintAuthorityRevoked: false });
    const result = checkMintAuthorityRevoked(token);
    expect(result.passed).toBe(false);
    expect(result.failure).toMatch(/mint/);
  });
});

describe('checkFreezeAuthorityRevoked', () => {
  it('passes when freeze authority is revoked', () => {
    const token = makeToken({ freezeAuthorityRevoked: true });
    expect(checkFreezeAuthorityRevoked(token)).toEqual({ passed: true, failure: undefined });
  });

  it('fails when freeze authority is not revoked', () => {
    const token = makeToken({ freezeAuthorityRevoked: false });
    const result = checkFreezeAuthorityRevoked(token);
    expect(result.passed).toBe(false);
    expect(result.failure).toMatch(/freeze/);
  });
});

describe('checkSellability', () => {
  it('passes when token is sellable', () => {
    const result = checkSellability(makeSellability({ sellable: true }));
    expect(result.passed).toBe(true);
  });

  it('fails when token is not sellable', () => {
    const result = checkSellability(makeSellability({ sellable: false, reason: 'honeypot' }));
    expect(result.passed).toBe(false);
    expect(result.failure).toMatch(/sellability/);
  });
});

describe('checkTopHolderConcentration', () => {
  it('passes when top-10 concentration is within cap', () => {
    const holders = makeHolders({ top10Concentration: 0.25 });
    expect(checkTopHolderConcentration(holders, defaultConfig)).toEqual({ passed: true, failure: undefined });
  });

  it('passes at exact cap boundary', () => {
    const holders = makeHolders({ top10Concentration: 0.3 });
    expect(checkTopHolderConcentration(holders, defaultConfig)).toEqual({ passed: true, failure: undefined });
  });

  it('fails when top-10 concentration exceeds cap', () => {
    const holders = makeHolders({ top10Concentration: 0.5 });
    const result = checkTopHolderConcentration(holders, defaultConfig);
    expect(result.passed).toBe(false);
    expect(result.failure).toMatch(/concentration/);
  });

  it('fails when single holder owns everything', () => {
    const holders = makeHolders({ top10Concentration: 1.0 });
    expect(checkTopHolderConcentration(holders, defaultConfig).passed).toBe(false);
  });
});

describe('checkMinHolders', () => {
  it('passes when holder count meets minimum', () => {
    const holders = makeHolders({ totalHolders: 50 });
    expect(checkMinHolders(holders, defaultConfig)).toEqual({ passed: true, failure: undefined });
  });

  it('passes when holder count exceeds minimum', () => {
    const holders = makeHolders({ totalHolders: 500 });
    expect(checkMinHolders(holders, defaultConfig)).toEqual({ passed: true, failure: undefined });
  });

  it('fails when holder count is below minimum', () => {
    const holders = makeHolders({ totalHolders: 10 });
    const result = checkMinHolders(holders, defaultConfig);
    expect(result.passed).toBe(false);
    expect(result.failure).toMatch(/holder/);
  });

  it('fails when no holders', () => {
    const holders = makeHolders({ totalHolders: 0 });
    expect(checkMinHolders(holders, defaultConfig).passed).toBe(false);
  });
});

describe('checkTxnVelocity', () => {
  it('passes when velocity meets minimum', () => {
    expect(checkTxnVelocity(10, defaultConfig)).toEqual({ passed: true, failure: undefined });
  });

  it('passes when velocity exceeds minimum', () => {
    expect(checkTxnVelocity(100, defaultConfig)).toEqual({ passed: true, failure: undefined });
  });

  it('fails when velocity is below minimum', () => {
    const result = checkTxnVelocity(5, defaultConfig);
    expect(result.passed).toBe(false);
    expect(result.failure).toMatch(/velocity/);
  });

  it('fails when velocity is zero', () => {
    expect(checkTxnVelocity(0, defaultConfig).passed).toBe(false);
  });
});

describe('checkDeployerBlocklist', () => {
  it('passes when deployer is not on blocklist', () => {
    const token = makeToken({ deployer: 'unknownDeployer' });
    expect(checkDeployerBlocklist(token, defaultConfig)).toEqual({ passed: true, failure: undefined });
  });

  it('fails when deployer is on blocklist', () => {
    const token = makeToken({ deployer: 'knownRug1' });
    const result = checkDeployerBlocklist(token, defaultConfig);
    expect(result.passed).toBe(false);
    expect(result.failure).toMatch(/blocklist/);
  });

  it('passes with empty blocklist', () => {
    const token = makeToken({ deployer: 'knownRug1' });
    const config: DiscoveryConfig = { ...defaultConfig, ruggersBlocklist: [] };
    expect(checkDeployerBlocklist(token, config)).toEqual({ passed: true, failure: undefined });
  });
});

describe('runAllFilters', () => {
  it('passes when all filters pass', () => {
    const token = makeToken();
    const holders = makeHolders();
    const sellability = makeSellability();
    const result = runAllFilters(token, holders, 20, sellability, defaultConfig);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('collects all failures when multiple filters fail', () => {
    const token = makeToken({
      poolLiquidityUsd: 0,
      lpBurnedOrLocked: false,
      mintAuthorityRevoked: false,
      freezeAuthorityRevoked: false,
      deployer: 'knownRug1',
    });
    const holders = makeHolders({ totalHolders: 0, top10Concentration: 1.0 });
    const sellability = makeSellability({ sellable: false, reason: 'honeypot' });
    const result = runAllFilters(token, holders, 0, sellability, defaultConfig);
    expect(result.passed).toBe(false);
    // All 9 filters should fail (liquidity, LP, mint, freeze, sellability, concentration, holders, velocity, blocklist)
    expect(result.failures.length).toBe(9);
  });

  it('fails on first filter failure even if rest pass', () => {
    const token = makeToken({ poolLiquidityUsd: 0 }); // only liquidity fails
    const holders = makeHolders();
    const sellability = makeSellability();
    const result = runAllFilters(token, holders, 20, sellability, defaultConfig);
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBe(1);
  });
});
