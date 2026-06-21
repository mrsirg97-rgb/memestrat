# strat

memecoin scalp strategy. long-only, fast in/out. a regime-gated model: momentum when price is
trending, a hard no-entry veto when it is dying, and mean-reversion when ranging — but the
mean-reversion branch is on probation and ships disabled (a memecoin has no stable mean to
revert to). the edge is expected to live in the momentum branch and in survivorship
(discovery filtering, see TASK.md), not in fading. the signal math is the easy part; exits
and survivorship produce the edge. this doc covers the per-symbol signal + position logic only.

semantics: `BUY` = open or add to a long, `SELL` = reduce/close a long, `NOOP` = hold. there
is no shorting — you cannot reliably short these.


## computation

### timescale

everything is in **bars**, where a bar is seconds-to-1m (config, not a constant). the original
day-based windows do not apply — a memecoin's whole life is minutes to hours.

```
short term --> 5 | 13 bar EMA
long term  --> 34 | 55 bar EMA
```

### prereq

#### exponential moving average

$$
\begin{align}
  &\alpha = \text{smoothing factor} \\
  &p_{t} = \text{current price} \\
  &n = \text{number of periods} \\
  &\alpha = \frac{2}{1 + n} \\
  &EMA(p_{t}, EMA_{t-1}, n) = \alpha\times{p_{t}} + (1 - \alpha)\times{EMA_{t-1}}
\end{align}
$$

#### deviation

$$
\begin{align}
  &DEV(p_{t}, EMA_{t}) = p_{t} - EMA_{t}
\end{align}
$$

#### exponential standard deviation

deviation weighted toward recent data (current point weighted more than history):

$$
\begin{align}
  &ESTD(p_{t}, EMA_{t}, ESTD_{t-1}, n) = \sqrt{\alpha\times{DEV(p_{t}, EMA_{t})^{2}} + (1 - \alpha)\times{ESTD_{t-1}^{2}}}
\end{align}
$$

#### slope (rate of change)

$$
\begin{align}
  &\delta = \frac{EMA_{t_{end}} - EMA_{t_{start}}}{t_{end} - t_{start}}
\end{align}
$$

#### z-score

$$
\begin{align}
  &z(p_{t}, EMA_{t}, ESTD_{t}) = \frac{DEV(p_{t}, EMA_{t})}{ESTD_{t}}
\end{align}
$$

thresholds:

$$
\begin{align}
  &\text{band} =
  \begin{cases}
    z > 1.5 & \text{overbought} \\
    0 \le z \le 1.5 & \text{rich} \\
    -1.5 \le z < 0 & \text{cheap} \\
    z < -1.5 & \text{oversold}
  \end{cases}
\end{align}
$$


## regime

classify off the **long-term slope**, normalized by ESTD so the bands mean the same thing
across tokens of wildly different volatility (config thresholds `T_up`, `T_down`):

```
slope_norm = longTermSlope / longTermESTD

regime =
  slope_norm >  T_up    -> UPTREND
  slope_norm < -T_down  -> DOWNTREND
  otherwise             -> RANGING
```

the regime is the master gate. it decides *whether* to look for an entry at all, and which
entry model to use. this is the single most important change from a plain mean-reversion
model: fading an oversold reading inside a DOWNTREND is how you catch a rug.


## confirmation

no entry fires on the z-score alone. an entry candidate must also clear, on the current bar:

  - **liquidity** above the floor (also a discovery gate, re-checked live — LP can drain).
  - **volume expansion**: current-bar volume above its own short EMA by a config multiple.
  - **buy pressure**: net taker flow positive over the last k bars.
  - **executable spread**: simulated slippage to fill the intended size is under a cap.

fail any of these -> the signal degrades to `NOOP`. unconfirmed alpha is not alpha.


## signal

