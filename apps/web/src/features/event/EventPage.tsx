"use client";

import Link from "next/link";
import { useCallback, useEffect, useReducer, useState, type ReactNode } from "react";
import type { ApiEventDetail, ApiMarket, SideName } from "@outcome/relayer/api-types";
import { useFaucet } from "@/components/shell/Shell";
import { Badge } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Countdown } from "@/components/ui/Countdown";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { Fact, Facts } from "@/components/ui/Facts";
import { Notice } from "@/components/ui/Notice";
import { Panel } from "@/components/ui/Panel";
import { PriceButton } from "@/components/ui/PriceButton";
import { Row, RowList, type Column } from "@/components/ui/RowList";
import { Skeleton } from "@/components/ui/Skeleton";
import { GetTestFunds, needsTestFunds } from "@/features/account/GetTestFunds";
import { LoggedOut } from "@/features/account/LoggedOut";
import { cadenceLabel, chancePx, chanceText, eventPhase, isQuoted, prices, selectedContract, volumeText, type EventPhase } from "@/features/markets/derive";
import { usePlaceOrder, useReclaimOrder } from "@/features/ticket/actions";
import { orderEntries, SETTLING_MS, type OrderEntry } from "@/features/ticket/entries";
import { useBalances, useLocalOrders, useOpenOrders, useOrders, useOrdersFinished, usePositions } from "@/features/ticket/hooks";
import { OrderTimelineView } from "@/features/ticket/OrderTimeline";
import { Ticket, type TicketDraft } from "@/features/ticket/Ticket";
import { deriveTimeline, type LocalOrder } from "@/features/ticket/timeline";
import { explorerAddressUrl, explorerTxUrl, useConfig } from "@/lib/config";
import { shortAddress } from "@/lib/format";
import { useAccount } from "@/lib/privy/account";
import { useReconnect } from "@/lib/privy/use-reconnect";
import { chainNow, useEvent, useHealth } from "@/lib/relayer/hooks";
import { marketHref, type TicketAction } from "@/lib/routes";
import { ContractDetails } from "./ContractDetails";
import { EventPositions } from "./EventPositions";
import { formatWhen } from "./when";
import styles from "./Event.module.css";

const LISTED_ORDERS = 3;

const CONTRACTS: Column[] = [
  { id: "contract", header: "Contract", primary: true },
  { id: "chance", header: "Chance", align: "right", width: "7rem" },
  { id: "buy", header: "Buy", actions: true, width: "12.5rem" },
];

const resultWord = (market: ApiMarket) => (market.resolution === "yes" ? "Resolved Yes" : market.resolution === "no" ? "Resolved No" : null);

function StatusBadge({ phase, event }: { phase: EventPhase; event: ApiEventDetail }) {
  switch (phase.phase) {
    case "live":
      return (
        <Badge tone="positive" dot>
          Live
        </Badge>
      );
    case "upcoming":
      return <Badge>{phase.opensAt === null ? "Not open yet" : `Opens ${formatWhen(phase.opensAt)}`}</Badge>;
    case "closed":
      return <Badge>{event.markets.some((market) => market.settleState === "awaiting_result" || market.settleState === "needs_review") ? "Awaiting result" : "Closed"}</Badge>;
    case "settled":
      return <Badge>Settled</Badge>;
  }
}

/** Path, title, status, and for the selected contract its chance, the time left and the volume. */
function Head({ event, market, phase, onDeadline }: { event: ApiEventDetail; market: ApiMarket; phase: EventPhase; onDeadline(): void }) {
  const result = resultWord(market);
  const chance = chancePx(market);
  const volume = volumeText(event);
  return (
    <header className={styles.head}>
      <nav aria-label="Path" className={styles.path}>
        <Link href="/">Markets</Link>
        {[event.category, ...event.subcategory].flatMap((name) => [
          <span key={`${name}-slash`} aria-hidden="true">
            /
          </span>,
          <span key={name}>{name}</span>,
        ])}
      </nav>
      <h1 className={styles.title}>{event.title}</h1>
      <div className={styles.headline}>
        <p className={styles.figureLine}>
          {result || chance !== null ? (
            <>
              <span className={styles.figure}>{result ?? chanceText(chance)}</span>
              {!result && <span className={styles.soft}>{event.shape === "ladder" ? `chance of ${market.label}` : "chance of Yes"}</span>}
            </>
          ) : (
            <span className={styles.soft}>{event.shape === "ladder" ? `No offers on ${market.label} yet` : "No offers yet"}</span>
          )}
        </p>
        <StatusBadge phase={phase} event={event} />
        {phase.phase === "live" && <Countdown to={event.expiresAt} label="closes in" announce onClosed={onDeadline} />}
        <span className={styles.soft}>{`${cadenceLabel(event.cadence)}${volume ? ` · ${volume}` : ""}`}</span>
      </div>
    </header>
  );
}

