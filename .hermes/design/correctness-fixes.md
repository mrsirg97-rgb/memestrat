# Design: Correctness Fixes to STRAT.md + Implementation

## Fix 1: Regime call-site inconsistency (doc-only)

**Problem:** STRAT.md live loop pseudocode shows `regime = classify(longSlope, longESTD)` but the implementation calls `classifyRegime(bar.close, priceAtWindowStart, thresholds)` which computes ROC.

**Fix:** Update STRAT.md live loop to match implementation:
```
regime = classifyRegime(price_now, price_at_window_start, thresholds)
```
Remove the `longSlope` computation from the live loop pseudocode (it's not used by regime anymore). Keep `shortSlope` — it's used in UPTREND entry.

**Rationale change:** Replace the "0.5 threshold unreachable" justification with the real reason: ESTD-normalized regime detection assumes stationary dispersion (holds for established assets) but memecoins have non-stationary volatility — steps from ~0 to extreme in one bar. ROC is chosen for responsiveness; regime shifts happen in a handful of bars and trailing dispersion lags. Tradeoff: ROC is noisier, false flips pushed to confirmation layer.

## Fix 2a: zScore ESTD-below-epsilon guard

**Problem:** `zScore(price, ema, estd)` returns `dev / estd`. When `estd → 0` (flat pre-pump bars), this gives `0/0 = NaN` that silently compares false. Current code returns 0 when estd === 0, but doesn't distinguish "price = EMA" from "ESTD undefined."

**Fix:** `zScore` returns `number | undefined`. When `estd < epsilon` (configurable, default 1e-9), return `undefined`. `computeIndicators` propagates undefined z. `generateSignal` treats undefined z as NOOP — fail closed per AGENTS.md.

**Type changes:**
- `zScore` → `number | undefined`
- `Indicators.shortZ` / `Indicators.longZ` → `number | undefined`
- `generateSignal` signature adds undefined z handling

**Epsilon:** Default `ZSCORE_EPSILON = 1e-9` — far below any meaningful price deviation. Added as a constant in math.ts; can be made configurable later if needed.

## Fix 2b: ROC denominator guard

**Problem:** `classifyRegime` checks `priceAtWindowStart === 0` (exact). Near-zero prices could cause extreme ROC values.

**Fix:** Change to `priceAtWindowStart <= ROC_EPSILON` where `ROC_EPSILON = 1e-9`. Already returns RANGING on guard hit, just broadening the guard.

## Fix 3: Regime rationale (doc-only)

See Fix 1 rationale change.

## Fix 4: Tests

New test coverage:
- **Warmup period:** `priceAtWindowStart === undefined` → RANGING, z undefined when estd undefined
- **ESTD-below-epsilon → NOOP:** zScore returns undefined, generateSignal returns NOOP
- **ROC denominator guard:** near-zero priceAtWindowStart → RANGING
- **Regime boundary conditions:** exact boundary at +T and -T (roc === T_up → RANGING, not UPTREND; roc === -T_down → RANGING, not DOWNTREND)
- **Property tests:** zScore invariant (|z| * estd ≈ |dev| when estd > epsilon), regime invariant (classifyRegime output is always one of UPTREND/DOWNTREND/RANGING), signal invariant (DOWNTREND always → NOOP regardless of z/slope)

## Surface Items (PR description only — no code changes)

A. Z-score signal layer still divides by ESTD — same stationarity argument applies. Options: keep with justification, replace with MAD, or add a robust normalizer.
B. UPTREND entry requires shortZ <= 0 but z stays pinned overbought through vertical pumps — entry may never fire on strongest moves.
C. Regime-flip exit fires at ROC < -T_down (default 0.5 = -50%) — too slow for rug defense. Propose decoupling T_down from T_up.
