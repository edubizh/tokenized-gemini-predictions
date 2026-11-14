"use client";

import { createContext, createElement, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";
import type { ApiHealth, ApiMarket } from "@outcome/relayer/api-types";
import { getReads } from "@/lib/chain/reads";
import { clock } from "@/lib/clock";
import { useConfig } from "@/lib/config";
import { usePolling, type Polled } from "@/lib/polling";
import { getHealth, getMarket, getMarkets } from "@/lib/relayer/client";

const HEALTH_INTERVAL_MS = 5_000;
const MARKETS_INTERVAL_MS = 3_000;
const MARKET_INTERVAL_MS = 2_000;
/** How often the clock is read from the cluster while the relayer cannot be asked for it, and how soon after a failed read. */
const CLUSTER_CLOCK_INTERVAL_MS = 30_000;
const CLUSTER_CLOCK_RETRY_MS = 10_000;

export interface HealthState {
  /** The relayer's last answer; null before the first one and while it cannot be reached. */
  health: ApiHealth | null;
  /** True when the last attempt failed. */
  offline: boolean;
  /** True until the first attempt has finished. */
  loading: boolean;
}

const HealthContext = createContext<HealthState | null>(null);

/** Polls the relayer's `/health` once for the whole app and keeps the app's clock aligned with the cluster. Mounted in the root layout. */
export function HealthProvider({ children }: { children: ReactNode }) {
  const config = useConfig();
  const clusterClockReadAt = useRef(0);
  const read = useCallback(
    async (signal: AbortSignal) => {
      try {
        const health = await getHealth(signal);
        clock.sync(health.chainTime);
        return health;
      } catch (error) {
        // Without the relayer the clock is read from the cluster itself, so that an order's expiry
        // and the opening of redemption are still counted on the clock the program uses.
        if (!signal.aborted && Date.now() - clusterClockReadAt.current >= CLUSTER_CLOCK_INTERVAL_MS) {
          clusterClockReadAt.current = Date.now();
          await getReads(config)
            .fetchClusterTime()
            .then(
              (seconds) => clock.sync(seconds),
              () => {
                // Tried again sooner than after a good read; until then the last alignment stands.
                clusterClockReadAt.current = Date.now() - CLUSTER_CLOCK_INTERVAL_MS + CLUSTER_CLOCK_RETRY_MS;
              },
            );
        }
        throw error;
      }
    },
    [config],
  );
  const polled = usePolling(read, HEALTH_INTERVAL_MS);
  const offline = polled.error !== null;
  const health = offline ? null : (polled.data ?? null);
  const value = useMemo<HealthState>(() => ({ health, offline, loading: polled.loading }), [health, offline, polled.loading]);
  return createElement(HealthContext.Provider, { value }, children);
}

export function useHealth(): HealthState {
  const state = useContext(HealthContext);
  if (!state) throw new Error("useHealth must be used inside HealthProvider");
  return state;
}

/** The cluster clock in unix milliseconds, for countdowns to on-chain deadlines. */
export function chainNow(): number {
  return clock.chainNowMs();
}

export function useMarkets(scope: "live" | "all" = "live"): Polled<ApiMarket[]> {
  const read = useCallback((signal: AbortSignal) => getMarkets(scope, signal), [scope]);
  return usePolling(read, MARKETS_INTERVAL_MS);
}

/** One market. `data` is null when the relayer does not know the symbol. */
export function useMarket(symbol: string): Polled<ApiMarket | null> {
  const read = useCallback((signal: AbortSignal) => getMarket(symbol, signal), [symbol]);
  return usePolling(read, MARKET_INTERVAL_MS);
}
