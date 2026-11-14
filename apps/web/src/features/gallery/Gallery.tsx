"use client";

import { useState, type ReactNode } from "react";
import { cost, feeCap, parseUnits, PAYOUT_PER_UNIT } from "@outcome/relayer/money";
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
  ["shape", "Shape and space"],
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
  ["market", "A market, from these parts"],
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

/** What each colour was chosen against. The figures are computed here, not typed in. */
const CANDIDATES: ReadonlyArray<{ name: (typeof THEME)[number]; options: ReadonlyArray<{ hex: string; verdict: string }> }> = [
  {
    name: "forest",
    options: [
      { hex: "#1F3B2D", verdict: "The starting point. Reads as charcoal in small text." },
      { hex: COLORS.forest, verdict: "As dark, with more green in it, so a filled button is plainly forest green." },
      { hex: "#234534", verdict: "Greener, but secondary text made from it falls under 4.5 on the page." },
    ],
  },
  {
    name: "jade",
    options: [
      { hex: "#00A86B", verdict: "Classic jade. Cannot carry a price or a label at AA." },
      { hex: "#17A673", verdict: "The starting point. The same problem: under 3 on the page." },
      { hex: COLORS.jade, verdict: "The same hue, taken down until text on white, text on the page and white text on it all pass." },
    ],
  },
  {
    name: "peach",
    options: [
      { hex: "#FFF5EE", verdict: "Seashell. So near white that surfaces stop separating." },
      { hex: COLORS.peach, verdict: "Close to white, skin-like, and white surfaces still show on it without a border." },
      { hex: "#FBEEE4", verdict: "Separates well, but reads as sand, and jade on it fails." },
    ],
  },
];

const TYPE = [
  ["2xl", "600", "32px / 1.15", "57¢"],
  ["xl", "600", "24px / 1.25", "Bitcoin above $66,000 on November 15?"],
  ["lg", "600", "20px / 1.3", "Your positions"],
  ["base", "400", "16px / 1.5", "Tokens are minted only after the order fills."],
  ["sm", "400", "14px / 1.45", "Closes in 12:41 · $90,173 volume"],
  ["xs", "500", "12px / 1.35", "Solana devnet · test funds"],
] as const;

const RADII = [
  ["sm", "8px", "Small marks, skeletons"],
  ["md", "12px", "Every control"],
  ["lg", "20px", "Surfaces"],
] as const;

const SPACES = [4, 8, 12, 16, 24, 32, 48, 64] as const;

