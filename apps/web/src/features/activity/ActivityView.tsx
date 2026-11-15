"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { Receipt, ReceiptLine } from "@/components/ui/Receipt";
import { Row, RowList, type Column } from "@/components/ui/RowList";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stamp } from "@/components/ui/Stamp";
import { marketHref } from "@/lib/routes";
import { formatClock, type TimeOptions } from "@/features/markets/wording";
import { OrderTimelineView } from "@/features/ticket/OrderTimeline";
import type { SendProgress } from "@/features/ticket/Ticket";
import { formatContracts, formatDollars, formatPrice, shortAddress } from "@/lib/format";
import type { ReconnectView } from "@/lib/privy/reconnect";
import type { ActivityRow } from "./rows";
import styles from "./Activity.module.css";

const COLUMNS: Column[] = [
  { id: "order", header: "Order", primary: true },
  { id: "placed", header: "Placed", align: "right", width: "6.5rem" },
  { id: "quantity", header: "Quantity", align: "right", width: "5.5rem" },
  { id: "limit", header: "Limit", align: "right", width: "4.5rem" },
  { id: "status", header: "Status", width: "6.5rem" },
  { id: "more", header: "Details", actions: true, width: "6rem" },
];

export interface ActivityReclaim {
  /** The order being reclaimed, or the one whose last attempt failed. */
  address: string | null;
  progress: SendProgress | null;
  error: string | null;
  /** Set while the trading wallet is not connected in this tab. */
  reconnect?: ReconnectView | null;
  onReclaim(row: ActivityRow): void;
}

export interface ActivityViewProps extends TimeOptions {
  /** Newest first. Null until the orders have been read. */
  rows: readonly ActivityRow[] | null;
  /** True while the relayer is not answering: only what Solana and this browser know is listed. */
  offline?: boolean;
  /** The wall clock the list is drawn for, unix milliseconds. */
  nowMs: number;
  /** The cluster clock, unix milliseconds: order deadlines are on-chain. */
  chainNow(): number;
  /** Freezes the expiry countdowns at this cluster time, for the gallery. */
  frozenAtMs?: number;
  /** Called when an order's expiry countdown reaches zero. */
  onExpired?(): void;
  reclaim: ActivityReclaim;
  txUrl(signature: string): string;
  addressUrl(address: string): string;
  /** Order addresses drawn open, for the gallery. */
  defaultExpanded?: readonly string[];
}

function day(atMs: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(new Date(atMs));
}

