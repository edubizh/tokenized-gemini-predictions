"use client";

import { useEffect, useState } from "react";
import { countdownParts, spokenDuration } from "@/lib/format";
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
  /** `display` is for the single most important number on a screen. */
  size?: "inline" | "display";
  /** Words used when time is up. */
  closedText?: string;
  /** Keeps the last two minutes in the ordinary colour, for deadlines that are always short. */
  calm?: boolean;
}

/** The figure for a given time left. `Countdown` drives it from a clock. */
export function CountdownView({ remainingMs, label, size = "inline", closedText = "closed", calm }: CountdownViewProps) {
  const timed = remainingMs === null ? "running" : countdownState(remainingMs);
  const state = calm && timed === "closing" ? "running" : timed;
  return (
    <span className={`${styles.countdown} ${size === "display" ? styles.display : ""}`} data-state={state}>
      {/* The ticking figure is hidden from screen readers; the line below speaks on state changes. */}
      <span aria-hidden="true" className={styles.visual}>
        {state === "closed" ? (
          <span className={styles.note}>{closedText}</span>
        ) : (
          <>
            {label && <span className={styles.label}>{label}</span>}
            <span className={styles.time}>{remainingMs === null ? "–:––" : countdownParts(remainingMs).text}</span>
            {state === "closing" && <span className={styles.note}>closing</span>}
          </>
        )}
      </span>
      <span className="sr-only" role="status">
        {remainingMs === null ? "" : <Spoken state={state} label={label} remainingMs={remainingMs} closedText={closedText} />}
      </span>
    </span>
  );
}

/** Re-renders its text only when the state changes, so it is announced then and not every second. */
function Spoken({ state, label, remainingMs, closedText }: { state: CountdownState; label: string; remainingMs: number; closedText: string }) {
  const [spoken, setSpoken] = useState({ state, text: describe(state, label, remainingMs, closedText) });
  if (spoken.state !== state) setSpoken({ state, text: describe(state, label, remainingMs, closedText) });
  return <>{spoken.text}</>;
}

function describe(state: CountdownState, label: string, remainingMs: number, closedText: string): string {
  if (state === "closed") return closedText;
  const rounded = state === "closing" ? remainingMs : Math.ceil(remainingMs / 60_000) * 60_000;
  return `${label} ${state === "closing" ? "" : "about "}${spokenDuration(rounded)}${state === "closing" ? ", closing" : ""}`;
}

export interface CountdownProps extends Omit<CountdownViewProps, "remainingMs"> {
  /** The deadline, unix milliseconds, on the same clock as `now`. */
  to: number;
  /** The clock to count on. Defaults to the local wall clock; pass the chain clock for on-chain deadlines. */
  now?: () => number;
  /** Called once when the countdown reaches zero. */
  onClosed?(): void;
}

/** Ticks once per second. Renders a placeholder until mounted so server and client markup agree. */
export function Countdown({ to, now = Date.now, onClosed, ...view }: CountdownProps) {
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let done = false;
    const tick = () => {
      const left = to - now();
      setRemainingMs(left);
      if (left <= 0) {
        if (!done) onClosed?.();
        done = true;
        return;
      }
      // Wake just after the next whole second of the remaining time.
      timer = setTimeout(tick, (left % 1000 || 1000) + 5);
    };
    tick();
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, now]);

  return <CountdownView remainingMs={remainingMs} {...view} />;
}
