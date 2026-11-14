// Durable registry of the venue contracts the relayer offers: what the venue says about each one,
// where its market lives on-chain, and how far its settlement got. Table `markets`, kept in the
// same SQLite file as the order journal.

import { DatabaseSync } from "node:sqlite";
import type { SettleState } from "./api/types.ts";
import type { ContractInfo } from "./venue/venue.ts";

export type { SettleState };

export interface RegistryMarket {
  symbol: string;
  eventTicker: string;
  series: string;
  underlying: string;
  title: string;
  label: string;
  /** Unix milliseconds. */
  effectiveAt: number;
  expiresAt: number;
  strike: string | null;
  venueStatus: string;
  marketState: string;
  tickPx: bigint;
  unitIncrement: bigint;
  minUnits: bigint;
  resolution: "yes" | "no" | null;
  settlementValue: string | null;
  marketAddress: string | null;
  yesMint: string | null;
  noMint: string | null;
  settleState: SettleState;
  settleSignature: string | null;
  detail: string | null;
  /** Unix milliseconds. */
  updatedAt: number;
}

export interface Registry {
  /**
   * Stores what the venue says about a contract. Never clears on-chain or settle fields, and a
   * display field, strike, resolution or settlement value the venue left out keeps its old value.
   */
  upsertContract(info: ContractInfo, nowMs: number): RegistryMarket;
  setOnchain(symbol: string, a: { marketAddress: string; yesMint: string; noMint: string }): void;
  setSettle(symbol: string, state: SettleState, info?: { signature?: string; detail?: string }): void;
  get(symbol: string): RegistryMarket | undefined;
  /** Contracts of the given series that have not expired, soonest expiry first. */
  live(nowMs: number, series: string[]): RegistryMarket[];
  /** At most `limit` contracts, newest expiry first. */
  all(limit: number): RegistryMarket[];
  /** Markets with an on-chain address whose settle state is open or awaiting_result. */
  onchainUnsettled(): RegistryMarket[];
  close(): void;
}

/** The contract's series: the venue's, else the event ticker without its trailing digits. */
export function seriesOf(info: Pick<ContractInfo, "series" | "eventTicker">): string {
  if (info.series !== undefined && info.series !== "") return info.series;
  return info.eventTicker.replace(/\d+$/, "") || info.eventTicker;
}

/** The series without a trailing interval tag: `BTC15M` -> `BTC`. Anything else is returned as is. */
export function underlyingOf(series: string): string {
  return /^(.*\D)\d+[A-Za-z]+$/.exec(series)?.[1] ?? series;
}

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

type Row = Record<string, unknown>;

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toMarket(row: Row): RegistryMarket {
  return {
    symbol: String(row.symbol),
    eventTicker: String(row.event_ticker),
    series: String(row.series),
    underlying: String(row.underlying),
    title: String(row.title),
    label: String(row.label),
    effectiveAt: Number(row.effective_at),
    expiresAt: Number(row.expires_at),
    strike: textOrNull(row.strike),
    venueStatus: String(row.venue_status),
    marketState: String(row.market_state),
    tickPx: BigInt(String(row.tick_px)),
    unitIncrement: BigInt(String(row.unit_increment)),
    minUnits: BigInt(String(row.min_units)),
    resolution: row.resolution === "yes" || row.resolution === "no" ? row.resolution : null,
    settlementValue: textOrNull(row.settlement_value),
    marketAddress: textOrNull(row.market_address),
    yesMint: textOrNull(row.yes_mint),
    noMint: textOrNull(row.no_mint),
    settleState: row.settle_state as SettleState,
    settleSignature: textOrNull(row.settle_signature),
    detail: textOrNull(row.detail),
    updatedAt: Number(row.updated_at),
  };
}

