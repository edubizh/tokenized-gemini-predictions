"use client";

import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Countdown, CountdownView } from "@/components/ui/Countdown";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { Notice } from "@/components/ui/Notice";
import { Panel } from "@/components/ui/Panel";
import { Timeline, type TimelineStep } from "@/components/ui/Timeline";
import { formatClock } from "@/features/markets/wording";
import { formatCents, formatContracts, shortAddress } from "@/lib/format";
import type { ReconnectView } from "@/lib/privy/reconnect";
import { ReconnectWords } from "@/lib/privy/ReconnectWords";
import type { SendProgress } from "./Ticket";
import type { DerivedTimeline, OrderStamp } from "./timeline";
import styles from "./OrderTimeline.module.css";

export interface ReclaimState {
  onReclaim(): void;
  progress: SendProgress | null;
  /** Why the last attempt failed. */
  error: string | null;
  /** Set while the trading wallet is not connected in this tab: reconnecting takes Reclaim's place. */
  reconnect?: ReconnectView | null;
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
   * `slip` is the order in the trade panel's place; `entry` is one order in a list; `detail` is
   * the steps alone, under a row that already shows the order's terms and status.
   */
  variant?: "slip" | "entry" | "detail";
  timeZone?: string;
}

const STATUS: Record<OrderStamp, { word: string; tone: BadgeTone }> = {
  OPEN: { word: "Open", tone: "neutral" },
  FILLED: { word: "Filled", tone: "positive" },
  REFUNDED: { word: "Refunded", tone: "neutral" },
  EXPIRED: { word: "Expired", tone: "neutral" },
};

/** An order: its terms and status, its steps with their transactions, and what can still be done about it. */
export function OrderTimelineView({ timeline, marketTitle, txUrl, chainNow, frozenAtMs, onExpired, reclaim, onPlaceAnother, variant = "entry", timeZone }: OrderTimelineViewProps) {
  const steps: TimelineStep[] = timeline.steps.map((step) => ({
    id: step.id,
    status: step.status,
    title: step.title,
    description:
      step.text || step.detail ? (
        <>
          {step.text}
          {step.detail && <span className={styles.detailLine}>{step.detail}</span>}
        </>
      ) : undefined,
    time: step.atMs === null ? undefined : formatClock(step.atMs, { seconds: true, timeZone }),
    link: step.signature ? <ExternalLink href={txUrl(step.signature)}>{shortAddress(step.signature)}</ExternalLink> : undefined,
  }));
  const expiresAtMs = timeline.expiresAt * 1000;
  const running = timeline.open && !timeline.canReclaim && expiresAtMs > (frozenAtMs ?? chainNow());
  const selling = timeline.kind === "sell";
  const terms = `${selling ? "Sell" : "Buy"} ${timeline.side === "YES" ? "Yes" : "No"} · ${formatContracts(timeline.units)} at ${formatCents(timeline.limitPx)}`;
  const slip = variant === "slip";
  const size = slip ? "default" : "row";
  const reconnect = timeline.canReclaim ? (reclaim?.reconnect ?? null) : null;
  const status = STATUS[timeline.stamp];

  const body: ReactNode = (
    <>
      {variant !== "detail" && (
        <div className={styles.head}>
          <div>
            <p className={styles.terms}>{terms}</p>
            {marketTitle && <p className={styles.soft}>{marketTitle}</p>}
          </div>
          <Badge tone={status.tone}>{status.word}</Badge>
        </div>
      )}

      <Timeline steps={steps} label={`Steps of the order: ${terms}`} />

      {reclaim?.error && (
        <Notice tone="negative" title={selling ? "The tokens were not reclaimed" : "The hold was not reclaimed"}>
          {reclaim.error}
        </Notice>
      )}

      {running &&
        (frozenAtMs === undefined ? (
          <Countdown to={expiresAtMs} now={chainNow} label="order expires in" closedText="order expired" calm onClosed={onExpired} />
        ) : (
          <CountdownView remainingMs={expiresAtMs - frozenAtMs} label="order expires in" closedText="order expired" calm />
        ))}

      {timeline.canReclaim && reclaim && (
        <div className={styles.foot}>
          <p className={styles.soft} role={reconnect ? "status" : undefined}>
            {reconnect ? <ReconnectWords reconnect={reconnect} /> : "The relayer can no longer fill this order."}
          </p>
          {reconnect ? (
            <Button key="reconnect" size={size} block={slip} onClick={reconnect.onReconnect} data-testid="reconnect">
              Reconnect wallet
            </Button>
          ) : (
            <Button key="reclaim" size={size} block={slip} onClick={reclaim.onReclaim} busy={reclaim.progress === "wallet" ? "Check your wallet" : reclaim.progress === "sending" ? "Sending" : false}>
              {selling ? "Reclaim tokens" : "Reclaim hold"}
            </Button>
          )}
        </div>
      )}

      {onPlaceAnother && (
        <Button size={size} block={slip} onClick={onPlaceAnother} data-testid="place-another">
          Place another order
        </Button>
      )}
    </>
  );

  const shared = { "aria-label": `${marketTitle ? `${marketTitle}: ` : ""}${terms}`, "data-testid": `order-${variant}`, "data-stamp": timeline.stamp };
  return variant === "detail" ? (
    <div className={styles.order} {...shared}>
      {body}
    </div>
  ) : (
    <Panel className={styles.order} role="article" {...shared}>
      {body}
    </Panel>
  );
}
