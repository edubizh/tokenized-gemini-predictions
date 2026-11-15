"use client";

import { useCallback, useReducer } from "react";
import { knownMarkets } from "@/features/markets/known";
import { useReclaimOrder } from "@/features/ticket/actions";
import { orderEntries, SETTLING_MS } from "@/features/ticket/entries";
import { useChainMarkets, useLocalOrders, useOpenOrders, useOrders, useOrdersFinished } from "@/features/ticket/hooks";
import type { LocalOrder } from "@/features/ticket/timeline";
import type { SendProgress } from "@/features/ticket/Ticket";
import { useAccount } from "@/lib/privy/account";
import type { ReconnectView } from "@/lib/privy/reconnect";
import { useReconnect } from "@/lib/privy/use-reconnect";
import { chainNow, useHealth, useOnchainMarkets } from "@/lib/relayer/hooks";
import { buildActivityRows, type ActivityRow } from "./rows";

export interface Reclaiming {
  /** The order being reclaimed, or the one whose last attempt failed. */
  address: string | null;
  progress: SendProgress | null;
  error: string | null;
  /** Set while the trading wallet is not connected in this tab: reconnecting takes Reclaim's place. */
  reconnect: ReconnectView | null;
  onReclaim(row: ActivityRow): void;
}

export interface OrderRows {
  /** Newest first; null while loading. */
  rows: ActivityRow[] | null;
  /** True while the relayer is not answering: open orders are read from Solana alone. */
  relayerDown: boolean;
  reclaiming: Reclaiming;
  /** Draws the rows again, for a countdown that reached zero. */
  redraw(): void;
}

/**
 * The wallet's orders: the relayer's record, the open order accounts on Solana and what this
 * browser kept when it placed them, merged one row per order and matched to their markets. Either
 * source can be shown without the other, so open orders stay listed while the relayer is stopped.
 */
export function useOrderRows(): OrderRows {
  const { offline } = useHealth();
  const { refresh: refreshBalances } = useAccount();
  const openOrders = useOpenOrders();
  const local = useLocalOrders();
  const markets = useOnchainMarkets();
  const reclaimOrder = useReclaimOrder();
  const reconnect = useReconnect();
  const [, redraw] = useReducer((count: number) => count + 1, 0);

  const now = Date.now();
  const recentlyPlaced = Object.values(local.orders).some((order) => now - order.placedAt < SETTLING_MS);
  const orders = useOrders((openOrders.data?.orders.length ?? 0) > 0 || recentlyPlaced);

  const loading = (orders.data === undefined && orders.loading) || (openOrders.data === undefined && openOrders.loading);
  const relayerDown = offline || orders.error !== null || markets.error !== null;
  const entries = loading ? null : orderEntries({ api: orders.data, open: openOrders.data, local: local.orders, nowMs: now, relayerAway: relayerDown });

  // The relayer names the markets. Orders whose market it does not name, and every open order
  // while it is not answering, are matched to their market account on Solana.
  const relayerTried = markets.data !== undefined || !markets.loading;
  const listedAddresses = new Set((markets.data ?? []).flatMap((market) => (market.onchain ? [market.onchain.market] : [])));
  const listedSymbols = new Set((markets.data ?? []).map((market) => market.symbol));
  const chainMarkets = useChainMarkets(
    entries === null || !relayerTried
      ? null
      : {
          markets: entries.flatMap((entry) => (entry.marketAddress !== null && (relayerDown || !listedAddresses.has(entry.marketAddress)) ? [entry.marketAddress] : [])),
          symbols: entries.flatMap((entry) => (entry.marketAddress === null && entry.symbol !== null && !listedSymbols.has(entry.symbol) ? [entry.symbol] : [])),
        },
  );
  const rows =
    entries === null || !chainMarkets.settled
      ? null
      : buildActivityRows(entries, knownMarkets({ relayer: markets.data, chain: chainMarkets.markets, offline: relayerDown }), Math.floor(chainNow() / 1000), relayerDown);

  // Balances are read again as soon as an order finishes.
  useOrdersFinished(openOrders.data, orders.data, refreshBalances);

  const { reclaim } = reclaimOrder;
  const { markReclaimed } = local;
  const refreshOpen = openOrders.refresh;
  const refreshOrders = orders.refresh;
  const onReclaim = useCallback(
    async (row: ActivityRow) => {
      const chain = row.entry.chain;
      if (!chain) return;
      const outcomeMint = chain.side === 0 ? row.market?.onchain?.yesMint : row.market?.onchain?.noMint;
      const signature = await reclaim(chain, outcomeMint);
      if (!signature) return;
      const record: LocalOrder = row.entry.local ?? {
        address: row.address,
        signature: null,
        symbol: row.entry.symbol ?? row.market?.symbol ?? "",
        kind: chain.kind === 1 ? "sell" : "buy",
        side: chain.side === 0 ? "YES" : "NO",
        units: chain.qtyUnits.toString(),
        limitPx: chain.limitPx.toString(),
        maxFeeMicros: chain.maxFee.toString(),
        placedAt: row.entry.placedAt ?? Date.now(),
        expiresAt: chain.expiresAt,
      };
      markReclaimed(record, signature);
      refreshOpen();
      refreshOrders();
    },
    [markReclaimed, reclaim, refreshOpen, refreshOrders],
  );

  return {
    rows,
    relayerDown,
    reclaiming: { address: reclaimOrder.address, progress: reclaimOrder.progress, error: reclaimOrder.error, reconnect, onReclaim: (row) => void onReclaim(row) },
    redraw,
  };
}