function OrderReceiptView({ row, txUrl, addressUrl }: { row: ActivityRow; txUrl(signature: string): string; addressUrl(address: string): string }) {
  const { receipt, timeline } = row;
  const symbol = row.entry.symbol ?? row.market?.symbol ?? null;
  const sale = receipt.sale;
  const tokens = (units: bigint) => `${formatContracts(units)} ${timeline.side}`;
  const waiting = timeline.canReclaim ? "waiting to be reclaimed" : "still held";
  let note: string;
  if (sale) {
    note =
      sale.paidMicros === null
        ? "The tokens stay with the program on Solana until the order fills, is cancelled, or is reclaimed."
        : "A sale is filled as a buy of the opposite outcome. The fee comes out of the proceeds, and only when a fill is recorded on Solana.";
  } else {
    note =
      receipt.returnedMicros === null
        ? "The hold stays with the program on Solana until the order fills, is cancelled, or is reclaimed."
        : "Amounts are in test dollars. Cost and fee are taken from the hold only when a fill is recorded on Solana.";
  }
  return (
    <Receipt title="Order receipt" note={note}>
      {row.title && <ReceiptLine label="Market">{row.title}</ReceiptLine>}
      <ReceiptLine label="Venue symbol">{symbol ?? "not known"}</ReceiptLine>
      <ReceiptLine label="Venue order id">{receipt.venueOrderId ?? "not sent"}</ReceiptLine>
      {receipt.fills.map((fill, index) => (
        <ReceiptLine key={fill.tradeId} label={receipt.fills.length > 1 ? `Fill ${index + 1} of ${receipt.fills.length}` : "Fill"}>
          {`${formatContracts(fill.units)} at ${formatPrice(fill.px)}`}
        </ReceiptLine>
      ))}
      {receipt.fills.length === 0 && <ReceiptLine label="Fill">none</ReceiptLine>}
      <ReceiptLine label="Order account">
        <ExternalLink href={addressUrl(row.address)} mono>
          {shortAddress(row.address)}
        </ExternalLink>
      </ReceiptLine>
      {receipt.signatures.map((entry) => (
        <ReceiptLine key={entry.signature} label={`${entry.label}, transaction`}>
          <ExternalLink href={txUrl(entry.signature)} mono>
            {shortAddress(entry.signature)}
          </ExternalLink>
        </ReceiptLine>
      ))}
      {sale ? (
        <>
          <ReceiptLine label="Tokens held" total>
            {tokens(sale.heldUnits)}
          </ReceiptLine>
          <ReceiptLine label="Proceeds">{formatDollars(sale.proceedsMicros)}</ReceiptLine>
          <ReceiptLine label="Fee">{formatDollars(receipt.feeMicros)}</ReceiptLine>
          <ReceiptLine label="Tokens returned">{sale.returnedUnits === null ? waiting : tokens(sale.returnedUnits)}</ReceiptLine>
          <ReceiptLine label="Test dollars paid" total>
            {sale.paidMicros === null ? "not yet" : formatDollars(sale.paidMicros)}
          </ReceiptLine>
        </>
      ) : (
        <>
          <ReceiptLine label="Held" total>
            {formatDollars(receipt.heldMicros)}
          </ReceiptLine>
          <ReceiptLine label="Cost">{formatDollars(receipt.costMicros)}</ReceiptLine>
          <ReceiptLine label="Fee">{formatDollars(receipt.feeMicros)}</ReceiptLine>
          <ReceiptLine label="Hold returned" total>
            {receipt.returnedMicros === null ? waiting : formatDollars(receipt.returnedMicros)}
          </ReceiptLine>
        </>
      )}
    </Receipt>
  );
}

