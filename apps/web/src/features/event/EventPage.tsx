"use client";

import Link from "next/link";
import { useCallback, useEffect, useReducer, useState, type ReactNode } from "react";
import type { ApiEventDetail, ApiMarket, SideName } from "@outcome/relayer/api-types";
import { PageHeader, useFaucet } from "@/components/shell/Shell";
import { ButtonLink } from "@/components/ui/Button";
import { Countdown } from "@/components/ui/Countdown";
import { Notice } from "@/components/ui/Notice";
import { PriceButton } from "@/components/ui/PriceButton";
import { Row, RowList, type Column } from "@/components/ui/RowList";
import { Skeleton } from "@/components/ui/Skeleton";
import { GetTestFunds, needsTestFunds } from "@/features/account/GetTestFunds";
import { LoggedOut } from "@/features/account/LoggedOut";
import { cadenceLabel, chancePx, chanceText, prices, selectedContract, volumeUnits } from "@/features/markets/derive";
import { usePlaceOrder, useReclaimOrder } from "@/features/ticket/actions";
import { orderEntries, SETTLING_MS, type OrderEntry } from "@/features/ticket/entries";
import { useBalances, useLocalOrders, useOpenOrders, useOrders, useOrdersFinished, usePositions } from "@/features/ticket/hooks";
import { OrderTimelineView } from "@/features/ticket/OrderTimeline";
import { Ticket, type TicketDraft } from "@/features/ticket/Ticket";
import { deriveTimeline, type LocalOrder } from "@/features/ticket/timeline";
import type { Position } from "@/lib/chain/reads";
import { explorerTxUrl, useConfig } from "@/lib/config";
import { formatContracts, formatDollars } from "@/lib/format";
import { useAccount } from "@/lib/privy/account";
import { useReconnect } from "@/lib/privy/use-reconnect";
import { chainNow, useEvent, useHealth } from "@/lib/relayer/hooks";
import { marketHref, type TicketAction } from "@/lib/routes";
import styles from "./Event.module.css";

const LISTED_ORDERS = 3;

const CONTRACTS: Column[] = [
  { id: "contract", header: "Contract", primary: true },
  { id: "chance", header: "Chance", align: "right", width: "6rem" },
  { id: "buy", header: "Buy", actions: true, width: "11rem" },
];

const POSITION: Column[] = [
  { id: "side", header: "Outcome", primary: true },
  { id: "tokens", header: "Contracts", align: "right", width: "7rem" },
  { id: "pays", header: "Pays", align: "right", width: "11rem" },
];

/** The contracts of the event as plain rows: label, chance or result, and the price of each side. */
function Contracts({ event, selected }: { event: ApiEventDetail; selected: ApiMarket }) {
  return (
    <RowList label="Contracts of this event" columns={CONTRACTS}>
      {event.markets.map((market) => {
        const { yes, no } = prices(market);
        const chosen = market.symbol === selected.symbol;
        return (
          <Row
            key={market.symbol}
            cells={[
              <Link key="contract" href={marketHref(market)} className={chosen ? styles.selected : undefined} aria-current={chosen ? "true" : undefined} data-testid="contract">
                {market.label}
              </Link>,
              market.resolution ? `Resolved ${market.resolution === "yes" ? "Yes" : "No"}` : chanceText(chancePx(market)),
              <>
                <PriceButton side="YES" px={yes} href={marketHref(market, "YES")} subject={market.label} />
                <PriceButton side="NO" px={no} href={marketHref(market, "NO")} subject={market.label} />
              </>,
            ]}
          />
        );
      })}
    </RowList>
  );
}

/** The wallet's tokens of the selected contract's two mints. */
function PositionView({ market, positions }: { market: ApiMarket; positions: readonly Position[] | undefined }) {
  const onchain = market.onchain;
  const held = (["YES", "NO"] as const).flatMap((side) => {
    const mint = side === "YES" ? onchain?.yesMint : onchain?.noMint;
    const units = positions?.find((position) => position.mint === mint)?.units ?? 0n;
    return units > 0n ? [{ side, units }] : [];
  });
  if (held.length === 0) {
    return <p className={styles.note}>{positions === undefined ? "Reading your tokens from Solana." : "No tokens of this contract yet. A filled order mints them to your wallet."}</p>;
  }
  return (
    <RowList label="Your position in this contract" columns={POSITION}>
      {held.map(({ side, units }) => {
        const word = side === "YES" ? "Yes" : "No";
        const payout = side === "YES" ? onchain?.yesPayout : onchain?.noPayout;
        return <Row key={side} cells={[word, formatContracts(units), payout == null ? `${formatDollars(units * 10_000n)} if ${word}` : formatDollars(units * BigInt(payout))]} />;
      })}
    </RowList>
  );
}

