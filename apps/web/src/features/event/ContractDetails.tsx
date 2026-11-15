"use client";

import type { ApiDepth, ApiEventDetail, ApiMarket, ApiTrade } from "@outcome/relayer/api-types";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { Fact, Facts } from "@/components/ui/Facts";
import { Panel } from "@/components/ui/Panel";
import { Row, RowList, type Column } from "@/components/ui/RowList";
import { centsText, NO_VALUE } from "@/features/markets/derive";
import { formatClock } from "@/features/markets/wording";
import { formatContracts } from "@/lib/format";
import { useDepth, useHistory, useTrades } from "@/lib/relayer/hooks";
import { PriceChart } from "./PriceChart";
import styles from "./Event.module.css";

const LEVELS = 5;
const TRADES = 8;

const BOOK: Column[] = [
  { id: "bid", header: "Bid", primary: true },
  { id: "bidSize", header: "Contracts", align: "right", width: "6rem" },
  { id: "ask", header: "Ask", align: "right", width: "5rem" },
  { id: "askSize", header: "Contracts", align: "right", width: "6rem" },
];

const TRADE: Column[] = [
  { id: "time", header: "Time", primary: true },
  { id: "taker", header: "Taker", width: "6rem" },
  { id: "price", header: "Price of Yes", align: "right", width: "7rem" },
  { id: "size", header: "Contracts", align: "right", width: "6rem" },
];

const px = (value: string | null | undefined) => centsText(value == null ? null : BigInt(value));

function Book({ depth }: { depth: ApiDepth | null | undefined }) {
  const bids = depth?.bids.slice(0, LEVELS) ?? [];
  const asks = depth?.asks.slice(0, LEVELS) ?? [];
  const rows = Math.max(bids.length, asks.length);
  if (rows === 0) return <p className={styles.note}>{depth === undefined ? "Reading the order book." : "Nobody bids or offers on this contract right now."}</p>;
  return (
    <RowList label="Order book, in prices of Yes" columns={BOOK}>
      {Array.from({ length: rows }, (_, index) => {
        const bid = bids[index];
        const ask = asks[index];
        return <Row key={index} cells={[px(bid?.px), bid ? formatContracts(BigInt(bid.units)) : NO_VALUE, px(ask?.px), ask ? formatContracts(BigInt(ask.units)) : NO_VALUE]} />;
      })}
    </RowList>
  );
}

function Trades({ trades }: { trades: ApiTrade[] | null | undefined }) {
  const recent = trades?.slice(0, TRADES) ?? [];
  if (recent.length === 0) return <p className={styles.note}>{trades === undefined ? "Reading recent trades." : "No trades yet."}</p>;
  return (
    <RowList label="Recent trades" columns={TRADE}>
      {recent.map((trade) => (
        <Row key={trade.id} cells={[formatClock(trade.at, { seconds: true }), trade.taker === "buy" ? "Bought Yes" : "Sold Yes", px(trade.px), formatContracts(BigInt(trade.units))]} />
      ))}
    </RowList>
  );
}

/** What the page shows about the selected contract: its prices, history, book, trades and rule. */
export function ContractDetails({ event, market }: { event: ApiEventDetail; market: ApiMarket }) {
  const depth = useDepth(market.symbol);
  const trades = useTrades(market.symbol);
  const history = useHistory(market.symbol);
  const rule = event.rules[market.symbol];

  return (
    <>
      <section className={styles.section} aria-labelledby="price-title">
        <div className={styles.sectionHead}>
          <h2 id="price-title">{event.shape === "ladder" ? market.label : "Price of Yes"}</h2>
          <p className={styles.quote} data-testid="quote-line">
            <span>
              Bid <strong>{px(market.book?.bidPx)}</strong>
            </span>
            <span>
              Ask <strong>{px(market.book?.askPx)}</strong>
            </span>
            <span>
              Last <strong>{px(market.lastPx)}</strong>
            </span>
          </p>
        </div>
        <Panel>
          <PriceChart history={history.data} />
        </Panel>
      </section>

      <section className={styles.section} aria-labelledby="book-title">
        <h2 id="book-title" className={styles.sectionTitle}>
          Order book
        </h2>
        <Book depth={depth.data} />
      </section>

      <section className={styles.section} aria-labelledby="trades-title">
        <h2 id="trades-title" className={styles.sectionTitle}>
          Recent trades
        </h2>
        <Trades trades={trades.data} />
      </section>

      <section className={styles.section} aria-labelledby="rule-title">
        <h2 id="rule-title" className={styles.sectionTitle}>
          Rule
        </h2>
        <Panel className={styles.rule}>
          <p>{rule ?? event.description}</p>
          <h3 className="sr-only">Resolution</h3>
          <Facts>
            <Fact label="Resolves from">{event.source ? `${event.source.agency}, ${event.source.index}` : "The venue's reference price at the close"}</Fact>
            {event.termsUrl && (
              <Fact label="Terms">
                <ExternalLink href={event.termsUrl}>Contract terms</ExternalLink>
              </Fact>
            )}
          </Facts>
        </Panel>
      </section>
    </>
  );
}
