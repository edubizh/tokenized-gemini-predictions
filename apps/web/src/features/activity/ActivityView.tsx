"use client";

import Link from "next/link";
import { useState } from "react";
import type { SideName } from "@outcome/relayer/api-types";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { Fact, Facts } from "@/components/ui/Facts";
import { Notice } from "@/components/ui/Notice";
import { Row, RowList, type Column } from "@/components/ui/RowList";
import { Skeleton } from "@/components/ui/Skeleton";
import { NO_VALUE } from "@/features/markets/derive";
import { formatClock } from "@/features/markets/wording";
import { OrderTimelineView } from "@/features/ticket/OrderTimeline";
import type { OrderStamp } from "@/features/ticket/timeline";
import { formatCents, formatContracts, formatDollars, shortAddress } from "@/lib/format";
import { marketHref } from "@/lib/routes";
import { orderAmount } from "./figures";
import type { ActivityRow } from "./rows";
import type { Reclaiming } from "./useOrderRows";
import styles from "./Activity.module.css";

const COLUMNS: Column[] = [
  { id: "market", header: "Market", primary: true, width: "minmax(12rem, 1fr)" },
  { id: "order", header: "Order", width: "5rem" },
  { id: "time", header: "Placed", align: "right", width: "5.5rem" },
  { id: "contracts", header: "Contracts", align: "right", width: "5rem" },
  { id: "price", header: "Price", align: "right", width: "3.5rem" },
  { id: "amount", header: "Amount", align: "right", width: "5rem" },
  { id: "status", header: "Status", width: "5.5rem" },
  { id: "details", header: "Details", actions: true, width: "5.5rem" },
];

const SIDE_WORD: Record<SideName, string> = { YES: "Yes", NO: "No" };
const STATUS: Record<OrderStamp, { word: string; tone: BadgeTone }> = {
  OPEN: { word: "Open", tone: "neutral" },
  FILLED: { word: "Filled", tone: "positive" },
  REFUNDED: { word: "Refunded", tone: "neutral" },
  EXPIRED: { word: "Expired", tone: "neutral" },
};

export interface ActivityViewProps {
  /** Newest first. Null until the orders have been read. */
  rows: readonly ActivityRow[] | null;
  /** True while the relayer is not answering: only what Solana and this browser know is listed. */
  offline: boolean;
  /** The wall clock the list is drawn for, unix milliseconds. */
  nowMs: number;
  /** The cluster clock, unix milliseconds: order deadlines are on-chain. */
  chainNow(): number;
  /** Called when an order's expiry countdown reaches zero. */
  onExpired(): void;
  reclaim: Reclaiming;
  txUrl(signature: string): string;
  addressUrl(address: string): string;
}

const day = (atMs: number) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(atMs));

/** The figures of one order, where the steps above them say what happened. */
function OrderFacts({ row, addressUrl }: { row: ActivityRow; addressUrl(address: string): string }) {
  const { figures, timeline } = row;
  const sale = figures.sale;
  const tokens = (units: bigint) => `${formatContracts(units)} ${SIDE_WORD[timeline.side]}`;
  const waiting = timeline.canReclaim ? "To reclaim" : "Still held";
  return (
    <>
      <h3 className="sr-only">Figures of the order</h3>
      <Facts>
        {figures.fills.length === 0 ? (
          <Fact label="Fill">None</Fact>
        ) : (
          figures.fills.map((fill, index) => (
            <Fact key={fill.tradeId} label={figures.fills.length > 1 ? `Fill ${index + 1} of ${figures.fills.length}` : "Fill"}>
              {`${formatContracts(fill.units)} at ${formatCents(fill.px)}`}
            </Fact>
          ))
        )}
        <Fact label="Order account">
          <ExternalLink href={addressUrl(row.address)}>{shortAddress(row.address)}</ExternalLink>
        </Fact>
        {sale ? (
          <>
            <Fact label="Tokens held">{tokens(sale.heldUnits)}</Fact>
            <Fact label="Proceeds">{formatDollars(sale.proceedsMicros)}</Fact>
            <Fact label="Fee">{formatDollars(figures.feeMicros)}</Fact>
            <Fact label="Tokens returned">{sale.returnedUnits === null ? waiting : tokens(sale.returnedUnits)}</Fact>
            <Fact label="Test dollars paid" total>
              {sale.paidMicros === null ? "Not yet" : formatDollars(sale.paidMicros)}
            </Fact>
          </>
        ) : (
          <>
            <Fact label="Held">{formatDollars(figures.heldMicros)}</Fact>
            <Fact label="Cost">{formatDollars(figures.costMicros)}</Fact>
            <Fact label="Fee">{formatDollars(figures.feeMicros)}</Fact>
            <Fact label="Hold returned" total>
              {figures.returnedMicros === null ? waiting : formatDollars(figures.returnedMicros)}
            </Fact>
          </>
        )}
      </Facts>
    </>
  );
}

