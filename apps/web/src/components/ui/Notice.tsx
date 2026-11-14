import type { ReactNode } from "react";
import styles from "./Notice.module.css";

/** `caution` is kept for pages of the previous design and is drawn as `neutral`. */
export type NoticeTone = "neutral" | "positive" | "negative" | "caution";

export interface NoticeProps {
  tone?: NoticeTone;
  title: string;
  /** One sentence: what happened and what to do next. */
  children?: ReactNode;
  /** Up to two buttons or links: the way forward, and for a wait, Retry and Cancel. */
  action?: ReactNode;
  /** Something is being waited for: the mark becomes a spinner. The title says what, and is what gets announced. */
  busy?: boolean;
}

/**
 * A message placed where it applies: waiting, done, went wrong, nothing here yet. Errors are
 * announced at once, the rest politely.
 */
export function Notice({ tone = "neutral", title, children, action, busy }: NoticeProps) {
  const look = tone === "positive" ? styles.positive : tone === "negative" ? styles.negative : "";
  return (
    <div className={`${styles.notice} ${look}`} role={tone === "negative" ? "alert" : "status"}>
      <span className={busy ? styles.spinner : styles.mark} aria-hidden="true" />
      <div className={styles.text}>
        <p className={styles.title}>{title}</p>
        {children && <p className={styles.body}>{children}</p>}
      </div>
      {action && <div className={styles.actions}>{action}</div>}
    </div>
  );
}
