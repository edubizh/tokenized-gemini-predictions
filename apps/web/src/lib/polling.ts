"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { startPoller } from "./poller";

export interface Polled<T> {
  /** The last good value; kept while a later attempt fails. */
  data: T | undefined;
  /** The most recent failure, cleared by the next success. */
  error: Error | null;
  /** True until the first attempt has finished. */
  loading: boolean;
  /** Runs the function now; during a run, once more as soon as it ends. */
  refresh(): void;
}

/**
 * Calls `fn` now and then every `intervalMs`. Runs never overlap, and nothing runs while the tab
 * is hidden; it catches up when the tab is shown again. A failed run keeps the last good value.
 * Pass `null` as the interval to stop.
 */
export function usePolling<T>(fn: (signal: AbortSignal) => Promise<T>, intervalMs: number | null): Polled<T> {
  const [state, setState] = useState<{ data: T | undefined; error: Error | null; loading: boolean }>({ data: undefined, error: null, loading: true });
  const latest = useRef(fn);
  latest.current = fn;
  const trigger = useRef<() => void>(() => {});

  useEffect(() => {
    if (intervalMs === null) return;
    const poller = startPoller<T>({
      fn: (signal) => latest.current(signal),
      intervalMs,
      onData: (data) => setState({ data, error: null, loading: false }),
      onError: (error) => setState((previous) => ({ data: previous.data, error, loading: false })),
      paused: () => document.hidden,
    });
    const onVisibility = () => {
      if (!document.hidden) poller.refresh();
    };
    trigger.current = poller.refresh;
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      poller.stop();
      document.removeEventListener("visibilitychange", onVisibility);
      trigger.current = () => {};
    };
  }, [intervalMs]);

  const refresh = useCallback(() => trigger.current(), []);
  return { ...state, refresh };
}
