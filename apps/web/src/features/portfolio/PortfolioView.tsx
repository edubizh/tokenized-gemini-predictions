"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { ApiMarket, SideName } from "@outcome/relayer/api-types";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Countdown } from "@/components/ui/Countdown";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { Notice } from "@/components/ui/Notice";
import { Panel } from "@/components/ui/Panel";
import { Row, RowList, type Column } from "@/components/ui/RowList";
import { Skeleton } from "@/components/ui/Skeleton";
import type { ActivityRow } from "@/features/activity/rows";
import type { Reclaiming } from "@/features/activity/useOrderRows";
import { NO_VALUE } from "@/features/markets/derive";
import { marketTitle } from "@/features/markets/wording";
import type { Balances } from "@/lib/chain/reads";
import { formatCents, formatContracts, formatDollars, shortAddress } from "@/lib/format";
import type { ReconnectView } from "@/lib/privy/reconnect";
import { ReconnectWords } from "@/lib/privy/ReconnectWords";
import { marketHref } from "@/lib/routes";
import type { RedeemState } from "./actions";
import { summarize, type Portfolio, type PositionRow } from "./positions";
import styles from "./Portfolio.module.css";

/** What a finished redemption leaves on the page, until the page is left. */
export interface Redemption {
  mint: string;
  market: ApiMarket;
  side: SideName;
  /** Tokens burned, in units. */
  units: bigint;
  /** Test dollars received, in micro-dollars. Zero for tokens that lost. */
  payoutMicros: bigint;
  signature: string;
}

export interface PortfolioViewProps {
  /** Null until the wallet's balances have been read. */
  balances: Balances | null;
  /** Null until the wallet's tokens have been read. */
  portfolio: Portfolio | null;
  /** The orders whose hold is still with the program; null until they have been read. */
  openOrders: readonly ActivityRow[] | null;
  /** True while the relayer is not answering: prices are not known and nothing can be sold. */
  offline: boolean;
  /** True while Solana has not answered the first read of the wallet's tokens. */
  chainFailing: boolean;
  /** True for a wallet that has not been given test funds yet: that step stands in for the empty state. */
  firstRun: boolean;
  redemptions: readonly Redemption[];
  redeeming: RedeemState;
  onRedeem(row: PositionRow): void;
  reclaiming: Reclaiming;
  /** Set while the trading wallet is not connected in this tab: reconnecting takes the place of Redeem. */
  reconnect: ReconnectView | null;
  /** The cluster clock, unix milliseconds: redemption opens and orders expire on it. */
  chainNow(): number;
  /** Called when a countdown reaches zero, so the rows can be drawn again in their new state. */
  onDeadline(): void;
  txUrl(signature: string): string;
  addressUrl(address: string): string;
}

const POSITION: Column = { id: "position", header: "Market", primary: true, width: "minmax(12rem, 1fr)" };
const SIDE: Column = { id: "side", header: "Side", width: "3rem" };
const CONTRACTS: Column = { id: "contracts", header: "Contracts", align: "right", width: "5.5rem" };
const STATUS: Column = { id: "status", header: "Status", width: "9rem" };
const ACTION: Column = { id: "action", header: "Action", actions: true, width: "7.5rem" };

const POSITIONS: Column[] = [POSITION, SIDE, CONTRACTS, { id: "value", header: "Value", align: "right", width: "5.5rem" }, STATUS, ACTION];
const SETTLED: Column[] = [POSITION, SIDE, CONTRACTS, { id: "pays", header: "Pays", align: "right", width: "5.5rem" }, STATUS, ACTION];
const ORDERS: Column[] = [
  POSITION,
  { id: "order", header: "Order", width: "5.5rem" },
  CONTRACTS,
  { id: "limit", header: "Limit", align: "right", width: "4rem" },
  { id: "held", header: "Held", align: "right", width: "6rem" },
  STATUS,
  ACTION,
];
const OTHER: Column[] = [{ id: "mint", header: "Token mint", primary: true }, CONTRACTS];

const SIDE_WORD: Record<SideName, string> = { YES: "Yes", NO: "No" };

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className={styles.section} aria-labelledby={`${id}-title`} data-testid={`portfolio-${id}`}>
      <h2 id={`${id}-title`}>{title}</h2>
      {children}
    </section>
  );
}

