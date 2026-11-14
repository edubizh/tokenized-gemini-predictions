import type { ReactNode } from "react";
import styles from "./Badge.module.css";

export type BadgeTone = "neutral" | "positive" | "negative";

export interface BadgeProps {
  /** `positive` for filled, redeemable, live; `negative` for an error; `neutral` for everything else. */
  tone?: BadgeTone;
  /** A small dot before the word, for something that is live right now. */
  dot?: boolean;
  children: ReactNode;
}

/** The status of one thing in a word. The word carries the meaning; the tone only supports it. */
export function Badge({ tone = "neutral", dot, children }: BadgeProps) {
  return (
    <span className={`${styles.badge} ${tone === "neutral" ? "" : styles[tone]}`}>
      {dot && <span className={styles.dot} aria-hidden="true" />}
      {children}
    </span>
  );
}
