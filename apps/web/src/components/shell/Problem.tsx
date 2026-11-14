import type { ReactNode } from "react";
import styles from "./Problem.module.css";

/** A page with nothing else to show: what kind of problem, one sentence, one way back. */
export function ProblemView({ kind, title, children, action }: { kind: string; title: string; children: ReactNode; action: ReactNode }) {
  return (
    <div className={styles.problem} data-testid="problem">
      <p className={styles.kind}>{kind}</p>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.text}>{children}</p>
      <div className={styles.action}>{action}</div>
    </div>
  );
}
