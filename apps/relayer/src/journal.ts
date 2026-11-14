// Durable write-ahead journal of every order the relayer has seen. Each method commits before it
// returns, so a restarted process can tell exactly how far an order got.

import { DatabaseSync } from "node:sqlite";
import { buyCost, sellProceeds } from "./venue/mapping.ts";
import type { Outcome, VenueFill, VenueOrderResult } from "./venue/types.ts";

export type OrderState =
  | "seen"
  | "submitting"
  | "venue_filled"
  | "venue_not_filled"
  | "venue_unknown"
  | "chain_filled"
  | "chain_cancelled"
  | "orphaned"
  | "failed";

export interface NewOrder {
  orderAddress: string;
  clientOrderId: string;
  kind: "buy" | "sell";
  side: Outcome;
  symbol: string;
  units: bigint;
  limitPx: bigint;
  maxFeeMicros: bigint;
  /** Unix seconds. */
  expiresAt: number;
}

export interface JournalOrder extends NewOrder {
  state: OrderState;
  venueOrderId: string | null;
  filledUnits: bigint;
  /** Cost of a buy, proceeds of a sell. */
  amountMicros: bigint;
  feeMicros: bigint;
  chainSignature: string | null;
  detail: string | null;
  /** Unix milliseconds. */
  createdAt: number;
  updatedAt: number;
}

export type ChainOutcome = "chain_filled" | "chain_cancelled" | "orphaned" | "failed";

export interface Journal {
  /** Idempotent on `orderAddress`; a different `clientOrderId` for a known address throws. */
  recordSeen(order: NewOrder): { created: boolean; row: JournalOrder };
  /** Only from "seen". */
  markSubmitting(orderAddress: string): void;
  /** From "submitting" or "venue_unknown". */
  recordVenueResult(orderAddress: string, result: VenueOrderResult): void;
  markChain(orderAddress: string, outcome: ChainOutcome, info?: { signature?: string; detail?: string }): void;
  get(orderAddress: string): JournalOrder | undefined;
  byState(...states: OrderState[]): JournalOrder[];
  /** Rows that still need work, oldest first. */
  unresolved(): JournalOrder[];
  fills(orderAddress: string): VenueFill[];
  /** Net signed units (YES positive) the venue account holds because of orphaned orders. */
  houseInventoryUnits(symbol: string): bigint;
  close(): void;
}

const TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  seen: ["submitting", "chain_cancelled", "failed"],
  submitting: ["venue_filled", "venue_not_filled", "venue_unknown"],
  venue_unknown: ["venue_filled", "venue_not_filled", "venue_unknown", "orphaned", "failed"],
  venue_filled: ["chain_filled", "orphaned", "failed"],
  venue_not_filled: ["chain_cancelled", "failed"],
  chain_filled: [],
  chain_cancelled: [],
  orphaned: [],
  failed: [],
};

