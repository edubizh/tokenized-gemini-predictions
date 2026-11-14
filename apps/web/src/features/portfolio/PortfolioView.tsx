"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { SideName } from "@outcome/relayer/api-types";
import type { FaucetStatus } from "@/components/shell/AccountMenu";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Countdown, CountdownView } from "@/components/ui/Countdown";
import { EmptyState } from "@/components/ui/EmptyState";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { Notice } from "@/components/ui/Notice";
import { Receipt, ReceiptLine } from "@/components/ui/Receipt";
import { Row, RowList, type Column } from "@/components/ui/RowList";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stamp } from "@/components/ui/Stamp";
import { marketHref } from "@/features/markets/MarketsList";
import { formatClock, marketTitle, type TimeOptions } from "@/features/markets/wording";
import type { Balances } from "@/lib/chain/reads";
import { formatContracts, formatDollars, formatSol, shortAddress } from "@/lib/format";
import type { RedeemState } from "./actions";
import { resultWords, sideStatement, type Portfolio, type PositionRow } from "./positions";
import styles from "./Portfolio.module.css";

/** Below these the faucet tops a wallet up, so that is when the page offers it. */
const LOW_STABLE_MICROS = 100_000_000n;
const LOW_LAMPORTS = 10_000_000n;

/** What a finished redemption leaves on the page in the row's place. */
export interface RedemptionReceipt {
  mint: string;
  /** The market's title, such as "ETH Up". */
  title: string;
  side: SideName;
  /** Tokens burned, in units. */
  units: bigint;
  /** Test dollars received, in micro-dollars. Zero for tokens that lost. */
  payoutMicros: bigint;
  signature: string;
  /** When it was confirmed, unix milliseconds. */
  at: number;
}

export interface PortfolioViewProps extends TimeOptions {
  /** Null until the wallet's balances have been read. */
  balances: Balances | null;
  /** Null until the wallet's tokens have been read. */
  portfolio: Portfolio | null;
  /** True while the relayer is not answering, so tokens cannot be matched to their markets. */
  unnamed?: boolean;
  faucet: { status: FaucetStatus; onRequest(): void };
  receipts: readonly RedemptionReceipt[];
  redeeming: RedeemState;
  onRedeem(row: PositionRow): void;
  /** The wall clock the page is drawn for, unix milliseconds. */
  nowMs: number;
  /** The cluster clock, unix milliseconds: redemption opens on it. */
  chainNow(): number;
  /** Freezes the countdowns, for the gallery. */
  frozen?: boolean;
  /** Called when a countdown reaches zero, so the caller can group the positions again. */
  onDeadline?(): void;
  txUrl(signature: string): string;
  addressUrl(address: string): string;
}

const TOKENS: Column = { id: "tokens", header: "Tokens", align: "right", width: "5.5rem" };
const ACTIONS: Column = { id: "actions", header: "Actions", actions: true, width: "5.5rem" };
const columns = (value: string, time: string): Column[] => [
  { id: "position", header: "Position", primary: true },
  TOKENS,
  { id: "value", header: value, align: "right", width: "9rem" },
  { id: "time", header: time, align: "right", width: "9.5rem" },
  ACTIONS,
];
const LIVE = columns("Worth now", "Closes in");
const AWAITING = columns("Pays", "Closed");
const REDEEMABLE = columns("Pays", "Result");
const OPENING = columns("Pays", "Redeem in");
const UNKNOWN: Column[] = [{ id: "mint", header: "Token mint", primary: true }, TOKENS];

function Group({ id, title, count, note, empty, children }: { id: string; title: string; count: number; note: string; empty: string; children: ReactNode }) {
  return (
    <section className={styles.group} aria-labelledby={`${id}-title`} data-testid={`group-${id}`}>
      <div className={styles.groupHead}>
        <h2 id={`${id}-title`}>{title}</h2>
        {count > 0 && (
          <span className={styles.count}>
            {count}
            <span className="sr-only">{count === 1 ? " position" : " positions"}</span>
          </span>
        )}
      </div>
      {children ? (
        <>
          <p className={styles.groupNote}>{note}</p>
          <div className={styles.groupBody}>{children}</div>
        </>
      ) : (
        <div className={styles.groupBody}>
          <p className={styles.emptyLine}>{empty}</p>
        </div>
      )}
    </section>
  );
}

