"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { durationSpoken, durationText, msUntilTextChanges } from "./duration";
import styles from "./Countdown.module.css";

const CLOSING_MS = 2 * 60 * 1000;

export type CountdownState = "running" | "closing" | "closed";

export function countdownState(remainingMs: number): CountdownState {
  return remainingMs <= 0 ? "closed" : remainingMs <= CLOSING_MS ? "closing" : "running";
}

export interface CountdownViewProps {
  /** Milliseconds left; null before the first tick. */
  remainingMs: number | null;
  /** Short words before the time: "closes in", "expires in", "opens in". */
  label: string;
  /** `display` is for the one number that matters on a screen. */
  size?: "inline" | "display";
  /** Words used when time is up. */
  closedText?: string;
  /** Leaves out the "closing" state of the last two minutes, for deadlines that are always short. */
  calm?: boolean;
  /**
   * Speaks when the last two minutes begin and when time is up. For the one countdown that matters
   * on a page, never for the countdowns of a list: without it a countdown is read, not announced.
   */
  announce?: boolean;
}

/** The time left in a sentence, as a screen reader finds it when it reads here. */
function spoken(state: CountdownState, label: string, remainingMs: number, closedText: string): string {
  if (state === "closed") return closedText;
  return `${label} ${durationSpoken(remainingMs, state === "closing")}${state === "closing" ? ", closing" : ""}`.trim();
}

/** The figure for a given time left. `Countdown` drives it from a clock. */
export function CountdownView({ remainingMs, label, size = "inline", closedText = "closed", calm, announce }: CountdownViewProps) {
  const timed = remainingMs === null ? "running" : countdownState(remainingMs);
  const state = calm && timed === "closing" ? "running" : timed;
  return (
    <span className={`${styles.countdown} ${size === "display" ? styles.display : ""}`} data-state={state}>
      {/* The ticking figure is for the eye. The sentence after it is what a screen reader reads: current, and silent. */}
      <span aria-hidden="true" className={styles.visual}>
        {state === "closed" ? (
          <span className={styles.note}>{closedText}</span>
        ) : (
          <>
            {label && <span className={styles.label}>{label}</span>}
            <span className={styles.time}>{remainingMs === null ? "–:––" : durationText(remainingMs)}</span>
            {state === "closing" && <span className={styles.note}>closing</span>}
          </>
        )}
      </span>
      <span className="sr-only">{remainingMs === null ? "" : spoken(state, label, remainingMs, closedText)}</span>
      {announce && <Announcement state={remainingMs === null ? null : state} label={label} closedText={closedText} />}
    </span>
  );
}

/**
 * A live region that stays empty until the state changes after its first reading, so nothing is
 * said as the page loads; then it says that the end is near, and that it has come.
 */
function Announcement({ state, label, closedText }: { state: CountdownState | null; label: string; closedText: string }) {
  const [seen, setSeen] = useState(state);
  const [text, setText] = useState("");
  if (state !== seen) {
    setSeen(state);
    if (seen !== null && state !== null) setText(state === "closed" ? closedText : state === "closing" ? `${label} under two minutes`.trim() : "");
  }
  return (
    <span className="sr-only" role="status">
      {text}
    </span>
  );
}

export interface CountdownProps extends Omit<CountdownViewProps, "remainingMs"> {
  /** The deadline, unix milliseconds, on the same clock as `now`. */
  to: number;
  /** The clock to count on. Defaults to the local wall clock; pass the chain clock for on-chain deadlines. */
  now?: () => number;
  /** Called once when the countdown reaches zero. */
  onClosed?(): void;
}

/**
 * Wakes only when the figure is due to change: every second under an hour, every minute or hour
 * above. Renders a placeholder until mounted so server and client markup agree.
 */
export function Countdown({ to, now = Date.now, onClosed, ...view }: CountdownProps) {
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  // Read through effect events: a new function on every render neither restarts the clock nor goes stale.
  const readNow = useEffectEvent(now);
  const closed = useEffectEvent(() => onClosed?.());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const left = to - readNow();
      setRemainingMs(left);
      if (left <= 0) closed();
      else timer = setTimeout(tick, msUntilTextChanges(left));
    };
    tick();
    return () => clearTimeout(timer);
  }, [to]);

  return <CountdownView remainingMs={remainingMs} {...view} />;
}
