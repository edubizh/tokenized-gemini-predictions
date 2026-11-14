import type { ReactNode } from "react";
import styles from "./Receipt.module.css";

export interface ReceiptProps {
  /** Small heading at the top: "Order receipt", "Redemption". */
  title?: string;
  /** A stamp or other mark opposite the title. */
  mark?: ReactNode;
  /** Which edge is perforated. */
  edge?: "top" | "bottom";
  /** Text under the lines, such as "Anything unused is refunded." */
  note?: ReactNode;
  children: ReactNode;
}

/** Key and value lines joined by dotted leaders, on raised paper with one perforated edge. */
export function Receipt({ title, mark, edge = "top", note, children }: ReceiptProps) {
  return (
    <div className={`${styles.receipt} ${edge === "top" ? styles.edgeTop : styles.edgeBottom}`}>
      {(title || mark) && (
        <div className={styles.head}>
          {title && <p className={styles.title}>{title}</p>}
          {mark}
        </div>
      )}
      <dl className={styles.lines}>{children}</dl>
      {note && <p className={styles.note}>{note}</p>}
    </div>
  );
}

export interface ReceiptLineProps {
  label: string;
  /** The value, set in mono. */
  children: ReactNode;
  /** Totals are set apart by a dashed rule. */
  total?: boolean;
}

export function ReceiptLine({ label, children, total }: ReceiptLineProps) {
  return (
    <div className={`${styles.line} ${total ? styles.total : ""}`}>
      <dt className={styles.key}>{label}</dt>
      <span className={styles.leader} aria-hidden="true" />
      <dd className={styles.value}>{children}</dd>
    </div>
  );
}
