import Link from "next/link";
import type { ApiEvent } from "@outcome/relayer/api-types";
import { Badge } from "@/components/ui/Badge";
import { Countdown } from "@/components/ui/Countdown";
import { Panel } from "@/components/ui/Panel";
import { PriceButton } from "@/components/ui/PriceButton";
import { eventHref, marketHref } from "@/lib/routes";
import { cadenceLabel, cardRows, chancePx, chanceText, eventPhase, isQuoted, prices, volumeText } from "./derive";
import styles from "./Markets.module.css";

/**
 * One event of the index: its underlying, question and timeframe, Yes and No of its contract (or
 * of the two contracts of a ladder worth showing first), and the time left. The title leads to the
 * event; a price leads there with that contract and side chosen.
 */
export function EventCard({ event }: { event: ApiEvent }) {
  const phase = eventPhase(event, Date.now());
  const rows = cardRows(event);
  const volume = volumeText(event);
  const [only] = event.markets;
  const binary = event.shape === "binary" && only !== undefined;

  return (
    <Panel className={styles.card} data-testid="event-card" data-ticker={event.ticker}>
      <div className={styles.cardHead}>
        <span className={styles.mark} aria-hidden="true">
          {event.underlying}
        </span>
        <div className={styles.heading}>
          <h2 className={styles.cardTitle}>
            <Link href={eventHref(event.ticker)} className={styles.cardLink}>
              {event.title}
            </Link>
          </h2>
          <p className={styles.meta}>
            {[cadenceLabel(event.cadence), volume].filter(Boolean).join(" · ")}
          </p>
        </div>
        {binary && (
          <p className={styles.chance}>
            <span className={isQuoted(only) ? styles.figure : styles.none}>{isQuoted(only) ? chanceText(chancePx(only)) : "No offers"}</span>
            {isQuoted(only) && <span className={styles.caption}>chance</span>}
          </p>
        )}
      </div>

      {binary ? (
        <div className={styles.buttons}>
          <PriceButton side="YES" px={prices(only).yes} href={marketHref(only, "YES")} subject={event.title} />
          <PriceButton side="NO" px={prices(only).no} href={marketHref(only, "NO")} subject={event.title} />
        </div>
      ) : (
        <div className={styles.contracts}>
          <ul>
            {rows.markets.map((market) => {
              const quoted = isQuoted(market);
              const chance = chancePx(market);
              const subject = `${event.title}, ${market.label}`;
              return (
                <li key={market.symbol} className={styles.contract} data-testid="card-contract" data-quoted={quoted || undefined}>
                  <p className={styles.contractLine}>
                    <span className={styles.label}>{market.label}</span>
                    <span className={quoted && chance !== null ? styles.rowChance : styles.none}>{quoted ? chanceText(chance) : "No offers"}</span>
                  </p>
                  <div className={styles.buttons}>
                    <PriceButton side="YES" px={prices(market).yes} href={marketHref(market, "YES")} subject={subject} />
                    <PriceButton side="NO" px={prices(market).no} href={marketHref(market, "NO")} subject={subject} />
                  </div>
                </li>
              );
            })}
          </ul>
          {rows.more > 0 && <p className={styles.more}>+{rows.more} more</p>}
        </div>
      )}

      <p className={styles.foot}>
        {phase.phase === "live" ? (
          <>
            <Badge tone="positive" dot>
              Live
            </Badge>
            <Countdown to={event.expiresAt} label="closes in" />
          </>
        ) : phase.phase === "upcoming" ? (
          <>
            <Badge>Upcoming</Badge>
            {phase.opensAt !== null && <Countdown to={phase.opensAt} label="opens in" closedText="opening" calm />}
          </>
        ) : (
          <Badge>Closed</Badge>
        )}
      </p>
    </Panel>
  );
}
