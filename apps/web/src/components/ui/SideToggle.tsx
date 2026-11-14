"use client";

import { Segmented } from "./Segmented";

export type Side = "YES" | "NO";

export interface SideToggleProps {
  value: Side;
  onChange(side: Side): void;
  /** Accessible name of the group. */
  label?: string;
  /** Optional figure after each word, such as the ask price. */
  detail?: Partial<Record<Side, string>>;
  disabled?: boolean;
}

/** The Yes or No choice as the order form of the previous design asks for it. New code uses Segmented. */
export function SideToggle({ value, onChange, label = "Side", detail, disabled }: SideToggleProps) {
  return (
    <Segmented
      label={label}
      value={value}
      onChange={onChange}
      stretch
      disabled={disabled}
      options={[
        { value: "YES", label: "Yes", detail: detail?.YES, tone: "yes" },
        { value: "NO", label: "No", detail: detail?.NO, tone: "no" },
      ]}
    />
  );
}
