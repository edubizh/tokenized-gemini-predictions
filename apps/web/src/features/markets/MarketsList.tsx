"use client";

import Link from "next/link";
import type { ApiMarket } from "@outcome/relayer/api-types";
import { Countdown, CountdownView } from "@/components/ui/Countdown";
import { PriceButton } from "@/components/ui/PriceButton";
import { Row, RowList, type Column } from "@/components/ui/RowList";
import { Skeleton } from "@/components/ui/Skeleton";
import { askPx } from "./book";
import { closesLine, formatClock, listedMarkets, marketTitle, notTradableWords, payoutStatement, type TimeOptions } from "./wording";
import styles from "./Markets.module.css";

const COLUMNS: Column[] = [
  { id: "market", header: "Market", primary: true },
  { id: "closes", header: "Time left", align: "right", width: "8.5rem" },
  { id: "buy", header: "Buy", actions: true, width: "10rem" },
];

export function marketHref(symbol: string, side?: "YES" | "NO"): string {
  return `/markets/${symbol}${side ? `?side=${side.toLowerCase()}` : ""}`;
}

export interface MarketsListViewProps extends TimeOptions {
  markets: readonly ApiMarket[];
  /** The time the list is drawn for, unix milliseconds. */
  nowMs: number;
  /** Freezes the countdowns at `nowMs`, for the gallery. */
  frozen?: boolean;
}

/** Live contracts as ruled rows: what YES pays for, the time left, and the price of each side. */
export function MarketsListView({ markets, nowMs, frozen, timeZone }: MarketsListViewProps) {
  return (
    <RowList label="Markets" columns={COLUMNS}>
      {listedMarkets(markets, nowMs).map((market) => {
        const title = marketTitle(market);
        const upcoming = market.startsAt > nowMs;
        const deadline = upcoming ? market.startsAt : market.expiresAt;
        const label = upcoming ? "opens in" : "";
        const reason = notTradableWords(market, { timeZone });
        return (
          <Row
            key={market.symbol}
            cells={[
              <div key="market" className={styles.market}>
                <Link href={marketHref(market.symbol)} className={styles.title}>
                  {title}
                </Link>
                <p className={styles.statement}>{payoutStatement(market, { timeZone })}</p>
              </div>,
              <div key="closes" className={styles.closes}>
                {frozen ? (
                  <CountdownView remainingMs={deadline - nowMs} label={label} closedText="awaiting result" />
                ) : (
                  <Countdown to={deadline} label={label} closedText={upcoming ? "opening" : "awaiting result"} />
                )}
                <span className={styles.clock}>{market.expiresAt <= nowMs ? `closed ${formatClock(market.expiresAt, { timeZone })}` : closesLine(market, { timeZone })}</span>
              </div>,
              reason === null ? (
                <>
                  <PriceButton side="YES" px={askPx(market, "YES")} href={marketHref(market.symbol, "YES")} subject={title} />
                  <PriceButton side="NO" px={askPx(market, "NO")} href={marketHref(market.symbol, "NO")} subject={title} />
                </>
              ) : (
                <span key="reason" className={styles.reason}>
                  {reason}
                </span>
              ),
            ]}
          />
        );
      })}
    </RowList>
  );
}

/** Rows with the dimensions of the real ones, shown until the first answer arrives. */
export function MarketsListSkeleton() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Loading markets</span>
      <RowList label="Markets, loading" columns={COLUMNS}>
        {[0, 1, 2].map((row) => (
          <Row
            key={row}
            cells={[
              <div key="market" className={styles.market}>
                <Skeleton width="5rem" height="1.25rem" />
                <Skeleton width="min(28rem, 100%)" height="1rem" />
              </div>,
              <Skeleton key="closes" width="3.5rem" height="1.25rem" />,
              <>
                <Skeleton width="4.5rem" height="44px" />
                <Skeleton width="4.5rem" height="44px" />
              </>,
            ]}
          />
        ))}
      </RowList>
    </div>
  );
}
