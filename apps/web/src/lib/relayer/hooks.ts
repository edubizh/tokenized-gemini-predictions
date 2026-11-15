"use client";

// What the pages read from the relayer, each on its own beat. Every hook keeps the last good
// answer while a later read fails, and none reads while the tab is hidden.

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { ApiDepth, ApiEvent, ApiEventDetail, ApiHealth, ApiHistory, ApiMarket, ApiTrade } from "@outcome/relayer/api-types";
import { getReads } from "@/lib/chain/reads";
import { clock } from "@/lib/clock";
import { useConfig } from "@/lib/config";
import { usePolling, type Polled } from "@/lib/polling";
import { getDepth, getEvent, getEvents, getHealth, getHistory, getMarkets, getTrades } from "./client";

const HEALTH_INTERVAL_MS = 5_000;
const EVENTS_INTERVAL_MS = 5_000;
const EVENT_INTERVAL_MS = 3_000;
const DEPTH_INTERVAL_MS = 3_000;
const TRADES_INTERVAL_MS = 10_000;
const HISTORY_INTERVAL_MS = 60_000;
const ONCHAIN_MARKETS_INTERVAL_MS = 10_000;
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

/**
 * Polls what is read about one thing, named by `key`. A new key is read at once, and the answer
 * for the key before it is never given for it. Null reads nothing.
 */
function useKeyedPolling<T>(key: string | null, read: (key: string, signal: AbortSignal) => Promise<T>, intervalMs: number): Polled<T> {
  const fn = useCallback(async (signal: AbortSignal) => ({ key: key as string, value: await read(key as string, signal) }), [key, read]);
  const polled = usePolling(fn, key === null ? null : intervalMs);
  const { refresh } = polled;
  const previous = useRef(key);
  useEffect(() => {
    // Starting to read is the poller's own first read; only a change of key in mid-flight needs asking for.
    if (previous.current !== null && key !== null && previous.current !== key) refresh();
    previous.current = key;
  }, [key, refresh]);

  const current = polled.data !== undefined && polled.data.key === key ? polled.data : undefined;
  const error = key === null ? null : polled.error;
  return { data: current?.value, error, loading: key !== null && current === undefined && error === null, refresh };
}

/** Every listed event that has not expired, with its contracts and their quotes. Every 5 s. */
export function useEvents(): Polled<ApiEvent[]> {
  return usePolling(getEvents, EVENTS_INTERVAL_MS);
}

/** One event with its description and rules, expired or not. `data` is null when the relayer does not know the ticker. Every 3 s. */
export function useEvent(ticker: string): Polled<ApiEventDetail | null> {
  return useKeyedPolling(ticker, getEvent, EVENT_INTERVAL_MS);
}

/** The resting orders of the selected contract; pass null while none is selected. `data` is null for a symbol the relayer does not know. Every 3 s. */
export function useDepth(symbol: string | null): Polled<ApiDepth | null> {
  return useKeyedPolling(symbol, getDepth, DEPTH_INTERVAL_MS);
}

/** The recent trades of the selected contract, newest first. Every 10 s. */
export function useTrades(symbol: string | null): Polled<ApiTrade[] | null> {
  return useKeyedPolling(symbol, getTrades, TRADES_INTERVAL_MS);
}

/** The price history of the selected contract, oldest first. Every 60 s. */
export function useHistory(symbol: string | null): Polled<ApiHistory | null> {
  return useKeyedPolling(symbol, getHistory, HISTORY_INTERVAL_MS);
}

/** The markets that exist on-chain: only these can hold positions or orders. Every 10 s. */
export function useOnchainMarkets(): Polled<ApiMarket[]> {
  return usePolling(getMarkets, ONCHAIN_MARKETS_INTERVAL_MS);
}
