/** Position management — exits, sizing, and R-based PnL tracking. */
import type { ExitConfig, SizingConfig } from '../types/config.js';
import type { Position, PositionAction, Regime, TradeOutcome } from '../types/signal.js';

/**
 * Build a new position from entry parameters.
 */
export function createPosition(
  mint: string,
  entry: number,
  size: number,
  config: ExitConfig,
  timestamp: number,
): Position {
  const stop = entry * (1 - config.hardStopPct);
  const trailDist = entry * config.trailDistPct;

  const tpLadder = config.tpLadder.map((level) => ({
    target: entry * (1 + level.targetPct),
    sizeFrac: level.sizeFrac,
    hit: false,
  }));

  return {
    mint,
    entry,
    size,
    stop,
    tpLadder,
    trail: stop, // trail starts at hard stop, arms once in profit
    trailDist,
    ageBars: 0,
    maxAgeBars: config.maxAgeBars,
    minProgress: config.minProgress,
    entryTimestamp: timestamp,
  };
}

/**
 * Manage position exits — evaluated every bar, independent of signal generation.
 * Exits take priority over entries.
 */
export function managePosition(
  pos: Position,
  price: number,
  regime: Regime,
): PositionAction {
  // Update trailing stop first — it's stateful and always advances.
  // Trail distance scales with current price, not entry price.
  const currentTrailDist = price * (pos.trailDist / pos.entry);
  pos.trail = Math.max(pos.trail, price - currentTrailDist);

  // 1. Hard stop — fixed at entry, the max acceptable loss. Never widened.
  if (price <= pos.stop) {
    return { type: 'CLOSE', reason: 'stop' };
  }

  // 2. Trailing stop — check after updating (can trigger on same bar as update).
  if (price <= pos.trail) {
    return { type: 'CLOSE', reason: 'trail' };
  }

  // 3. Take-profit ladder — scale out, lock partial gains, let a runner run.
  for (const level of pos.tpLadder) {
    if (price >= level.target && !level.hit) {
      return { type: 'REDUCE', sizeFrac: level.sizeFrac, reason: 'tp' };
    }
  }

  // 4. Time stop — a scalp that hasn't moved is decaying risk, not a position.
  if (pos.ageBars >= pos.maxAgeBars && price <= pos.entry * pos.minProgress) {
    return { type: 'CLOSE', reason: 'time' };
  }

  // 5. Regime flip — if the long-term trend rolls into DOWNTREND, get out.
  if (regime === 'DOWNTREND') {
    return { type: 'CLOSE', reason: 'regime' };
  }

  return { type: 'HOLD' };
}

/**
 * Advance position state by one bar (increment age, mark TP hits).
 */
export function advancePosition(pos: Position, price: number): void {
  pos.ageBars += 1;

  // Mark TP levels as hit if price has passed them
  for (const level of pos.tpLadder) {
    if (price >= level.target) {
      level.hit = true;
    }
  }
}

/**
 * Calculate position size using risk-based sizing capped by liquidity.
 * @param bankroll Current bankroll in USD.
 * @param entryPrice Entry price in USD.
 * @param stopPrice Stop price in USD.
 * @param poolLiquidityUsd Pool liquidity in USD.
 * @param config Sizing configuration.
 * @returns Position size in USD.
 */
export function calculateSize(
  bankroll: number,
  entryPrice: number,
  stopPrice: number,
  poolLiquidityUsd: number,
  config: SizingConfig,
): number {
  const riskBudget = bankroll * config.perTradeRiskPct;
  const stopDistance = entryPrice - stopPrice;

  if (stopDistance <= 0) return 0;

  const sizeByRisk = riskBudget / (stopDistance / entryPrice); // normalize to price ratio
  const sizeByLiq = poolLiquidityUsd * config.maxPoolFrac;

  return Math.min(sizeByRisk, sizeByLiq);
}

/**
 * Calculate PnL in R multiples for a trade outcome.
 * R = risk amount (capital at risk on the trade).
 * A stop hit is -1R, a 3:1 exit is +3R.
 */
export function calculatePnlR(
  entry: number,
  exitPrice: number,
  stop: number,
  size: number,
): { pnlR: number; pnlUsd: number; riskAmount: number } {
  const riskAmount = (entry - stop) * size / entry; // risk in USD
  const pnlUsd = (exitPrice - entry) * size / entry; // PnL in USD

  if (riskAmount === 0) return { pnlR: 0, pnlUsd: 0, riskAmount: 0 };

  const pnlR = pnlUsd / riskAmount;

  return { pnlR, pnlUsd, riskAmount };
}

/**
 * Build a trade outcome record from position and exit details.
 */
export function buildTradeOutcome(
  pos: Position,
  exitPrice: number,
  exitReason: string,
  exitTimestamp: number,
): TradeOutcome {
  const { pnlR, pnlUsd, riskAmount } = calculatePnlR(pos.entry, exitPrice, pos.stop, pos.size);

  return {
    mint: pos.mint,
    entry: pos.entry,
    exitPrice,
    exitReason,
    pnlR,
    riskAmount,
    pnlUsd,
    entryTimestamp: pos.entryTimestamp,
    exitTimestamp,
    closed: true,
  };
}