function PositionCell({ row, words }: { row: PositionRow; words: string }) {
  return (
    <div className={styles.position}>
      <p className={styles.name}>
        <span className={`${styles.side} ${row.side === "YES" ? styles.yes : styles.no}`}>{row.side}</span>
        <Link href={marketHref(row.market.symbol)} className={styles.title}>
          {marketTitle(row.market)}
        </Link>
      </p>
      <p className={styles.statement}>{words}</p>
    </div>
  );
}

const tokens = (row: { units: bigint }) => (
  <span key="tokens" className={styles.figure}>
    {formatContracts(row.units)}
  </span>
);

function pays(row: PositionRow) {
  const amount = row.payoutMicros ?? 0n;
  return (
    <span key="value" className={`${styles.figure} ${amount === 0n ? styles.nothing : ""}`}>
      {formatDollars(amount)}
    </span>
  );
}

function RedemptionReceiptView({ receipt, txUrl, timeZone }: { receipt: RedemptionReceipt; txUrl(signature: string): string; timeZone?: string }) {
  const paid = receipt.payoutMicros > 0n;
  return (
    <div data-testid="redemption-receipt">
      <Receipt
        title={`${paid ? "Redeemed" : "Cleared"} · ${receipt.title}`}
        mark={<Stamp value={paid ? "REDEEMED" : "LOST"} />}
        note={paid ? "The tokens were burned and the test dollars are in your wallet." : "These tokens lost, so burning them paid nothing."}
      >
        <ReceiptLine label="Tokens burned">{`${formatContracts(receipt.units)} ${receipt.side}`}</ReceiptLine>
        <ReceiptLine label="Confirmed">{formatClock(receipt.at, { seconds: true, zone: true, timeZone })}</ReceiptLine>
        <ReceiptLine label="Transaction">
          <ExternalLink href={txUrl(receipt.signature)} mono>
            {shortAddress(receipt.signature)}
          </ExternalLink>
        </ReceiptLine>
        <ReceiptLine label="Test dollars received" total>
          {formatDollars(receipt.payoutMicros)}
        </ReceiptLine>
      </Receipt>
    </div>
  );
}

