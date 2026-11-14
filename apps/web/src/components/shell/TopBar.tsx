import Link from "next/link";
import type { ReactNode } from "react";
import { formatDollars } from "@/lib/format";
import { Skeleton } from "@/components/ui/Skeleton";
import styles from "./TopBar.module.css";

export const NAV = [
  { href: "/markets", label: "Markets" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/activity", label: "Activity" },
] as const;

export interface TopBarProps {
  /** The current path, to mark the current page. */
  pathname: string;
  /** Markets, Portfolio and Activity need a login, so they are shown only with one. */
  showNav: boolean;
  /**
   * Test-dollar balance in micro-dollars. `null` shows a placeholder while it loads; `undefined`
   * leaves the balance out (logged out, or nothing deployed yet).
   */
  balanceMicros?: bigint | null;
  /** The account menu, or a log in button. */
  account?: ReactNode;
}

function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function TopBar({ pathname, showNav, balanceMicros, account }: TopBarProps) {
  return (
    <header className={styles.bar}>
      <div className={styles.inner}>
        <Link href="/" className={styles.wordmark}>
          Outcome Tokens
        </Link>

        {showNav && (
          <nav className={styles.nav} aria-label="Main">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className={styles.link} aria-current={isCurrent(pathname, item.href) ? "page" : undefined}>
                {item.label}
              </Link>
            ))}
          </nav>
        )}

        <div className={styles.right}>
          {balanceMicros !== undefined && (
            <p className={styles.balance}>
              <span className={styles.balanceLabel}>Test dollars</span>
              <span className={styles.balanceValue}>{balanceMicros === null ? <Skeleton width="5.5rem" height="1.1em" /> : formatDollars(balanceMicros)}</span>
            </p>
          )}
          {account}
        </div>
      </div>
    </header>
  );
}
