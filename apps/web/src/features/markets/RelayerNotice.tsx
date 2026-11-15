"use client";

import type { ApiHealth } from "@outcome/relayer/api-types";
import { Notice } from "@/components/ui/Notice";
import { useAccount } from "@/lib/privy/account";
import { useHealth } from "@/lib/relayer/hooks";

/** What the relayer's state means for the person looking at the page, or nothing when all is well. */
function RelayerNoticeView({ health, offline }: { health: ApiHealth | null; offline: boolean }) {
  if (offline) {
    return (
      <Notice title="The relayer is not answering">
        Markets cannot be listed and new orders would not be filled until it is back. Your balances and open orders are read from Solana and are not affected.
      </Notice>
    );
  }
  if (!health) return null;
  if (health.paused.place) {
    return (
      <Notice title="Trading is paused">
        New orders cannot be placed right now. Orders already placed are still filled or refunded.
      </Notice>
    );
  }
  if (health.paused.fill) {
    return (
      <Notice title="Fills are paused">
        Open orders will not fill until this is lifted. An order that expires can be reclaimed in full.
      </Notice>
    );
  }
  if (!health.venueConnected) {
    return (
      <Notice title="The venue is not connected">
        The relayer cannot reach the exchange sandbox, so new orders would not fill. Holds are safe on Solana and come back when an order expires.
      </Notice>
    );
  }
  return null;
}

/** Sits at the top of the pages of an account, which need the relayer for part of what they show. */
export function RelayerNotice() {
  const { health, offline } = useHealth();
  const notice = RelayerNoticeView({ health, offline });
  return notice ? <div style={{ marginBottom: "var(--space-5)" }}>{notice}</div> : null;
}

/** Solana itself is not answering, so what is on screen is the last good read. */
export function ChainNoticeView() {
  return (
    <Notice title="Solana devnet is not answering">
      Balances, tokens and open orders are shown as they were last read. The app keeps trying; nothing is lost.
    </Notice>
  );
}

/** Sits beside the relayer's notice while the wallet's accounts cannot be read. */
export function ChainNotice() {
  const { stale, balances } = useAccount();
  if (!stale || balances === null) return null;
  return (
    <div style={{ marginBottom: "var(--space-5)" }}>
      <ChainNoticeView />
    </div>
  );
}
