"use client";

import { useCallback } from "react";
import { PageHeader } from "@/components/shell/Shell";
import { useVenue } from "@/components/shell/NetworkStrip";
import { explorerAddressUrl, useConfig } from "@/lib/config";
import { usePolling } from "@/lib/polling";
import { getStatus } from "@/lib/relayer/client";
import { useHealth, useOnchainMarkets } from "@/lib/relayer/hooks";
import { SystemView, type SystemAddresses } from "./SystemView";

const STATUS_INTERVAL_MS = 5_000;

/** Readable without a login: nothing here is about one wallet. */
export function SystemPage({ addresses }: { addresses: SystemAddresses }) {
  const config = useConfig();
  const venue = useVenue();
  const { health, offline } = useHealth();
  const status = usePolling(
    useCallback((signal: AbortSignal) => getStatus(signal), []),
    STATUS_INTERVAL_MS,
  );
  const markets = useOnchainMarkets();

  return (
    <>
      <PageHeader title="How it works">
        A program on Solana devnet holds each order&apos;s test dollars. A relayer places the matching order at a venue, and tokens are minted only after that order fills. This page says what is trusted, and shows the relayer&apos;s own books.
      </PageHeader>
      <SystemView
        venue={venue}
        health={health}
        offline={offline}
        status={offline || status.error ? null : (status.data ?? null)}
        markets={markets.data ?? []}
        addresses={addresses}
        nowMs={Date.now()}
        addressUrl={(address) => explorerAddressUrl(config, address)}
      />
    </>
  );
}
