"use client";

import Link from "next/link";
import type { ApiMarket } from "@outcome/relayer/api-types";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Countdown, CountdownView } from "@/components/ui/Countdown";
import { Notice } from "@/components/ui/Notice";
import { Row, RowList, type Column } from "@/components/ui/RowList";
import { Stamp, type StampValue } from "@/components/ui/Stamp";
import type { Position } from "@/lib/chain/reads";
import { formatContracts, formatDollars, formatPrice } from "@/lib/format";
import { askPx } from "./book";
import { formatClock, formatStrike, marketTitle, payoutStatement, resultIsIn, type TimeOptions } from "./wording";
import styles from "./Markets.module.css";

/** True while the 15-minute window is running. */
export function isLive(market: Pick<ApiMarket, "startsAt" | "expiresAt" | "settleState">, nowMs: number): boolean {
  return market.settleState === "open" && market.startsAt <= nowMs && nowMs < market.expiresAt;
}

function stampFor(market: ApiMarket, nowMs: number): StampValue | null {
  if (market.settleState === "settled" || market.onchain?.status === "settled") return "SETTLED";
  if (market.onchain?.status === "halted") return "HALTED";
  return isLive(market, nowMs) ? "OPEN" : null;
}

export interface MarketHeaderViewProps extends TimeOptions {
  market: ApiMarket;
  nowMs: number;
  /** Freezes the countdown at `nowMs`, for the gallery. */
  frozen?: boolean;
  onClosed?(): void;
}

/** The question, then three facts on one ruled line: time left, price to beat, price of each side. */
export function MarketHeaderView({ market, nowMs, frozen, onClosed, timeZone }: MarketHeaderViewProps) {
  const upcoming = market.startsAt > nowMs;
  const expired = nowMs >= market.expiresAt;
  const deadline = upcoming ? market.startsAt : market.expiresAt;
  const stamp = stampFor(market, nowMs);
  const yes = askPx(market, "YES");
  const no = askPx(market, "NO");

  let timeNote = `${upcoming ? "opens" : expired ? "closed" : "closes"} ${formatClock(deadline, { timeZone, zone: true })}`;
  if (expired && !resultIsIn(market)) timeNote = `${timeNote}, awaiting the result`;
  let beatNote = upcoming ? `set at ${formatClock(market.startsAt, { timeZone })}` : `${market.underlying} at ${formatClock(market.startsAt, { timeZone })}`;
  if (market.settlementValue !== null) beatNote = `final price ${formatStrike(market.settlementValue)}`;

  return (
    <header>
      <Link href="/markets" className={styles.back}>
        <span aria-hidden="true">← </span>Markets
      </Link>
      <div className={styles.head}>
        <h1>{marketTitle(market)}</h1>
        {stamp && <Stamp value={stamp} />}
      </div>
      <p className={styles.lead}>{payoutStatement(market, { timeZone })}</p>

      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt className={styles.factLabel}>{upcoming ? "Opens in" : expired ? "Window" : "Closes in"}</dt>
          <dd className={styles.factValue}>
            {frozen ? (
              <CountdownView remainingMs={deadline - nowMs} label="" size="display" />
            ) : (
              <Countdown to={deadline} label="" size="display" closedText={upcoming ? "open" : "closed"} onClosed={onClosed} />
            )}
          </dd>
          <dd className={styles.factNote}>{timeNote}</dd>
        </div>
        <div className={styles.fact}>
          <dt className={styles.factLabel}>Price to beat</dt>
          <dd className={styles.factValue}>{market.strike === null ? <span className={styles.pending}>Not set yet</span> : formatStrike(market.strike)}</dd>
          <dd className={styles.factNote}>{beatNote}</dd>
        </div>
        <div className={styles.fact}>
          <dt className={styles.factLabel}>{market.resolution || expired ? "Result" : "Price now"}</dt>
          {market.resolution ? (
            <dd className={styles.factValue}>
              <span className={`${styles.result} ${market.resolution === "yes" ? styles.yes : styles.no}`}>{market.resolution.toUpperCase()}</span>
            </dd>
          ) : expired ? (
            <dd className={styles.factValue}>
              <span className={styles.pending}>Not in yet</span>
            </dd>
          ) : (
            <dd className={`${styles.factValue} ${styles.sides}`}>
              <span>
                <span className={`${styles.sideWord} ${styles.yes}`}>YES</span>
                {yes === null ? "–" : formatPrice(yes)}
              </span>
              <span>
                <span className={`${styles.sideWord} ${styles.no}`}>NO</span>
                {no === null ? "–" : formatPrice(no)}
              </span>
            </dd>
          )}
          <dd className={styles.factNote}>
            {market.resolution ? `${market.resolution.toUpperCase()} tokens pay $1.00 each` : expired ? "the venue reports it after the close" : "per contract, in test dollars"}
          </dd>
        </div>
      </dl>
    </header>
  );
}

