"use client";

import type { ReactNode } from "react";
import type { ApiHealth, ApiMarket, ApiStatus } from "@outcome/relayer/api-types";
import { networkNotice, type Venue } from "@/components/shell/network";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { Notice } from "@/components/ui/Notice";
import { Receipt, ReceiptLine } from "@/components/ui/Receipt";
import { Row, RowList, type Column } from "@/components/ui/RowList";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatClock, marketTitle, type TimeOptions } from "@/features/markets/wording";
import { formatContracts, formatDollars, formatSol, shortAddress } from "@/lib/format";
import styles from "./System.module.css";

/** The deployment's accounts. Null where nothing has been deployed yet. */
export interface SystemAddresses {
  program: string;
  config: string | null;
  stableMint: string | null;
  treasury: string | null;
}

export interface SystemViewProps extends TimeOptions {
  /** The venue the relayer trades on, as last reported. */
  venue: Venue;
  /** Null before the relayer's first answer and while it cannot be reached. */
  health: ApiHealth | null;
  offline: boolean;
  /** Null until `/status` has answered. */
  status: ApiStatus | null;
  /** Every market the relayer lists, to name the reconciliation rows. */
  markets: readonly ApiMarket[];
  addresses: SystemAddresses;
  /** The wall clock the page is drawn for, unix milliseconds. */
  nowMs: number;
  addressUrl(address: string): string;
}

// Seven columns: the numeric ones give up width before the market's name does.
const RECONCILE: Column[] = [
  { id: "market", header: "Market", primary: true, width: "minmax(6rem, 1fr)" },
  { id: "yes", header: "YES supply", align: "right", width: "minmax(3.5rem, 5.5rem)" },
  { id: "no", header: "NO supply", align: "right", width: "minmax(3.5rem, 5.5rem)" },
  { id: "venue", header: "Venue position", align: "right", width: "minmax(4.5rem, 7.5rem)" },
  { id: "flight", header: "In flight", align: "right", width: "minmax(3.5rem, 5rem)" },
  { id: "house", header: "Operator inventory", align: "right", width: "minmax(5rem, 9.5rem)" },
  { id: "check", header: "Check", width: "minmax(5.5rem, 6.5rem)" },
];

const ALERTS: Column[] = [
  { id: "alert", header: "Alert", primary: true },
  { id: "when", header: "When", align: "right", width: "8rem" },
  { id: "order", header: "Order", align: "right", width: "7rem" },
];

/** Signed units as contracts: YES positive, NO negative. */
function signedContracts(units: bigint): string {
  if (units === 0n) return formatContracts(0n);
  return units > 0n ? `+${formatContracts(units)}` : `−${formatContracts(-units)}`;
}

function seconds(count: number): string {
  return `${count} ${count === 1 ? "second" : "seconds"}`;
}

function day(atMs: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(new Date(atMs));
}

function Section({ id, title, note, children }: { id: string; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.section} aria-labelledby={`${id}-title`} id={id}>
      <h2 id={`${id}-title`}>{title}</h2>
      {note && <p className={styles.sectionNote}>{note}</p>}
      {children}
    </section>
  );
}

function Fact({ label, note, children }: { label: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.ledgerRow}>
      <dt className={styles.ledgerLabel}>{label}</dt>
      <dd className={styles.ledgerValue}>{children}</dd>
      <dd className={styles.ledgerNote}>{note}</dd>
    </div>
  );
}

function AddressFact({ label, address, note, addressUrl }: { label: string; address: string | null; note: string; addressUrl(address: string): string }) {
  return (
    <Fact label={label} note={note}>
      {address === null ? (
        <span className={styles.attention}>not deployed yet</span>
      ) : (
        <ExternalLink href={addressUrl(address)} mono>
          <span className={styles.full}>{address}</span>
          <span className={styles.short}>{shortAddress(address)}</span>
        </ExternalLink>
      )}
    </Fact>
  );
}

