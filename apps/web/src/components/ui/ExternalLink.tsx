import type { ReactNode } from "react";
import styles from "./ExternalLink.module.css";

export interface ExternalLinkProps {
  href: string;
  children: ReactNode;
  /** Accepted from pages of the previous design; it no longer changes anything. */
  mono?: boolean;
}

/** A transaction or an address on the explorer. Opens in a new tab and says so. */
export function ExternalLink({ href, children }: ExternalLinkProps) {
  return (
    <a className={styles.link} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <svg className={styles.arrow} viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
        <path d="M2.5 7.5l5-5M3.5 2.5h4v4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