/** Opens (and creates when missing) the registry at `path`; `":memory:"` gives a throwaway one. */
export function openRegistry(path: string): Registry {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode=WAL");
  // The journal writes to the same file through its own connection.
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(SCHEMA);

  const selectOne = db.prepare("SELECT * FROM markets WHERE symbol = ?");
  const upsert = db.prepare(
    `INSERT INTO markets (symbol, event_ticker, series, underlying, title, label, effective_at, expires_at, strike,
       venue_status, market_state, tick_px, unit_increment, min_units, resolution, settlement_value, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (symbol) DO UPDATE SET
       event_ticker = excluded.event_ticker, series = excluded.series, underlying = excluded.underlying,
       title = excluded.title, label = excluded.label, effective_at = excluded.effective_at,
       expires_at = excluded.expires_at, strike = excluded.strike, venue_status = excluded.venue_status,
       market_state = excluded.market_state, tick_px = excluded.tick_px, unit_increment = excluded.unit_increment,
       min_units = excluded.min_units, resolution = excluded.resolution,
       settlement_value = excluded.settlement_value, updated_at = excluded.updated_at`,
  );
  const updateOnchain = db.prepare("UPDATE markets SET market_address = ?, yes_mint = ?, no_mint = ?, updated_at = ? WHERE symbol = ?");
  const updateSettle = db.prepare(
    `UPDATE markets SET settle_state = ?, settle_signature = COALESCE(?, settle_signature), detail = COALESCE(?, detail),
       updated_at = ? WHERE symbol = ?`,
  );
  const selectAll = db.prepare("SELECT * FROM markets ORDER BY expires_at DESC, symbol LIMIT ?");
  const selectUnsettled = db.prepare(
    `SELECT * FROM markets WHERE market_address IS NOT NULL AND settle_state IN ('open', 'awaiting_result')
     ORDER BY expires_at, symbol`,
  );

  function get(symbol: string): RegistryMarket | undefined {
    const row = selectOne.get(symbol) as Row | undefined;
    return row === undefined ? undefined : toMarket(row);
  }

  function mustChange(result: { changes: number | bigint }, symbol: string): void {
    if (Number(result.changes) === 0) throw new Error(`unknown market ${symbol}`);
  }

  return {
    upsertContract(info, nowMs) {
      const effectiveAt = info.effectiveAt.getTime();
      const expiresAt = info.expiresAt.getTime();
      if (!Number.isFinite(effectiveAt) || !Number.isFinite(expiresAt)) {
        throw new Error(`contract ${info.symbol}: unreadable effective or expiry date`);
      }
      const known = get(info.symbol);
      const series = info.series === undefined && known !== undefined ? known.series : seriesOf(info);
      upsert.run(
        info.symbol,
        info.eventTicker,
        series,
        underlyingOf(series),
        info.title ?? known?.title ?? info.eventTicker,
        info.label ?? known?.label ?? info.symbol.slice(info.symbol.lastIndexOf("-") + 1),
        effectiveAt,
        expiresAt,
        info.strike ?? known?.strike ?? null,
        info.status,
        info.marketState,
        info.tickPx.toString(),
        info.unitIncrement.toString(),
        info.minUnits.toString(),
        info.resolutionSide ?? known?.resolution ?? null,
        info.settlementValue ?? known?.settlementValue ?? null,
        nowMs,
      );
      return get(info.symbol)!;
    },

    setOnchain(symbol, a) {
      mustChange(updateOnchain.run(a.marketAddress, a.yesMint, a.noMint, Date.now(), symbol), symbol);
    },

    setSettle(symbol, state, info) {
      mustChange(updateSettle.run(state, info?.signature ?? null, info?.detail ?? null, Date.now(), symbol), symbol);
    },

    get,

    live(nowMs, series) {
      if (series.length === 0) return [];
      const marks = series.map(() => "?").join(", ");
      const rows = db
        .prepare(`SELECT * FROM markets WHERE expires_at > ? AND series IN (${marks}) ORDER BY expires_at, symbol`)
        .all(nowMs, ...series) as Row[];
      return rows.map(toMarket);
    },

    all(limit) {
      if (!Number.isInteger(limit) || limit <= 0) return [];
      return (selectAll.all(limit) as Row[]).map(toMarket);
    },

    onchainUnsettled() {
      return (selectUnsettled.all() as Row[]).map(toMarket);
    },

    close() {
      db.close();
    },
  };
}
