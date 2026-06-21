build an autonomous memecoin scalping pipeline that discovers candidates, generates
signals, manages risk, and proves itself in simulation before anything goes live.

# setup

work directly in this repo. use test driven design: for each feature, isolate it, write the
test, make it pass, commit. one feature per commit, tests green before every commit.

for each feature, keep a session log under `./sessions/` (i.e. `~/Projects/memestrat/sessions/`):
`sessions-NNN.md`, starting at `sessions-001.md` and increasing monotonically — one file per
feature, never reused. capture what you built, the key decisions and trade-offs, and the
outcome (tests, branch, PR). terse, not academic — this is the audit trail of the build.

read the companion docs first — they govern how this gets built:
  - `AGENTS.md` — the engineering habits and conventions to build by. read before writing code.
  - `STRAT.md` — the per-symbol signal + position logic to implement against.
  - `WORKFLOW.md` — git/github flow: branch per task, one PR per task, CI as the gate.

# implementation

substrate is the agent's call, but it is driven by one fact: the strategy math is small and
portable, while the discovery/data layer is the bulk of the work and depends on mature
chain tooling (rpc, token-program introspection, pool/holder state, a quote source for
sellability sim). pick a language with first-class access to that ecosystem — do not
hand-roll chain plumbing. the signal math then ports in trivially.

the architecture below (event loop, per-symbol listeners, scoped resource lifecycles,
circuit breaker) is the reusable shape regardless of language.

# venue + execution (assumption — confirm before live)

target solana memecoins (pump.fun / raydium-class venues). all execution is **simulated
paper trading** against real market data. no real capital moves without an explicit human
sign-off gate. keep the data source and the execution layer behind interfaces so the venue
is swappable and live-vs-sim is a config flag, not a code change.

# the core mandate

maximize realized profit while bounding downside. these are scalps, not holds — a position
that isn't working is closed, not nursed. the catastrophic loss (rug / unsellable / -100%)
is the enemy; most of the work is keeping those out of the book, not picking tops.

# strategy adaptation (from STRAT.md)

the base mean-reversion + z-score model stays, but retuned and re-gated for memecoins:

1. **retime everything.** drop the day-based EMA periods. work in ticks / sub-minute bars.
   short term ~ 5/13 bars, long term ~ 34/55 bars, where a bar is seconds-to-1m. make the
   windows a tunable param/config block, not a magic constant.

2. **regime split — fade only when ranging, ride when trending.** the pure model fades
   overbought and buys oversold. that's wrong in a vertical pump. use the long-term slope:
     - long-term slope flat/ranging -> mean-revert (the STRAT.md logic applies). **on
       probation:** mean reversion is the weakest primitive for memecoins (a memecoin has no
       stable mean to revert to; "oversold" is often the first bar of the rug). ship this
       branch DISABLED by default. only enable it if it independently clears positive
       expectancy in sim. the edge is expected to live in the trend + discovery branches.
     - long-term slope strongly positive -> momentum/breakout entries with a trailing stop;
       do NOT fade a healthy pump early. this is the primary edge.
     - long-term slope strongly negative -> **hard veto on all longs.** never buy the
       "oversold" dip of a dying coin. this single rule is the main defense against the
       -100% tail. note: slope-of-long-EMA is a lagging instrument — the real-time risk load
       is carried by the hard stop + trailing stop, not by this veto. consider a faster
       regime proxy (EMA cross, rate-of-change percentile, market structure).

3. **confirm signals, don't trust them raw.** a z-score entry only fires with volume
   expansion + live buy-side pressure + liquidity above floor. an unconfirmed signal is NOOP.

