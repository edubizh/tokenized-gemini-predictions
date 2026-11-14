"use client";

import { Button } from "@/components/ui/Button";
import { Countdown, CountdownView } from "@/components/ui/Countdown";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { Notice } from "@/components/ui/Notice";
import { Stamp } from "@/components/ui/Stamp";
import { Timeline, type TimelineStep } from "@/components/ui/Timeline";
import { formatClock } from "@/features/markets/wording";
import { formatContracts, formatPrice, shortAddress } from "@/lib/format";
import type { SendProgress } from "./Ticket";
import type { DerivedTimeline } from "./timeline";
import styles from "./Ticket.module.css";

export interface ReclaimState {
  onReclaim(): void;
  progress: SendProgress | null;
  /** Why the last attempt failed. */
  error: string | null;
}

export interface OrderTimelineViewProps {
  timeline: DerivedTimeline;
  /** Shown before the terms when the order is listed away from its market. */
  marketTitle?: string;
  txUrl(signature: string): string;
  /** The cluster clock, unix milliseconds: order deadlines are on-chain. */
  chainNow(): number;
  /** Freezes the expiry countdown at this cluster time, for the gallery. */
  frozenAtMs?: number;
  /** Called when the expiry countdown reaches zero, so the caller can derive the timeline again. */
  onExpired?(): void;
  reclaim?: ReclaimState;
  onPlaceAnother?(): void;
  /**
   * `slip` is the ticket turned receipt; `entry` is a row in a list of orders; `detail` is the
   * steps alone, under a row that already shows the order's terms and stamp.
   */
  variant?: "slip" | "entry" | "detail";
  timeZone?: string;
}

/** An order as its terms on one line, four stamped steps, and whatever can still be done about it. */
export function OrderTimelineView({ timeline, marketTitle, txUrl, chainNow, frozenAtMs, onExpired, reclaim, onPlaceAnother, variant = "entry", timeZone }: OrderTimelineViewProps) {
  const steps: TimelineStep[] = timeline.steps.map((step) => ({
    id: step.id,
    status: step.status,
    title: step.title,
    description:
      step.text || step.detail ? (
        <>
          {step.text}
          {step.detail && <span className={styles.stepDetail}>{step.detail}</span>}
        </>
      ) : undefined,
    time: step.atMs === null ? undefined : formatClock(step.atMs, { seconds: true, zone: true, timeZone }),
    link: step.signature ? (
      <ExternalLink href={txUrl(step.signature)} mono>
        {shortAddress(step.signature)}
      </ExternalLink>
    ) : undefined,
  }));
  const expiresAtMs = timeline.expiresAt * 1000;
  const running = timeline.open && !timeline.canReclaim && expiresAtMs > (frozenAtMs ?? chainNow());
  const terms = `Buy ${timeline.side} ${formatContracts(timeline.units)} at ${formatPrice(timeline.limitPx)}`;
  const showFoot = running || (timeline.canReclaim && reclaim) || onPlaceAnother;

  return (
    <article className={variant === "slip" ? styles.slip : variant === "detail" ? styles.detail : styles.entry} aria-label={`${marketTitle ? `${marketTitle}: ` : ""}${terms}`} data-testid={`order-${variant}`} data-stamp={timeline.stamp}>
      {variant !== "detail" && (
        <div className={styles.summaryLine}>
          <p className={styles.terms}>
            <span className={styles.kind}>Buy</span>
            <span className={`${styles.side} ${timeline.side === "YES" ? styles.yes : styles.no}`}>{timeline.side}</span>
            <span className={styles.figure}>{formatContracts(timeline.units)}</span>
            <span className={styles.at}>at</span>
            <span className={styles.figure}>{formatPrice(timeline.limitPx)}</span>
            {marketTitle && <span className={styles.at}>{`· ${marketTitle}`}</span>}
          </p>
          <Stamp value={timeline.stamp} />
        </div>
      )}

      <Timeline steps={steps} label={`Progress of the order to ${terms.toLowerCase()}`} />

      {reclaim?.error && (
        <Notice tone="negative" title="The hold was not reclaimed">
          {reclaim.error}
        </Notice>
      )}

      {showFoot && (
        <div className={styles.foot}>
          {running ? (
            frozenAtMs === undefined ? (
              <Countdown to={expiresAtMs} now={chainNow} label="order expires in" closedText="order expired" calm onClosed={onExpired} />
            ) : (
              <CountdownView remainingMs={expiresAtMs - frozenAtMs} label="order expires in" closedText="order expired" calm />
            )
          ) : (
            timeline.canReclaim && reclaim && <span className={styles.footNote}>The relayer can no longer fill this order.</span>
          )}
          <div className={styles.actions}>
            {timeline.canReclaim && reclaim && (
              <Button size={variant === "slip" ? "default" : "row"} block={variant === "slip"} onClick={reclaim.onReclaim} busy={reclaim.progress === "wallet" ? "Check your wallet" : reclaim.progress === "sending" ? "Sending" : false}>
                Reclaim hold
              </Button>
            )}
            {onPlaceAnother && (
              <Button size={variant === "slip" ? "default" : "row"} block={variant === "slip"} onClick={onPlaceAnother}>
                Place another order
              </Button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