export interface EventPageProps {
  /** The venue's event ticker, from the address. */
  ticker: string;
  /** The contract the link names; the page picks one when it names none. */
  contract: string | null;
  initialSide: SideName;
  initialAction?: TicketAction;
}

/**
 * One event: its contracts as plain rows and, for the selected one, the order ticket, the user's
 * orders and their tokens. Everyone can open it; only the ticket asks for a login.
 */
export function EventPage({ ticker, contract, initialSide, initialAction = "buy" }: EventPageProps) {
  const config = useConfig();
  const account = useAccount();
  const { health, offline } = useHealth();
  const { balances, refresh: refreshBalances } = useBalances();
  const eventPoll = useEvent(ticker);
  const openOrders = useOpenOrders();
  const local = useLocalOrders();
  const positions = usePositions();
  const placing = usePlaceOrder();
  const reclaiming = useReclaimOrder();
  const faucet = useFaucet();
  const reconnect = useReconnect();
  const [activeAddress, setActiveAddress] = useState<string | null>(null);
  // Drawn again when a countdown reaches zero, so what depends on the time is derived afresh.
  const [, redraw] = useReducer((count: number) => count + 1, 0);

  const now = Date.now();
  const recentlyPlaced = Object.values(local.orders).some((order) => now - order.placedAt < SETTLING_MS);
  const orders = useOrders((openOrders.data?.orders.length ?? 0) > 0 || recentlyPlaced);
  const relayerDown = offline || eventPoll.error !== null;
  const event = eventPoll.data;
  const txUrl = useCallback((signature: string) => explorerTxUrl(config, signature), [config]);
  // The tab is named after the event once it is known.
  const pageTitle = event?.title ?? null;
  useEffect(() => {
    if (pageTitle) document.title = `${pageTitle} · Outcome Tokens`;
  }, [pageTitle]);
  const { refresh: refreshPositions } = positions;
  // A fill or a refund has just changed the wallet: read it again now, not at the next turn.
  useOrdersFinished(
    openOrders.data,
    orders.data,
    useCallback(() => {
      refreshBalances();
      refreshPositions();
    }, [refreshBalances, refreshPositions]),
  );

  if (event === undefined) {
    return relayerDown ? (
      <Notice title="This market cannot be shown right now" action={<ButtonLink href="/portfolio" size="row">Open Portfolio</ButtonLink>}>
        The relayer is not answering. This page retries on its own; your tokens and open orders are in Portfolio and Activity.
      </Notice>
    ) : (
      <div aria-busy="true" style={{ display: "grid", gap: "var(--space-3)" }}>
        <span className="sr-only">Loading the market</span>
        <Skeleton width="min(24rem, 100%)" height="1.875rem" />
        <Skeleton width="min(16rem, 100%)" height="1.5rem" />
        <Skeleton width="100%" height="12rem" />
      </div>
    );
  }
  const market = event && selectedContract(event, contract);
  if (!event || !market) {
    return (
      <Notice title="No such market" action={<ButtonLink href="/" size="row">See all markets</ButtonLink>}>
        The relayer knows no event with this address. It may be mistyped.
      </Notice>
    );
  }

  const entries = orderEntries({ api: orders.data, open: openOrders.data, local: local.orders, nowMs: now, relayerAway: relayerDown }).filter(
    (entry) => entry.symbol === market.symbol || (entry.marketAddress !== null && entry.marketAddress === market.onchain?.market),
  );
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
    eventPoll.refresh();
    refreshOrders();
  };

  const reclaim = async (entry: OrderEntry) => {
    if (!entry.chain) return;
    const outcomeMint = entry.chain.side === 0 ? market.onchain?.yesMint : market.onchain?.noMint;
    const signature = await reclaiming.reclaim(entry.chain, outcomeMint);
    if (!signature) return;
    const record: LocalOrder = entry.local ?? {
      address: entry.address,
      signature: null,
      symbol: market.symbol,
      kind: entry.chain.kind === 1 ? "sell" : "buy",
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

  const timelineOf = (entry: OrderEntry, variant: "slip" | "entry", onPlaceAnother?: () => void) => (
    <OrderTimelineView
      key={entry.address}
      variant={variant}
      timeline={deriveTimeline({ chainOrder: entry.chain, apiOrder: entry.api, local: entry.local, chainNowSecs, relayerAway: relayerDown })}
      txUrl={txUrl}
      chainNow={chainNow}
      onExpired={redraw}
      onPlaceAnother={onPlaceAnother}
      reclaim={{
        onReclaim: () => void reclaim(entry),
        progress: reclaiming.address === entry.address ? reclaiming.progress : null,
        error: reclaiming.address === entry.address ? reclaiming.error : null,
        reconnect,
      }}
    />
  );

  // The wallet's tokens of this contract's two mints, which is what the ticket can sell.
  const onchain = market.onchain;
  const heldOf = (mint: string) => positions.data?.find((position) => position.mint === mint)?.units ?? 0n;
  const held = positions.data === undefined ? null : onchain ? { YES: heldOf(onchain.yesMint), NO: heldOf(onchain.noMint) } : { YES: 0n, NO: 0n };

  const active = activeAddress === null ? undefined : entries.find((entry) => entry.address === activeAddress);
  const listed = entries.filter((entry) => entry.address !== active?.address);
  const loggedIn = account.ready && account.authenticated;
  const started = now >= market.startsAt;
  const volume = volumeUnits(event);

  let panel: ReactNode;
  if (active) {
    panel = timelineOf(active, "slip", () => {
      setActiveAddress(null);
      placing.clearError();
    });
  } else if (now >= market.expiresAt || market.settleState !== "open") {
    panel = (
      <Notice title="This market has closed" action={<ButtonLink href="/" size="row">See all markets</ButtonLink>}>
        {`Orders are no longer taken. ${market.resolution ? `It resolved ${market.resolution === "yes" ? "Yes" : "No"}.` : "The result is not in yet."} Tokens you hold are redeemed from Portfolio once the market is settled.`}
      </Notice>
    );
  } else if (relayerDown) {
    panel = (
      <Notice title="Orders cannot be placed right now">
        The relayer is not answering, so a new order would not reach the venue. Orders you already placed are safe on Solana, and each can be reclaimed once it expires.
      </Notice>
    );
  } else if (!account.ready) {
    panel = <Skeleton width="100%" height="20rem" />;
  } else if (!account.authenticated) {
    panel = <LoggedOut title="Log in to trade">Everyone can look at every market. Placing an order takes a login and test funds.</LoggedOut>;
  } else if (needsTestFunds(config, account)) {
    // The first-run step above is what there is to do.
    panel = null;
  } else if (account.trader === "unknown") {
    // Whether the wallet is a trader is read from Solana; until it is known the ticket is not offered.
    panel = account.stale ? (
      <Notice title="Solana devnet is not answering">Your account could not be read yet. The page keeps trying; nothing is lost.</Notice>
    ) : (
      <Skeleton width="100%" height="20rem" />
    );
  } else {
    panel = (
      <Ticket
        key={market.symbol}
        market={market}
        health={health}
        balances={balances}
        held={held}
        initialSide={initialSide}
        initialAction={initialAction}
        reconnect={reconnect}
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
      <PageHeader title={event.title}>
        {`${event.underlying} · ${cadenceLabel(event.cadence)} · `}
        <Countdown to={started ? event.expiresAt : market.startsAt} label={started ? "closes in" : "opens in"} closedText={started ? "closed" : "open"} onClosed={redraw} />
        {volume !== null && ` · ${formatContracts(volume)} contracts traded`}
      </PageHeader>
      <div className={styles.columns}>
        <div className={styles.aside}>
          {loggedIn && <GetTestFunds />}
          {panel}
        </div>
        <div className={styles.main}>
          <Contracts event={event} selected={market} />
          {loggedIn && (
            <>
              <section className={styles.section} aria-labelledby="orders-title">
                <h2 id="orders-title">{`Your orders · ${market.label}`}</h2>
                {listed.length === 0 ? (
                  <p className={styles.note}>{active ? "No earlier orders for this contract." : "No orders for this contract yet. Each one you place is tracked here step by step."}</p>
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
              <section className={styles.section} aria-labelledby="position-title">
                <h2 id="position-title">{`Your position · ${market.label}`}</h2>
                <PositionView market={market} positions={positions.data} />
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}
