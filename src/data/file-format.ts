/**
 * On-disk data format for historical backtesting.
 *
 * Directory layout (per token):
 *
 *   data/<mint>/
 *     meta.json    — token metadata + discovery data (JSON)
 *     bars.jsonl   — OHLCV bars, one JSON object per line (JSONL)
 *
 * ### Sample integrity
 *
 * The format represents rugs and dead-on-arrivals honestly:
 * - A **rug pull** is encoded as bars where `close → 0` (price collapse)
 *   and/or `volume → 0` (liquidity dried up). The loader does NOT drop these.
 * - A **dead-on-arrival** has `meta.json` with `poolLiquidityUsd: 0` or
 *   `lpBurnedOrLocked: false` — the discovery filter will reject it, but it
 *   stays in the universe so the filter's rejection is real, not survivorship.
 * - An **unsellable** token has `sellable: false` in meta.json — the scanner
 *   will filter it out, but the bars remain for replay.
 *
 * A rug is NOT a data quality problem — it is a data point. The loader
 * preserves every bar. The discovery filter decides whether to trade it.
 *
 * ### How a rug is encoded (concrete example)
 *
 * ```
 * meta.json:
 *   { "mint": "RUG123", "poolLiquidityUsd": 5000, "lpBurnedOrLocked": false, ... }
 *
 * bars.jsonl (last few lines):
 *   {"timestamp": 1700000500000, "open": 0.50, "high": 0.52, "low": 0.10, "close": 0.12, "volume": 8000, "netFlow": -7500, "txnCount": 45}
 *   {"timestamp": 1700000515000, "open": 0.12, "high": 0.12, "low": 0.001, "close": 0.001, "volume": 200, "netFlow": -190, "txnCount": 3}
 *   {"timestamp": 1700000530000, "open": 0.001, "high": 0.001, "low": 0.001, "close": 0.001, "volume": 0, "netFlow": 0, "txnCount": 0}
 * ```
 *
 * The price collapses from $0.50 to $0.001 in 2 bars, volume dries to 0,
 * net flow is massively negative (panic selling). The discovery filter would
 * reject this token (LP not burned, low liquidity), but the bars are preserved
 * so the backtest sees the full picture.
 */

/**
 * Token metadata file on disk.
 * Contains everything the scanner needs to evaluate a candidate.
 */
export interface FileTokenMeta {
  /** TokenInfo fields */
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  lpBurnedOrLocked: boolean;
  poolAddress?: string;
  poolLiquidityUsd: number;
  deployer: string;
  createdAt: number;

  /** HolderDistribution fields */
  totalHolders: number;
  top10Concentration: number;
  top1Concentration: number;
  giniCoefficient: number;

  /** Transaction velocity (txns per hour) */
  txnVelocity: number;

  /** Sellability check result */
  sellable: boolean;
  estimatedSlippageBps: number;
  estimatedFillTimeSeconds: number;
  sellabilityReason?: string;
}

/**
 * A single bar row from the JSONL file.
 * Matches the Bar interface exactly.
 */
export interface FileBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  netFlow: number;
  txnCount: number;
}
