"use client";

import { useMemo, useState, type ReactNode } from "react";
import { AccountMenu } from "@/components/shell/AccountMenu";
import { Footer } from "@/components/shell/Footer";
import { NetworkStripView } from "@/components/shell/NetworkStrip";
import { TopBar } from "@/components/shell/TopBar";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Countdown, CountdownView } from "@/components/ui/Countdown";
import { EmptyState } from "@/components/ui/EmptyState";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { Field } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { PriceButton } from "@/components/ui/PriceButton";
import { Receipt, ReceiptLine } from "@/components/ui/Receipt";
import { Row, RowList, type Column } from "@/components/ui/RowList";
import { SideToggle, type Side } from "@/components/ui/SideToggle";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stamp, STAMP_VALUES, type StampValue } from "@/components/ui/Stamp";
import { Timeline } from "@/components/ui/Timeline";
import { formatClock, formatStrike } from "@/features/markets/wording";
import { WelcomeView, type WelcomeState } from "@/features/onboarding/WelcomeView";
import { formatContracts, formatDollars, formatPrice, shortAddress } from "@/lib/format";
import { askPrices, buildFixtures, FIXTURE_USER, fixtureSignature } from "@/lib/relayer/fixtures";
import { ACCOUNT_SECTIONS, AccountGallery } from "./AccountGallery";
import { TRADING_SECTIONS, TradingGallery } from "./TradingGallery";
import styles from "./Gallery.module.css";

const SECTIONS = [
  ["tokens", "Colour and type"],
  ["button", "Button"],
  ["side-toggle", "Side toggle"],
  ["price-button", "Price button"],
  ["field", "Field"],
  ["stamp", "Stamp"],
  ["countdown", "Countdown"],
  ["row-list", "Row list"],
  ["notice", "Notice"],
  ["receipt", "Receipt"],
  ["timeline", "Order timeline"],
  ["empty-state", "Empty state"],
  ["skeleton", "Skeleton"],
  ["external-link", "External link"],
  ["network-strip", "Network strip"],
  ["top-bar", "Top bar"],
  ["account-menu", "Account menu"],
  ["footer", "Footer"],
  ["welcome", "Welcome screen"],
  ...TRADING_SECTIONS,
  ...ACCOUNT_SECTIONS,
] as const;

const COLOURS = [
  ["paper", "paper-raised", "paper-sunken", "rule", "rule-strong"],
  ["ink", "ink-2", "ink-3", "focus"],
  ["yes", "yes-strong", "yes-tint", "no", "no-strong", "no-tint"],
  ["positive", "positive-tint", "caution", "caution-tint", "negative", "negative-tint"],
] as const;

const TYPE = [
  ["2xl", "31px, the one number that matters", "9:41"],
  ["xl", "25px, page titles", "Bitcoin up or down in 15 minutes"],
  ["lg", "20px, section titles", "Your orders in this market"],
  ["base", "16px, body", "Tokens are minted only after the order fills."],
  ["sm", "14px, dense rows and helper text", "Anything unused is refunded."],
  ["xs", "12px, captions and stamps", "Held on Solana at 2:05:09 PM"],
] as const;

const EXPLORER = { cluster: "devnet", rpcUrl: "https://api.devnet.solana.com", explorerBase: "https://explorer.solana.com" } as const;
const txUrl = (signature: string) => `${EXPLORER.explorerBase}/tx/${signature}?cluster=devnet`;

const ORDER_STAMP: Record<string, StampValue> = {
  seen: "OPEN",
  submitting: "OPEN",
  venue_filled: "OPEN",
  venue_not_filled: "OPEN",
  venue_unknown: "OPEN",
  chain_filled: "FILLED",
  chain_cancelled: "REFUNDED",
  orphaned: "REFUNDED",
  failed: "EXPIRED",
};

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section id={id} className={styles.section} aria-labelledby={`${id}-title`}>
      <header className={styles.sectionHead}>
        <h2 id={`${id}-title`}>{title}</h2>
        {note && <p className={styles.sectionNote}>{note}</p>}
      </header>
      {children}
    </section>
  );
}

function Specimen({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <figure className={`${styles.specimen} ${wide ? styles.wide : ""}`}>
      <figcaption className={styles.caption}>{label}</figcaption>
      <div className={styles.stage}>{children}</div>
    </figure>
  );
}

