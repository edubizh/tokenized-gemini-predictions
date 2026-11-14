"use client";

import { useId } from "react";
import styles from "./Segmented.module.css";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** A figure after the word, such as the price: "57¢". */
  detail?: string;
  /** Yes and No have their own faces; every other choice is neutral. */
  tone?: "yes" | "no";
}

export interface SegmentedProps<T extends string> {
  /** Accessible name of the group: "Side", "Action", "Category". */
  label: string;
  /** Two to six short options. Their values are checked against the type of `value`. */
  options: readonly SegmentedOption<NoInfer<T>>[];
  value: T;
  /** Written as a property, not a method, so that the option type is taken from `value` alone. */
  onChange: (value: T) => void;
  /** 44px by default; `row` is the compact size. */
  size?: "default" | "row";
  /** The options share the full width equally. */
  stretch?: boolean;
  disabled?: boolean;
}

/**
 * One choice among a few: Yes or No, Buy or Sell, a category. Radio semantics: Tab reaches the
 * group and the arrow keys move within it. The chosen option is filled; the others stay outlined.
 */
export function Segmented<T extends string>({ label, options, value, onChange, size = "default", stretch, disabled }: SegmentedProps<T>) {
  const name = useId();
  return (
    <fieldset className={[styles.group, size === "row" ? styles.row : "", stretch ? styles.stretch : ""].filter(Boolean).join(" ")} disabled={disabled}>
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <label key={option.value} className={styles.segment}>
          <input type="radio" className={styles.input} name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
          <span className={styles.face} data-tone={option.tone}>
            <span className={styles.word}>{option.label}</span>
            {option.detail && <span>{option.detail}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