/** The wallet's test dollars and outcome tokens, grouped by where each market is in its life. */
export function PortfolioView({ balances, portfolio, unnamed, faucet, receipts, redeeming, onRedeem, nowMs, chainNow, frozen, onDeadline, txUrl, addressUrl, timeZone }: PortfolioViewProps) {
  const redeemed = new Set(receipts.map((receipt) => receipt.mint));
  const redeemable = (portfolio?.redeemable ?? []).filter((row) => !redeemed.has(row.mint));
  const winning = redeemable.filter((row) => (row.payoutMicros ?? 0n) > 0n);
  const redeemableMicros = winning.reduce((sum, row) => sum + (row.payoutMicros ?? 0n), 0n);
  const low = balances !== null && (balances.stableMicros < LOW_STABLE_MICROS || balances.lamports < LOW_LAMPORTS);
  const faucetWords = faucet.status.kind === "working" ? "Asking the faucet for test funds." : faucet.status.kind === "idle" ? null : faucet.status.text;
  const chainMs = chainNow();

  const closes = (row: PositionRow) => (
    <div key="time" className={styles.stack}>
      {frozen ? <CountdownView remainingMs={row.market.expiresAt - nowMs} label="" /> : <Countdown to={row.market.expiresAt} label="" onClosed={onDeadline} />}
      <span className={styles.sub}>{`closes ${formatClock(row.market.expiresAt, { timeZone })}`}</span>
    </div>
  );
  const opens = (row: PositionRow) => {
    const openAtMs = (row.redeemAfter ?? 0) * 1000;
    return (
      <div key="time" className={styles.stack}>
        {frozen ? (
          <CountdownView remainingMs={openAtMs - chainMs} label="" closedText="opening" calm />
        ) : (
          <Countdown to={openAtMs} now={chainNow} label="" closedText="opening" calm onClosed={onDeadline} />
        )}
        <span className={styles.sub}>{`opens ${formatClock(openAtMs, { seconds: true, timeZone })}`}</span>
      </div>
    );
  };
  const busy = (row: PositionRow) => (redeeming.mint === row.mint ? (redeeming.progress === "wallet" ? "Check your wallet" : redeeming.progress === "sending" ? "Sending" : false) : false);
  const title = (row: PositionRow) => `${formatContracts(row.units)} ${row.side} of ${marketTitle(row.market)}`;

  let body: ReactNode;
  if (portfolio === null) {
    body = (
      <div aria-busy="true" style={{ display: "grid", gap: "var(--space-3)" }}>
        <span className="sr-only">Reading your tokens from Solana</span>
        <Skeleton width="6rem" height="1.6rem" />
        <Skeleton width="100%" height="56px" />
        <Skeleton width="100%" height="56px" />
      </div>
    );
  } else if (portfolio.empty && receipts.length === 0) {
    body = <EmptyState action={<ButtonLink href="/markets">See live markets</ButtonLink>}>No positions yet. Pick a market to buy your first outcome tokens.</EmptyState>;
  } else {
    body = (
      <>
        <Group
          id="live"
          title="Live"
          count={portfolio.live.length}
          note="Markets that are still open. Worth is what the tokens would fetch at the best bid right now; it moves until the market closes."
          empty="No tokens in a market that is still open."
        >
          {portfolio.live.length > 0 && (
            <RowList label="Live positions" columns={LIVE}>
              {portfolio.live.map((row) => (
                <Row
                  key={row.mint}
                  cells={[
                    <PositionCell key="position" row={row} words={sideStatement(row.market, row.side, { timeZone })} />,
                    tokens(row),
                    <div key="value" className={styles.stack}>
                      {row.worthMicros === null ? <span className={styles.words}>no bid right now</span> : <span className={styles.figure}>
                          <span className={styles.about}>about </span>
                          {formatDollars(row.worthMicros)}
                        </span>}
                      <span className={styles.sub}>{`pays ${formatDollars(row.fullPayoutMicros)} if ${row.side}`}</span>
                    </div>,
                    closes(row),
                    null,
                  ]}
                />
              ))}
            </RowList>
          )}
        </Group>

        <Group
          id="awaiting"
          title="Awaiting result"
          count={portfolio.awaiting.length}
          note="The fifteen minutes are over. The venue reports the result, then the market is settled on Solana, usually within a minute."
          empty="Nothing is waiting for a result."
        >
          {portfolio.awaiting.length > 0 && (
            <RowList label="Positions awaiting a result" columns={AWAITING}>
              {portfolio.awaiting.map((row) => (
                <Row
                  key={row.mint}
                  cells={[
                    <PositionCell key="position" row={row} words={sideStatement(row.market, row.side, { timeZone })} />,
                    tokens(row),
                    <span key="value" className={styles.figure}>{`${formatDollars(row.fullPayoutMicros)} if ${row.side}`}</span>,
                    <div key="time" className={styles.stack}>
                      <span className={styles.figure}>{formatClock(row.market.expiresAt, { timeZone })}</span>
                      <span className={styles.sub}>{row.market.settleState === "needs_review" ? "result under review" : row.market.resolution ? "result in, settling" : "result not in yet"}</span>
                    </div>,
                    null,
                  ]}
                />
              ))}
            </RowList>
          )}
        </Group>

        <Group
          id="redeemable"
          title="Redeemable"
          count={redeemable.length}
          note="Settled markets. Each winning token pays $1.00 in test dollars. Tokens of the side that lost pay nothing; Clear burns them."
          empty="Nothing to redeem right now. Winning tokens appear here once their market is settled."
        >
          {(redeemable.length > 0 || receipts.length > 0) && (
            <>
              {redeemable.length > 0 && (
                <RowList label="Redeemable positions" columns={REDEEMABLE}>
                  {redeemable.map((row) => {
                    const won = (row.payoutMicros ?? 0n) > 0n;
                    return (
                      <Row
                        key={row.mint}
                        cells={[
                          <PositionCell key="position" row={row} words={resultWords(row.market, { timeZone })} />,
                          tokens(row),
                          pays(row),
                          <Stamp key="time" value={won ? "REDEEMABLE" : "LOST"} />,
                          won ? (
                            <Button key="action" size="row" onClick={() => onRedeem(row)} busy={busy(row)} aria-label={`Redeem ${title(row)}`}>
                              Redeem
                            </Button>
                          ) : (
                            <Button key="action" size="row" variant="quiet" onClick={() => onRedeem(row)} busy={busy(row)} aria-label={`Clear ${title(row)}`}>
                              Clear
                            </Button>
                          ),
                        ]}
                      />
                    );
                  })}
                </RowList>
              )}
              {receipts.length > 0 && (
                <div className={styles.receipts}>
                  {receipts.map((receipt) => (
                    <RedemptionReceiptView key={receipt.signature} receipt={receipt} txUrl={txUrl} timeZone={timeZone} />
                  ))}
                </div>
              )}
              {redeeming.error && (
                <div className={styles.problem}>
                  <Notice tone="negative" title="The tokens were not redeemed">
                    {redeeming.error}
                  </Notice>
                </div>
              )}
            </>
          )}
        </Group>

        <Group
          id="opening"
          title="Redemption opening soon"
          count={portfolio.opening.length}
          note="Settled moments ago. Redemption opens a short, fixed time after settlement, on the Solana clock."
          empty="No settled market is waiting for redemption to open."
        >
          {portfolio.opening.length > 0 && (
            <RowList label="Positions whose redemption opens soon" columns={OPENING}>
              {portfolio.opening.map((row) => (
                <Row key={row.mint} cells={[<PositionCell key="position" row={row} words={resultWords(row.market, { timeZone })} />, tokens(row), pays(row), opens(row), null]} />
              ))}
            </RowList>
          )}
        </Group>

        {portfolio.unknown.length > 0 && (
          <Group
            id="unknown"
            title="Unknown market"
            count={portfolio.unknown.length}
            note={
              unnamed
                ? "The relayer is not answering, so these tokens cannot be matched to their markets right now. They are safe in your wallet."
                : "Tokens in your wallet from a mint the relayer does not list. They cannot be valued or redeemed from here."
            }
            empty=""
          >
            <RowList label="Tokens of unknown markets" columns={UNKNOWN}>
              {portfolio.unknown.map((balance) => (
                <Row
                  key={balance.mint}
                  cells={[
                    <div key="mint" className={styles.position}>
                      <p className={styles.title}>Unknown market</p>
                      <p className={styles.mint}>
                        <ExternalLink href={addressUrl(balance.mint)} mono>
                          <span className={styles.full}>{balance.mint}</span>
                          <span className={styles.short}>{shortAddress(balance.mint)}</span>
                        </ExternalLink>
                      </p>
                    </div>,
                    tokens(balance),
                  ]}
                />
              ))}
            </RowList>
          </Group>
        )}
      </>
    );
  }

  return (
    <>
      <dl className={styles.facts} aria-label="Your balances">
        <div className={styles.fact}>
          <dt className={styles.factLabel}>Test dollars</dt>
          <dd className={`${styles.factValue} ${styles.balance}`} data-testid="portfolio-balance">
            {balances === null ? <Skeleton width="9rem" height="1em" /> : formatDollars(balances.stableMicros)}
          </dd>
          <dd className={styles.factNote}>in your wallet on Solana devnet, no value</dd>
        </div>
        <div className={styles.fact}>
          <dt className={styles.factLabel}>Redeemable now</dt>
          <dd className={styles.factValue}>{portfolio === null ? <Skeleton width="5rem" height="1em" /> : formatDollars(redeemableMicros)}</dd>
          <dd className={styles.factNote}>{winning.length === 0 ? "nothing to redeem" : `from ${winning.length} winning ${winning.length === 1 ? "position" : "positions"}`}</dd>
        </div>
        <div className={styles.fact}>
          <dt className={styles.factLabel}>Devnet SOL</dt>
          <dd className={styles.factValue}>{balances === null ? <Skeleton width="4rem" height="1em" /> : formatSol(balances.lamports)}</dd>
          <dd className={styles.factNote}>pays network fees</dd>
        </div>
      </dl>

      {(low || faucetWords) && (
        <div className={styles.low}>
          {low && (
            <>
              <span>{balances !== null && balances.stableMicros < LOW_STABLE_MICROS ? "Running low on test dollars." : "Running low on SOL for network fees."}</span>
              <Button size="row" onClick={faucet.onRequest} busy={faucet.status.kind === "working" ? "Asking" : false}>
                Get test funds
              </Button>
            </>
          )}
          {faucetWords && <span role="status">{faucetWords}</span>}
        </div>
      )}

      <div className={styles.groups}>{body}</div>
    </>
  );
}