```
func generate_signal(price, regime, shortZ, longZ, shortSlope, confirmed):

  // ---- DOWNTREND: the veto. no new risk in a dying coin. ----
  if regime == DOWNTREND:
    return NOOP            // entries blocked; exits are handled by manage_position()

  // ---- RANGING: mean-revert. ON PROBATION — disabled by default. ----
  // mean reversion is the weakest primitive here: a memecoin has no stable mean to revert
  // to, and "oversold" is often the first bar of the rug, not a dip. ship this branch OFF
  // (RANGING_ENABLED = false) and only switch it on if it independently clears positive
  // expectancy in sim. the edge is expected to live in UPTREND + discovery, not here.
  if regime == RANGING:
    if not RANGING_ENABLED:
      return NOOP
    if shortZ < -1.5 and longZ <= 0 and confirmed:
      return BUY           // oversold inside a stable range
    if shortZ > 1.5:
      return SELL          // overbought -> take it off (exit, see manage_position)
    return NOOP

  // ---- UPTREND: momentum. ride it, do not fade it. ----
  if regime == UPTREND:
    // enter on a confirmed continuation: a shallow pullback toward the short EMA
    // that resumes upward, NOT a blowoff top.
    if shortZ <= 0 and shortSlope > 0 and confirmed:
      return BUY           // buying strength on the dip, with the trend
    // do NOT sell on "overbought" here — that is the trend working. exits in an
    // uptrend are owned by the trailing stop in manage_position(), not by z-score.
    return NOOP

  return NOOP
```

note what is deliberately absent: there is no "sell because overbought" branch inside
UPTREND. in a vertical memecoin pump, z stays pinned overbought for the entire ride; fading
it caps every winner at near-zero gain. the trailing stop, not the oscillator, exits a trend.


## position management (exits)

every open position carries its exits from the moment of entry. exits are evaluated every
bar, independent of `generate_signal`, and take priority over it.

```
func manage_position(pos, price, regime):
  // 1. hard stop — fixed at entry, the max acceptable loss. never widened.
  if price <= pos.stop:
    return CLOSE("stop")

  // 2. take-profit ladder — scale out, lock partial gains, let a runner run.
  for level in pos.tp_ladder:
    if price >= level.target and not level.hit:
      return REDUCE(level.size, "tp")

  // 3. trailing stop — arms once in profit; this is the trend's exit.
  pos.trail = max(pos.trail, price - pos.trail_dist)
  if price <= pos.trail:
    return CLOSE("trail")

  // 4. time stop — a scalp that hasn't moved is decaying risk, not a position.
  if pos.age_bars >= pos.max_age and price < pos.entry * pos.min_progress:
    return CLOSE("time")

  // 5. regime flip — if the long-term trend rolls into DOWNTREND, get out.
  if regime == DOWNTREND:
    return CLOSE("regime")

  return HOLD
```


## sizing

risk-based, capped by liquidity. never let the position be a size you cannot exit cleanly.

```
risk_budget   = bankroll * per_trade_risk_pct        // e.g. 0.01–0.02
stop_distance = entry - stop                          // in price terms
size_by_risk  = risk_budget / stop_distance           // lose exactly risk_budget at stop
size_by_liq   = pool_liquidity * max_pool_frac         // your exit must not move the price
size          = min(size_by_risk, size_by_liq)
```


## live loop

discovery (TASK.md) promotes a filtered, scored token to the watchlist. one listener per
watched symbol then runs:

```
func price_listener(symbol):
  for price, volume, flow in stream(symbol) until demoted:
    shortEMA, longEMA   = ema(short), ema(long)
    shortESTD, longESTD = estd(short), estd(long)
    shortSlope, longSlope = slope(shortEMA), slope(longEMA)
    shortZ, longZ       = z(price, shortEMA, shortESTD), z(price, longEMA, longESTD)
    regime              = classify(longSlope, longESTD)
    confirmed           = confirm(liquidity, volume, flow, slippage)

    if has_open_position(symbol):
      act_on(manage_position(position(symbol), price, regime))   // exits first

    signal = generate_signal(price, regime, shortZ, longZ, shortSlope, confirmed)
    act_on(signal)        // subject to risk governor: caps, daily loss limit, breaker
```

exits are always evaluated before entries. the risk governor sits between `act_on` and the
execution layer and can veto or flatten everything (see TASK.md).