export function Gallery({ anchorMs }: { anchorMs: number }) {
  const fixtures = useMemo(() => buildFixtures(anchorMs), [anchorMs]);
  const [side, setSide] = useState<Side>("YES");
  const [quantity, setQuantity] = useState("5.00");
  const [limit, setLimit] = useState("0.57");
  const [email, setEmail] = useState("");
  const signature = fixtureSignature("gallery");
  const wallet = { address: FIXTURE_USER, embedded: true };
  const external = { address: FIXTURE_USER, embedded: false };

  const marketColumns: Column[] = [
    { id: "market", header: "Market", primary: true },
    { id: "beat", header: "Price to beat", align: "right", width: "8.5rem" },
    { id: "closes", header: "Closes in", align: "right", width: "7rem" },
    { id: "buy", header: "Buy", actions: true, width: "9.5rem" },
  ];
  const orderColumns: Column[] = [
    { id: "order", header: "Order", primary: true },
    { id: "limit", header: "Limit", align: "right", width: "4.5rem" },
    { id: "paid", header: "Paid", align: "right", width: "5.5rem" },
    { id: "placed", header: "Placed", align: "right", width: "7rem" },
    { id: "status", header: "Status", width: "6.5rem" },
  ];

  const welcomeStates: Array<[string, WelcomeState, typeof wallet]> = [
    ["Ready", { kind: "ready" }, wallet],
    ["Ready, with a connected wallet", { kind: "ready" }, external],
    ["Working, step one", { kind: "working", step: "login" }, wallet],
    ["Working, step two", { kind: "working", step: "funding" }, wallet],
    ["Done", { kind: "done", signature, at: formatClock(anchorMs, { seconds: true, zone: true, timeZone: "UTC" }) }, wallet],
    ["Already registered", { kind: "already" }, wallet],
    ["Not set up yet", { kind: "not_bootstrapped" }, wallet],
    ["Error, with a retry", { kind: "error", message: "The transaction failed and nothing was sent. The faucet account is empty. You can try again." }, wallet],
    ["Loading", { kind: "loading" }, wallet],
  ];

  return (
    <div className={styles.page}>
      <nav className={styles.index} aria-label="Sections">
        <p className={styles.indexTitle}>Gallery</p>
        <ol>
          {SECTIONS.map(([id, title]) => (
            <li key={id}>
              <a href={`#${id}`}>{title}</a>
            </li>
          ))}
        </ol>
      </nav>

      <main className={styles.content}>
        <header className={styles.pageHead}>
          <h1>Component gallery</h1>
          <p>Every primitive and shell part in every state, fed by fixtures. Development only.</p>
        </header>

        <Section id="tokens" title="Colour and type" note="Paper and ink. Colour stays under a tenth of any screen.">
          <div className={styles.swatches}>
            {COLOURS.map((group) => (
              <div key={group[0]} className={styles.swatchRow}>
                {group.map((name) => (
                  <div key={name} className={styles.swatch}>
                    <span className={styles.chip} style={{ background: `var(--${name})` }} />
                    <span className={styles.swatchName}>{name}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className={styles.typeScale}>
            {TYPE.map(([name, use, sample]) => (
              <div key={name} className={styles.typeRow}>
                <span className={styles.typeName}>{name}</span>
                <span style={{ fontSize: `var(--text-${name})`, lineHeight: `var(--leading-${name})`, fontWeight: name === "xl" || name === "lg" ? 600 : name === "2xl" ? 500 : 400 }} className={name === "2xl" || name === "xs" ? "mono" : undefined}>
                  {sample}
                </span>
                <span className={styles.typeUse}>{use}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section id="button" title="Button" note="One primary button per view. A busy button keeps its width and names what it is doing.">
          <div className={styles.grid}>
            <Specimen label="Primary">
              <Button variant="primary">Place order · hold $2.97</Button>
            </Specimen>
            <Specimen label="Primary, busy">
              <Button variant="primary" busy="Signing">
                Place order · hold $2.97
              </Button>
            </Specimen>
            <Specimen label="Primary, disabled">
              <Button variant="primary" disabled>
                Place order · hold $2.97
              </Button>
            </Specimen>
            <Specimen label="Secondary">
              <Button>Place another order</Button>
            </Specimen>
            <Specimen label="Secondary, busy">
              <Button busy="Sending">Place another order</Button>
            </Specimen>
            <Specimen label="Secondary, disabled">
              <Button disabled>Place another order</Button>
            </Specimen>
            <Specimen label="Quiet">
              <Button variant="quiet">Show receipt</Button>
            </Specimen>
            <Specimen label="Quiet, disabled">
              <Button variant="quiet" disabled>
                Show receipt
              </Button>
            </Specimen>
            <Specimen label="In a row, 32px">
              <span className={styles.inline}>
                <Button size="row">Reclaim</Button>
                <Button size="row" variant="primary">
                  Redeem
                </Button>
                <Button size="row" busy="Signing">
                  Reclaim
                </Button>
              </span>
            </Specimen>
            <Specimen label="As a link">
              <ButtonLink href="#button" variant="primary">
                Go to markets
              </ButtonLink>
            </Specimen>
          </div>
        </Section>

        <Section id="side-toggle" title="Side toggle" note="A radio group: Tab reaches it, the arrow keys move between YES and NO.">
          <div className={styles.grid}>
            <Specimen label={`Selected: ${side}`}>
              <div className={styles.ticketWidth}>
                <SideToggle value={side} onChange={setSide} />
              </div>
            </Specimen>
            <Specimen label="NO selected, with ask prices">
              <div className={styles.ticketWidth}>
                <SideToggle value="NO" onChange={() => {}} detail={{ YES: "$0.57", NO: "$0.45" }} label="Side, with prices" />
              </div>
            </Specimen>
            <Specimen label="Disabled">
              <div className={styles.ticketWidth}>
                <SideToggle value="YES" onChange={() => {}} disabled label="Side, disabled" />
              </div>
            </Specimen>
          </div>
        </Section>

        <Section id="price-button" title="Price button" note="The only place the cents shorthand is used.">
          <div className={styles.grid}>
            <Specimen label="YES and NO">
              <span className={styles.inline}>
                <PriceButton side="YES" px={5_700n} subject="Bitcoin up" />
                <PriceButton side="NO" px={4_500n} subject="Bitcoin up" />
              </span>
            </Specimen>
            <Specimen label="One side without an offer">
              <span className={styles.inline}>
                <PriceButton side="YES" px={9_900n} />
                <PriceButton side="NO" px={null} />
              </span>
            </Specimen>
            <Specimen label="No offers">
              <span className={styles.inline}>
                <PriceButton side="YES" px={null} />
                <PriceButton side="NO" px={null} />
              </span>
            </Specimen>
          </div>
        </Section>

        <Section id="field" title="Field" note="Numbers are mono and right aligned, with the unit inside the control.">
          <div className={styles.grid}>
            <Specimen label="Quantity, with steppers">
              <div className={styles.ticketWidth}>
                <Field
                  label="Quantity"
                  numeric
                  suffix="contracts"
                  value={quantity}
                  onChange={setQuantity}
                  helper="Minimum 0.01. Each contract pays $1.00 if you are right."
                  stepper={{
                    onDecrement: () => setQuantity((q) => Math.max(0.01, Number(q) - 1).toFixed(2)),
                    onIncrement: () => setQuantity((q) => (Number(q) + 1).toFixed(2)),
                  }}
                />
              </div>
            </Specimen>
            <Specimen label="Limit price">
              <div className={styles.ticketWidth}>
                <Field label="Limit price" numeric prefix="$" value={limit} onChange={setLimit} helper="The most you pay per contract. Best offer is $0.57." />
              </div>
            </Specimen>
            <Specimen label="Error">
              <div className={styles.ticketWidth}>
                <Field label="Quantity" numeric suffix="contracts" value="0.001" onChange={() => {}} error="Minimum is 0.01 contracts." />
              </div>
            </Specimen>
            <Specimen label="Disabled">
              <div className={styles.ticketWidth}>
                <Field label="Limit price" numeric prefix="$" value="0.57" onChange={() => {}} disabled helper="Trading is paused." />
              </div>
            </Specimen>
            <Specimen label="Text, with a placeholder">
              <div className={styles.ticketWidth}>
                <Field label="Email" type="email" placeholder="you@example.com" value={email} onChange={setEmail} />
              </div>
            </Specimen>
          </div>
        </Section>

        <Section id="stamp" title="Stamp" note="Each value has one fixed colour. A refund is ink, not red.">
          <div className={styles.stamps}>
            {STAMP_VALUES.map((value) => (
              <Stamp key={value} value={value} />
            ))}
          </div>
        </Section>

        <Section id="countdown" title="Countdown" note="Caution colour and the word closing in the last two minutes.">
          <div className={styles.grid}>
            <Specimen label="Running">
              <CountdownView label="closes in" remainingMs={581_000} />
            </Specimen>
            <Specimen label="Above an hour">
              <CountdownView label="opens in" remainingMs={3_723_000} />
            </Specimen>
            <Specimen label="Last two minutes">
              <CountdownView label="closes in" remainingMs={95_000} />
            </Specimen>
            <Specimen label="At zero">
              <CountdownView label="closes in" remainingMs={0} />
            </Specimen>
            <Specimen label="Display size">
              <CountdownView label="closes in" remainingMs={581_000} size="display" />
            </Specimen>
            <Specimen label="Display size, closing">
              <CountdownView label="order expires in" remainingMs={38_000} size="display" />
            </Specimen>
            <Specimen label="Live, ticking">
              <Countdown label="closes in" to={fixtures.markets[0]?.expiresAt ?? anchorMs} />
            </Specimen>
            <Specimen label="Before the first tick">
              <CountdownView label="closes in" remainingMs={null} />
            </Specimen>
          </div>
        </Section>

        <Section id="row-list" title="Row list" note="The ledger pattern. Rows are 56px at least and stack into two lines on a narrow screen.">
          <Specimen label="Markets, from fixtures" wide>
            <RowList label="Markets" columns={marketColumns}>
              {fixtures.markets.slice(0, 3).map((market) => {
                const asks = askPrices(market);
                return (
                  <Row
                    key={market.symbol}
                    cells={[
                      <div key="m" className={styles.market}>
                        <span className={styles.underlying}>{market.underlying}</span>
                        <span className={styles.marketTitle}>{market.title}</span>
                      </div>,
                      market.strike ? (
                        <span key="b" className="mono">{formatStrike(market.strike)}</span>
                      ) : (
                        <span key="b" className={styles.pending}>
                          set at start
                        </span>
                      ),
                      market.startsAt > anchorMs ? (
                        <CountdownView key="c" label="opens in" remainingMs={market.startsAt - anchorMs} />
                      ) : (
                        <CountdownView key="c" label="" remainingMs={market.expiresAt - anchorMs} />
                      ),
                      <>
                        <PriceButton side="YES" px={asks.yes} subject={market.title} />
                        <PriceButton side="NO" px={asks.no} subject={market.title} />
                      </>,
                    ]}
                  />
                );
              })}
            </RowList>
          </Specimen>
          <Specimen label="Orders in every state, from fixtures" wide>
            <RowList label="Orders" columns={orderColumns}>
              {fixtures.orders.map((order) => (
                <Row
                  key={order.address}
                  cells={[
                    <div key="o" className={styles.order}>
                      <span className={order.side === "YES" ? styles.yes : styles.no}>{order.side}</span>
                      <span className={`mono ${styles.quantity}`}>{formatContracts(BigInt(order.units))}</span>
                      <span className={styles.orderMarket}>{fixtures.markets.find((m) => m.symbol === order.symbol)?.title}</span>
                    </div>,
                    <span key="l" className="mono">
                      {formatPrice(BigInt(order.limitPx))}
                    </span>,
                    <span key="p" className="mono">
                      {order.state === "chain_filled" ? formatDollars(BigInt(order.amountMicros) + BigInt(order.feeMicros)) : "–"}
                    </span>,
                    <span key="t" className={styles.time}>
                      {formatClock(order.createdAt, { zone: true, timeZone: "UTC" })}
                    </span>,
                    <Stamp key="s" value={ORDER_STAMP[order.state] ?? "OPEN"} />,
                  ]}
                />
              ))}
            </RowList>
          </Specimen>
          <Specimen label="Loading" wide>
            <RowList label="Markets, loading" columns={marketColumns}>
              {[0, 1].map((row) => (
                <Row
                  key={row}
                  cells={[
                    <Skeleton key="m" width="16rem" height="1.2rem" />,
                    <Skeleton key="b" width="6rem" height="1.2rem" />,
                    <Skeleton key="c" width="3rem" height="1.2rem" />,
                    <>
                      <Skeleton width="4.5rem" height="44px" />
                      <Skeleton width="4.5rem" height="44px" />
                    </>,
                  ]}
                />
              ))}
            </RowList>
          </Specimen>
        </Section>

        <Section id="notice" title="Notice" note="Placed where the problem is. No floating toasts.">
          <div className={styles.stack}>
            <Notice tone="caution" title="The relayer is offline" action={<Button size="row">Check again</Button>}>
              New orders cannot be filled right now. Orders you already placed are safe and can be reclaimed once they expire.
            </Notice>
            <Notice tone="caution" title="Your wallet is on another network">
              Switch it to devnet to sign. In Phantom, turn on Testnet Mode under Settings, Developer Settings.
            </Notice>
            <Notice title="Trading is paused">New orders are not accepted for the moment. Redeeming and reclaiming still work.</Notice>
            <Notice tone="negative" title="The order was not placed" action={<Button size="row">Try again</Button>}>
              The program refused the transaction: TooCloseToClose (6011). This market closes in under a minute; pick the next one.
            </Notice>
            <Notice tone="positive" title="Redeemed">
              5.00 YES tokens were burned and $5.00 in test dollars arrived in your wallet.
            </Notice>
          </div>
        </Section>

        <Section id="receipt" title="Receipt" note="Dotted leaders, values in mono, totals under a dashed rule.">
          <div className={styles.grid}>
            <Specimen label="A filled order">
              <div className={styles.ticketWidth}>
                <Receipt title="Order receipt" mark={<Stamp value="FILLED" />} note="Test dollars. No value.">
                  <ReceiptLine label="Bitcoin up in 15 minutes">YES</ReceiptLine>
                  <ReceiptLine label="Quantity">5.00 contracts</ReceiptLine>
                  <ReceiptLine label="Limit price">$0.57</ReceiptLine>
                  <ReceiptLine label="Filled at">$0.56</ReceiptLine>
                  <ReceiptLine label="Cost">$2.80</ReceiptLine>
                  <ReceiptLine label="Venue fee">$0.09</ReceiptLine>
                  <ReceiptLine label="Refunded">$0.08</ReceiptLine>
                  <ReceiptLine label="Minted">
                    <ExternalLink href={txUrl(signature)} mono>
                      {shortAddress(signature)}
                    </ExternalLink>
                  </ReceiptLine>
                  <ReceiptLine label="Total paid" total>
                    $2.89
                  </ReceiptLine>
                </Receipt>
              </div>
            </Specimen>
            <Specimen label="An order that did not fill">
              <div className={styles.ticketWidth}>
                <Receipt title="Order receipt" mark={<Stamp value="REFUNDED" />} note="There were no offers at or below your limit before the order expired, so nothing was bought.">
                  <ReceiptLine label="Ether up in 15 minutes">NO</ReceiptLine>
                  <ReceiptLine label="Quantity">4.00 contracts</ReceiptLine>
                  <ReceiptLine label="Limit price">$0.40</ReceiptLine>
                  <ReceiptLine label="Held">$1.69</ReceiptLine>
                  <ReceiptLine label="Refund">
                    <ExternalLink href={txUrl(signature)} mono>
                      {shortAddress(signature)}
                    </ExternalLink>
                  </ReceiptLine>
                  <ReceiptLine label="Refunded" total>
                    $1.69
                  </ReceiptLine>
                </Receipt>
              </div>
            </Specimen>
            <Specimen label="A summary on a ticket, perforated below">
              <div className={styles.ticketWidth}>
                <Receipt edge="bottom" note="Anything unused is refunded.">
                  <ReceiptLine label="Cost at limit">$2.85</ReceiptLine>
                  <ReceiptLine label="Fee cap">$0.12</ReceiptLine>
                  <ReceiptLine label="Total held" total>
                    $2.97
                  </ReceiptLine>
                </Receipt>
              </div>
            </Specimen>
          </div>
        </Section>

        <Section id="timeline" title="Order timeline" note="Replaces the ticket after an order is sent. A step that did not happen is described in words.">
          <div className={styles.grid}>
            <Specimen label="Waiting for the venue">
              <div className={styles.timelineWidth}>
                <Timeline
                  label="Order progress"
                  steps={[
                    { id: "held", status: "done", title: "Held on Solana", description: "$2.97 in test dollars is held by the program.", time: "14:05:09 UTC", link: <ExternalLink href={txUrl(signature)} mono>{shortAddress(signature)}</ExternalLink> },
                    { id: "sent", status: "current", title: "Sent to the venue", description: "The relayer is placing a fill-or-kill order for 5.00 YES at $0.57." },
                    { id: "filled", status: "pending", title: "Filled" },
                    { id: "minted", status: "pending", title: "Tokens minted" },
                  ]}
                />
              </div>
            </Specimen>
            <Specimen label="Filled and minted">
              <div className={styles.timelineWidth}>
                <Timeline
                  label="Order progress, filled"
                  steps={[
                    { id: "held", status: "done", title: "Held on Solana", description: "$2.97 in test dollars was held by the program.", time: "14:05:09 UTC", link: <ExternalLink href={txUrl(signature)} mono>{shortAddress(signature)}</ExternalLink> },
                    { id: "sent", status: "done", title: "Sent to the venue", description: "Fill-or-kill order for 5.00 YES at $0.57.", time: "14:05:11 UTC" },
                    { id: "filled", status: "done", title: "Filled", description: "5.00 contracts at $0.56, fee $0.09.", time: "14:05:12 UTC" },
                    { id: "minted", status: "done", title: "Tokens minted", description: "5.00 YES tokens are in your wallet. $0.08 was refunded.", time: "14:05:14 UTC", link: <ExternalLink href={txUrl(signature)} mono>{shortAddress(signature)}</ExternalLink> },
                  ]}
                />
              </div>
            </Specimen>
            <Specimen label="Not filled, refunded">
              <div className={styles.timelineWidth}>
                <Timeline
                  label="Order progress, not filled"
                  steps={[
                    { id: "held", status: "done", title: "Held on Solana", description: "$1.69 in test dollars was held by the program.", time: "14:05:09 UTC", link: <ExternalLink href={txUrl(signature)} mono>{shortAddress(signature)}</ExternalLink> },
                    { id: "sent", status: "done", title: "Sent to the venue", description: "Fill-or-kill order for 4.00 NO at $0.40.", time: "14:05:11 UTC" },
                    { id: "filled", status: "skipped", title: "Not filled", description: "There were no offers at or below $0.40, so the venue cancelled the order. Nothing was bought.", time: "14:05:12 UTC" },
                    { id: "minted", status: "done", title: "Refunded", description: "The full $1.69 is back in your wallet.", time: "14:05:15 UTC", link: <ExternalLink href={txUrl(signature)} mono>{shortAddress(signature)}</ExternalLink> },
                  ]}
                />
              </div>
            </Specimen>
          </div>
        </Section>

        <Section id="empty-state" title="Empty state" note="One sentence and one action. No illustration.">
          <div className={styles.stack}>
            <EmptyState action={<ButtonLink href="#empty-state">See markets</ButtonLink>}>No positions yet. Pick a market to buy your first outcome tokens.</EmptyState>
            <EmptyState>No market is open right now. The next fifteen-minute window opens shortly.</EmptyState>
          </div>
        </Section>

        <Section id="skeleton" title="Skeleton" note="Still blocks with the final layout's dimensions. No shimmer.">
          <div className={styles.stack}>
            <Skeleton width="14rem" height="1.95rem" />
            <Skeleton width="100%" height="56px" />
            <Skeleton width="100%" height="56px" />
            <p>
              Balance <Skeleton inline width="5.5rem" height="1.1em" />
            </p>
          </div>
        </Section>

        <Section id="external-link" title="External link" note="Every on-chain step links to its transaction.">
          <div className={styles.stack}>
            <p>
              Transaction{" "}
              <ExternalLink href={txUrl(signature)} mono>
                {shortAddress(signature)}
              </ExternalLink>
            </p>
            <p>
              <ExternalLink href="https://explorer.solana.com/?cluster=devnet">Solana Explorer, devnet</ExternalLink>
            </p>
          </div>
        </Section>

        <Section id="network-strip" title="Network strip" note="Fixed at the top of every page, as it is on this one. It cannot be dismissed, and it names the venue the relayer reports.">
          <div className={styles.stack}>
            <Specimen label="The relayer trades on the exchange sandbox" wide>
              <div className={styles.frame}>
                <NetworkStripView venue="sandbox" fixed={false} />
              </div>
            </Specimen>
            <Specimen label="The relayer runs against a simulated venue" wide>
              <div className={styles.frame}>
                <NetworkStripView venue="mock" fixed={false} />
              </div>
            </Specimen>
          </div>
        </Section>

        <Section id="top-bar" title="Top bar">
          <div className={styles.stack}>
            <Specimen label="Logged in, on Markets" wide>
              <div className={styles.frame}>
                <TopBar pathname="/markets" showNav balanceMicros={1_000_000_000n} account={<AccountMenu address={FIXTURE_USER} embedded faucet={{ kind: "idle" }} onGetTestFunds={() => {}} onLogout={() => {}} />} />
              </div>
            </Specimen>
            <Specimen label="Logged in, on a market page, balance loading" wide>
              <div className={styles.frame}>
                <TopBar pathname="/markets/BTC" showNav balanceMicros={null} account={<AccountMenu address={FIXTURE_USER} embedded={false} faucet={{ kind: "idle" }} onGetTestFunds={() => {}} onLogout={() => {}} />} />
              </div>
            </Specimen>
            <Specimen label="Logged out" wide>
              <div className={styles.frame}>
                <TopBar pathname="/" showNav={false} account={<Button size="row">Log in</Button>} />
              </div>
            </Specimen>
          </div>
        </Section>

        <Section id="account-menu" title="Account menu" note="Arrow keys move through the items, Escape closes and returns focus to the button.">
          <div className={styles.menus}>
            <Specimen label="Open">
              <div className={styles.menuStage}>
                <AccountMenu address={FIXTURE_USER} embedded faucet={{ kind: "idle" }} onGetTestFunds={() => {}} onLogout={() => {}} defaultOpen />
              </div>
            </Specimen>
            <Specimen label="Sending test funds">
              <div className={styles.menuStage}>
                <AccountMenu address={FIXTURE_USER} embedded={false} faucet={{ kind: "working" }} onGetTestFunds={() => {}} onLogout={() => {}} defaultOpen />
              </div>
            </Specimen>
            <Specimen label="Test funds sent">
              <div className={styles.menuStage}>
                <AccountMenu address={FIXTURE_USER} embedded faucet={{ kind: "done", text: "Sent $1,000.00 in test dollars and 0.03 devnet SOL." }} onGetTestFunds={() => {}} onLogout={() => {}} defaultOpen />
              </div>
            </Specimen>
            <Specimen label="Top-up refused">
              <div className={styles.menuStage}>
                <AccountMenu address={FIXTURE_USER} embedded faucet={{ kind: "error", text: "One top-up per ten minutes. Try again in 4 minutes." }} onGetTestFunds={() => {}} onLogout={() => {}} defaultOpen />
              </div>
            </Specimen>
          </div>
        </Section>

        <Section id="footer" title="Footer">
          <div className={`${styles.frame} ${styles.footerFrame}`}>
            <Footer />
          </div>
        </Section>

        <Section id="welcome" title="Welcome screen" note="The first-run screen in each of its states.">
          <div className={styles.stack}>
            {welcomeStates.map(([label, state, who]) => (
              <Specimen key={label} label={label} wide>
                <div className={styles.screen}>
                  <WelcomeView state={state} wallet={who} balances={{ stableMicros: 1_000_000_000n, lamports: 50_000_000n }} txUrl={txUrl} onStart={() => {}} />
                </div>
              </Specimen>
            ))}
          </div>
        </Section>

        <TradingGallery anchorMs={anchorMs} Section={Section} Specimen={Specimen} />
        <AccountGallery anchorMs={anchorMs} Section={Section} Specimen={Specimen} />
      </main>
    </div>
  );
}
