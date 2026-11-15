import { DatabaseSync } from "node:sqlite";

// The `markets` table exactly as the first release of the registry created it: one curated
// 15-minute contract per event, with the event's title and series repeated on the row.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS markets (
    symbol TEXT PRIMARY KEY,
    event_ticker TEXT NOT NULL,
    series TEXT NOT NULL,
    underlying TEXT NOT NULL,
    title TEXT NOT NULL,
    label TEXT NOT NULL,
    effective_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    strike TEXT,
    venue_status TEXT NOT NULL,
    market_state TEXT NOT NULL,
    tick_px TEXT NOT NULL,
    unit_increment TEXT NOT NULL,
    min_units TEXT NOT NULL,
    resolution TEXT,
    settlement_value TEXT,
    market_address TEXT,
    yes_mint TEXT,
    no_mint TEXT,
    settle_state TEXT NOT NULL DEFAULT 'open',
    settle_signature TEXT,
    detail TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS markets_by_expiry ON markets (expires_at);
`;

export interface FirstReleaseMarket {
  symbol: string;
  eventTicker: string;
  series: string;
  underlying: string;
  title: string;
  label: string;
  effectiveAt: number;
  expiresAt: number;
  strike: string | null;
  venueStatus: string;
  marketState: string;
  resolution: string | null;
  settlementValue: string | null;
  marketAddress: string | null;
  yesMint: string | null;
  noMint: string | null;
  settleState: string;
  settleSignature: string | null;
  detail: string | null;
  updatedAt: number;
}

/** Creates a database file as the first release left it, holding the given markets. */
export function createFirstReleaseDatabase(path: string, markets: FirstReleaseMarket[]): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(SCHEMA);
    const insert = db.prepare(
      `INSERT INTO markets (symbol, event_ticker, series, underlying, title, label, effective_at, expires_at, strike,
         venue_status, market_state, tick_px, unit_increment, min_units, resolution, settlement_value, market_address,
         yes_mint, no_mint, settle_state, settle_signature, detail, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '100', '1', '1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const market of markets) {
      insert.run(
        market.symbol,
        market.eventTicker,
        market.series,
        market.underlying,
        market.title,
        market.label,
        market.effectiveAt,
        market.expiresAt,
        market.strike,
        market.venueStatus,
        market.marketState,
        market.resolution,
        market.settlementValue,
        market.marketAddress,
        market.yesMint,
        market.noMint,
        market.settleState,
        market.settleSignature,
        market.detail,
        market.updatedAt,
      );
    }
  } finally {
    db.close();
  }
}

/** The column names of a table, read through a connection of its own. */
export function columnsOf(path: string, table: string): string[] {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
  } finally {
    db.close();
  }
}
