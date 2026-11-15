"use client";

import Link from "next/link";
import type { ApiEvent, ApiMarket } from "@outcome/relayer/api-types";
import { PageHeader } from "@/components/shell/Shell";
import { Countdown } from "@/components/ui/Countdown";
import { Notice } from "@/components/ui/Notice";
import { PriceButton } from "@/components/ui/PriceButton";
import { Row, RowList, type Column } from "@/components/ui/RowList";
import { Skeleton } from "@/components/ui/Skeleton";
import { useEvents, useHealth } from "@/lib/relayer/hooks";
import { eventHref, marketHref } from "@/lib/routes";
import { cadenceLabel, prices, sortEvents } from "./derive";

const COLUMNS: Column[] = [
  { id: "event", header: "Market", primary: true },
  { id: "underlying", header: "On", width: "4rem" },
  { id: "cadence", header: "Runs", width: "5rem" },
  { id: "left", header: "Time left", align: "right", width: "8rem" },
  { id: "buy", header: "Buy", actions: true, width: "11rem" },
];

function EventRow({ event }: { event: ApiEvent }) {
  const [first] = event.markets;
  const started = first === undefined || Date.now() >= first.startsAt;
  const only: ApiMarket | undefined = event.shape === "binary" ? first : undefined;
  return (
    <Row
      cells={[
        <Link key="event" href={eventHref(event.ticker)} data-testid="event">
          {event.title}
        </Link>,
        event.underlying,
        cadenceLabel(event.cadence),
        <Countdown key="left" to={started ? event.expiresAt : (first?.startsAt ?? event.expiresAt)} label={started ? "" : "opens in"} closedText={started ? "closed" : "open"} />,
        only ? (
          <>
            <PriceButton side="YES" px={prices(only).yes} href={marketHref(only, "YES")} subject={event.title} />
            <PriceButton side="NO" px={prices(only).no} href={marketHref(only, "NO")} subject={event.title} />
          </>
        ) : (
          `${event.markets.length} contracts`
        ),
      ]}
    />
  );
}

/** Every event the venue lists, in the default order, each leading to its page. A plain list for now. */
export function MarketsIndex() {
  const events = useEvents();
  const { offline } = useHealth();

  let lead = "Every market the venue lists, on Solana devnet, traded with test funds.";
  let body;
  if (offline || events.error !== null) {
    // Prices from before the relayer went quiet are not shown as if they were current.
    body = (
      <Notice title="The relayer is not answering">
        Markets cannot be listed without it; this page retries on its own. Your tokens are still in <Link href="/portfolio">Portfolio</Link> and your orders in <Link href="/activity">Activity</Link>.
      </Notice>
    );
  } else if (events.data === undefined) {
    body = (
      <div aria-busy="true" style={{ display: "grid", gap: "var(--space-3)" }}>
        <span className="sr-only">Loading markets</span>
        <Skeleton width="100%" height="64px" />
        <Skeleton width="100%" height="64px" />
        <Skeleton width="100%" height="64px" />
      </div>
    );
  } else if (events.data.length === 0) {
    body = <Notice title="No markets yet">The venue lists nothing right now. New markets appear here on their own.</Notice>;
  } else {
    lead = `${events.data.length} markets on Solana devnet, traded with test funds.`;
    body = (
      <RowList label="Markets" columns={COLUMNS}>
        {sortEvents(events.data).map((event) => (
          <EventRow key={event.ticker} event={event} />
        ))}
      </RowList>
    );
  }

  return (
    <>
      <PageHeader title="Markets">{lead}</PageHeader>
      {body}
    </>
  );
}