/** The contracts of the event as rows: label, chance or result, and Yes and No at their prices. */
function Contracts({ event, selected, open }: { event: ApiEventDetail; selected: ApiMarket; open: boolean }) {
  return (
    <RowList label="Contracts of this event" columns={CONTRACTS}>
      {event.markets.map((market) => {
        const { yes, no } = prices(market);
        const chosen = market.symbol === selected.symbol;
        const quoted = isQuoted(market);
        const result = resultWord(market);
        return (
          <Row
            key={market.symbol}
            cells={[
              <Link
                key="contract"
                href={marketHref(market)}
                scroll={false}
                className={[styles.contract, chosen ? styles.selected : "", quoted || result ? "" : styles.dim].join(" ")}
                aria-current={chosen ? "true" : undefined}
                data-testid="contract-row"
                data-symbol={market.symbol}
              >
                {market.label}
              </Link>,
              <span key="chance" className={result || quoted ? styles.chanceCell : styles.soft}>
                {result ?? (!open ? "Awaiting result" : quoted ? chanceText(chancePx(market)) : "No offers")}
              </span>,
              open ? (
                <span key="buy" className={styles.rowActions}>
                  <PriceButton side="YES" px={yes} href={marketHref(market, "YES")} subject={market.label} />
                  <PriceButton side="NO" px={no} href={marketHref(market, "NO")} subject={market.label} />
                </span>
              ) : null,
            ]}
          />
        );
      })}
    </RowList>
  );
}

