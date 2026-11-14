"use client";

import { useEffect, useState } from "react";
import { useHealth } from "@/features/markets/hooks";
import { useConfig } from "@/lib/config";
import { networkNotice, type Venue } from "./network";
import styles from "./NetworkStrip.module.css";

/** The fixed notice for a given venue. It cannot be dismissed. */
export function NetworkStripView({ venue, fixed = true }: { venue: Venue; fixed?: boolean }) {
  const [where, value] = networkNotice(venue);
  return (
    <div className={`${styles.strip} ${fixed ? styles.fixed : ""}`} role="note" aria-label="Test network notice">
      <p className={styles.text}>
        <span>{where}</span> <span>{value}</span>
      </p>
    </div>
  );
}

/** The venue the relayer last reported in `/health`; until it answers, what the server knows. */
export function useVenue(): Venue {
  const config = useConfig();
  const { health } = useHealth();
  const [venue, setVenue] = useState<Venue>(config.fixtures ? "mock" : "sandbox");
  useEffect(() => {
    if (health) setVenue(health.venue);
  }, [health]);
  return venue;
}

/** Fixed at the top of every page, following the venue the relayer trades on. */
export function NetworkStrip() {
  return <NetworkStripView venue={useVenue()} />;
}
