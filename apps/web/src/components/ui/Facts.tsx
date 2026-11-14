import type { ReactNode } from "react";
import styles from "./Facts.module.css";

/** Label and value lines, inside a Panel: a cost summary, the details of a market or an order. */
export function Facts({ label, children }: { /** Accessible name of the list, when a heading does not name it. */ label?: string; children: ReactNode }) {
  return (
    <dl className={styles.facts} aria-label={label}>
      {children}
    </dl>
  );
}

export interface FactProps {
  label: string;
  children: ReactNode;
  /** The line the others add up to. It comes last, under a hairline. */
  total?: boolean;
}

export function Fact({ label, children, total }: FactProps) {
  return (
    <div className={`${styles.fact} ${total ? styles.total : ""}`}>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.value}>{children}</dd>
    </div>
  );
}
