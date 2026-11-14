"use client";

import Link from "next/link";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ApiMarket, ApiOrder, SideName } from "@outcome/relayer/api-types";
import { useFaucet } from "@/components/shell/Shell";
import { Notice } from "@/components/ui/Notice";
import { Skeleton } from "@/components/ui/Skeleton";
import { usePlaceOrder, useReclaimOrder } from "@/features/ticket/actions";
import { useBalances, useLocalOrders, useOpenOrders, useOrders, usePositions, type OpenOrdersRead } from "@/features/ticket/hooks";
import type { LocalOrders } from "@/features/ticket/local-orders";
import { OrderTimelineView } from "@/features/ticket/OrderTimeline";
import { Ticket, type TicketDraft } from "@/features/ticket/Ticket";
import { deriveTimeline, type LocalOrder } from "@/features/ticket/timeline";
import type { OpenOrder } from "@/lib/chain/reads";
import { explorerTxUrl, useConfig } from "@/lib/config";
import { ensureMarket } from "@/lib/relayer/client";
import { chainNow, useHealth, useMarket } from "./hooks";
import { ClosedPanel, HowItWorks, isLive, MarketHeaderView, PositionView, PreparingPanel } from "./MarketViews";
import styles from "./Markets.module.css";

const LISTED_ORDERS = 3;
/** A just-placed order can be missing from one read of the chain or of the relayer. */
const SETTLING_MS = 20_000;

interface Entry {
  address: string;
  api: ApiOrder | null;
  /** Undefined while it is not yet known whether the order account exists. */
  chain: OpenOrder | null | undefined;
  local: LocalOrder | null;
  at: number;
}

/** Everything known about the user's orders in one market, newest first. */
function entriesFor(market: ApiMarket, api: readonly ApiOrder[] | undefined, open: OpenOrdersRead | undefined, local: LocalOrders, nowMs: number): Entry[] {
  const addresses = new Set<string>();
  for (const order of api ?? []) if (order.symbol === market.symbol) addresses.add(order.address);
  for (const order of open?.orders ?? []) if (order.market === market.onchain?.market) addresses.add(order.address);
  for (const order of Object.values(local)) if (order.symbol === market.symbol) addresses.add(order.address);

  return [...addresses]
    .map((address): Entry => {
      const apiOrder = api?.find((order) => order.address === address) ?? null;
      const mine = local[address] ?? null;
      let chain: OpenOrder | null | undefined = open === undefined ? undefined : (open.orders.find((order) => order.address === address) ?? null);
      if (chain === null && mine && !mine.reclaimSignature) {
        const readBeforePlacing = (open?.startedAt ?? 0) < mine.placedAt;
        const relayerNotYet = apiOrder === null && nowMs - mine.placedAt < SETTLING_MS;
        if (readBeforePlacing || relayerNotYet) chain = undefined;
      }
      return { address, api: apiOrder, chain, local: mine, at: mine?.placedAt ?? apiOrder?.createdAt ?? nowMs };
    })
    .sort((a, b) => b.at - a.at);
}

/** Asks the relayer, once per market, to create a live market that is not on-chain yet. */
function useEnsureMarket(market: ApiMarket | null | undefined, refresh: () => void): { preparing: boolean; failed: boolean; retry(): void } {
  const [failed, setFailed] = useState(false);
  const asked = useRef<string | null>(null);
  const symbol = market?.symbol ?? null;
  const needed = market != null && market.onchain === null && isLive(market, Date.now());

  const run = useCallback(
    async (target: string) => {
      setFailed(false);
      try {
        await ensureMarket(target);
        refresh();
      } catch {
        setFailed(true);
      }
    },
    [refresh],
  );

  useEffect(() => {
    if (!needed || symbol === null || asked.current === symbol) return;
    asked.current = symbol;
    void run(symbol);
  }, [needed, symbol, run]);

  return { preparing: needed, failed, retry: () => symbol !== null && void run(symbol) };
}