/** The three things that happen to an order, in the words the timeline uses. */
export function HowItWorks() {
  return (
    <section className={styles.section} aria-labelledby="how-title">
      <h2 id="how-title">What happens to an order</h2>
      <ol className={styles.how}>
        <li>
          <span className={styles.howNumber}>1</span>
          <p className={styles.howText}>
            <strong>Held on Solana.</strong> Your wallet sends the cost at your limit, plus a cap for the fee, to the program. Only a fill at your price or a refund can move it.
          </p>
        </li>
        <li>
          <span className={styles.howNumber}>2</span>
          <p className={styles.howText}>
            <strong>Sent to the venue.</strong> The relayer places one order on the exchange sandbox that fills in full at your limit or better, or not at all.
          </p>
        </li>
        <li>
          <span className={styles.howNumber}>3</span>
          <p className={styles.howText}>
            <strong>Minted or refunded.</strong> A fill mints the tokens to your wallet and returns the unused hold. No fill returns all of it. If the order expires first, you can reclaim the hold yourself.
          </p>
        </li>
      </ol>
      <p className={styles.howNote}>
        Selling runs the same three steps with the tokens as the hold: the relayer buys the opposite outcome at the matching price, a fill burns your tokens and pays test dollars, and no fill returns the tokens.
      </p>
    </section>
  );
}

const POSITION_COLUMNS: Column[] = [
  { id: "side", header: "Outcome", primary: true },
  { id: "tokens", header: "Tokens", align: "right", width: "7rem" },
  { id: "pays", header: "Pays", align: "right", width: "11rem" },
];

/** The wallet's tokens of this market's two mints. */
export function PositionView({ market, positions }: { market: ApiMarket; positions: readonly Position[] | undefined }) {
  const onchain = market.onchain;
  const held = (["YES", "NO"] as const).flatMap((side) => {
    const mint = side === "YES" ? onchain?.yesMint : onchain?.noMint;
    const units = positions?.find((position) => position.mint === mint)?.units ?? 0n;
    return units > 0n ? [{ side, units }] : [];
  });

  return (
    <section className={styles.section} aria-labelledby="position-title">
      <h2 id="position-title">Your position</h2>
      {held.length === 0 ? (
        <p className={styles.muted}>{positions === undefined ? "Reading your tokens from Solana." : "No tokens in this market yet. A filled order mints them to your wallet."}</p>
      ) : (
        <RowList label="Your position in this market" columns={POSITION_COLUMNS}>
          {held.map(({ side, units }) => {
            const payout = side === "YES" ? onchain?.yesPayout : onchain?.noPayout;
            return (
              <Row
                key={side}
                cells={[
                  <span key="side" className={`${styles.positionSide} ${side === "YES" ? styles.yes : styles.no}`}>
                    {side}
                  </span>,
                  <span key="tokens" className={styles.quantity}>
                    {formatContracts(units)}
                  </span>,
                  <span key="pays" className={styles.quantity}>
                    {payout == null ? `${formatDollars(units * 10_000n)} if ${side}` : formatDollars(units * BigInt(payout))}
                  </span>,
                ]}
              />
            );
          })}
        </RowList>
      )}
    </section>
  );
}

/** In the ticket's place while the relayer creates the market account and its two mints. */
export function PreparingPanel({ failed, onRetry }: { failed: boolean; onRetry(): void }) {
  if (failed) {
    return (
      <Notice tone="negative" title="This market could not be prepared on Solana" action={<Button size="row" onClick={onRetry}>Try again</Button>}>
        The relayer did not create the market account. Nothing of yours was involved.
      </Notice>
    );
  }
  return (
    <div className={styles.panel} role="status">
      <p className={styles.panelTitle}>
        <span className={styles.working} aria-hidden="true" />
        Preparing this market on Solana
      </p>
      <p className={styles.panelText}>The relayer is creating the market account and its YES and NO token mints. The order ticket appears here in a few seconds.</p>
    </div>
  );
}

/** In the ticket's place once the window has ended. */
export function ClosedPanel({ market }: { market: ApiMarket }) {
  const result = market.resolution ? `The result is ${market.resolution.toUpperCase()}.` : "The result is not in yet.";
  return (
    <div className={styles.panel}>
      <p className={styles.panelTitle}>This market has closed</p>
      <p className={styles.panelText}>{`Orders are no longer taken. ${result} Tokens you hold are redeemed from Portfolio once the market is settled.`}</p>
      <ButtonLink href="/markets" block>
        See live markets
      </ButtonLink>
    </div>
  );
}
