import Link from "next/link";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatDollars } from "@/lib/format";
import { networkMark, type Cluster } from "./network";
import styles from "./Navbar.module.css";

/** The four destinations, shown to everyone, logged in or not. */
const NAV = [
  { href: "/markets", label: "Markets" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/activity", label: "Activity" },
  { href: "/vaults", label: "Vaults" },
] as const;

function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The quiet, permanent test-network notice: a jade dot, the network, and "test funds". */
export function NetworkMark({ cluster }: { cluster: Cluster }) {
  const words = networkMark(cluster);
  return (
    <p className={styles.mark}>
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.full}>{words.full}</span>
      <span className={styles.short}>{words.short}</span>
    </p>
  );
}

export interface NavbarProps {
  /** The current path, to mark the current page. */
  pathname: string;
  cluster: Cluster;
  /**
   * Test-dollar balance in micro-dollars. `null` shows a placeholder while it loads; `undefined`
   * leaves the balance out (logged out, or nothing deployed yet).
   */
  balanceMicros?: bigint | null;
  /** The wallet control: the account menu, or a log in button. */
  account?: ReactNode;
  /** Drawn in place instead of stuck to the top of the window, for the reference page. */
  inline?: boolean;
}

/** The see-through bar on every page: where you are, which network, how much, and whose wallet. */
export function Navbar({ pathname, cluster, balanceMicros, account, inline }: NavbarProps) {
  return (
    <header className={`${styles.bar} ${inline ? styles.inline : ""}`}>
      <div className={styles.inner}>
        <Link href="/" className={styles.brand}>
          Outcome Tokens
        </Link>

        <nav className={styles.nav} aria-label="Main">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className={styles.link} data-label={item.label} aria-current={isCurrent(pathname, item.href) ? "page" : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>

        <NetworkMark cluster={cluster} />

        {balanceMicros !== undefined && (
          <p className={styles.balance}>
            <span className="sr-only">Test dollar balance: </span>
            {balanceMicros === null ? <Skeleton width="4.5rem" height="1em" /> : formatDollars(balanceMicros)}
          </p>
        )}

        {account && <div className={styles.account}>{account}</div>}
      </div>
    </header>
  );
}
