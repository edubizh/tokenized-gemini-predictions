import type { ReactNode } from "react";
import styles from "./ExternalLink.module.css";

/** A link that leaves the app, such as a transaction on the explorer. Opens in a new tab and says so. */
export function ExternalLink({ href, children, mono }: { href: string; children: ReactNode; mono?: boolean }) {
  return (
    <a className={`${styles.link} ${mono ? styles.mono : ""}`} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span className={styles.arrow} aria-hidden="true">
        ↗
      </span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
