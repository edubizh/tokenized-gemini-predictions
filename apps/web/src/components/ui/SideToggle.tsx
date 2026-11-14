"use client";

import { useId } from "react";
import styles from "./SideToggle.module.css";

export type Side = "YES" | "NO";

export interface SideToggleProps {
  value: Side;
  onChange(side: Side): void;
  /** Accessible name of the group. */
  label?: string;
  /** Optional mono detail under each word, such as the ask price. */
  detail?: Partial<Record<Side, string>>;
  disabled?: boolean;
}

/**
 * Two segments with radio semantics: Tab reaches the group, the arrow keys move between YES and
 * NO. The selected segment fills with its colour; both always carry their word.
 */
export function SideToggle({ value, onChange, label = "Side", detail, disabled }: SideToggleProps) {
  const name = useId();
  return (
    <fieldset className={styles.group} disabled={disabled}>
      <legend className="sr-only">{label}</legend>
      {(["YES", "NO"] as const).map((side) => (
        <label key={side} className={`${styles.segment} ${side === "YES" ? styles.yes : styles.no}`}>
          <input type="radio" className={styles.input} name={name} value={side} checked={value === side} onChange={() => onChange(side)} />
          <span className={styles.face}>
            <span className={styles.word}>{side}</span>
            {detail?.[side] && <span className={styles.detail}>{detail[side]}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