/** How the demo works, what is trusted, and the relayer's own view of whether its books balance. */
export function SystemView({ venue, health, offline, status, markets, addresses, nowMs, addressUrl, timeZone }: SystemViewProps) {
  const simulated = venue === "mock";
  const venueName = simulated ? "a simulated venue" : "an exchange sandbox";
  const [where, value] = networkNotice(venue);
  const waiting = health === null && !offline;
  const unknown = <span className={styles.attention}>not known while the relayer is not answering</span>;
  const placeholder = (width: string) => (waiting ? <Skeleton width={width} height="1em" inline /> : unknown);
  const drift = health ? Math.round(health.serverTime / 1000) - health.chainTime : 0;
  const today = day(nowMs, timeZone);

  return (
    <div className={styles.sections}>
      <Section id="loop" title="The loop in five steps" note={`${where} ${value} Every amount is in test dollars, a test stablecoin on Solana devnet.`}>
        <ol className={styles.steps}>
          <li>
            <span className={styles.stepNumber}>1</span>
            <p className={styles.stepText}>
              <strong>Get test funds.</strong> After you log in, the demo registers your wallet as a trader and sends it test dollars and a little devnet SOL for network fees. One transaction, once per wallet.
            </p>
          </li>
          <li>
            <span className={styles.stepNumber}>2</span>
            <p className={styles.stepText}>
              <strong>Place an order.</strong> Your wallet sends the cost at your limit price, plus a cap for the fee, to a program on Solana. That is the hold. Only a fill within your terms or a refund can move it.
            </p>
          </li>
          <li>
            <span className={styles.stepNumber}>3</span>
            <p className={styles.stepText}>
              <strong>The relayer goes to the venue.</strong> It places one matching order on {venueName}. That order fills in full at your limit or better, or not at all.
            </p>
          </li>
          <li>
            <span className={styles.stepNumber}>4</span>
            <p className={styles.stepText}>
              <strong>Minted or refunded.</strong> A fill mints outcome tokens to your wallet and returns the unused hold. No fill returns all of it. If the order expires first, you can reclaim the hold yourself.
            </p>
          </li>
          <li>
            <span className={styles.stepNumber}>5</span>
            <p className={styles.stepText}>
              <strong>Settle and redeem.</strong> When the fifteen minutes end, the settler records the venue's result on Solana and funds the market's vault. Shortly after, redemption opens: each winning token pays $1.00 in test dollars, and tokens of the other side pay nothing.
            </p>
          </li>
        </ol>
      </Section>

      <Section id="trust" title="What you are trusting">
        <div className={styles.prose}>
          <p>
            <strong>The relayer and the settler are trusted.</strong> The program on Solana cannot see the venue. That an order filled, and at what price, is reported by the relayer. Which side won is reported by the settler. The tokens are claims on positions the operator holds at the venue, so this is a custodial bridge.
          </p>
          <p>The program limits what they can do to any one order:</p>
        </div>
        <dl className={styles.ledger}>
          <Fact label="Price" note="A fill can never cost more per contract than the limit you set.">
            at your limit or better
          </Fact>
          <Fact label="Quantity" note="A fill can never mint more than the order asked for. Anything not filled is refunded.">
            no more than you asked
          </Fact>
          <Fact label="Fee cap" note="The fee taken from the hold can never exceed the cap shown on the ticket.">
            no more than the cap
          </Fact>
          <Fact label="Deadline" note="After an order expires the relayer can no longer fill it, and anyone, including you, can send the whole hold back to your wallet.">
            {health ? `${seconds(health.orderTtlSecs)} after placing` : "a fixed time after placing"}
          </Fact>
        </dl>
      </Section>

      <Section id="status" title="Status" note="Read from the relayer every few seconds.">
        {offline && (
          <div style={{ marginBottom: "var(--space-4)" }}>
            <Notice tone="caution" title="The relayer is not answering">
              Its status cannot be shown until it is back. Balances, open orders and holds are on Solana and are not affected.
            </Notice>
          </div>
        )}
        <dl className={styles.ledger}>
          <Fact label="Relayer" note={health ? `its clock reads ${formatClock(health.serverTime, { seconds: true, zone: true, timeZone })}` : undefined}>
            {health ? "answering" : waiting ? <Skeleton width="6rem" height="1em" inline /> : <span className={styles.attention}>not answering</span>}
          </Fact>
          <Fact label="Venue" note={health ? (simulated ? "a stand-in for the exchange, run beside the relayer" : "the exchange's test environment; no real orders") : undefined}>
            {health ? (
              health.venueConnected ? (
                `${simulated ? "simulated venue" : "exchange sandbox"}, connected`
              ) : (
                <span className={styles.attention}>{`${simulated ? "simulated venue" : "exchange sandbox"}, not connected`}</span>
              )
            ) : (
              placeholder("11rem")
            )}
          </Fact>
          <Fact label="New orders" note={health?.paused.place ? "the program refuses new orders until this is lifted" : undefined}>
            {health ? health.paused.place ? <span className={styles.attention}>paused</span> : "accepted" : placeholder("5rem")}
          </Fact>
          <Fact label="Fills" note={health?.paused.fill ? "open orders wait; an order that expires can be reclaimed in full" : undefined}>
            {health ? health.paused.fill ? <span className={styles.attention}>paused</span> : "running" : placeholder("5rem")}
          </Fact>
          <Fact
            label="Solana clock"
            note={health ? (drift === 0 ? "in step with the relayer's clock" : `${seconds(Math.abs(drift))} ${drift > 0 ? "behind" : "ahead of"} the relayer's clock; order and redemption deadlines use this one`) : undefined}
          >
            {health ? <span className={styles.mono}>{formatClock(health.chainTime * 1000, { seconds: true, zone: true, timeZone })}</span> : placeholder("9rem")}
          </Fact>
          <Fact label="Relayer SOL" note="pays for recording fills, refunds and new markets on Solana">
            {status ? <span className={styles.mono}>{formatSol(BigInt(status.relayerLamports))}</span> : placeholder("5rem")}
          </Fact>
        </dl>
      </Section>

      <Section
        id="reconciliation"
        title="Reconciliation"
        note="For every market that is not settled yet, the tokens on Solana must match the operator's position at the venue: YES supply minus NO supply, plus fills in flight and operator inventory. Quantities are in contracts; NO counts as negative."
      >
        {status === null ? (
          <p className={styles.emptyLine}>{waiting || !offline ? "Reading the relayer's books." : "Not known while the relayer is not answering."}</p>
        ) : status.markets.length === 0 ? (
          <p className={styles.emptyLine}>No market is open or waiting for its result right now. A market is listed here from the moment it is created on Solana until it is settled.</p>
        ) : (
          <RowList label="Reconciliation by market" columns={RECONCILE}>
            {status.markets.map((row) => {
              const market = markets.find((candidate) => candidate.symbol === row.symbol);
              const figure = (key: string, units: bigint, signed: boolean) => (
                <span key={key} className={`${styles.figure} ${units === 0n ? styles.zero : ""}`}>
                  {signed ? signedContracts(units) : formatContracts(units)}
                </span>
              );
              return (
                <Row
                  key={row.symbol}
                  cells={[
                    <div key="market" className={styles.market}>
                      <span className={styles.marketTitle}>{market ? marketTitle(market) : "Market no longer listed"}</span>
                      <span className={styles.sub}>
                        {market ? `${market.expiresAt > nowMs ? "closes" : "closed"} ${formatClock(market.expiresAt, { zone: true, timeZone })}${market.resolution ? `, result ${market.resolution.toUpperCase()}` : ""}` : row.symbol}
                      </span>
                    </div>,
                    figure("yes", BigInt(row.yesSupply), false),
                    figure("no", BigInt(row.noSupply), false),
                    figure("venue", BigInt(row.venueNet), true),
                    figure("flight", BigInt(row.inFlight), true),
                    figure("house", BigInt(row.houseInventory), true),
                    <span key="check" className={`${styles.verdict} ${row.balanced ? styles.fine : styles.wrong}`}>
                      {row.balanced ? "balanced" : "not balanced"}
                    </span>,
                  ]}
                />
              );
            })}
          </RowList>
        )}
      </Section>

      <Section id="treasury" title="Treasury check">
        {status === null ? (
          <p className={styles.emptyLine}>{waiting || !offline ? "Reading the relayer's books." : "Not known while the relayer is not answering."}</p>
        ) : (
          <div className={styles.treasury}>
            <div className={styles.treasuryReceipt}>
              <Receipt title="Operator funds" note="Test dollars. No value.">
                <ReceiptLine label={simulated ? "Cash at the simulated venue" : "Cash at the venue"}>{formatDollars(BigInt(status.solvency.venueCashMicros))}</ReceiptLine>
                <ReceiptLine label="Treasury on Solana">{formatDollars(BigInt(status.solvency.treasuryMicros))}</ReceiptLine>
                <ReceiptLine label="Could be required">{formatDollars(BigInt(status.solvency.requiredMicros))}</ReceiptLine>
                <ReceiptLine label="Result" total>
                  <span className={status.solvency.ok ? styles.fine : styles.wrong}>{status.solvency.ok ? "covered" : "not covered"}</span>
                </ReceiptLine>
              </Receipt>
            </div>
            <div className={styles.prose}>
              <p>
                Every winning token pays $1.00, and the settler pays that into a market's vault when it settles. This check compares what the operator has, at the venue and in the treasury on Solana, with the most that open markets and settlements not yet redeemed could require.
              </p>
            </div>
          </div>
        )}
      </Section>

      <Section id="alerts" title="Recent alerts" note="The relayer raises one when something needs a person: a fill it could not record on Solana, or books that do not balance.">
        {status === null ? (
          <p className={styles.emptyLine}>{waiting || !offline ? "Reading the relayer's alerts." : "Not known while the relayer is not answering."}</p>
        ) : status.alerts.length === 0 ? (
          <p className={styles.emptyLine}>No alerts.</p>
        ) : (
          <RowList label="Recent alerts" columns={ALERTS}>
            {status.alerts.map((alert) => (
              <Row
                key={`${alert.at}:${alert.kind}:${alert.orderAddress ?? ""}`}
                cells={[
                  <div key="alert" className={styles.alert}>
                    <span className={styles.alertKind}>{alert.kind.replace(/_/g, " ").replace(/^./, (first) => first.toUpperCase())}</span>
                    {alert.detail && <span className={styles.alertDetail}>{alert.detail.replace(/^./, (first) => first.toUpperCase()).replace(/([^.])$/, "$1.")}</span>}
                  </div>,
                  <div key="when" className={styles.market} style={{ justifyItems: "inherit" }}>
                    <span className={styles.figure}>{formatClock(alert.at, { zone: true, timeZone })}</span>
                    {day(alert.at, timeZone) !== today && <span className={styles.sub}>{day(alert.at, timeZone)}</span>}
                  </div>,
                  alert.orderAddress ? (
                    <ExternalLink key="order" href={addressUrl(alert.orderAddress)} mono>
                      {shortAddress(alert.orderAddress)}
                    </ExternalLink>
                  ) : (
                    <span key="order" className={styles.sub}>
                      none
                    </span>
                  ),
                ]}
              />
            ))}
          </RowList>
        )}
      </Section>

      <Section id="addresses" title="Addresses" note="On Solana devnet. Each opens in the explorer.">
        <dl className={`${styles.ledger} ${styles.wideValue}`}>
          <AddressFact label="Program" address={addresses.program} note="holds every order's test dollars and mints the tokens" addressUrl={addressUrl} />
          <AddressFact label="Config" address={addresses.config} note="the program's settings: who the relayer and settler are, and the limits" addressUrl={addressUrl} />
          <AddressFact label="Test-dollar mint" address={addresses.stableMint} note="the test stablecoin every amount here is in" addressUrl={addressUrl} />
          <AddressFact label="Treasury" address={addresses.treasury} note="receives the cost and fee of every fill" addressUrl={addressUrl} />
          {health && <AddressFact label="Relayer" address={health.relayer} note="the key that records fills and refunds" addressUrl={addressUrl} />}
        </dl>
      </Section>
    </div>
  );
}
