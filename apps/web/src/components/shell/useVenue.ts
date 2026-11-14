"use client";

import { useState } from "react";
import { useHealth } from "@/features/markets/hooks";
import { useConfig } from "@/lib/config";
import type { Venue } from "./network";

/**
 * The venue the relayer last reported in `/health`; until it answers, what the server knows.
 * It is remembered, not derived: `health` is null again while the relayer cannot be reached, and a
 * relayer that trades on the simulated venue must not be shown as the sandbox for that time.
 */
export function useVenue(): Venue {
  const config = useConfig();
  const { health } = useHealth();
  const [venue, setVenue] = useState<Venue>(config.fixtures ? "mock" : "sandbox");
  // Adjusted while rendering, so no render ever shows a venue older than the last report.
  if (health && health.venue !== venue) setVenue(health.venue);
  return venue;
}