/** Orders newest first as ruled rows; each opens in place into its steps and its receipt. */
export function ActivityView({ rows, offline = false, nowMs, chainNow, frozenAtMs, onExpired, reclaim, txUrl, addressUrl, defaultExpanded, timeZone }: ActivityViewProps) {
  // What the user opened or closed. An order whose hold can be reclaimed starts open, so the
  // Reclaim button is on screen without a click.
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(() => new Map((defaultExpanded ?? []).map((address) => [address, true])));
  const isOpen = (row: ActivityRow) => chosen.get(row.address) ?? row.timeline.canReclaim;
  const toggle = (row: ActivityRow) => setChosen((previous) => new Map(previous).set(row.address, !isOpen(row)));

  if (rows === null) {
    return (
      <div aria-busy="true">
        <span className="sr-only">Loading your orders</span>
        <RowList label="Your orders, loading" columns={COLUMNS} dense>
          {[0, 1, 2].map((index) => (
            <Row
              key={index}
              cells={[
                <div key="order" className={styles.order}>
                  <Skeleton width="11rem" height="1.25rem" />
                  <Skeleton width="min(22rem, 100%)" height="1rem" />
                </div>,
                <Skeleton key="placed" width="4rem" height="1rem" />,
                <Skeleton key="quantity" width="2.5rem" height="1rem" />,
                <Skeleton key="limit" width="2.5rem" height="1rem" />,
                <Skeleton key="status" width="4rem" height="1.25rem" />,
                null,
              ]}
            />
          ))}
        </RowList>
      </div>
    );
  }
  if (rows.length === 0 && offline) {
    return <EmptyState>You have no open orders on Solana. Orders that have finished are listed again when the relayer answers.</EmptyState>;
  }
  if (rows.length === 0) {
    return <EmptyState action={<ButtonLink href="/">See all markets</ButtonLink>}>No orders yet. Each order you place is listed here, with every step it took and its receipt.</EmptyState>;
  }

  const today = day(nowMs, timeZone);
  return (
    <>
      {offline && (
        <p className={styles.offline} role="status">
          Listed while the relayer is away: orders still open on Solana, each of which can be reclaimed once it expires, and earlier orders as they were last known. An order that finished in the meantime is listed again when the relayer answers.
        </p>
      )}
      <RowList label="Your orders" columns={COLUMNS} dense>
        {rows.map((row) => {
          const { timeline } = row;
          const open = isOpen(row);
          const detailId = `order-${row.address}`;
          const terms = `${row.kind} ${timeline.side} ${formatContracts(timeline.units)}${row.title ? ` of ${row.title}` : ""}`;
          const placedDay = row.entry.placedAt === null ? null : day(row.entry.placedAt, timeZone);
          return (
            <Row
              key={row.address}
              cells={[
                <div key="order" className={styles.order} data-testid="activity-order" data-stamp={timeline.stamp}>
                  <p className={styles.terms}>
                    <span className={styles.kind}>{row.kind}</span>
                    <span className={`${styles.side} ${timeline.side === "YES" ? styles.yes : styles.no}`}>{timeline.side}</span>
                    {row.market && row.title ? (
                      <Link href={marketHref(row.market)} className={styles.title}>
                        {row.title}
                      </Link>
                    ) : (
                      <span className={styles.unlisted}>Market no longer listed</span>
                    )}
                  </p>
                  <p className={styles.words}>{row.words}</p>
                </div>,
                row.entry.placedAt === null ? (
                  <span key="placed" className={styles.sub}>
                    not known
                  </span>
                ) : (
                  <div key="placed" className={styles.stack}>
                    <span className={styles.figure}>{formatClock(row.entry.placedAt, { timeZone })}</span>
                    {placedDay !== today && <span className={styles.sub}>{placedDay}</span>}
                  </div>
                ),
                <span key="quantity" className={styles.figure}>
                  {formatContracts(timeline.units)}
                </span>,
                <span key="limit" className={styles.figure}>
                  {formatPrice(timeline.limitPx)}
                </span>,
                <Stamp key="status" value={timeline.stamp} />,
                <Button key="more" size="row" variant="quiet" aria-expanded={open} aria-controls={detailId} onClick={() => toggle(row)}>
                  <span className={styles.caret} aria-hidden="true">
                    {open ? "−" : "+"}
                  </span>
                  Details
                  <span className="sr-only">{` of the order to ${terms}`}</span>
                </Button>,
              ]}
              detail={
                open ? (
                  <div id={detailId} className={styles.detail}>
                    <OrderTimelineView
                      variant="detail"
                      timeline={timeline}
                      marketTitle={row.title ?? undefined}
                      txUrl={txUrl}
                      chainNow={chainNow}
                      frozenAtMs={frozenAtMs}
                      onExpired={onExpired}
                      timeZone={timeZone}
                      reclaim={{
                        onReclaim: () => reclaim.onReclaim(row),
                        progress: reclaim.address === row.address ? reclaim.progress : null,
                        error: reclaim.address === row.address ? reclaim.error : null,
                        reconnect: reclaim.reconnect,
                      }}
                    />
                    <div className={styles.receipt}>
                      <OrderReceiptView row={row} txUrl={txUrl} addressUrl={addressUrl} />
                    </div>
                  </div>
                ) : undefined
              }
            />
          );
        })}
      </RowList>
      <p className={styles.count}>{`${rows.length} ${rows.length === 1 ? "order" : "orders"}. Times are in your time zone, ${formatClock(nowMs, { zone: true, timeZone }).split(" ").at(-1)}.`}</p>
    </>
  );
}
