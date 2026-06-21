/** Market data types — the raw inputs to the signal engine. */

/** A single price bar (OHLCV + flow). */
export interface Bar {
  /** Bar timestamp (epoch ms). */
  timestamp: number;
  /** Open price (USD). */
  open: number;
  /** High price (USD). */
  high: number;
  /** Low price (USD). */
  low: number;
  /** Close price (USD). */
  close: number;
  /** Volume in USD. */
  volume: number;
  /** Net taker flow in USD (positive = buy pressure, negative = sell pressure). */
  netFlow: number;
  /** Number of transactions in this bar. */
  txnCount: number;
}

/** Token metadata from the chain. */
export interface TokenInfo {
  /** Token mint address. */
  mint: string;
  /** Token symbol (if available). */
  symbol: string;
  /** Token name (if available). */
  name: string;
  /** Decimals. */
  decimals: number;
  /** Whether mint authority is revoked. */
  mintAuthorityRevoked: boolean;
  /** Whether freeze authority is revoked. */
  freezeAuthorityRevoked: boolean;
  /** Whether LP is burned or locked. */
  lpBurnedOrLocked: boolean;
  /** LP pool address (Raydium/Orca). */
  poolAddress?: string;
  /** Pool liquidity in USD. */
  poolLiquidityUsd: number;
  /** Deployer address. */
  deployer: string;
  /** Creation timestamp (epoch ms). */
  createdAt: number;
}

/** Holder distribution snapshot. */
export interface HolderDistribution {
  /** Total unique holders. */
  totalHolders: number;
  /** Top-10 holders as fraction of total supply. */
  top10Concentration: number;
  /** Top holder as fraction of total supply. */
  top1Concentration: number;
  /** Gini coefficient of holder distribution (0 = perfectly equal, 1 = perfectly unequal). */
  giniCoefficient: number;
}

/** Sellability simulation result. */
export interface SellabilityResult {
  /** Whether the token is sellable (can exit a position). */
  sellable: boolean;
  /** Estimated slippage in basis points for a sell of the given size. */
  estimatedSlippageBps: number;
  /** Estimated time to fill in seconds. */
  estimatedFillTimeSeconds: number;
  /** Reason if not sellable. */
  reason?: string;
}

/** Token candidate with discovery filter results and score. */
export interface TokenCandidate {
  token: TokenInfo;
  holders: HolderDistribution;
  /** Transaction velocity (txns per hour). */
  txnVelocity: number;
  /** Composite discovery score (0-1). */
  score: number;
  /** Whether all survivorship filters passed. */
  passed: boolean;
  /** List of filter failures (empty if passed). */
  failures: string[];
}

/** Watchlist entry — a promoted candidate being actively monitored. */
export interface WatchlistEntry {
  token: TokenInfo;
  score: number;
  /** When this entry was promoted (epoch ms). */
  promotedAt: number;
  /** When this entry was last updated (epoch ms). */
  updatedAt: number;
  /** Whether this entry should be demoted (decayed below floor). */
  demoted: boolean;
}

/** Liquidity snapshot for a token. */
export interface LiquiditySnapshot {
  /** Pool liquidity in USD. */
  liquidityUsd: number;
  /** Timestamp of this snapshot (epoch ms). */
  timestamp: number;
}