export function MarketPage({ symbol, initialSide }: { symbol: string; initialSide: SideName }) {
  const config = useConfig();
  const { health } = useHealth();
  const { balances } = useBalances();
  const marketPoll = useMarket(symbol);
  const openOrders = useOpenOrders();
  const local = useLocalOrders();
  const positions = usePositions();
  const placing = usePlaceOrder();
  const reclaiming = useReclaimOrder();
  const faucet = useFaucet();
  const [activeAddress, setActiveAddress] = useState<string | null>(null);
  // Drawn again when a countdown reaches zero, so what depends on the time is derived afresh.
  const [, redraw] = useReducer((count: number) => count + 1, 0);

  const now = Date.now();
  const recentlyPlaced = Object.values(local.orders).some((order) => now - order.placedAt < SETTLING_MS);
  const orders = useOrders((openOrders.data?.orders.length ?? 0) > 0 || recentlyPlaced);
  const market = marketPoll.data;
  const ensure = useEnsureMarket(market, marketPoll.refresh);
  const txUrl = useCallback((signature: string) => explorerTxUrl(config, signature), [config]);

  if (market === undefined) {
    return marketPoll.loading ? (
      <div aria-busy="true" style={{ display: "grid", gap: "var(--space-3)" }}>
        <span className="sr-only">Loading the market</span>
        <Skeleton width="9rem" height="1.95rem" />
        <Skeleton width="min(34rem, 100%)" height="1.5rem" />
        <Skeleton width="100%" height="6.5rem" />
      </div>
    ) : (
      <Notice tone="caution" title="This market cannot be shown right now">
        The relayer is not answering, and it is the source of market details. This page retries on its own.
      </Notice>
    );
  }
  if (market === null) {
    return (
      <Notice title="No such market" action={<Link href="/markets">See live markets</Link>}>
        The relayer does not list a market with this address. It may have closed some time ago.
      </Notice>
    );
  }

  const entries = entriesFor(market, orders.data, openOrders.data, local.orders, now);
  const chainNowSecs = Math.floor(chainNow() / 1000);
  const refreshOrders = () => {
    openOrders.refresh();
    orders.refresh();
    positions.refresh();
  };

  const place = async (draft: TicketDraft) => {
    const placed = await placing.place(market, draft, health?.orderTtlSecs ?? 45);
    if (!placed) return;
    local.save(placed);
    setActiveAddress(placed.address);
    refreshOrders();
  };

  const reclaim = async (entry: Entry) => {
    if (!entry.chain) return;
    const outcomeMint = entry.chain.side === 0 ? market.onchain?.yesMint : market.onchain?.noMint;
    const signature = await reclaiming.reclaim(entry.chain, outcomeMint);
    if (!signature) return;
    const record: LocalOrder = entry.local ?? {
      address: entry.address,
      signature: null,
      symbol: market.symbol,
      side: entry.chain.side === 0 ? "YES" : "NO",
      units: entry.chain.qtyUnits.toString(),
      limitPx: entry.chain.limitPx.toString(),
      maxFeeMicros: entry.chain.maxFee.toString(),
      placedAt: entry.api?.createdAt ?? Date.now(),
      expiresAt: entry.chain.expiresAt,
    };
    local.markReclaimed(record, signature);
    refreshOrders();
  };

  const timelineOf = (entry: Entry, variant: "slip" | "entry", onPlaceAnother?: () => void) => (
    <OrderTimelineView
      key={entry.address}
      variant={variant}
      timeline={deriveTimeline({ chainOrder: entry.chain, apiOrder: entry.api, local: entry.local, chainNowSecs })}
      txUrl={txUrl}
      chainNow={chainNow}
      onExpired={redraw}
      onPlaceAnother={onPlaceAnother}
      reclaim={{
        onReclaim: () => void reclaim(entry),
        progress: reclaiming.address === entry.address ? reclaiming.progress : null,
        error: reclaiming.address === entry.address ? reclaiming.error : null,
      }}
    />
  );

  const active = activeAddress === null ? undefined : entries.find((entry) => entry.address === activeAddress);
  const listed = entries.filter((entry) => entry.address !== active?.address);

  let aside;
  if (active) {
    aside = timelineOf(active, "slip", () => {
      setActiveAddress(null);
      placing.clearError();
    });
  } else if (now >= market.expiresAt || market.settleState !== "open") {
    aside = <ClosedPanel market={market} />;
  } else if (ensure.preparing) {
    aside = <PreparingPanel failed={ensure.failed} onRetry={ensure.retry} />;
  } else {
    aside = (
      <Ticket
        key={market.symbol}
        market={market}
        health={health}
        balances={balances}
        initialSide={initialSide}
        progress={placing.progress}
        error={placing.error}
        onSubmit={(draft) => void place(draft)}
        onGetTestFunds={faucet.request}
        fundsNote={faucet.status.kind === "done" || faucet.status.kind === "error" ? faucet.status.text : faucet.status.kind === "working" ? "Asking the faucet for test funds." : null}
      />
    );
  }

  return (
    <>
      <MarketHeaderView market={market} nowMs={now} onClosed={redraw} />
      <div className={styles.columns}>
        <div className={styles.aside}>{aside}</div>
        <div className={styles.main}>
          <section className={styles.section} aria-labelledby="orders-title">
            <h2 id="orders-title">Your orders in this market</h2>
            {listed.length === 0 ? (
              <p className={styles.muted}>{active ? "No earlier orders in this market." : "No orders in this market yet. Each one you place is tracked here step by step."}</p>
            ) : (
              <>
                <div className={styles.orders}>{listed.slice(0, LISTED_ORDERS).map((entry) => timelineOf(entry, "entry"))}</div>
                {listed.length > LISTED_ORDERS && (
                  <p className={styles.more}>
                    <Link href="/activity">{`${listed.length - LISTED_ORDERS} earlier ${listed.length - LISTED_ORDERS === 1 ? "order" : "orders"} in Activity`}</Link>
                  </p>
                )}
              </>
            )}
          </section>
          <PositionView market={market} positions={positions.data} />
          <HowItWorks />
        </div>
      </div>
    </>
  );
}
