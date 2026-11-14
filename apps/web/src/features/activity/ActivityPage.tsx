"use client";

import { useCallback, useReducer } from "react";
import { PageHeader } from "@/components/shell/Shell";
import { chainNow, useMarkets } from "@/features/markets/hooks";
import { useReclaimOrder } from "@/features/ticket/actions";
import { orderEntries, SETTLING_MS } from "@/features/ticket/entries";
import { useLocalOrders, useOpenOrders, useOrders } from "@/features/ticket/hooks";
import type { LocalOrder } from "@/features/ticket/timeline";
import { explorerAddressUrl, explorerTxUrl, useConfig } from "@/lib/config";
import { ActivityView } from "./ActivityView";
import { buildActivityRows, type ActivityRow } from "./rows";

export function ActivityPage() {
  const config = useConfig();
  const openOrders = useOpenOrders();
  const local = useLocalOrders();
  const markets = useMarkets("all");
  const reclaiming = useReclaimOrder();
  // Drawn again when an order's countdown reaches zero, so its stamp and Reclaim appear on time.
  const [, redraw] = useReducer((count: number) => count + 1, 0);

  const now = Date.now();
  const recentlyPlaced = Object.values(local.orders).some((order) => now - order.placedAt < SETTLING_MS);
  const orders = useOrders((openOrders.data?.orders.length ?? 0) > 0 || recentlyPlaced);

  // The relayer's record and the open order accounts are merged; either can be shown without the other.
  const loading = (orders.data === undefined && orders.loading) || (openOrders.data === undefined && openOrders.loading);
  const rows = loading
    ? null
    : buildActivityRows(orderEntries({ api: orders.data, open: openOrders.data, local: local.orders, nowMs: now }), markets.data ?? [], Math.floor(chainNow() / 1000));

  const { reclaim } = reclaiming;
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

  return (
    <>
      <PageHeader title="Activity">Your orders, newest first. Open one to see each step it took, where its test dollars went, and the transactions on Solana.</PageHeader>
      <ActivityView
        rows={rows}
        nowMs={now}
        chainNow={chainNow}
        onExpired={redraw}
        reclaim={{ address: reclaiming.address, progress: reclaiming.progress, error: reclaiming.error, onReclaim: (row) => void onReclaim(row) }}
        txUrl={(signature) => explorerTxUrl(config, signature)}
        addressUrl={(address) => explorerAddressUrl(config, address)}
      />
    </>
  );
}