const ADDRESS = "8rj8Qk3mV7cLwq9Yt2HfZxN5uBd4sEaPo6GiTnRyDK8p";
const SIGNATURE = "5Kd3NBUAdUnhyzqZ1mVfGq3oZ5mZ1x8Jq7Y2rQ9fWb6uT4cLxPa9sHv2EoRi7nMw3yDgCk8tJbFz6uXe1AhVq9fQz";
const txUrl = (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;

const MINUTE = 60_000;
const MARKETS = [
  { id: "btc", title: "Bitcoin above $66,000 on November 15?", leftMs: 19 * 60 * MINUTE + 6 * MINUTE, volume: "$90,173", yes: 5700n, no: 4400n },
  { id: "eth", title: "Ethereum above $1,750 on November 14?", leftMs: 4 * MINUTE + 41_000, volume: "$12,880", yes: 6400n, no: 3700n },
  { id: "sol", title: "Solana up in the next 15 minutes?", leftMs: 108_000, volume: "$3,204", yes: 350n, no: null },
] as const;

const MARKET_COLUMNS: Column[] = [
  { id: "market", header: "Market", primary: true },
  { id: "left", header: "Time left", align: "right", width: "6.5rem" },
  { id: "volume", header: "Volume", align: "right", width: "6rem" },
  { id: "buy", header: "Buy", actions: true, width: "12.5rem" },
];

const STRIKES = [
  { label: "$66,000 or above", volume: "$90,173", yes: 5700n, no: 4400n },
  { label: "$67,000 or above", volume: "$41,220", yes: 3100n, no: 7000n },
  { label: "$68,000 or above", volume: "$18,064", yes: 1200n, no: 8900n },
] as const;

const STRIKE_COLUMNS: Column[] = [
  { id: "contract", header: "Contract", primary: true },
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

/** Up to eight short options: the cadences a markets index filters by. */
const CADENCES = [
  { value: "all", label: "All" },
  { value: "5m", label: "5 min" },
  { value: "15m", label: "15 min" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
] as const;

const CONTRAST_COLUMNS: Column[] = [
  { id: "pair", header: "Pairing", primary: true },
  { id: "ratio", header: "Ratio", align: "right", width: "4.5rem" },
  { id: "needs", header: "Needs", align: "right", width: "4rem" },
  { id: "use", header: "Used for", width: "minmax(0, 24rem)" },
];

function Section({ id, title, note, children }: { id: string; title: string; note: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`}>
      <header className={styles.sectionHead}>
        <h2 id={`${id}-title`}>{title}</h2>
        <p className={styles.note}>{note}</p>
      </header>
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

/** What an order of this size holds, by the program's own arithmetic; null while the entry is not a valid order. */
function quote(quantity: string, cents: string): { cost: bigint; fee: bigint; payout: bigint } | null {
  if (!/^\d{1,2}$/.test(cents) || cents === "0" || cents === "00") return null;
  try {
    const units = parseUnits(quantity);
    if (units <= 0n) return null;
    const px = BigInt(cents) * 100n;
    return { cost: cost(units, px), fee: feeCap(units, px), payout: units * PAYOUT_PER_UNIT };
  } catch {
    return null;
  }
}

export function Gallery({ anchorMs }: { anchorMs: number }) {
  const [side, setSide] = useState<"yes" | "no">("yes");
  const [action, setAction] = useState<"buy" | "sell">("buy");
  const [category, setCategory] = useState("all");
  const [cadence, setCadence] = useState("all");
  const [quantity, setQuantity] = useState("5.00");
  const [limit, setLimit] = useState("57");
  const [email, setEmail] = useState("");
  const held = quote(quantity, limit);
  const word = side === "yes" ? "Yes" : "No";

  const sideChoice = (
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
  );

  /** The filters of a markets index: how often a market closes, and what it is about. */
  const filters = (
    <div className={styles.filters}>
      <Segmented label="Cadence" size="row" value={cadence} onChange={setCadence} options={CADENCES} />
      <Segmented
        label="Category"
        size="row"
        value={category}
        onChange={setCategory}
        options={[
          { value: "all", label: "All" },
          { value: "crypto", label: "Crypto" },
          { value: "commodities", label: "Commodities" },
        ]}
      />
    </div>
  );

  const positions = (
    <RowList label="Positions" columns={POSITION_COLUMNS}>
      <Row
        cells={[
          <span key="position">
            Bitcoin above $66,000 <span className={styles.soft}>· Yes</span>
          </span>,
          formatContracts(500n),
          formatDollars(2_850_000n),
          <Badge key="status" tone="positive" dot>
            Live
          </Badge>,
          <ButtonLink key="action" size="row" href="#row-list">
            Sell
          </ButtonLink>,
        ]}
      />
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
        detail={
          <p className={styles.rowDetail}>
            Settled Yes on Nov 14, 21:00 UTC. <ExternalLink href={txUrl(SIGNATURE)}>{shortAddress(SIGNATURE)}</ExternalLink>
          </p>
        }
      />
      <Row
        cells={[
          <Skeleton key="position" width="14rem" height="1.25rem" />,
          <Skeleton key="quantity" width="3rem" height="1rem" />,
          <Skeleton key="value" width="3.5rem" height="1rem" />,
          <Skeleton key="status" width="4.5rem" height="1.5rem" />,
          <Skeleton key="action" width="4rem" height="2.25rem" />,
        ]}
      />
    </RowList>
  );

  return (
    <div className={styles.page}>
      <header>
        <h1>Design reference</h1>
        <p className={styles.lead}>Every part of the interface in every state, as docs/DESIGN.md describes it. Development only.</p>
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

      <Section id="palette" title="Palette" note="Four theme colours. Every other tone is one of them mixed toward another, kept as a solid value.">
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

        <h3 className={styles.subhead}>What they were chosen against</h3>
        <div className={styles.candidates}>
          {CANDIDATES.map((group) => (
            <Panel key={group.name} className={styles.candidateGroup}>
              {group.options.map((option) => {
                const chosen = option.hex === COLORS[group.name];
                const figures =
                  group.name === "peach"
                    ? `${contrast(option.hex, COLORS.white).toFixed(2)} against white · jade on it ${contrast(COLORS.jade, option.hex).toFixed(2)}`
                    : `${contrast(option.hex, COLORS.white).toFixed(2)} on white · ${contrast(option.hex, COLORS.peach).toFixed(2)} on the page`;
                return (
                  <div key={option.hex} className={styles.candidate}>
                    <span className={styles.candidateChip} style={{ background: option.hex }} />
                    <div>
                      <p className={styles.candidateName}>
                        {option.hex} {chosen && <Badge tone="positive">Chosen</Badge>}
                      </p>
                      <p className={styles.candidateFigures}>{figures}</p>
                      <p className={styles.candidateVerdict}>{option.verdict}</p>
                    </div>
                  </div>
                );
              })}
            </Panel>
          ))}
        </div>
      </Section>

      <Section id="contrast" title="Contrast" note="Every pairing the system uses, measured by the WCAG 2.1 formula. Text needs 4.5, boundaries and marks need 3.">
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

      <Section id="type" title="Type" note="One typeface, Reddit Sans. Six sizes, three weights, tabular figures everywhere.">
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

      <Section id="shape" title="Shape and space" note="Three radii and the 4px steps.">
        <div className={styles.grid}>
          <Specimen label="Radius" surface>
            <div className={styles.radii}>
              {RADII.map(([name, value, use]) => (
                <div key={name}>
                  <span className={styles.radius} style={{ borderRadius: `var(--rounded-${name})` }} />
                  <p className={styles.swatchName}>
                    {name} · {value}
                  </p>
                  <p className={styles.swatchNote}>{use}</p>
                </div>
              ))}
            </div>
          </Specimen>
          <Specimen label="Space" surface>
            <div className={styles.spaces}>
              {SPACES.map((step, index) => (
                <div key={step} className={styles.space}>
                  <span className={styles.spaceBar} style={{ width: step }} />
                  <span className={styles.swatchNote}>
                    {index + 1} · {step}px
                  </span>
                </div>
              ))}
            </div>
          </Specimen>
        </div>
      </Section>

      <Section id="button" title="Button" note="One primary per view. A busy button keeps its width and names what it is doing.">
        <div className={styles.grid}>
          <Specimen label="Primary, secondary, quiet">
            <Button variant="primary">Buy Yes · hold $2.92</Button>
            <Button>Place another order</Button>
            <Button variant="quiet">Show details</Button>
          </Specimen>
          <Specimen label="The same on a surface" surface>
            <Button variant="primary">Buy Yes · hold $2.92</Button>
            <Button>Place another order</Button>
            <Button variant="quiet">Show details</Button>
          </Specimen>
          <Specimen label="Busy">
            <Button variant="primary" busy="Check your wallet">
              Buy Yes · hold $2.92
            </Button>
            <Button busy="Sending">Place another order</Button>
          </Specimen>
          <Specimen label="Disabled" surface>
            <Button variant="primary" disabled>
              Buy Yes · hold $2.92
            </Button>
            <Button disabled>Place another order</Button>
            <Button variant="quiet" disabled>
              Show details
            </Button>
          </Specimen>
          <Specimen label="Compact, for rows and notices">
            <Button size="row" variant="primary">
              Redeem $5.00
            </Button>
            <Button size="row">Reclaim</Button>
            <Button size="row" variant="quiet">
              Details
            </Button>
            <Button size="row" busy="Signing">
              Reclaim
            </Button>
          </Specimen>
          <Specimen label="Full width, and a link that looks like a button" surface>
            <Button variant="primary" block>
              Log in to trade
            </Button>
            <ButtonLink href="#button" block>
              See all markets
            </ButtonLink>
          </Specimen>
        </div>
      </Section>

      <Section id="yes-no" title="Yes and No" note="No hue of their own. Yes is jade, No is forest, and each always carries its word.">
        <div className={styles.grid}>
          <Specimen label="At rest, in lists (PriceButton)" surface>
            <PriceButton side="YES" px={5700n} href="#yes-no" subject="Bitcoin above $66,000" />
            <PriceButton side="NO" px={4400n} href="#yes-no" subject="Bitcoin above $66,000" />
          </Specimen>
          <Specimen label="At rest, on the page">
            <PriceButton side="YES" px={350n} href="#yes-no" />
            <PriceButton side="NO" px={9650n} href="#yes-no" />
          </Specimen>
          <Specimen label="No offer on a side" surface>
            <PriceButton side="YES" px={6400n} href="#yes-no" />
            <PriceButton side="NO" px={null} />
          </Specimen>
          <Specimen label="Chosen, in the trade panel (Segmented)" surface>
            <div className={styles.full}>{sideChoice}</div>
          </Specimen>
        </div>
      </Section>

      <Section id="segmented" title="Segmented" note="One choice among a few, up to eight. The chosen option is filled, the others stay outlined. Arrow keys move within the group. Two or three options can share the width; more keep their own and wrap.">
        <div className={styles.grid}>
          <Specimen label="Buy or Sell" surface>
            <Segmented
              label="Action"
              value={action}
              onChange={setAction}
              options={[
                { value: "buy", label: "Buy" },
                { value: "sell", label: "Sell" },
              ]}
            />
          </Specimen>
          <Specimen label="Compact, as the filters above a list: seven cadences, then categories" wide>
            {filters}
          </Specimen>
          <Specimen label="The same in a column as narrow as a phone: the options wrap, none is hidden">
            <div className={styles.phone}>{filters}</div>
          </Specimen>
          <Specimen label="Disabled" surface>
            <Segmented
              label="Action, disabled"
              value={action}
              onChange={setAction}
              disabled
              options={[
                { value: "buy", label: "Buy" },
                { value: "sell", label: "Sell" },
              ]}
            />
          </Specimen>
        </div>
      </Section>

      <Section id="field" title="Field" note="A visible label above, the unit inside, and an error that says what is allowed.">
        <div className={styles.grid}>
          <Specimen label="Numeric, with a unit and steppers" surface>
            <div className={styles.full}>
              <Field label="Quantity" numeric suffix="contracts" value={quantity} onChange={setQuantity} helper="Minimum 0.01" stepper={{ onDecrement: () => {}, onIncrement: () => {} }} />
            </div>
          </Specimen>
          <Specimen label="Price in cents" surface>
            <div className={styles.full}>
              <Field label="Limit price" numeric suffix="¢" value={limit} onChange={setLimit} helper="Best offer is 57¢" />
            </div>
          </Specimen>
          <Specimen label="Text, on the page">
            <div className={styles.full}>
              <Field label="Email" type="email" placeholder="you@example.com" value={email} onChange={setEmail} />
            </div>
          </Specimen>
          <Specimen label="Invalid" surface>
            <div className={styles.full}>
              <Field label="Quantity" numeric suffix="contracts" value="0" onChange={() => {}} error="Minimum is 0.01 contracts" />
            </div>
          </Specimen>
          <Specimen label="Something to know" surface>
            <div className={styles.full}>
              <Field label="Limit price" numeric suffix="¢" value="50" onChange={() => {}} warning="Below the best offer of 57¢: this order may not fill." />
            </div>
          </Specimen>
          <Specimen label="Disabled" surface>
            <div className={styles.full}>
              <Field label="Quantity" numeric suffix="contracts" value="5.00" onChange={() => {}} disabled stepper={{ onDecrement: () => {}, onIncrement: () => {} }} />
            </div>
          </Specimen>
        </div>
      </Section>

      <Section id="badge" title="Badge" note="The status of one thing in a word. Three tones.">
        <div className={styles.grid}>
          <Specimen label="Neutral, positive, negative" surface>
            <Badge>Open</Badge>
            <Badge>Refunded</Badge>
            <Badge>Settled</Badge>
            <Badge tone="positive">Filled</Badge>
            <Badge tone="positive">Redeemable</Badge>
            <Badge tone="negative">Failed</Badge>
          </Specimen>
          <Specimen label="Live, on the page">
            <Badge tone="positive" dot>
              Live
            </Badge>
            <Badge>Closed</Badge>
          </Specimen>
        </div>
      </Section>

      <Section id="notice" title="Notice" note="A message where it applies: a title, one sentence, at most two actions. Every wait says what it waits for. On the two tints the boundary of an action is forest.">
        <div className={styles.stack}>
          <Notice busy title="Waiting for your wallet" action={[<Button key="retry" size="row">Retry</Button>, <Button key="cancel" size="row" variant="quiet">Cancel</Button>]}>
            Approve the request in Phantom. If no window opened, press Retry.
          </Notice>
          <Notice title="The relayer is not answering" action={<Button size="row">Check again</Button>}>
            New orders would not be filled right now. Orders you already placed are safe and can be reclaimed once they expire.
          </Notice>
          <Notice title="No positions yet" action={<ButtonLink href="#notice" size="row">See markets</ButtonLink>}>
            Buy Yes or No in any market and your tokens are listed here.
          </Notice>
          <Notice tone="positive" title="Redeemed" action={<ButtonLink href="#notice" size="row">See portfolio</ButtonLink>}>
            5.00 Yes tokens were burned and $5.00 in test dollars arrived in your wallet.
          </Notice>
          <Notice tone="negative" title="The order was not placed" action={[<Button key="retry" size="row">Try again</Button>, <Button key="cancel" size="row" variant="quiet">Cancel</Button>]}>
            This market closes in under a minute, so the program refused the order. Nothing was held.
          </Notice>
          <Specimen label="Inside the trade panel: the actions go under the text, by the width of the notice itself">
            <Panel className={styles.aside}>
              <div className={styles.stack}>
                <Notice busy title="Waiting for your wallet" action={[<Button key="retry" size="row">Retry</Button>, <Button key="cancel" size="row" variant="quiet">Cancel</Button>]}>
                  Approve the request in Phantom.
                </Notice>
                <Notice title="Trading is paused">New orders are not accepted for the moment.</Notice>
                <Notice tone="positive" title="Filled" action={<ButtonLink href="#notice" size="row">See activity</ButtonLink>}>
                  2.00 Yes at 56¢. Your tokens are in your wallet.
                </Notice>
                <Notice tone="negative" title="Test funds were not sent" action={<Button size="row">Try again</Button>}>
                  The faucet did not answer.
                </Notice>
              </div>
            </Panel>
          </Specimen>
        </div>
      </Section>

      <Section id="panel" title="Panel and Facts" note="A white surface for anything that is not a list, and label and value lines inside it. A heading before the lines names them.">
        <div className={styles.grid}>
          <Specimen label="Facts, ending in a total" wide>
            <Panel className={styles.full}>
              <h3 className="sr-only">Order summary</h3>
              <Facts>
                <Fact label="Cost at limit">$2.85</Fact>
                <Fact label="Fee, at most">$0.07</Fact>
                <Fact label="Pays if Yes wins">$5.00</Fact>
                <Fact label="Held until filled" total>
                  $2.92
                </Fact>
              </Facts>
            </Panel>
          </Specimen>
          <Specimen label="Facts about one thing" wide>
            <Panel className={styles.full}>
              <h3 className="sr-only">Market details</h3>
              <Facts>
                <Fact label="Closes">Nov 15, 21:00 UTC</Fact>
                <Fact label="Resolves from">The exchange index price</Fact>
                <Fact label="Volume">$90,173</Fact>
                <Fact label="Token">
                  <ExternalLink href={txUrl(SIGNATURE)}>{shortAddress(ADDRESS)}</ExternalLink>
                </Fact>
              </Facts>
            </Panel>
          </Specimen>
        </div>
      </Section>

      <Section id="row-list" title="RowList" note="Every list. Its own surface, numbers right aligned, one line of main text per row. Where the list itself is narrow its rows stack, and what hangs under a row stays with it.">
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

          {positions}

          <Specimen label="The same list in a narrow column, such as the main column beside the trade panel: it stacks by its own width">
            <div className={styles.column}>{positions}</div>
          </Specimen>
        </div>
      </Section>

      <Section id="timeline" title="Timeline" note="The steps of an order. Every on-chain step links to its transaction; a step that did not happen is said in words.">
        <div className={styles.grid}>
          <Specimen label="Filling" wide>
            <Panel className={styles.full}>
              <Timeline
                label="Order progress"
                steps={[
                  { id: "held", status: "done", title: "Held on Solana", description: "$2.92 in test dollars is held by the program.", time: "14:05:09 UTC", link: <ExternalLink href={txUrl(SIGNATURE)}>{shortAddress(SIGNATURE)}</ExternalLink> },
                  { id: "sent", status: "done", title: "Sent to the venue", description: "Buy 5.00 Yes at 57¢ or better.", time: "14:05:10 UTC" },
                  { id: "fill", status: "current", title: "Waiting for a fill", description: "The order rests until it fills or expires." },
                  { id: "mint", status: "pending", title: "Tokens minted" },
                ]}
              />
            </Panel>
          </Specimen>
          <Specimen label="Not filled, refunded" wide>
            <Panel className={styles.full}>
              <Timeline
                label="Order progress, refunded"
                steps={[
                  { id: "held", status: "done", title: "Held on Solana", time: "14:05:09 UTC", link: <ExternalLink href={txUrl(SIGNATURE)}>{shortAddress(SIGNATURE)}</ExternalLink> },
                  { id: "sent", status: "done", title: "Sent to the venue", time: "14:05:10 UTC" },
                  { id: "fill", status: "skipped", title: "Not filled", description: "No offer at 50¢ or better before the order expired." },
                  { id: "refund", status: "done", title: "Refunded in full", description: "$2.57 came back to your wallet.", time: "14:06:12 UTC", link: <ExternalLink href={txUrl(SIGNATURE)}>{shortAddress(SIGNATURE)}</ExternalLink> },
                ]}
              />
            </Panel>
          </Specimen>
        </div>
      </Section>

      <Section id="countdown" title="Countdown" note="Next to anything with a deadline. The longer the wait, the calmer the figure: seconds under an hour, minutes from an hour up, hours from a day up. In the last two minutes it gets heavier and says so; there is no warning colour.">
        <div className={styles.grid}>
          <Specimen label="Under an hour, live: minutes and seconds" surface>
            <Countdown to={anchorMs + 12 * MINUTE + 41_000} label="closes in" />
          </Specimen>
          <Specimen label="From an hour up: hours and minutes" surface>
            <CountdownView remainingMs={19 * 60 * MINUTE + 6 * MINUTE + 26_000} label="closes in" />
          </Specimen>
          <Specimen label="From a day up: days and hours" surface>
            <CountdownView remainingMs={3 * 24 * 60 * MINUTE + 4 * 60 * MINUTE + 20 * MINUTE} label="closes in" />
          </Specimen>
          <Specimen label="Last two minutes" surface>
            <CountdownView remainingMs={68_000} label="closes in" />
          </Specimen>
          <Specimen label="Over" surface>
            <CountdownView remainingMs={0} label="closes in" closedText="awaiting result" />
          </Specimen>
          <Specimen label="As the number that matters, live, and the one on the page that announces its end">
            <Countdown to={anchorMs + 9 * MINUTE + 41_000} label="closes in" size="display" announce />
          </Specimen>
          <Specimen label="The same for a market that closes next week">
            <CountdownView remainingMs={6 * 24 * 60 * MINUTE + 23 * 60 * MINUTE} label="closes in" size="display" />
          </Specimen>
        </div>
      </Section>

      <Section id="small" title="ExternalLink and Skeleton" note="A transaction on the explorer, and the still shape of what is loading.">
        <div className={styles.grid}>
          <Specimen label="A transaction and an address" surface>
            <ExternalLink href={txUrl(SIGNATURE)}>{shortAddress(SIGNATURE)}</ExternalLink>
            <ExternalLink href={txUrl(SIGNATURE)}>View transaction</ExternalLink>
          </Specimen>
          <Specimen label="Skeleton, on a surface" surface>
            <div className={styles.skeletons}>
              <Skeleton width="12rem" height="1.25rem" />
              <Skeleton width="100%" height="1rem" />
              <Skeleton width="70%" height="1rem" />
            </div>
          </Specimen>
          <Specimen label="Skeleton, on the page">
            <div className={styles.skeletons}>
              <Skeleton width="9rem" height="1.875rem" />
              <Skeleton width="100%" height="1rem" />
            </div>
          </Specimen>
        </div>
      </Section>

      <Section id="market" title="A market, from these parts" note="Built only from the components above, to show that they are enough: the question, the price, the time left, the volume, and the trade panel.">
        <div className={styles.market}>
          <header className={styles.marketHead}>
            <p className={styles.crumbs}>
              Crypto · Bitcoin
              <Badge tone="positive" dot>
                Live
              </Badge>
            </p>
            <h3 className={styles.question}>Bitcoin above $66,000 on November 15?</h3>
            <div className={styles.headline}>
              <p>
                <span className={styles.price}>57¢</span>
                <span className={styles.soft}>Yes, best offer</span>
              </p>
              <CountdownView remainingMs={19 * 60 * MINUTE + 6 * MINUTE + 26_000} label="closes in" />
              <span className={styles.soft}>$90,173 volume</span>
            </div>
          </header>

          <Panel className={styles.trade}>
            <form className={styles.tradeForm} onSubmit={(event) => event.preventDefault()} aria-label="Trade">
              <Segmented
                label="Action"
                size="row"
                value={action}
                onChange={setAction}
                options={[
                  { value: "buy", label: "Buy" },
                  { value: "sell", label: "Sell" },
                ]}
              />
              {sideChoice}
              <Field label="Quantity" numeric suffix="contracts" value={quantity} onChange={setQuantity} error={held ? undefined : "Enter a quantity of 0.01 or more"} />
              <Field label="Limit price" numeric suffix="¢" value={limit} onChange={setLimit} helper={held ? "Best offer is 57¢" : undefined} error={held ? undefined : "Enter a price from 1¢ to 99¢"} />
              <h4 className="sr-only">Order summary</h4>
              <Facts>
                <Fact label="Cost at limit">{held ? formatDollars(held.cost) : "–"}</Fact>
                <Fact label="Fee, at most">{held ? formatDollars(held.fee) : "–"}</Fact>
                <Fact label={`Pays if ${word} wins`}>{held ? formatDollars(held.payout) : "–"}</Fact>
                <Fact label="Held until filled" total>
                  {held ? formatDollars(held.cost + held.fee) : "–"}
                </Fact>
              </Facts>
              <Button type="submit" variant="primary" block disabled={!held}>
                {action === "buy" ? `Buy ${word}` : `Sell ${word}`}
                {held && action === "buy" ? ` · hold ${formatDollars(held.cost + held.fee)}` : ""}
              </Button>
              <p className={styles.fine}>Test dollars on Solana devnet. Anything unused is refunded.</p>
            </form>
          </Panel>

          <div className={styles.marketDetails}>
            <h4 className={styles.blockTitle}>About this market</h4>
            <Panel>
              <Facts>
                <Fact label="Closes">Nov 15, 21:00 UTC</Fact>
                <Fact label="Resolves from">The exchange index price at the close</Fact>
                <Fact label="Pays">$1.00 per contract to the side that is right</Fact>
              </Facts>
            </Panel>
            <h4 className={styles.blockTitle}>Contracts of this event</h4>
            <RowList label="Contracts of this event" columns={STRIKE_COLUMNS}>
              {STRIKES.map((strike) => (
                <Row
                  key={strike.label}
                  cells={[
                    <a key="contract" href="#market" className={styles.rowTitle}>
                      {strike.label}
                    </a>,
                    strike.volume,
                    <span key="buy" className={styles.rowActions}>
                      <PriceButton side="YES" px={strike.yes} href="#market" subject={strike.label} />
                      <PriceButton side="NO" px={strike.no} href="#market" subject={strike.label} />
                    </span>,
                  ]}
                />
              ))}
            </RowList>
          </div>
        </div>
      </Section>

      <Section id="shell" title="Shell" note="The navbar is see-through and stays at the top; the real one is above this page. Here it is in its other states. The wallet control shows and hides a panel: Tab goes through it, Escape closes it.">
        <div className={styles.stack}>
          <Specimen label="Logged out" wide>
            <div className={styles.frame}>
              <Navbar inline pathname="/markets" cluster="devnet" account={<Button size="row" variant="primary">Log in</Button>} />
            </div>
          </Specimen>
          <Specimen label="Logged in, balance loading" wide>
            <div className={styles.frame}>
              <Navbar inline pathname="/portfolio" cluster="devnet" balanceMicros={null} account={<AccountMenu address={ADDRESS} embedded faucet={{ kind: "idle" }} onGetTestFunds={() => {}} onLogout={() => {}} />} />
            </div>
          </Specimen>
          <Specimen label="Logged in, with the panel of the wallet control open" wide>
            <div className={`${styles.frame} ${styles.frameTall}`}>
              <Navbar
                inline
                pathname="/activity"
                cluster="devnet"
                balanceMicros={1_000_000_000n}
                account={<AccountMenu address={ADDRESS} embedded={false} faucet={{ kind: "done", text: "Sent $100.00 in test dollars." }} onGetTestFunds={() => {}} onLogout={() => {}} defaultOpen />}
              />
            </div>
          </Specimen>
          <Specimen label="Footer, with the exchange sandbox and with a simulated venue" wide>
            <div className={styles.frame}>
              <FooterView venue="sandbox" />
              <FooterView venue="mock" />
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
