import type { ReactNode } from "react";
import styles from "./Timeline.module.css";

/** `skipped` is a step that did not happen; its description says so in words. */
export type StepStatus = "done" | "current" | "pending" | "skipped";

export interface TimelineStep {
  id: string;
  status: StepStatus;
  title: string;
  /** One line saying what happened, or what is being waited for. */
  description?: ReactNode;
  /** When it happened, already formatted. */
  time?: string;
  /** A link to the transaction of this step. */
  link?: ReactNode;
}

const STATUS_WORD: Record<StepStatus, string> = { done: "Done", current: "In progress", pending: "Not yet", skipped: "Did not happen" };

/** A vertical list of steps, each stamped as it completes. */
export function Timeline({ steps, label }: { steps: readonly TimelineStep[]; label: string }) {
  return (
    <ol className={styles.timeline} aria-label={label}>
      {steps.map((step) => (
        <li key={step.id} className={styles.step} data-status={step.status} aria-current={step.status === "current" ? "step" : undefined}>
          <span className={styles.mark} aria-hidden="true">
            {step.status === "done" && (
              <svg viewBox="0 0 16 16" width="16" height="16">
                <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" />
              </svg>
            )}
            {step.status === "current" && <span className={styles.pulse} />}
            {step.status === "pending" && <span className={styles.hollow} />}
            {step.status === "skipped" && <span className={styles.dash} />}
          </span>
          <div className={styles.body}>
            <p className={styles.title}>
              <span className="sr-only">{`${STATUS_WORD[step.status]}: `}</span>
              {step.title}
            </p>
            {step.description && <p className={styles.description}>{step.description}</p>}
          </div>
          {(step.time || step.link) && (
            <div className={styles.meta}>
              {step.time && <span className={styles.time}>{step.time}</span>}
              {step.link}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
