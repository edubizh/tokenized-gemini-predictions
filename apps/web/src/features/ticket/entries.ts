// Everything known about the wallet's orders, one entry per order address: the relayer's record,
// the order account on Solana (which exists only while the order is open), and what this browser
// kept when it placed the order. Pure.

import type { ApiOrder } from "@outcome/relayer/api-types";
import type { OpenOrder } from "@/lib/chain/reads";
import type { LocalOrder } from "./timeline";

/** A just-placed order can be missing from one read of the chain or of the relayer. */
export const SETTLING_MS = 20_000;

export interface OrderEntry {
  address: string;
  api: ApiOrder | null;
  /** Undefined while it is not yet known whether the order account exists. */
  chain: OpenOrder | null | undefined;
  local: LocalOrder | null;
  /** Sort key: when the order was placed, or now when only its account is known. */
  at: number;
  /** When the order was placed, unix milliseconds, where that is known. */
  placedAt: number | null;
  /** The venue symbol of its market, where the relayer or this browser knows it. */
  symbol: string | null;
  /** The on-chain market account, where the order account has been read. */
  marketAddress: string | null;
}

export interface OrderSources {
  api: readonly ApiOrder[] | undefined;
  /** The open orders with the time the read began; an order placed after that may be missing. */
  open: { orders: readonly OpenOrder[]; startedAt: number } | undefined;
  local: Readonly<Record<string, LocalOrder>>;
  nowMs: number;
}

/** Newest first. */
export function orderEntries({ api, open, local, nowMs }: OrderSources): OrderEntry[] {
  const addresses = new Set<string>();
  for (const order of api ?? []) addresses.add(order.address);
  for (const order of open?.orders ?? []) addresses.add(order.address);
  for (const order of Object.values(local)) addresses.add(order.address);

  return [...addresses]
    .map((address): OrderEntry => {
      const apiOrder = api?.find((order) => order.address === address) ?? null;
      const mine = local[address] ?? null;
      let chain: OpenOrder | null | undefined = open === undefined ? undefined : (open.orders.find((order) => order.address === address) ?? null);
      if (chain === null && mine && !mine.reclaimSignature) {
        const readBeforePlacing = (open?.startedAt ?? 0) < mine.placedAt;
        const relayerNotYet = apiOrder === null && nowMs - mine.placedAt < SETTLING_MS;
        if (readBeforePlacing || relayerNotYet) chain = undefined;
      }
      const placedAt = mine?.placedAt ?? apiOrder?.createdAt ?? null;
      return { address, api: apiOrder, chain, local: mine, at: placedAt ?? nowMs, placedAt, symbol: apiOrder?.symbol ?? mine?.symbol ?? null, marketAddress: chain?.market ?? null };
    })
    .sort((a, b) => b.at - a.at);
}