4. **exit fast and asymmetric.** every position carries, from the moment of entry:
     - a hard stop (max acceptable loss, set before the trade).
     - a take-profit ladder (scale out, don't all-or-nothing).
     - a trailing stop once in profit (lock gains on momentum runs).
     - a time-stop: if it hasn't moved in N bars, exit flat. dead scalps tie up capital
       and decay into risk.

# discovery (where win rate is actually won)

a scanner that continuously surfaces candidates and scores them. this is a survivorship
filter first, an alpha filter second. a candidate is only promoted to the watchlist if it
clears ALL of:
  - liquidity floor (min LP depth).
  - LP burned or locked.
  - mint authority revoked AND freeze authority revoked (freeze-auth = vault-freeze DoS / a
    soft honeypot — non-negotiable filter).
  - sellability check — simulate a sell; if you can't get out, it's not a candidate.
  - top-holder concentration cap (e.g. top-10 wallets under a threshold).
  - minimum unique holders + minimum txn velocity (real two-sided flow, not wash).
  - deployer not on a blocklist of known ruggers (blocklist, not allowlist — immutable-set
    posture: deny the known-bad, admit the rest).
scoring ranks the survivors; the watcher only ever trades from the scored, filtered pool.

# watcher service

a single event-driven service (one event loop, scoped concerns) running these concurrently:
  - **scanner** — polls/streams new tokens + market data, applies discovery filters, scores.
  - **watchlist** — the promoted candidate pool; demotes candidates that decay below floor.
  - **price listeners** — one per watched symbol, computes EMA/dev/z-score/trend and emits
    signals (the STRAT.md price_listener loop, retimed).
  - **position manager** — owns open positions, enforces stops / TP ladder / trailing /
    time-stop, handles fills.
  - **risk governor** — global circuit breaker (see below). can halt the whole pipeline.
each concern owns its own resources with explicit create/destroy lifecycles — no shared
mutable state leaking across concerns, no implicit cleanup.

# risk / downside (hard limits, enforced by the governor)

  - per-trade max loss capped at a small % of bankroll (e.g. 1-2%).
  - position size scaled down by liquidity and volatility — never size such that your own
    exit moves the price materially (cap position as a % of LP).
  - max concurrent positions cap.
  - daily loss limit -> trip the circuit breaker, flatten, stop opening new trades.
  - track catastrophic-loss rate (trades that lose more than the hard stop allowed, i.e.
    gapped/slipped/unsellable) as a first-class metric. driving it toward zero is the job
    of discovery, not the signal.

# performance targets (net of fees + slippage + modeled fills, out-of-sample)

success is risk-based, not win-rate based. **win rate is NOT a target and NOT a gate** — it
is a derived diagnostic, reported but never optimized. a high win rate bought with wide stops
is one trade from ruin; a 35%-win-rate book with 4:1 winners can be excellent. the unit of
account is **R** — the capital risked on a trade (size x entry-to-stop distance, ~a fixed %
of bankroll). every outcome is in multiples of R: a stop is -1R, a 3:1 exit is +3R, a
gap-through fill is worse than -1R.

the bar (all must hold on out-of-sample):
  - **expectancy > 0** — mean R per trade is positive. this is the edge. primary gate.
  - **profit factor** (gross +R / gross -R) >= 1.5.
  - **risk-adjusted return** — total R captured / max-drawdown-R >= a stated floor. reward
    per unit of pain; this is the headline number.
  - **max drawdown** (in R and as % bankroll) under a stated cap.
  - **tail control** — fraction of trades realizing worse than -1R (gap / slip / unsellable)
    under a small cap, and worst single-trade R bounded. the rug/fill tax, made measurable.
  - **exposure discipline** — max bankroll fraction in a single name AND max aggregate
    exposure stay under their caps for the whole run. sizing in and out is itself a metric,
    not a side effect.
report the full block every backtest. a run that nails expectancy but blows the drawdown or
tail cap is a FAIL, not a partial pass. there is no win-rate row to hide behind.

# simulation harness (gate to "done")

  - **adversarial fill model — the make-or-break component.** fills are NOT at mid. model a
    slippage curve as a function of order size vs. live pool liquidity; model stop
    gap-through (realized exits routinely worse than the stop price); model LP drain between
    signal and fill; tax every fill with fees + priority/MEV. a strategy that only works at
    mid is a strategy that only works on paper — this is where the paper-to-live cliff lives.
  - **sample integrity — no survivorship.** replay discovery against the full historical
    token universe at each point in time, including the rugs and dead-on-arrivals the filter
    would have admitted. a curated set of tokens that happened to survive is grading on easy
    mode and inflates every metric.
  - deterministic, reproducible backtest over recorded token data — same input, same result.
  - walk-forward / out-of-sample split. tune on in-sample, prove on out-of-sample only.
    keep the tunable surface small — pin most params with priors; with ~15 free knobs against
    a thin supply of independent events, in-sample fit is meaningless. only out-of-sample counts.
  - report the full metric block per run.
definition of done: the pipeline clears every performance target on out-of-sample data,
under the adversarial fill model, across a universe that includes the rugs and the dead.

# guardrails

  - paper/simulated by default; live trading requires an explicit human sign-off flag.
  - no metric gaming: do not optimize one target at the expense of the conjunction above.
  - if a filter or cap is relaxed to hit a number, log it loudly — a silently loosened rug
    filter reads as "passed" when it didn't.
