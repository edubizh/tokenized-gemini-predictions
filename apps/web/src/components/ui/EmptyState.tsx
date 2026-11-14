import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";

/** One sentence saying what will appear here, and one action that leads to it. No illustration. */
export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className={styles.empty}>
      <p className={styles.text}>{children}</p>
      {action}
    </div>
  );
}
