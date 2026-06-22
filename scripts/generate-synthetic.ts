/**
 * Synthetic dataset generator — deterministic, seeded, clearly labeled.
 *
 * Writes a `data/synthetic/` universe of known-shape archetypes for
 * pipeline smoke testing. NOT real market data.
 *
 * Archetypes:
 * - pumpers: strong uptrend → shallow pullback → recovery (should trade and win)
 * - choppers: oscillation around a level (should classify RANGING → NOOP)
 * - rugs: normal then price → 0 mid-life, bad metadata (discovery should REJECT)
 * - dead-on-arrivals: close=0 from bar 1 (discovery should REJECT)
 *
 * Usage: npx tsx scripts/generate-synthetic.ts [output-dir]
 * Default output: data/synthetic/
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Bar } from '../src/types/market.js';
import type { FileTokenMeta } from '../src/data/file-format.js';

// --- Seeded PRNG (mulberry32) for deterministic output ---
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Bar generation helpers ---
function makeBar(
  ts: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
  netFlow: number,
  txnCount: number,
): Bar {
  return { timestamp: ts, open, high, low, close, volume, netFlow, txnCount };
}

// --- Pumper: strong uptrend → shallow pullback → recovery ---
function generatePumper(seed: number, barCount: number = 120): Bar[] {
  const rng = mulberry32(seed);
  const bars: Bar[] = [];
  const baseTs = 1_000_000_000_000;
  let price = 1.0;

  for (let i = 0; i < barCount; i++) {
    let change: number;
    if (i < 30) {
      // Strong uptrend: 3-5% per bar
      change = 0.03 + rng() * 0.02;
    } else if (i < 45) {
      // Shallow pullback: -1 to -3% per bar
      change = -(0.01 + rng() * 0.02);
    } else {
      // Recovery: 1-3% per bar
      change = 0.01 + rng() * 0.02;
    }

    const open = price;
    price = price * (1 + change);
    const close = price;
    const high = Math.max(open, close) * (1 + rng() * 0.005);
    const low = Math.min(open, close) * (1 - rng() * 0.005);
    const volume = 1000 + Math.floor(rng() * 2000);
    const netFlow = volume * (change > 0 ? 0.3 : -0.2) * (0.5 + rng() * 0.5);
    const txnCount = 5 + Math.floor(rng() * 15);

    bars.push(makeBar(baseTs + i * 15_000, open, high, low, close, volume, netFlow, txnCount));
  }

  return bars;
}

// --- Chopper: oscillation around a level (ranging) ---
function generateChopper(seed: number, barCount: number = 120): Bar[] {
  const rng = mulberry32(seed);
  const bars: Bar[] = [];
  const baseTs = 1_000_000_000_000;
  const center = 1.0;
  const amplitude = 0.05; // ±5% oscillation
  let price = center;

  for (let i = 0; i < barCount; i++) {
    // Sinusoidal oscillation with noise
    const oscillation = Math.sin(i * 0.3) * amplitude;
    const noise = (rng() - 0.5) * 0.01;
    const open = price;
    price = center + oscillation + noise;
    const close = price;
    const high = Math.max(open, close) * (1 + rng() * 0.003);
    const low = Math.min(open, close) * (1 - rng() * 0.003);
    const volume = 500 + Math.floor(rng() * 1000);
    const netFlow = (rng() - 0.5) * volume * 0.1; // roughly balanced flow
    const txnCount = 3 + Math.floor(rng() * 10);

    bars.push(makeBar(baseTs + i * 15_000, open, high, low, close, volume, netFlow, txnCount));
  }

  return bars;
}

// --- Rug: normal for a while, then price → 0 mid-life ---
function generateRug(seed: number, barCount: number = 60): Bar[] {
  const rng = mulberry32(seed);
  const bars: Bar[] = [];
  const baseTs = 1_000_000_000_000;
  let price = 1.0;
  const rugPoint = Math.floor(barCount * 0.4); // rug at 40% of lifespan

  for (let i = 0; i < barCount; i++) {
    let change: number;
    let volume: number;
    let netFlow: number;
    let txnCount: number;

    if (i < rugPoint) {
      // Normal-ish trading before rug
      change = (rng() - 0.45) * 0.03; // slight upward bias
      volume = 1000 + Math.floor(rng() * 2000);
      netFlow = (rng() - 0.4) * volume * 0.2;
      txnCount = 5 + Math.floor(rng() * 15);
    } else {
      // Rug: price collapses rapidly
      const rugProgress = (i - rugPoint) / (barCount - rugPoint);
      change = -(0.05 + rng() * 0.1) * (1 + rugProgress * 2);
      volume = Math.max(0, Math.floor(1000 * (1 - rugProgress)));
      netFlow = -Math.abs(volume * 0.5); // massive outflow
      txnCount = Math.max(0, Math.floor(10 * (1 - rugProgress)));
    }

    const open = price;
    price = Math.max(0.001, price * (1 + change));
    const close = price;
    const high = Math.max(open, close) * (1 + rng() * 0.005);
    const low = Math.min(open, close) * (1 - rng() * 0.005);

    bars.push(makeBar(baseTs + i * 15_000, open, high, low, close, volume, netFlow, txnCount));
  }

  return bars;
}

// --- Dead-on-arrival: close=0 from bar 1 ---
function generateDeadOnArrival(barCount: number = 20): Bar[] {
  const baseTs = 1_000_000_000_000;
  const bars: Bar[] = [];

  for (let i = 0; i < barCount; i++) {
    bars.push(makeBar(baseTs + i * 15_000, 0, 0, 0, 0, 0, 0, 0));
  }

  return bars;
}

// --- Metadata generators ---
function makeGoodMeta(mint: string): FileTokenMeta {
  return {
    mint,
    symbol: mint.replace(/_/g, ''),
    name: `${mint} Token`,
    decimals: 9,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    lpBurnedOrLocked: true,
    poolLiquidityUsd: 100_000 + Math.floor(Math.random() * 200_000),
    deployer: 'good_deployer',
    createdAt: 1_000_000_000_000,
    totalHolders: 200 + Math.floor(Math.random() * 300),
    top10Concentration: 0.1 + Math.random() * 0.1,
    top1Concentration: 0.03 + Math.random() * 0.05,
    giniCoefficient: 0.2 + Math.random() * 0.2,
    txnVelocity: 30 + Math.floor(Math.random() * 40),
    sellable: true,
    estimatedSlippageBps: 30 + Math.floor(Math.random() * 40),
    estimatedFillTimeSeconds: 1,
  };
}

function makeRugMeta(mint: string): FileTokenMeta {
  return {
    mint,
    symbol: mint.replace(/_/g, ''),
    name: `${mint} Rug`,
    decimals: 9,
    mintAuthorityRevoked: false, // not revoked — can mint more
    freezeAuthorityRevoked: false, // not revoked — can freeze wallets
    lpBurnedOrLocked: false, // LP can be pulled
    poolLiquidityUsd: 1_000 + Math.floor(Math.random() * 4_000), // low liquidity
    deployer: 'ruggers_wallet',
    createdAt: 1_000_000_000_000,
    totalHolders: 5 + Math.floor(Math.random() * 15),
    top10Concentration: 0.7 + Math.random() * 0.25, // extremely concentrated
    top1Concentration: 0.5 + Math.random() * 0.3,
    giniCoefficient: 0.7 + Math.random() * 0.25,
    txnVelocity: 1 + Math.floor(Math.random() * 3),
    sellable: false,
    estimatedSlippageBps: 300 + Math.floor(Math.random() * 500),
    estimatedFillTimeSeconds: 30 + Math.floor(Math.random() * 60),
    sellabilityReason: 'insufficient liquidity',
  };
}

// --- Write helpers ---
async function writeToken(
  dataDir: string,
  mint: string,
  bars: Bar[],
  meta: FileTokenMeta,
): Promise<void> {
  const tokenDir = path.join(dataDir, mint);
  await fs.mkdir(tokenDir, { recursive: true });

  const jsonl = bars.map((b) => JSON.stringify(b)).join('\n') + '\n';
  await fs.writeFile(path.join(tokenDir, 'bars.jsonl'), jsonl, 'utf-8');
  await fs.writeFile(path.join(tokenDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

// --- Main ---
async function main(): Promise<void> {
  const outputDir = process.argv[2] || path.join(process.cwd(), 'data', 'synthetic');
  const baseTs = 1_000_000_000_000;

  console.error(`Generating synthetic dataset → ${outputDir}`);

  // Clean output directory
  try {
    await fs.rm(outputDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  await fs.mkdir(outputDir, { recursive: true });

  const tokens: Array<{ mint: string; archetype: string; bars: number }> = [];

  // --- Pumpers (should trade and win) ---
  const pumperCount = 5;
  for (let i = 0; i < pumperCount; i++) {
    const mint = `PUMPER_${String(i + 1).padStart(3, '0')}`;
    const bars = generatePumper(baseTs + i * 100, 120);
    const meta = makeGoodMeta(mint);
    await writeToken(outputDir, mint, bars, meta);
    tokens.push({ mint, archetype: 'pumper', bars: bars.length });
  }

  // --- Choppers (should classify RANGING → NOOP) ---
  const chopperCount = 5;
  for (let i = 0; i < chopperCount; i++) {
    const mint = `CHOPPER_${String(i + 1).padStart(3, '0')}`;
    const bars = generateChopper(baseTs + i * 100, 120);
    const meta = makeGoodMeta(mint);
    await writeToken(outputDir, mint, bars, meta);
    tokens.push({ mint, archetype: 'chopper', bars: bars.length });
  }

  // --- Rugs (discovery should REJECT) ---
  const rugCount = 5;
  for (let i = 0; i < rugCount; i++) {
    const mint = `RUG_${String(i + 1).padStart(3, '0')}`;
    const bars = generateRug(baseTs + i * 100, 60);
    const meta = makeRugMeta(mint);
    await writeToken(outputDir, mint, bars, meta);
    tokens.push({ mint, archetype: 'rug', bars: bars.length });
  }

  // --- Dead-on-arrivals (discovery should REJECT) ---
  const doaCount = 3;
  for (let i = 0; i < doaCount; i++) {
    const mint = `DEAD_${String(i + 1).padStart(3, '0')}`;
    const bars = generateDeadOnArrival(20);
    const meta = makeRugMeta(mint);
    await writeToken(outputDir, mint, bars, meta);
    tokens.push({ mint, archetype: 'dead-on-arrival', bars: bars.length });
  }

  // --- Write README ---
  const readme = `# Synthetic Dataset — Pipeline Smoke Test

**NOT real market data.** This is a deterministic, seeded universe of known-shape
archetypes for validating the backtest pipeline end-to-end.

## Archetypes

| Archetype | Count | Expected Behavior |
|---|---|---|
| Pumpers | ${pumperCount} | Strong uptrend → pullback → recovery. Should trade and win. |
| Choppers | ${chopperCount} | Oscillation around a level. Should classify RANGING → NOOP. |
| Rugs | ${rugCount} | Normal then price → 0 mid-life, bad metadata. Discovery should REJECT. |
| Dead-on-arrivals | ${doaCount} | close=0 from bar 1. Discovery should REJECT. |

**Total: ${tokens.length} tokens**

## Sanity Expectations

When running \`npm run backtest -- data/synthetic\`:

- **Tokens Filtered > 0**: rugs and dead-on-arrivals should be rejected by discovery
- **Some trades fire on pumpers**: the pump→pullback→recovery pattern should trigger entries
- **Choppers produce NOOP**: oscillation should be classified as ranging → no trade
- **Determinism**: same dataset → identical metrics on every run

## Token List

| Mint | Archetype | Bars |
|---|---|---|
${tokens.map((t) => `| ${t.mint} | ${t.archetype} | ${t.bars} |`).join('\n')}

## Generation

\`\`\`bash
npx tsx scripts/generate-synthetic.ts [output-dir]
\`\`\`

Default output: \`data/synthetic/\`
`;
  await fs.writeFile(path.join(outputDir, 'README.md'), readme, 'utf-8');

  // --- Summary ---
  const totalBars = tokens.reduce((sum, t) => sum + t.bars, 0);
  console.error(`Done: ${tokens.length} tokens, ${totalBars} total bars`);
  console.error(`  Pumpers: ${pumperCount} (should trade and win)`);
  console.error(`  Choppers: ${chopperCount} (should classify RANGING → NOOP)`);
  console.error(`  Rugs: ${rugCount} (discovery should REJECT)`);
  console.error(`  Dead-on-arrivals: ${doaCount} (discovery should REJECT)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
