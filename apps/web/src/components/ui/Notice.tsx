import type { ReactNode } from "react";
import styles from "./Notice.module.css";

export type NoticeTone = "neutral" | "caution" | "negative" | "positive";

export interface NoticeProps {
  tone?: NoticeTone;
  title: string;
  /** One sentence: what happened and what to do next. */
  children?: ReactNode;
  /** A button or link that resolves the problem. */
  action?: ReactNode;
}

/** An inline block placed where the problem is. Errors are announced at once, the rest politely. */
export function Notice({ tone = "neutral", title, children, action }: NoticeProps) {
  return (
    <div className={`${styles.notice} ${styles[tone]}`} role={tone === "negative" ? "alert" : "status"}>
      <div className={styles.text}>
        <p className={styles.title}>{title}</p>
        {children && <p className={styles.body}>{children}</p>}
      </div>
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
