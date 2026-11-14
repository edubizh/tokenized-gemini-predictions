import type { ReactNode } from "react";
import styles from "./Facts.module.css";

/**
 * Label and value lines, inside a Panel: a cost summary, the details of a market or an order.
 * A list of this kind takes no name of its own: put a heading before it (hidden with `sr-only`
 * where the lines explain themselves) and it is found and understood.
 */
export function Facts({ children }: { children: ReactNode }) {
  return <dl className={styles.facts}>{children}</dl>;
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