/** Every order of the wallet, newest first; each opens in place into its steps and its figures. */
export function ActivityView({ rows, offline, nowMs, chainNow, onExpired, reclaim, txUrl, addressUrl }: ActivityViewProps) {
  // What the user opened or closed. An order that can be reclaimed starts open, so Reclaim is in view.
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const isOpen = (row: ActivityRow) => chosen.get(row.address) ?? row.timeline.canReclaim;
  const toggle = (row: ActivityRow) => setChosen((previous) => new Map(previous).set(row.address, !isOpen(row)));

  if (rows === null) {
    return (
      <div aria-busy="true">
        <span className="sr-only">Loading your orders</span>
        <RowList label="Your orders, loading" columns={COLUMNS}>
          {[0, 1, 2].map((index) => (
            <Row
              key={index}
              cells={[
                <Skeleton key="m" width="14rem" />,
                <Skeleton key="o" width="3.5rem" />,
                <Skeleton key="t" width="4rem" />,
                <Skeleton key="c" width="2.5rem" />,
                <Skeleton key="p" width="2rem" />,
                <Skeleton key="a" width="3rem" />,
                <Skeleton key="s" width="4rem" />,
                null,
              ]}
            />
          ))}
        </RowList>
      </div>
    );
  }
  if (rows.length === 0) {
    return offline ? (
      <Notice title="No open orders on Solana">Orders that have finished are listed again when the relayer answers.</Notice>
    ) : (
      <Notice title="No orders yet" action={<ButtonLink href="/" size="row">See markets</ButtonLink>}>
        Each order you place is listed here, with every step it took and its transactions.
      </Notice>
    );
  }

  const today = day(nowMs);
  return (
    <div className={styles.page}>
      {offline && (
        <p className={styles.note} role="status">
          The relayer is not answering, so this lists the orders still open on Solana and earlier orders as they were last known.
        </p>
      )}
      <RowList label="Your orders" columns={COLUMNS}>
        {rows.map((row) => {
          const { timeline } = row;
          const open = isOpen(row);
          const detailId = `order-${row.address}`;
          const order = `${timeline.kind === "sell" ? "Sell" : "Buy"} ${SIDE_WORD[timeline.side]}`;
          const placed = row.entry.placedAt;
          const amount = orderAmount(row.figures);
          const status = STATUS[timeline.stamp];
          return (
            <Row
              key={row.address}
              cells={[
                row.market && row.title ? (
                  <Link key="market" href={marketHref(row.market)} className={styles.rowTitle} data-testid="activity-order" data-stamp={timeline.stamp}>
                    {row.title}
                  </Link>
                ) : (
                  <span key="market" data-testid="activity-order" data-stamp={timeline.stamp}>
                    Market no longer listed
                  </span>
                ),
                order,
                placed === null ? (
                  NO_VALUE
                ) : (
                  <span key="time" className={styles.time}>
                    {formatClock(placed)}
                    {day(placed) !== today && <span className={styles.day}>{day(placed)}</span>}
                  </span>
                ),
                formatContracts(timeline.units),
                formatCents(timeline.limitPx),
                amount === null ? NO_VALUE : formatDollars(amount),
                <Badge key="status" tone={status.tone}>
                  {status.word}
                </Badge>,
                <Button key="details" size="row" variant="quiet" aria-expanded={open} aria-controls={detailId} onClick={() => toggle(row)} data-testid="activity-details">
                  {open ? "Hide" : "Details"}
                  <span className="sr-only">{` of ${order} ${row.title ?? ""}`}</span>
                </Button>,
              ]}
              detail={
                open ? (
                  <div id={detailId} className={styles.detail} data-testid="activity-steps">
                    <OrderTimelineView
                      variant="detail"
                      timeline={timeline}
                      marketTitle={row.title ?? undefined}
                      txUrl={txUrl}
                      chainNow={chainNow}
                      onExpired={onExpired}
                      reclaim={{
                        onReclaim: () => reclaim.onReclaim(row),
                        progress: reclaim.address === row.address ? reclaim.progress : null,
                        error: reclaim.address === row.address ? reclaim.error : null,
                        reconnect: reclaim.reconnect,
                      }}
                    />
                    <div className={styles.facts}>
                      <OrderFacts row={row} addressUrl={addressUrl} />
                    </div>
                  </div>
                ) : undefined
              }
            />
          );
        })}
      </RowList>
      <p className={styles.note}>{`Times are in your time zone, ${formatClock(nowMs, { zone: true }).split(" ").at(-1)}.`}</p>
    </div>
  );
}
