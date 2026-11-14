import styles from "./Stamp.module.css";

export const STAMP_VALUES = ["OPEN", "FILLED", "REFUNDED", "EXPIRED", "SETTLED", "REDEEMABLE", "REDEEMED", "LOST", "HALTED"] as const;
export type StampValue = (typeof STAMP_VALUES)[number];

const TONE: Record<StampValue, "ink" | "positive" | "caution" | "muted"> = {
  OPEN: "ink",
  REFUNDED: "ink",
  FILLED: "positive",
  REDEEMABLE: "positive",
  REDEEMED: "positive",
  EXPIRED: "caution",
  HALTED: "caution",
  LOST: "muted",
  SETTLED: "muted",
};

/** A status label. Each value has one fixed colour, and the word itself always carries the meaning. */
export function Stamp({ value }: { value: StampValue }) {
  return <span className={`${styles.stamp} ${styles[TONE[value]]}`}>{value}</span>;
}
