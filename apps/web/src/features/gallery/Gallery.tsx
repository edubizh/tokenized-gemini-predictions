"use client";

import { useState, type ReactNode } from "react";
import { COLORS, contrast, ground, MIXES, PAIRINGS, THEME, type ColorName } from "@/app/theme";
import { AccountMenu } from "@/components/shell/AccountMenu";
import { FooterView } from "@/components/shell/Footer";
import { Navbar } from "@/components/shell/Navbar";
import { ProblemView } from "@/components/shell/Problem";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Countdown, CountdownView } from "@/components/ui/Countdown";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { Fact, Facts } from "@/components/ui/Facts";
import { Field } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { Panel } from "@/components/ui/Panel";
import { PriceButton } from "@/components/ui/PriceButton";
import { Row, RowList, type Column } from "@/components/ui/RowList";
import { Segmented } from "@/components/ui/Segmented";
import { Skeleton } from "@/components/ui/Skeleton";
import { Timeline } from "@/components/ui/Timeline";
import { formatContracts, formatDollars, shortAddress } from "@/lib/format";
import styles from "./Gallery.module.css";

const SECTIONS = [
  ["palette", "Palette"],
  ["contrast", "Contrast"],
  ["type", "Type"],
  ["button", "Button"],
  ["yes-no", "Yes and No"],
  ["segmented", "Segmented"],
  ["field", "Field"],
  ["badge", "Badge"],
  ["notice", "Notice"],
  ["panel", "Panel and Facts"],
  ["row-list", "RowList"],
  ["timeline", "Timeline"],
  ["countdown", "Countdown"],
  ["small", "ExternalLink and Skeleton"],
  ["shell", "Shell"],
] as const;

const ROLES: Record<ColorName, string> = {
  forest: "All text. The primary action. A selected neutral choice.",
  jade: "Prices, Yes, live, selected, done, the focus ring.",
  peach: "The page. The hovered row on a surface.",
  white: "Surfaces and fields. Text on forest and on jade.",
  "forest-soft": "Secondary text",
  edge: "Control boundaries",
  line: "Hairlines, skeletons",
  "forest-hover": "Forest under the pointer",
  "jade-hover": "Jade under the pointer",
  "jade-tint": "Yes at rest, positive",
  "jade-tint-hover": "Yes under the pointer",
  clay: "Errors only",
  "clay-tint": "Error notice",
};

const TYPE = [
  ["2xl", "600", "32px / 1.15", "57¢"],
  ["xl", "600", "24px / 1.25", "Bitcoin above $66,000 on November 15?"],
  ["lg", "600", "20px / 1.3", "Your positions"],
  ["base", "400", "16px / 1.5", "Tokens are minted only after the order fills."],
  ["sm", "400", "14px / 1.45", "Closes in 12:41 · $90,173 volume"],
  ["xs", "500", "12px / 1.35", "Solana devnet · test funds"],
] as const;