const UNRESOLVED: readonly OrderState[] = ["seen", "submitting", "venue_filled", "venue_not_filled", "venue_unknown"];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS orders (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    order_address TEXT NOT NULL UNIQUE,
    client_order_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('buy', 'sell')),
    side TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
    symbol TEXT NOT NULL,
    units TEXT NOT NULL,
    limit_px TEXT NOT NULL,
    max_fee_micros TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    venue_order_id TEXT,
    filled_units TEXT NOT NULL DEFAULT '0',
    amount_micros TEXT NOT NULL DEFAULT '0',
    fee_micros TEXT NOT NULL DEFAULT '0',
    chain_signature TEXT,
    detail TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fills (
    trade_id TEXT PRIMARY KEY,
    order_address TEXT NOT NULL REFERENCES orders (order_address),
    position INTEGER NOT NULL,
    units TEXT NOT NULL,
    px TEXT NOT NULL,
    fee_micros TEXT NOT NULL,
    fee_source TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS fills_by_order ON fills (order_address, position);
`;

type Row = Record<string, unknown>;

function toOrder(row: Row): JournalOrder {
  return {
    orderAddress: String(row.order_address),
    clientOrderId: String(row.client_order_id),
    kind: row.kind as "buy" | "sell",
    side: row.side as Outcome,
    symbol: String(row.symbol),
    units: BigInt(String(row.units)),
    limitPx: BigInt(String(row.limit_px)),
    maxFeeMicros: BigInt(String(row.max_fee_micros)),
    expiresAt: Number(row.expires_at),
    state: row.state as OrderState,
    venueOrderId: row.venue_order_id === null ? null : String(row.venue_order_id),
    filledUnits: BigInt(String(row.filled_units)),
    amountMicros: BigInt(String(row.amount_micros)),
    feeMicros: BigInt(String(row.fee_micros)),
    chainSignature: row.chain_signature === null ? null : String(row.chain_signature),
    detail: row.detail === null ? null : String(row.detail),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toFill(row: Row): VenueFill {
  return {
    tradeId: String(row.trade_id),
    units: BigInt(String(row.units)),
    px: BigInt(String(row.px)),
    feeMicros: BigInt(String(row.fee_micros)),
    feeSource: row.fee_source as VenueFill["feeSource"],
  };
}

/** Opens (and creates when missing) the journal at `path`; `":memory:"` gives a throwaway one. */
export function openJournal(path: string): Journal {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=FULL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(SCHEMA);

  const selectOrder = db.prepare("SELECT * FROM orders WHERE order_address = ?");
  const insertOrder = db.prepare(
    `INSERT INTO orders (order_address, client_order_id, kind, side, symbol, units, limit_px, max_fee_micros,
       expires_at, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'seen', ?, ?)`,
  );
  const updateState = db.prepare("UPDATE orders SET state = ?, updated_at = ? WHERE order_address = ?");
  const updateVenue = db.prepare(
    `UPDATE orders SET state = ?, venue_order_id = COALESCE(?, venue_order_id), filled_units = ?, amount_micros = ?,
       fee_micros = ?, detail = ?, updated_at = ? WHERE order_address = ?`,
  );
  const updateChain = db.prepare(
    `UPDATE orders SET state = ?, chain_signature = COALESCE(?, chain_signature), detail = COALESCE(?, detail),
       updated_at = ? WHERE order_address = ?`,
  );
  const selectFillOwner = db.prepare("SELECT order_address FROM fills WHERE trade_id = ?");
  const insertFill = db.prepare(
    "INSERT INTO fills (trade_id, order_address, position, units, px, fee_micros, fee_source) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const selectFills = db.prepare("SELECT * FROM fills WHERE order_address = ? ORDER BY position");
  const selectOrphaned = db.prepare("SELECT * FROM orders WHERE state = 'orphaned' AND symbol = ?");

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

  function get(orderAddress: string): JournalOrder | undefined {
    const row = selectOrder.get(orderAddress) as Row | undefined;
    return row === undefined ? undefined : toOrder(row);
  }

  /** The row for `orderAddress`, after checking that it may move to `to`. */
  function checked(orderAddress: string, to: OrderState): JournalOrder {
    const row = get(orderAddress);
    if (row === undefined) throw new Error(`unknown order ${orderAddress}`);
    if (!TRANSITIONS[row.state].includes(to)) {
      throw new Error(`illegal transition ${row.state} -> ${to} for order ${orderAddress}`);
    }
    return row;
  }

  function byState(...states: OrderState[]): JournalOrder[] {
    if (states.length === 0) return [];
    const marks = states.map(() => "?").join(", ");
    const rows = db.prepare(`SELECT * FROM orders WHERE state IN (${marks}) ORDER BY seq`).all(...states) as Row[];
    return rows.map(toOrder);
  }

  return {
    recordSeen(order) {
      return transaction(() => {
        const existing = get(order.orderAddress);
        if (existing !== undefined) {
          if (existing.clientOrderId !== order.clientOrderId) {
            throw new Error(
              `order ${order.orderAddress} is journaled with client order id ${existing.clientOrderId}, not ${order.clientOrderId}`,
            );
          }
          return { created: false, row: existing };
        }
        const now = Date.now();
        insertOrder.run(
          order.orderAddress,
          order.clientOrderId,
          order.kind,
          order.side,
          order.symbol,
          order.units.toString(),
          order.limitPx.toString(),
          order.maxFeeMicros.toString(),
          order.expiresAt,
          now,
          now,
        );
        return { created: true, row: get(order.orderAddress)! };
      });
    },

    markSubmitting(orderAddress) {
      transaction(() => {
        checked(orderAddress, "submitting");
        updateState.run("submitting", Date.now(), orderAddress);
      });
    },

    recordVenueResult(orderAddress, result) {
      transaction(() => {
        const now = Date.now();
        switch (result.kind) {
          case "filled": {
            const row = checked(orderAddress, "venue_filled");
            const total = result.fills.reduce((sum, fill) => sum + fill.units, 0n);
            if (total !== result.filledUnits) {
              throw new Error(`order ${orderAddress}: fills sum to ${total} units but the result reports ${result.filledUnits}`);
            }
            result.fills.forEach((fill, position) => {
              const owner = selectFillOwner.get(fill.tradeId) as Row | undefined;
              if (owner !== undefined) {
                throw new Error(`trade id ${fill.tradeId} is already stored for order ${String(owner.order_address)}`);
              }
              insertFill.run(
                fill.tradeId,
                orderAddress,
                position,
                fill.units.toString(),
                fill.px.toString(),
                fill.feeMicros.toString(),
                fill.feeSource,
              );
            });
            const amount = row.kind === "buy" ? buyCost(result.fills) : sellProceeds(result.fills);
            updateVenue.run(
              "venue_filled",
              result.venueOrderId,
              result.filledUnits.toString(),
              amount.toString(),
              result.feeMicros.toString(),
              null,
              now,
              orderAddress,
            );
            return;
          }
          case "not_filled":
            checked(orderAddress, "venue_not_filled");
            updateVenue.run("venue_not_filled", result.venueOrderId, "0", "0", "0", result.reason, now, orderAddress);
            return;
          case "rejected": {
            checked(orderAddress, "venue_not_filled");
            const detail = result.code === null ? `rejected: ${result.message}` : `rejected ${result.code}: ${result.message}`;
            updateVenue.run("venue_not_filled", null, "0", "0", "0", detail, now, orderAddress);
            return;
          }
          case "unknown":
            checked(orderAddress, "venue_unknown");
            updateVenue.run("venue_unknown", result.venueOrderId, "0", "0", "0", result.reason, now, orderAddress);
            return;
        }
      });
    },

    markChain(orderAddress, outcome, info) {
      transaction(() => {
        checked(orderAddress, outcome);
        updateChain.run(outcome, info?.signature ?? null, info?.detail ?? null, Date.now(), orderAddress);
      });
    },

    get,
    byState,

    unresolved() {
      return byState(...UNRESOLVED);
    },

    fills(orderAddress) {
      return (selectFills.all(orderAddress) as Row[]).map(toFill);
    },

    houseInventoryUnits(symbol) {
      // The venue only ever buys: a buy holds the order's own side, a sell holds the opposite one.
      return (selectOrphaned.all(symbol) as Row[]).map(toOrder).reduce((sum, row) => {
        const venueBoughtYes = (row.kind === "buy") === (row.side === "YES");
        return venueBoughtYes ? sum + row.filledUnits : sum - row.filledUnits;
      }, 0n);
    },

    close() {
      db.close();
    },
  };
}
