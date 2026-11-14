// What this browser remembers about the orders it placed: the placing transaction and the order's
// terms, by order address. It lets the timeline start at once and link to the first transaction.
// Nothing here is trusted for money; the chain and the relayer are the sources of truth.

import type { LocalOrder } from "./timeline";

const PREFIX = "outcome.orders.v1:";
const KEEP = 60;

export type LocalOrders = Record<string, LocalOrder>;

export function loadLocalOrders(wallet: string): LocalOrders {
  try {
    const raw = localStorage.getItem(PREFIX + wallet);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return typeof parsed === "object" && parsed !== null ? (parsed as LocalOrders) : {};
  } catch {
    return {};
  }
}

/** Keeps the newest orders only, so the record cannot grow without bound. */
export function withOrder(orders: LocalOrders, order: LocalOrder): LocalOrders {
  const next = Object.values({ ...orders, [order.address]: order })
    .sort((a, b) => b.placedAt - a.placedAt)
    .slice(0, KEEP);
  return Object.fromEntries(next.map((entry) => [entry.address, entry]));
}

export function storeLocalOrders(wallet: string, orders: LocalOrders): void {
  try {
    localStorage.setItem(PREFIX + wallet, JSON.stringify(orders));
  } catch {
    // Storage can be unavailable; the timeline then starts from the chain and the relayer.
  }
}