/** The event's dates, and the selected contract's accounts on Solana once it has them. */
function About({ event, market, open }: { event: ApiEventDetail; market: ApiMarket; open: boolean }) {
  const config = useConfig();
  const opens = Math.min(...event.markets.map((contract) => contract.startsAt));
  const onchain = market.onchain;
  const address = (value: string) => <ExternalLink href={explorerAddressUrl(config, value)}>{shortAddress(value)}</ExternalLink>;
  return (
    <>
      <section className={styles.section} aria-labelledby="dates-title">
        <h2 id="dates-title" className={styles.sectionTitle}>
          Dates
        </h2>
        <Panel>
          <Facts>
            <Fact label="Listed">{formatWhen(event.listedAt)}</Fact>
            <Fact label="Opens">{formatWhen(opens)}</Fact>
            <Fact label="Last order">{formatWhen(market.lastOrderAt)}</Fact>
            <Fact label="Closes">{formatWhen(event.expiresAt)}</Fact>
          </Facts>
          <p className={styles.after}>After the close the venue settles the result. Each winning token then redeems on Solana for $1.00 in test dollars.</p>
        </Panel>
      </section>
      <section className={styles.section} aria-labelledby="chain-title">
        <h2 id="chain-title" className={styles.sectionTitle}>
          On Solana
        </h2>
        {onchain ? (
          <Panel data-testid="onchain">
            <Facts>
              <Fact label="Market account">{address(onchain.market)}</Fact>
              <Fact label="Yes token mint">{address(onchain.yesMint)}</Fact>
              <Fact label="No token mint">{address(onchain.noMint)}</Fact>
            </Facts>
          </Panel>
        ) : (
          <p className={styles.note}>
            {open
              ? "This contract is not on Solana yet. Its market account and two token mints are created with its first order."
              : "Nobody traded this contract through this app, so it has no accounts on Solana."}
          </p>
        )}
      </section>
    </>
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
 * One event: its contracts, and for the selected one its prices, history, book, trades, rule and
 * the trade panel beside them. Everyone can open it; only trading asks for a login.
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
      <Notice title="The relayer is not answering" action={<ButtonLink href="/portfolio" size="row">Open Portfolio</ButtonLink>}>
        This market cannot be shown without it, and the page retries on its own. Your tokens are still in Portfolio.
      </Notice>
    ) : (
      <div className={styles.loading} aria-busy="true">
        <span className="sr-only">Loading the market</span>
        <Skeleton width="min(16rem, 100%)" height="1.25rem" />
        <Skeleton width="min(28rem, 100%)" height="1.875rem" />
        <Skeleton width="min(20rem, 100%)" height="2.25rem" />
        <Skeleton width="100%" height="16rem" />
      </div>
    );
  }
  const market = event && selectedContract(event, contract);
  if (!event || !market) {
    return (
      <Notice title="No such market" action={<ButtonLink href="/" size="row">See all markets</ButtonLink>}>
        The relayer knows no event at this address. It may be mistyped, or the event may be too old to keep.
      </Notice>
    );
  }

  const phase = eventPhase(event, now);
  const symbols = new Set(event.markets.map((contract) => contract.symbol));
  const addresses = new Set(event.markets.flatMap((contract) => (contract.onchain ? [contract.onchain.market] : [])));
  const entries = orderEntries({ api: orders.data, open: openOrders.data, local: local.orders, nowMs: now, relayerAway: relayerDown }).filter(
    (entry) => symbols.has(entry.symbol ?? "") || (entry.marketAddress !== null && addresses.has(entry.marketAddress)),
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
    const owner = event.markets.find((contract) => contract.onchain?.market === entry.marketAddress) ?? market;
    const outcomeMint = entry.chain.side === 0 ? owner.onchain?.yesMint : owner.onchain?.noMint;
    const signature = await reclaiming.reclaim(entry.chain, outcomeMint);
    if (!signature) return;
    const record: LocalOrder = entry.local ?? {
      address: entry.address,
      signature: null,
      symbol: owner.symbol,
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
      marketTitle={variant === "entry" ? event.markets.find((contract) => contract.symbol === entry.symbol)?.label : undefined}
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
  const open = phase.phase === "live" || phase.phase === "upcoming";

  let panel: ReactNode;
  if (active) {
    panel = timelineOf(active, "slip", () => {
      setActiveAddress(null);
      placing.clearError();
    });
  } else if (now >= market.expiresAt || market.settleState !== "open") {
    const result = resultWord(market);
    panel = (
      <Notice title="This market has closed" action={<ButtonLink href="/" size="row">See all markets</ButtonLink>}>
        {`Orders are no longer taken. ${result ? `It ${result.replace("Resolved", "resolved")}.` : "The result is not in yet."} Winning tokens are redeemed under Your position, or in Portfolio, once the market is settled.`}
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
    <div className={styles.page}>
      <Head event={event} market={market} phase={phase} onDeadline={redraw} />
      <aside className={styles.aside} aria-label="Trade">
        {loggedIn && <GetTestFunds />}
        {panel}
      </aside>
      <div className={styles.main}>
        <section className={styles.section} aria-labelledby="contracts-title">
          <h2 id="contracts-title" className="sr-only">
            Contracts
          </h2>
          <Contracts event={event} selected={market} open={open} />
        </section>
        {loggedIn && (
          <>
            <section className={styles.section} aria-labelledby="position-title">
              <h2 id="position-title" className={styles.sectionTitle}>
                Your position
              </h2>
              <EventPositions markets={event.markets} positions={positions.data} canSell={!relayerDown} reconnect={reconnect} onChanged={refreshOrders} />
            </section>
            <section className={styles.section} aria-labelledby="orders-title">
              <h2 id="orders-title" className={styles.sectionTitle}>
                Your orders
              </h2>
              {listed.length === 0 ? (
                <p className={styles.note}>{active ? "No earlier orders in this event." : "No orders in this event yet. Each one you place is tracked here step by step."}</p>
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
          </>
        )}
        <ContractDetails key={market.symbol} event={event} market={market} />
        <About event={event} market={market} open={open} />
      </div>
    </div>
  );
}