const ADDRESS = "8rj8Qk3mV7cLwq9Yt2HfZxN5uBd4sEaPo6GiTnRyDK8p";
const SIGNATURE = "5Kd3NBUAdUnhyzqZ1mVfGq3oZ5mZ1x8Jq7Y2rQ9fWb6uT4cLxPa9sHv2EoRi7nMw3yDgCk8tJbFz6uXe1AhVq9fQz";
const txUrl = (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
const tx = <ExternalLink href={txUrl(SIGNATURE)}>{shortAddress(SIGNATURE)}</ExternalLink>;

const MINUTE = 60_000;
const MARKETS = [
  { id: "btc", title: "Bitcoin above $66,000 on November 15?", leftMs: 19 * 60 * MINUTE + 6 * MINUTE, volume: "$90,173", yes: 5700n, no: 4400n },
  { id: "sol", title: "Solana up in the next 15 minutes?", leftMs: 108_000, volume: "$3,204", yes: 350n, no: null },
] as const;

const MARKET_COLUMNS: Column[] = [
  { id: "market", header: "Market", primary: true },
  { id: "left", header: "Time left", align: "right", width: "6.5rem" },
  { id: "volume", header: "Volume", align: "right", width: "6rem" },
  { id: "buy", header: "Buy", actions: true, width: "12.5rem" },
];

const POSITION_COLUMNS: Column[] = [
  { id: "position", header: "Position", primary: true },
  { id: "quantity", header: "Contracts", align: "right", width: "6rem" },
  { id: "value", header: "Value", align: "right", width: "6rem" },
  { id: "status", header: "Status", width: "7rem" },
  { id: "action", header: "Action", actions: true, width: "7rem" },
];

const CONTRAST_COLUMNS: Column[] = [
  { id: "pair", header: "Pairing", primary: true },
  { id: "ratio", header: "Ratio", align: "right", width: "4.5rem" },
  { id: "needs", header: "Needs", align: "right", width: "4rem" },
  { id: "use", header: "Used for", width: "minmax(0, 24rem)" },
];

const BUY_SELL = [
  { value: "buy", label: "Buy" },
  { value: "sell", label: "Sell" },
] as const;

const noop = () => {};

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className={styles.sectionHead}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** One labelled example. `surface` draws it on white, as inside a Panel; otherwise it is on the page. */
function Specimen({ label, surface, wide, children }: { label: string; surface?: boolean; wide?: boolean; children: ReactNode }) {
  return (
    <figure className={`${styles.specimen} ${wide ? styles.wide : ""}`}>
      <figcaption className={styles.caption}>{label}</figcaption>
      {surface ? <Panel className={styles.stage}>{children}</Panel> : <div className={styles.stage}>{children}</div>}
    </figure>
  );
}

function Swatch({ name, large }: { name: ColorName; large?: boolean }) {
  const recipe = MIXES[name];
  return (
    <div className={large ? styles.swatchLarge : undefined}>
      <span className={styles.chip} style={{ background: COLORS[name] }} />
      <p className={styles.swatchName}>{name}</p>
      <p className={styles.swatchValue}>{COLORS[name]}</p>
      {recipe && <p className={styles.swatchNote}>{`${recipe[0]} ${recipe[1]}% in ${recipe[2]}`}</p>}
      <p className={styles.swatchNote}>{ROLES[name]}</p>
    </div>
  );
}

export function Gallery({ anchorMs }: { anchorMs: number }) {
  const [side, setSide] = useState<"yes" | "no">("yes");
  const [action, setAction] = useState<"buy" | "sell">("buy");
  const [quantity, setQuantity] = useState("5.00");

  return (
    <div className={styles.page}>
      <header>
        <h1>Design reference</h1>
        <p className={styles.lead}>Every part of the interface in its states, as docs/DESIGN.md describes it. Development only.</p>
        <nav aria-label="Sections">
          <ul className={styles.index}>
            {SECTIONS.map(([id, title]) => (
              <li key={id}>
                <a href={`#${id}`}>{title}</a>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <Section id="palette" title="Palette">
        <div className={styles.theme}>
          {THEME.map((name) => (
            <Swatch key={name} name={name} large />
          ))}
        </div>
        <div className={styles.derived}>
          {(Object.keys(COLORS) as ColorName[])
            .filter((name) => !(THEME as readonly string[]).includes(name))
            .map((name) => (
              <Swatch key={name} name={name} />
            ))}
        </div>
      </Section>

      <Section id="contrast" title="Contrast">
        <RowList label="Contrast of every pairing" columns={CONTRAST_COLUMNS}>
          {PAIRINGS.map((pair) => {
            const [text, on] = [COLORS[pair.text], ground(pair.on)];
            return (
              <Row
                key={`${pair.text}-${pair.on}`}
                cells={[
                  <span key="pair" className={styles.pair}>
                    <span className={styles.pairSample} style={{ background: on, color: text }}>
                      57¢
                    </span>
                    {pair.text} on {pair.on}
                  </span>,
                  contrast(text, on).toFixed(2),
                  String(pair.min),
                  <span key="use" className={styles.soft}>
                    {pair.use}
                  </span>,
                ]}
              />
            );
          })}
        </RowList>
      </Section>

      <Section id="type" title="Type">
        <Panel>
          {TYPE.map(([name, weight, size, sample]) => (
            <div key={name} className={styles.typeRow}>
              <span className={styles.typeName}>{name}</span>
              <span className={name === "2xl" ? styles.price : undefined} style={{ fontSize: `var(--text-${name})`, lineHeight: `var(--leading-${name})`, fontWeight: Number(weight) }}>
                {sample}
              </span>
              <span className={styles.typeUse}>
                {size} · {weight}
              </span>
            </div>
          ))}
        </Panel>
      </Section>

      <Section id="button" title="Button">
        <div className={styles.grid}>
          <Specimen label="Primary, secondary, quiet" surface>
            <Button variant="primary">Buy Yes · hold $2.92</Button>
            <Button>Place another order</Button>
            <Button variant="quiet">Show details</Button>
          </Specimen>
          <Specimen label="Busy and disabled">
            <Button variant="primary" busy="Check your wallet">
              Buy Yes · hold $2.92
            </Button>
            <Button disabled>Place another order</Button>
          </Specimen>
          <Specimen label="Compact, for rows and notices">
            <Button size="row" variant="primary">
              Redeem $5.00
            </Button>
            <Button size="row">Reclaim</Button>
            <Button size="row" variant="quiet">
              Details
            </Button>
          </Specimen>
        </div>
      </Section>

      <Section id="yes-no" title="Yes and No">
        <div className={styles.grid}>
          <Specimen label="PriceButton, and a side with no offer" surface>
            <PriceButton side="YES" px={5700n} href="#yes-no" subject="Bitcoin above $66,000" />
            <PriceButton side="NO" px={null} />
          </Specimen>
          <Specimen label="Chosen, in the trade panel (Segmented)" surface>
            <div className={styles.full}>
              <Segmented
                label="Side"
                value={side}
                onChange={setSide}
                stretch
                options={[
                  { value: "yes", label: "Yes", detail: "57¢", tone: "yes" },
                  { value: "no", label: "No", detail: "44¢", tone: "no" },
                ]}
              />
            </div>
          </Specimen>
        </div>
      </Section>

      <Section id="segmented" title="Segmented">
        <div className={styles.grid}>
          <Specimen label="Buy or Sell" surface>
            <Segmented label="Action" value={action} onChange={setAction} options={BUY_SELL} />
          </Specimen>
          <Specimen label="Disabled" surface>
            <Segmented label="Action, disabled" value={action} onChange={setAction} disabled options={BUY_SELL} />
          </Specimen>
        </div>
      </Section>

      <Section id="field" title="Field">
        <div className={styles.grid}>
          <Specimen label="Numeric, with a unit and steppers" surface>
            <div className={styles.full}>
              <Field label="Quantity" numeric suffix="contracts" value={quantity} onChange={setQuantity} helper="Minimum 0.01" stepper={{ onDecrement: noop, onIncrement: noop }} />
            </div>
          </Specimen>
          <Specimen label="Invalid" surface>
            <div className={styles.full}>
              <Field label="Quantity" numeric suffix="contracts" value="0" onChange={noop} error="Minimum is 0.01 contracts" />
            </div>
          </Specimen>
          <Specimen label="Something to know" surface>
            <div className={styles.full}>
              <Field label="Limit price" numeric suffix="¢" value="50" onChange={noop} warning="Below the best offer of 57¢: this order may not fill." />
            </div>
          </Specimen>
          <Specimen label="Disabled" surface>
            <div className={styles.full}>
              <Field label="Quantity" numeric suffix="contracts" value="5.00" onChange={noop} disabled />
            </div>
          </Specimen>
        </div>
      </Section>

      <Section id="badge" title="Badge">
        <Specimen label="Neutral, positive, negative, live" surface>
          <Badge>Open</Badge>
          <Badge tone="positive">Filled</Badge>
          <Badge tone="negative">Failed</Badge>
          <Badge tone="positive" dot>
            Live
          </Badge>
        </Specimen>
      </Section>

      <Section id="notice" title="Notice">
        <div className={styles.stack}>
          <Notice busy title="Waiting for your wallet" action={[<Button key="retry" size="row">Retry</Button>, <Button key="cancel" size="row" variant="quiet">Cancel</Button>]}>
            Approve the request in Phantom. If no window opened, press Retry.
          </Notice>
          <Notice tone="positive" title="Redeemed">
            5.00 Yes tokens were burned and $5.00 in test dollars arrived in your wallet.
          </Notice>
          <Notice tone="negative" title="The order was not placed" action={<Button size="row">Try again</Button>}>
            This market closes in under a minute, so the program refused the order. Nothing was held.
          </Notice>
        </div>
      </Section>

      <Section id="panel" title="Panel and Facts">
        <Specimen label="Facts, ending in a total">
          <Panel className={styles.full}>
            <h3 className="sr-only">Order summary</h3>
            <Facts>
              <Fact label="Cost at limit">$2.85</Fact>
              <Fact label="Fee, at most">$0.07</Fact>
              <Fact label="Token">
                <ExternalLink href={txUrl(SIGNATURE)}>{shortAddress(ADDRESS)}</ExternalLink>
              </Fact>
              <Fact label="Held until filled" total>
                $2.92
              </Fact>
            </Facts>
          </Panel>
        </Specimen>
      </Section>

      <Section id="row-list" title="RowList">
        <div className={styles.stack}>
          <RowList label="Markets" columns={MARKET_COLUMNS}>
            {MARKETS.map((market) => (
              <Row
                key={market.id}
                cells={[
                  <a key="market" href="#row-list" className={styles.rowTitle}>
                    {market.title}
                  </a>,
                  <CountdownView key="left" remainingMs={market.leftMs} label="" />,
                  market.volume,
                  <span key="buy" className={styles.rowActions}>
                    <PriceButton side="YES" px={market.yes} href="#row-list" subject={market.title} />
                    <PriceButton side="NO" px={market.no} href={market.no === null ? undefined : "#row-list"} subject={market.title} />
                  </span>,
                ]}
              />
            ))}
          </RowList>
          <RowList label="Positions" columns={POSITION_COLUMNS}>
            <Row
              cells={[
                <span key="position">
                  Ethereum above $1,700 <span className={styles.soft}>· Yes</span>
                </span>,
                formatContracts(200n),
                formatDollars(2_000_000n),
                <Badge key="status" tone="positive">
                  Redeemable
                </Badge>,
                <Button key="action" size="row" variant="primary">
                  Redeem
                </Button>,
              ]}
              detail={<p className={styles.rowDetail}>Settled Yes on Nov 14, 21:00 UTC. {tx}</p>}
            />
          </RowList>
        </div>
      </Section>

      <Section id="timeline" title="Timeline">
        <Specimen label="Done, skipped, current and pending">
          <Panel className={styles.full}>
            <Timeline
              label="Order progress"
              steps={[
                { id: "held", status: "done", title: "Held on Solana", description: "$2.92 in test dollars is held by the program.", time: "14:05:09 UTC", link: tx },
                { id: "fill", status: "skipped", title: "Not filled", description: "No offer at 50¢ or better before the order expired." },
                { id: "refund", status: "current", title: "Returning your funds", description: "The program sends the held amount back." },
                { id: "done", status: "pending", title: "Refunded in full" },
              ]}
            />
          </Panel>
        </Specimen>
      </Section>

      <Section id="countdown" title="Countdown">
        <div className={styles.grid}>
          <Specimen label="Live, minutes and seconds; hours; days" surface>
            <Countdown to={anchorMs + 12 * MINUTE + 41_000} label="closes in" />
            <CountdownView remainingMs={19 * 60 * MINUTE + 6 * MINUTE + 26_000} label="closes in" />
            <CountdownView remainingMs={3 * 24 * 60 * MINUTE + 4 * 60 * MINUTE} label="closes in" />
          </Specimen>
          <Specimen label="Last two minutes, over, and display size">
            <CountdownView remainingMs={68_000} label="closes in" />
            <CountdownView remainingMs={0} label="closes in" closedText="awaiting result" />
            <Countdown to={anchorMs + 9 * MINUTE + 41_000} label="closes in" size="display" announce />
          </Specimen>
        </div>
      </Section>

      <Section id="small" title="ExternalLink and Skeleton">
        <div className={styles.grid}>
          <Specimen label="A transaction" surface>
            {tx}
          </Specimen>
          <Specimen label="Skeleton" surface>
            <div className={styles.skeletons}>
              <Skeleton width="12rem" height="1.25rem" />
              <Skeleton width="100%" height="1rem" />
            </div>
          </Specimen>
        </div>
      </Section>

      <Section id="shell" title="Shell">
        <div className={styles.stack}>
          <Specimen label="Logged in, with the panel of the wallet control open" wide>
            <div className={`${styles.frame} ${styles.frameTall}`}>
              <Navbar
                inline
                pathname="/activity"
                cluster="devnet"
                balanceMicros={1_000_000_000n}
                account={<AccountMenu address={ADDRESS} embedded={false} faucet={{ kind: "done", text: "Sent $100.00 in test dollars." }} onGetTestFunds={noop} onLogout={noop} defaultOpen />}
              />
            </div>
          </Specimen>
          <Specimen label="Footer" wide>
            <div className={styles.frame}>
              <FooterView venue="sandbox" />
            </div>
          </Specimen>
          <Specimen label="A page with nothing to show" wide>
            <ProblemView kind="Page not found" title="There is nothing at this address" action={<ButtonLink href="#shell">Back to the markets</ButtonLink>}>
              The link may be mistyped, or it pointed to something this demo no longer keeps.
            </ProblemView>
          </Specimen>
        </div>
      </Section>
    </div>
  );
}
