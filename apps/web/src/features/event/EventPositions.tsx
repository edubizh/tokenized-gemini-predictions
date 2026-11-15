"use client";

import type { ApiMarket } from "@outcome/relayer/api-types";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Countdown } from "@/components/ui/Countdown";
import { Notice } from "@/components/ui/Notice";
import { Row, RowList, type Column } from "@/components/ui/RowList";
import { useRedeem } from "@/features/portfolio/actions";
import { buildPortfolio, type PositionRow } from "@/features/portfolio/positions";
import type { Position } from "@/lib/chain/reads";
import { formatContracts, formatDollars } from "@/lib/format";
import type { ReconnectView } from "@/lib/privy/reconnect";
import { chainNow } from "@/lib/relayer/hooks";
import { marketHref } from "@/lib/routes";
import styles from "./Event.module.css";

const COLUMNS: Column[] = [
  { id: "position", header: "Position", primary: true },
  { id: "contracts", header: "Contracts", align: "right", width: "6rem" },
  { id: "value", header: "Value", align: "right", width: "9rem" },
  { id: "action", header: "Action", actions: true, width: "8rem" },
];

const word = (row: PositionRow) => (row.side === "YES" ? "Yes" : "No");

function value(row: PositionRow): string {
  switch (row.group) {
    case "live":
      return row.valueMicros === null ? "no bid right now" : `about ${formatDollars(row.valueMicros)}`;
    case "awaiting":
      return `${formatDollars(row.fullPayoutMicros)} if ${word(row)}`;
    default:
      return formatDollars(row.payoutMicros ?? 0n);
  }
}

export interface EventPositionsProps {
  markets: readonly ApiMarket[];
  positions: readonly Position[] | undefined;
  /** False while the relayer is away: a sale goes through it. */
  canSell: boolean;
  reconnect: ReconnectView | null;
  onChanged(): void;
}

/**
 * The wallet's tokens in this event's contracts, with what can be done with each: Sell while the
 * market runs, Redeem a winner or Clear a loser once settled, the countdown while redemption opens.
 */
export function EventPositions({ markets, positions, canSell, reconnect, onChanged }: EventPositionsProps) {
  const redeeming = useRedeem();
  if (positions === undefined) return <p className={styles.note}>Reading your tokens from Solana.</p>;
  const portfolio = buildPortfolio(positions, markets.filter((market) => market.onchain !== null), { wallMs: Date.now(), chainSecs: Math.floor(chainNow() / 1000) });
  const rows = [...portfolio.live, ...portfolio.awaiting, ...portfolio.redeemable, ...portfolio.opening];
  if (rows.length === 0) return <p className={styles.note}>No tokens in this event yet. A filled order mints them to your wallet.</p>;

  const redeem = async (row: PositionRow) => {
    if (await redeeming.redeem(row)) onChanged();
  };
  const action = (row: PositionRow) => {
    const name = `${word(row)} ${row.market.label}`;
    if (row.group === "live") {
      return canSell ? (
        <ButtonLink key="sell" size="row" href={marketHref(row.market, row.side, "sell")}>
          Sell<span className="sr-only">{` ${name}`}</span>
        </ButtonLink>
      ) : null;
    }
    if (row.group === "opening" && row.redeemAfter !== null) return <Countdown key="opening" to={row.redeemAfter * 1000} now={chainNow} label="redeem in" calm />;
    if (row.group !== "redeemable") return <span className={styles.soft}>awaiting result</span>;
    const won = (row.payoutMicros ?? 0n) > 0n;
    if (reconnect) {
      return (
        <Button key="reconnect" size="row" onClick={reconnect.onReconnect} data-testid="reconnect" aria-label={`Reconnect wallet to ${won ? "redeem" : "clear"} ${name}`}>
          Reconnect
        </Button>
      );
    }
    const busy = redeeming.mint === row.mint && redeeming.progress ? (redeeming.progress === "wallet" ? "Check your wallet" : "Sending") : false;
    return (
      <Button key="redeem" size="row" variant={won ? "secondary" : "quiet"} busy={busy} onClick={() => void redeem(row)} aria-label={`${won ? "Redeem" : "Clear"} ${name}`} data-testid="redeem">
        {won ? "Redeem" : "Clear"}
      </Button>
    );
  };

  return (
    <>
      <RowList label="Your position in this event" columns={COLUMNS}>
        {rows.map((row) => (
          <Row key={row.mint} cells={[`${word(row)} · ${row.market.label}`, formatContracts(row.units), value(row), action(row)]} />
        ))}
      </RowList>
      {redeeming.error && (
        <Notice tone="negative" title="Not redeemed">
          {redeeming.error}
        </Notice>
      )}
    </>
  );
}
