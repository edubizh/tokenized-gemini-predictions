"use client";

import { useEffect, useState } from "react";
import { useHealth } from "@/features/markets/hooks";
import { useConfig } from "@/lib/config";
import type { Venue } from "./network";

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
