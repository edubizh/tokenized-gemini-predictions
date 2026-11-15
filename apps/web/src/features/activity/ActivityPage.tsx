"use client";

import { useCallback, useReducer } from "react";
import { PageHeader } from "@/components/shell/Shell";
import { AccountOnly } from "@/features/account/LoggedOut";
import { knownMarkets } from "@/features/markets/known";
import { ChainNotice, RelayerNotice } from "@/features/markets/RelayerNotice";
import { useReclaimOrder } from "@/features/ticket/actions";
import { orderEntries, SETTLING_MS } from "@/features/ticket/entries";
import { useChainMarkets, useLocalOrders, useOpenOrders, useOrders, useOrdersFinished } from "@/features/ticket/hooks";
import type { LocalOrder } from "@/features/ticket/timeline";
import { explorerAddressUrl, explorerTxUrl, useConfig } from "@/lib/config";
import { useAccount } from "@/lib/privy/account";
import { useReconnect } from "@/lib/privy/use-reconnect";
import { chainNow, useHealth, useOnchainMarkets } from "@/lib/relayer/hooks";
import { ActivityView } from "./ActivityView";
import { buildActivityRows, type ActivityRow } from "./rows";

/** Everyone can open the page; what it shows belongs to an account. */
export function ActivityPage() {
  return (
    <AccountOnly title="Activity" sentence="Every order you place is listed here once you are logged in, with each step it took and its transactions on Solana.">
      <Activity />
    </AccountOnly>
  );
}

function Activity() {
  const config = useConfig();
  const { offline } = useHealth();
  const { refresh: refreshBalances } = useAccount();
  const openOrders = useOpenOrders();
  const local = useLocalOrders();
  const markets = useOnchainMarkets();
  const reclaiming = useReclaimOrder();
  const reconnect = useReconnect();
  // Drawn again when an order's countdown reaches zero, so its stamp and Reclaim appear on time.
  const [, redraw] = useReducer((count: number) => count + 1, 0);

  const now = Date.now();
  const recentlyPlaced = Object.values(local.orders).some((order) => now - order.placedAt < SETTLING_MS);
  const orders = useOrders((openOrders.data?.orders.length ?? 0) > 0 || recentlyPlaced);

  // The relayer's record and the open order accounts are merged; either can be shown without the other.
  const loading = (orders.data === undefined && orders.loading) || (openOrders.data === undefined && openOrders.loading);
  // The relayer names the markets. Orders whose market it does not name, and every open order
  // while it is not answering, are matched to their market account on Solana.
  const relayerDown = offline || orders.error !== null || markets.error !== null;
  const entries = loading ? null : orderEntries({ api: orders.data, open: openOrders.data, local: local.orders, nowMs: now, relayerAway: relayerDown });

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

  // The top bar's balance is read again as soon as an order finishes.
  useOrdersFinished(openOrders.data, orders.data, refreshBalances);

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

  return (
    <>
      <RelayerNotice />
      <ChainNotice />
      <PageHeader title="Activity">Your orders, newest first. Open one to see each step it took, where its test dollars went, and the transactions on Solana.</PageHeader>
      <ActivityView
        rows={rows}
        offline={relayerDown}
        nowMs={now}
        chainNow={chainNow}
        onExpired={redraw}
        reclaim={{ address: reclaiming.address, progress: reclaiming.progress, error: reclaiming.error, reconnect, onReclaim: (row) => void onReclaim(row) }}
        txUrl={(signature) => explorerTxUrl(config, signature)}
        addressUrl={(address) => explorerAddressUrl(config, address)}
      />
    </>
  );
}
