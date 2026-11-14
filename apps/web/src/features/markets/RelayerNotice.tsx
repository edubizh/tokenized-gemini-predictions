"use client";

import type { ApiHealth } from "@outcome/relayer/api-types";
import { Notice } from "@/components/ui/Notice";
import { useHealth } from "./hooks";

/** What the relayer's state means for the person looking at the page, or nothing when all is well. */
export function RelayerNoticeView({ health, offline }: { health: ApiHealth | null; offline: boolean }) {
  if (offline) {
    return (
      <Notice tone="caution" title="The relayer is not answering">
        Markets cannot be listed and new orders would not be filled until it is back. Your balances and open orders are read from Solana and are not affected.
      </Notice>
    );
  }
  if (!health) return null;
  if (health.paused.place) {
    return (
      <Notice tone="caution" title="Trading is paused">
        New orders cannot be placed right now. Orders already placed are still filled or refunded.
      </Notice>
    );
  }
  if (health.paused.fill) {
    return (
      <Notice tone="caution" title="Fills are paused">
        Open orders will not fill until this is lifted. An order that expires can be reclaimed in full.
      </Notice>
    );
  }
  if (!health.venueConnected) {
    return (
      <Notice tone="caution" title="The venue is not connected">
        The relayer cannot reach the exchange sandbox, so new orders would not fill. Holds are safe on Solana and come back when an order expires.
      </Notice>
    );
  }
  return null;
}

/** Sits at the top of every page that needs the relayer. */
export function RelayerNotice() {
  const { health, offline } = useHealth();
  const notice = RelayerNoticeView({ health, offline });
  return notice ? <div style={{ marginBottom: "var(--space-5)" }}>{notice}</div> : null;
}
