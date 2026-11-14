"use client";

import Link from "next/link";
import { DISCLAIMER, venueLine, type Venue } from "./network";
import { useVenue } from "./useVenue";
import styles from "./Footer.module.css";

/** The footer for a given venue: the standing line, then where orders go. */
export function FooterView({ venue }: { venue: Venue }) {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <p>
          {DISCLAIMER} {venueLine(venue)}
        </p>
        <Link href="/system">How it works</Link>
      </div>
    </footer>
  );
}

/** At the end of every page, following the venue the relayer trades on. */
export function Footer() {
  return <FooterView venue={useVenue()} />;
}