function Figure({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className={styles.figure}>
      <dt className={styles.figureLabel}>{label}</dt>
      <dd className={styles.figureValue} data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

function MarketLink({ market, testId }: { market: ApiMarket; testId: string }) {
  return (
    <Link href={marketHref(market)} className={styles.rowTitle} data-testid={testId}>
      {marketTitle(market)}
    </Link>
  );
}

const money = (micros: bigint | null) => (micros === null ? NO_VALUE : formatDollars(micros));
const named = (row: { units: bigint; side: SideName; market: ApiMarket }) => `${formatContracts(row.units)} ${SIDE_WORD[row.side]} of ${marketTitle(row.market)}`;

/** The wallet's test dollars, its outcome tokens and its open orders, as they stand on Solana. */
export function PortfolioView({
  balances,
  portfolio,
  openOrders,
  offline,
  chainFailing,
  firstRun,
  redemptions,
  redeeming,
  onRedeem,
  reclaiming,
  reconnect,
  chainNow,
  onDeadline,
  txUrl,
  addressUrl,
}: PortfolioViewProps) {
  const done = new Set(redemptions.map((redemption) => redemption.mint));
  const held = portfolio ? [...portfolio.live, ...portfolio.awaiting] : [];
  const settled = portfolio ? [...portfolio.redeemable, ...portfolio.opening].filter((row) => !done.has(row.mint)) : [];
  const orders = openOrders ?? [];
  const summary = portfolio && openOrders ? summarize({ ...portfolio, redeemable: settled.filter((row) => row.group === "redeemable") }, orders.map((row) => row.timeline)) : null;
  const empty = portfolio !== null && openOrders !== null && portfolio.empty && orders.length === 0 && redemptions.length === 0;

  const redeemBusy = (row: PositionRow) => (redeeming.mint === row.mint ? (redeeming.progress === "wallet" ? "Check your wallet" : redeeming.progress === "sending" ? "Sending" : false) : false);
  const reclaimBusy = (row: ActivityRow) => (reclaiming.address === row.address ? (reclaiming.progress === "wallet" ? "Check your wallet" : reclaiming.progress === "sending" ? "Sending" : false) : false);

  const summaryPanel = (
    <Panel>
      <h2 className="sr-only">Summary</h2>
      <dl className={styles.summary}>
        <Figure label="Test dollars" testId="portfolio-balance">
          {balances === null ? <Skeleton width="6rem" /> : formatDollars(balances.stableMicros)}
        </Figure>
        <Figure label="Value at current prices" testId="portfolio-value">
          {summary === null ? <Skeleton width="5rem" /> : summary.valueMicros === 0n && !summary.priced ? NO_VALUE : formatDollars(summary.valueMicros)}
        </Figure>
        <Figure label="Open orders" testId="portfolio-open-orders">
          {summary === null ? <Skeleton width="3rem" /> : summary.openOrders}
        </Figure>
        <Figure label="Redeemable now" testId="portfolio-redeemable">
          {summary === null ? <Skeleton width="5rem" /> : formatDollars(summary.redeemableMicros)}
        </Figure>
      </dl>
    </Panel>
  );

  if (portfolio === null || openOrders === null) {
    return (
      <div className={styles.page}>
        {summaryPanel}
        {chainFailing ? (
          <Notice title="Solana devnet is not answering">Your tokens could not be read yet. The page keeps trying; nothing is lost.</Notice>
        ) : (
          <Section id="loading" title="Positions">
            <div aria-busy="true">
              <span className="sr-only">Reading your tokens from Solana</span>
              <RowList label="Positions, loading" columns={POSITIONS}>
                {[0, 1].map((index) => (
                  <Row key={index} cells={[<Skeleton key="p" width="14rem" />, <Skeleton key="s" width="2rem" />, <Skeleton key="c" width="3rem" />, <Skeleton key="v" width="3.5rem" />, <Skeleton key="t" width="6rem" />, null]} />
                ))}
              </RowList>
            </div>
          </Section>
        )}
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {summaryPanel}

      {empty && !firstRun && (
        <Notice title="No positions yet" action={<ButtonLink href="/" size="row">See markets</ButtonLink>}>
          Buy Yes or No in any market and your tokens are listed here.
        </Notice>
      )}

      {held.length > 0 && (
        <Section id="positions" title="Positions">
          <RowList label="Positions" columns={POSITIONS}>
            {held.map((row) => (
              <Row
                key={row.mint}
                cells={[
                  <MarketLink key="position" market={row.market} testId="position-row" />,
                  SIDE_WORD[row.side],
                  formatContracts(row.units),
                  money(row.valueMicros),
                  row.group === "live" ? (
                    <Countdown key="status" to={row.market.expiresAt} label="closes in" closedText="closed" calm onClosed={onDeadline} />
                  ) : (
                    <Badge key="status">Awaiting result</Badge>
                  ),
                  // A sale goes through the relayer, so it is not offered while the relayer is away.
                  row.group === "live" && !offline ? (
                    <span key="action" className={styles.action} data-testid="position-sell">
                      <ButtonLink size="row" href={marketHref(row.market, row.side, "sell")}>
                        Sell<span className="sr-only">{` ${named(row)}`}</span>
                      </ButtonLink>
                    </span>
                  ) : null,
                ]}
              />
            ))}
          </RowList>
          {offline && <p className={styles.note}>Values and selling come back when the relayer answers. Your tokens are read from Solana and are safe.</p>}
        </Section>
      )}

      {orders.length > 0 && (
        <Section id="orders" title="Open orders">
          <RowList label="Open orders" columns={ORDERS}>
            {orders.map((row) => {
              const { timeline } = row;
              return (
                <Row
                  key={row.address}
                  cells={[
                    row.market ? <MarketLink key="position" market={row.market} testId="open-order" /> : <span key="position" data-testid="open-order">Market not known</span>,
                    `${timeline.kind === "sell" ? "Sell" : "Buy"} ${SIDE_WORD[timeline.side]}`,
                    formatContracts(timeline.units),
                    formatCents(timeline.limitPx),
                    timeline.kind === "sell" ? `${formatContracts(timeline.units)} tokens` : formatDollars(timeline.holdMicros),
                    timeline.canReclaim ? (
                      <Badge key="status">Expired</Badge>
                    ) : (
                      <Countdown key="status" to={timeline.expiresAt * 1000} now={chainNow} label="expires in" closedText="expired" calm onClosed={onDeadline} />
                    ),
                    timeline.canReclaim ? (
                      reclaiming.reconnect ? (
                        <Button key="action" size="row" onClick={reclaiming.reconnect.onReconnect}>
                          Reconnect wallet
                        </Button>
                      ) : (
                        <Button key="action" size="row" onClick={() => reclaiming.onReclaim(row)} busy={reclaimBusy(row)} data-testid="order-reclaim">
                          Reclaim<span className="sr-only">{` the ${timeline.kind === "sell" ? "tokens" : "hold"} of ${row.title ?? "this order"}`}</span>
                        </Button>
                      )
                    ) : null,
                  ]}
                />
              );
            })}
          </RowList>
          {reclaiming.error && (
            <Notice tone="negative" title="Nothing was reclaimed">
              {reclaiming.error}
            </Notice>
          )}
        </Section>
      )}

      {(settled.length > 0 || redemptions.length > 0) && (
        <Section id="settled" title="Settled">
          <RowList label="Settled positions" columns={SETTLED}>
            {settled.map((row) => {
              const won = (row.payoutMicros ?? 0n) > 0n;
              let action: ReactNode = null;
              if (row.group === "redeemable") {
                action = reconnect ? (
                  <Button key="action" size="row" onClick={reconnect.onReconnect}>
                    Reconnect wallet
                  </Button>
                ) : (
                  <Button key="action" size="row" variant={won ? "secondary" : "quiet"} onClick={() => onRedeem(row)} busy={redeemBusy(row)} data-testid={won ? "position-redeem" : "position-clear"}>
                    {won ? "Redeem" : "Clear"}
                    <span className="sr-only">{` ${named(row)}`}</span>
                  </Button>
                );
              }
              return (
                <Row
                  key={row.mint}
                  cells={[
                    <MarketLink key="position" market={row.market} testId="position-row" />,
                    SIDE_WORD[row.side],
                    formatContracts(row.units),
                    money(row.payoutMicros),
                    // A position that pays nothing is lost at once; only a winner waits for the redeem window.
                    row.payoutMicros === 0n ? (
                      <Badge key="status">Lost</Badge>
                    ) : row.group === "opening" ? (
                      <Countdown key="status" to={(row.redeemAfter ?? 0) * 1000} now={chainNow} label="redeem in" closedText="opening" calm onClosed={onDeadline} />
                    ) : (
                      <Badge key="status" tone={won ? "positive" : undefined}>
                        {won ? "Won" : "Lost"}
                      </Badge>
                    ),
                    action,
                  ]}
                />
              );
            })}
            {redemptions.map((redemption) => (
              <Row
                key={redemption.signature}
                cells={[
                  <MarketLink key="position" market={redemption.market} testId="position-row" />,
                  SIDE_WORD[redemption.side],
                  formatContracts(redemption.units),
                  formatDollars(redemption.payoutMicros),
                  <Badge key="status">{redemption.payoutMicros > 0n ? "Redeemed" : "Cleared"}</Badge>,
                  <span key="action" data-testid="redemption-tx">
                    <ExternalLink href={txUrl(redemption.signature)}>{shortAddress(redemption.signature)}</ExternalLink>
                  </span>,
                ]}
              />
            ))}
          </RowList>
          {reconnect && settled.some((row) => row.group === "redeemable") && (
            <p className={styles.note} role="status">
              <ReconnectWords reconnect={reconnect} />
            </p>
          )}
          {redeeming.error && (
            <Notice tone="negative" title="The tokens were not redeemed">
              {redeeming.error}
            </Notice>
          )}
        </Section>
      )}

      {portfolio.unknown.length > 0 && (
        <Section id="other" title="Other tokens">
          <RowList label="Tokens of markets that are not known" columns={OTHER}>
            {portfolio.unknown.map((balance) => (
              <Row
                key={balance.mint}
                cells={[
                  <ExternalLink key="mint" href={addressUrl(balance.mint)}>
                    {shortAddress(balance.mint)}
                  </ExternalLink>,
                  formatContracts(balance.units),
                ]}
              />
            ))}
          </RowList>
          <p className={styles.note}>Nothing names the market of these tokens, so they cannot be valued or redeemed here. They are safe in your wallet.</p>
        </Section>
      )}
    </div>
  );
}
