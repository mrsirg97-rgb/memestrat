# dataset

how to build a real, survivorship-honest backtest dataset. this is a HUMAN job — curation is
where survivorship bias sneaks in, and judging the source is a human call, not a model's. the
agent builds the loader and a synthetic dataset; the real universe is assembled by hand.

## the one rule that matters: sample by birth, not by survival

select the universe by a point-in-time criterion you can reconstruct as-of the past — e.g.
"every pump.fun launch in week W that crossed $Xk liquidity" — and take ALL of them, winners
and corpses. the instant you select from a "top tokens" / "trending" list, every rug is
already deleted and the sample is a lie. enumerate from a launch / first-liquidity event
stream, never from what has data today.

## what to collect (to the loader's format)

per token → `data/<mint>/`:

- `bars.jsonl` — one JSON object per line: `{timestamp, open, high, low, close, volume, netFlow, txnCount}` at the bar interval, across the token's life.
- `meta.json` — `mint, symbol, name, decimals, mintAuthorityRevoked, freezeAuthorityRevoked, lpBurnedOrLocked, poolLiquidityUsd, deployer, createdAt, totalHolders, top10Concentration, top1Concentration, giniCoefficient, txnVelocity, sellable, estimatedSlippageBps, estimatedFillTimeSeconds`.

**critical:** metadata must be AS-OF the decision point (early life, when discovery would
evaluate the token) — not current. current authority / holder state leaks the future into the
past.

## sources, and the rug-retention trap

- **on-chain indexed (best for honesty — corpses are permanent on-chain):** Helius, Bitquery, Shyft, or raw RPC (`getSignaturesForAddress` → reconstruct trades).
- **aggregators (fast, but they PRUNE dead tokens → survivorship):** Birdeye, Dexscreener, GeckoTerminal. fine for backfilling *bars*; bad as the *universe enumerator* — they forget the dead.
- **rule:** the list of who's IN must come from the permanent record (on-chain / launch data). backfill bars from aggregators if convenient, but never let them decide membership.

## include the garbage on purpose

real memecoin universes are mostly garbage — that's the honest distribution, and the strategy
has to survive it. the dataset should be too:

- rugs (LP pulled, price→0, unsellable), honeypots (freeze/mint live, `sellable=false`), dead-on-arrivals (no traction, `close=0` from bar 1).
- **if under ~60–70% of the tokens are rugs/dead, the sample probably has survivorship bias.** a dataset that's mostly winners is fiction.

## leaks to refuse

- **survivorship** → sample by birth (above).
- **look-ahead** → every feature as-of decision time, never current.
- **outcome selection** → never filter the universe by anything only knowable after the fact.

## self-check before trusting a run

- loader `skipped = 0` — no silent universe shrink (the fix-3 loader reports drops).
- `Tokens Filtered` is HIGH — most got rejected by discovery. near zero means the sample has no garbage in it.
- spot-check: pick 3 known rugs, confirm they're in `data/` and got filtered.

## minimum viable first cut

one week of pump.fun launches that crossed ~$Xk liquidity → enumerate ALL of them → pull bars
+ as-of meta → write to `data/real/` → `npm run backtest -- data/real/`. a few hundred
token-lifecycles is enough to start; expand once the pipeline behaves and the metrics look
sane.

## what the run tells you (and what it doesn't)

a PASS here is a *real-market* verdict only if the dataset is honest (sampled by birth, rugs
included, no look-ahead). the synthetic dataset (`data/synthetic/`) proves the pipeline runs;
this dataset proves whether the strategy has edge. don't confuse the two.
