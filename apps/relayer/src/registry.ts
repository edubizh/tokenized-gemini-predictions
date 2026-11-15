// Durable registry of the venue's events and contracts: what the venue says about each one, where
// a contract's market lives on-chain, and how far its settlement got. Tables `events` and
// `markets`, kept in the same SQLite file as the order journal.

import { DatabaseSync } from "node:sqlite";
import type { Cadence, SettleState } from "./api/types.ts";
import type { ContractInfo, EventInfo } from "./venue/venue.ts";

export type { SettleState };

/** One contract of the venue; a "market" once it also exists on-chain. */
export interface RegistryMarket {
  symbol: string;
  eventTicker: string;
  /** Title of the event the contract belongs to. */
  title: string;
  label: string;
  sortOrder: number;
  rules: string;
  /** Unix milliseconds. */
  effectiveAt: number;
  expiresAt: number;
  strike: string | null;
  venueStatus: string;
  marketState: string;
  tickPx: bigint;
  unitIncrement: bigint;
  minUnits: bigint;
  /** Price of the last trade at the venue in YES price space; null when it never traded. */
  lastPx: bigint | null;
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

export interface RegistryEvent {
  ticker: string;
  title: string;
  category: string;
  subcategory: string[];
  underlying: string;
  shape: "binary" | "ladder";
  cadence: Cadence;
  description: string;
  source: { agency: string; index: string } | null;
  termsUrl: string | null;
  /** Unix milliseconds. */
  listedAt: number;
  expiresAt: number;
  venueStatus: string;
  volumeUnits: bigint;
  updatedAt: number;
  /** Ascending by `sortOrder`. */
  markets: RegistryMarket[];
}

export interface Registry {
  /**
   * Stores a list read: every event with its contracts, in one transaction. On-chain and settle
   * fields are never touched, and a venue status never moves backwards. An event or a contract
   * that cannot be stored is left out and reported in the returned list; the rest is stored.
   */
  storeEvents(events: EventInfo[], nowMs: number): Error[];
  /**
   * Stores a single read of a contract the registry knows, under the same rules. What the read
   * left out (label, rule, strike, resolution, settlement value, last price) keeps its value.
   */
  updateContract(info: ContractInfo, nowMs: number): RegistryMarket;
  setOnchain(symbol: string, a: { marketAddress: string; yesMint: string; noMint: string }): void;
  setSettle(symbol: string, state: SettleState, info?: { signature?: string; detail?: string }): void;
  /**
   * Deletes the contracts that expired more than a day before `nowMs` and never got an on-chain
   * market, and the events of that age left without a contract.
   */
  prune(nowMs: number): void;
  get(symbol: string): RegistryMarket | undefined;
  /** One event with its contracts, expired or not. */
  event(ticker: string): RegistryEvent | undefined;
  /** The events that have not expired, soonest expiry first, with their contracts. */
  liveEvents(nowMs: number): RegistryEvent[];
  /** At most `limit` markets that exist on-chain, newest expiry first. */
  onchain(limit: number): RegistryMarket[];
  /** Markets with an on-chain address whose settle state is open or awaiting_result. */
  onchainUnsettled(): RegistryMarket[];
  close(): void;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    ticker TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    subcategory TEXT NOT NULL,
    underlying TEXT NOT NULL,
    shape TEXT NOT NULL,
    cadence TEXT NOT NULL,
    description TEXT NOT NULL,
    source_agency TEXT,
    source_index TEXT,
    terms_url TEXT,
    listed_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    venue_status TEXT NOT NULL,
    volume_units TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_by_expiry ON events (expires_at);
  CREATE TABLE IF NOT EXISTS markets (
    symbol TEXT PRIMARY KEY,
    event_ticker TEXT NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    rules TEXT NOT NULL DEFAULT '',
    effective_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    strike TEXT,
    venue_status TEXT NOT NULL,
    market_state TEXT NOT NULL,
    tick_px TEXT NOT NULL,
    unit_increment TEXT NOT NULL,
    min_units TEXT NOT NULL,
    last_px TEXT,
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
  CREATE INDEX IF NOT EXISTS markets_by_event ON markets (event_ticker);
`;

/**
 * The first release listed crypto contracts only, one per event, and repeated the event's title,
 * series and underlying on the market row. Each of those rows gets an event made from its own
 * columns, with the cadence that follows from how long the contract ran; then the repeated
 * columns go and the new ones arrive.
 */
const MIGRATE_FIRST_RELEASE = `
  INSERT OR IGNORE INTO events (ticker, title, category, subcategory, underlying, shape, cadence, description,
    listed_at, expires_at, venue_status, volume_units, updated_at)
  SELECT event_ticker, title, 'Crypto', '[]', underlying, 'binary',
    CASE WHEN expires_at - effective_at <= 300000 THEN '5m'
         WHEN expires_at - effective_at <= 900000 THEN '15m'
         WHEN expires_at - effective_at <= 5400000 THEN 'hourly'
         WHEN expires_at - effective_at <= 129600000 THEN 'daily'
         WHEN expires_at - effective_at <= 864000000 THEN 'weekly'
         ELSE 'monthly' END,
    '', effective_at, expires_at, venue_status, '0', updated_at
  FROM markets GROUP BY event_ticker;
  ALTER TABLE markets ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE markets ADD COLUMN rules TEXT NOT NULL DEFAULT '';
  ALTER TABLE markets ADD COLUMN last_px TEXT;
  ALTER TABLE markets DROP COLUMN series;
  ALTER TABLE markets DROP COLUMN underlying;
  ALTER TABLE markets DROP COLUMN title;
`;

/** A market row with the title of its event; a row is never hidden by a missing event. */
const SELECT_MARKETS = `SELECT m.*, COALESCE(e.title, m.event_ticker) AS title
  FROM markets m LEFT JOIN events e ON e.ticker = m.event_ticker`;

/** The order a venue status moves in. */
const STATUS_ORDER = ["approved", "active", "under_review", "settled"];
/** Contracts that never got an on-chain market are forgotten this long after they expired. */
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1_000;

type Row = Record<string, unknown>;

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** `read`, unless it would move a known status backwards: a read can be older than an earlier one. */
function laterStatus(stored: string | undefined, read: string): string {
  if (stored === undefined) return read;
  const from = STATUS_ORDER.indexOf(stored);
  const to = STATUS_ORDER.indexOf(read);
  return from >= 0 && to >= 0 && to < from ? stored : read;
}

function toMarket(row: Row): RegistryMarket {
  return {
    symbol: String(row.symbol),
    eventTicker: String(row.event_ticker),
    title: String(row.title),
    label: String(row.label),
    sortOrder: Number(row.sort_order),
    rules: String(row.rules),
    effectiveAt: Number(row.effective_at),
    expiresAt: Number(row.expires_at),
    strike: textOrNull(row.strike),
    venueStatus: String(row.venue_status),
    marketState: String(row.market_state),
    tickPx: BigInt(String(row.tick_px)),
    unitIncrement: BigInt(String(row.unit_increment)),
    minUnits: BigInt(String(row.min_units)),
    lastPx: row.last_px === null ? null : BigInt(String(row.last_px)),
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

function toEvent(row: Row, markets: RegistryMarket[]): RegistryEvent {
  return {
    ticker: String(row.ticker),
    title: String(row.title),
    category: String(row.category),
    subcategory: JSON.parse(String(row.subcategory)) as string[],
    underlying: String(row.underlying),
    shape: row.shape === "ladder" ? "ladder" : "binary",
    cadence: row.cadence as Cadence,
    description: String(row.description),
    source: row.source_agency === null || row.source_index === null ? null : { agency: String(row.source_agency), index: String(row.source_index) },
    termsUrl: textOrNull(row.terms_url),
    listedAt: Number(row.listed_at),
    expiresAt: Number(row.expires_at),
    venueStatus: String(row.venue_status),
    volumeUnits: BigInt(String(row.volume_units)),
    updatedAt: Number(row.updated_at),
    markets,
  };
}

/**
 * Opens (and creates when missing) the registry at `path`; `":memory:"` gives a throwaway one. A
 * file of the first release is brought to the current tables in place, once.
 */
export function openRegistry(path: string): Registry {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode=WAL");
  // The journal writes to the same file through its own connection.
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(SCHEMA);

  /** Runs `work` in one transaction: committed when it returns, rolled back when it throws. */
  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const columns = db.prepare("PRAGMA table_info(markets)").all() as Row[];
  if (columns.some((column) => column.name === "title")) transaction(() => db.exec(MIGRATE_FIRST_RELEASE));

  const selectOne = db.prepare(`${SELECT_MARKETS} WHERE m.symbol = ?`);
  const selectStored = db.prepare("SELECT * FROM markets WHERE symbol = ?");
  const upsertMarket = db.prepare(
    `INSERT INTO markets (symbol, event_ticker, label, sort_order, rules, effective_at, expires_at, strike, venue_status,
       market_state, tick_px, unit_increment, min_units, last_px, resolution, settlement_value, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (symbol) DO UPDATE SET
       event_ticker = excluded.event_ticker, label = excluded.label, sort_order = excluded.sort_order,
       rules = excluded.rules, effective_at = excluded.effective_at, expires_at = excluded.expires_at,
       strike = excluded.strike, venue_status = excluded.venue_status, market_state = excluded.market_state,
       tick_px = excluded.tick_px, unit_increment = excluded.unit_increment, min_units = excluded.min_units,
       last_px = excluded.last_px, resolution = excluded.resolution, settlement_value = excluded.settlement_value,
       updated_at = excluded.updated_at`,
  );
  const selectEventStatus = db.prepare("SELECT venue_status FROM events WHERE ticker = ?");
  const upsertEvent = db.prepare(
    `INSERT INTO events (ticker, title, category, subcategory, underlying, shape, cadence, description, source_agency,
       source_index, terms_url, listed_at, expires_at, venue_status, volume_units, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (ticker) DO UPDATE SET
       title = excluded.title, category = excluded.category, subcategory = excluded.subcategory,
       underlying = excluded.underlying, shape = excluded.shape, cadence = excluded.cadence,
       description = excluded.description, source_agency = excluded.source_agency, source_index = excluded.source_index,
       terms_url = excluded.terms_url, listed_at = excluded.listed_at, expires_at = excluded.expires_at,
       venue_status = excluded.venue_status, volume_units = excluded.volume_units, updated_at = excluded.updated_at`,
  );
  const updateOnchain = db.prepare("UPDATE markets SET market_address = ?, yes_mint = ?, no_mint = ?, updated_at = ? WHERE symbol = ?");
  const updateSettle = db.prepare(
    `UPDATE markets SET settle_state = ?, settle_signature = COALESCE(?, settle_signature), detail = COALESCE(?, detail),
       updated_at = ? WHERE symbol = ?`,
  );
  const deleteMarkets = db.prepare("DELETE FROM markets WHERE expires_at < ? AND market_address IS NULL");
  const deleteEvents = db.prepare(
    "DELETE FROM events WHERE expires_at < ? AND NOT EXISTS (SELECT 1 FROM markets WHERE markets.event_ticker = events.ticker)",
  );
  const selectEvent = db.prepare("SELECT * FROM events WHERE ticker = ?");
  const selectEventMarkets = db.prepare(`${SELECT_MARKETS} WHERE m.event_ticker = ? ORDER BY m.sort_order, m.symbol`);
  const selectLiveEvents = db.prepare("SELECT * FROM events WHERE expires_at > ? ORDER BY expires_at, ticker");
  const selectLiveMarkets = db.prepare(
    `SELECT m.*, e.title AS title FROM markets m JOIN events e ON e.ticker = m.event_ticker
     WHERE e.expires_at > ? ORDER BY m.sort_order, m.symbol`,
  );
  const selectOnchain = db.prepare(`${SELECT_MARKETS} WHERE m.market_address IS NOT NULL ORDER BY m.expires_at DESC, m.symbol LIMIT ?`);
  const selectUnsettled = db.prepare(
    `${SELECT_MARKETS} WHERE m.market_address IS NOT NULL AND m.settle_state IN ('open', 'awaiting_result')
     ORDER BY m.expires_at, m.symbol`,
  );

  function get(symbol: string): RegistryMarket | undefined {
    const row = selectOne.get(symbol) as Row | undefined;
    return row === undefined ? undefined : toMarket(row);
  }

  function mustChange(result: { changes: number | bigint }, symbol: string): void {
    if (Number(result.changes) === 0) throw new Error(`unknown market ${symbol}`);
  }

  /** Writes what the venue says about a contract over what is stored for it, if anything. */
  function writeContract(eventTicker: string, info: ContractInfo, stored: Row | undefined, nowMs: number): void {
    const effectiveAt = info.effectiveAt.getTime();
    const expiresAt = info.expiresAt.getTime();
    if (!Number.isFinite(effectiveAt) || !Number.isFinite(expiresAt)) {
      throw new Error(`contract ${info.symbol}: unreadable effective or expiry date`);
    }
    const lastPx = info.lastPx ?? null;
    upsertMarket.run(
      info.symbol,
      eventTicker,
      info.label ?? textOrNull(stored?.label) ?? info.symbol.slice(info.symbol.lastIndexOf("-") + 1),
      info.sortOrder ?? Number(stored?.sort_order ?? 0),
      info.rules ?? textOrNull(stored?.rules) ?? "",
      effectiveAt,
      expiresAt,
      info.strike ?? textOrNull(stored?.strike),
      laterStatus(stored === undefined ? undefined : String(stored.venue_status), info.status),
      info.marketState,
      info.tickPx.toString(),
      info.unitIncrement.toString(),
      info.minUnits.toString(),
      lastPx === null ? textOrNull(stored?.last_px) : lastPx.toString(),
      info.resolutionSide ?? textOrNull(stored?.resolution),
      info.settlementValue ?? textOrNull(stored?.settlement_value),
      nowMs,
    );
  }

  function writeEvent(event: EventInfo, nowMs: number): void {
    const listedAt = event.listedAt.getTime();
    const expiresAt = event.expiresAt.getTime();
    if (!Number.isFinite(listedAt) || !Number.isFinite(expiresAt)) {
      throw new Error(`event ${event.ticker}: unreadable listing or expiry date`);
    }
    const stored = selectEventStatus.get(event.ticker) as Row | undefined;
    upsertEvent.run(
      event.ticker,
      event.title,
      event.category,
      JSON.stringify(event.subcategory),
      event.underlying,
      event.shape,
      event.cadence,
      event.description,
      event.source?.agency ?? null,
      event.source?.index ?? null,
      event.termsUrl,
      listedAt,
      expiresAt,
      laterStatus(stored === undefined ? undefined : String(stored.venue_status), event.status),
      event.volumeUnits.toString(),
      nowMs,
    );
  }

  return {
    storeEvents(events, nowMs) {
      const problems: Error[] = [];
      const attempt = (write: () => void): boolean => {
        try {
          write();
          return true;
        } catch (error) {
          problems.push(error instanceof Error ? error : new Error(String(error)));
          return false;
        }
      };
      transaction(() => {
        for (const event of events) {
          // No contract is stored without its event.
          if (!attempt(() => writeEvent(event, nowMs))) continue;
          for (const info of event.contracts) {
            attempt(() => writeContract(event.ticker, info, selectStored.get(info.symbol) as Row | undefined, nowMs));
          }
        }
      });
      return problems;
    },

    updateContract(info, nowMs) {
      const stored = selectStored.get(info.symbol) as Row | undefined;
      if (stored === undefined) throw new Error(`unknown market ${info.symbol}`);
      writeContract(String(stored.event_ticker), info, stored, nowMs);
      return get(info.symbol)!;
    },

    setOnchain(symbol, a) {
      mustChange(updateOnchain.run(a.marketAddress, a.yesMint, a.noMint, Date.now(), symbol), symbol);
    },

    setSettle(symbol, state, info) {
      mustChange(updateSettle.run(state, info?.signature ?? null, info?.detail ?? null, Date.now(), symbol), symbol);
    },

    prune(nowMs) {
      const before = nowMs - PRUNE_AFTER_MS;
      transaction(() => {
        deleteMarkets.run(before);
        deleteEvents.run(before);
      });
    },

    get,

    event(ticker) {
      const row = selectEvent.get(ticker) as Row | undefined;
      return row === undefined ? undefined : toEvent(row, (selectEventMarkets.all(ticker) as Row[]).map(toMarket));
    },

    liveEvents(nowMs) {
      const byEvent = new Map<string, RegistryMarket[]>();
      for (const market of (selectLiveMarkets.all(nowMs) as Row[]).map(toMarket)) {
        const siblings = byEvent.get(market.eventTicker);
        if (siblings === undefined) byEvent.set(market.eventTicker, [market]);
        else siblings.push(market);
      }
      return (selectLiveEvents.all(nowMs) as Row[]).map((row) => toEvent(row, byEvent.get(String(row.ticker)) ?? []));
    },

    onchain(limit) {
      if (!Number.isInteger(limit) || limit <= 0) return [];
      return (selectOnchain.all(limit) as Row[]).map(toMarket);
    },

    onchainUnsettled() {
      return (selectUnsettled.all() as Row[]).map(toMarket);
    },

    close() {
      db.close();
    },
  };
}
