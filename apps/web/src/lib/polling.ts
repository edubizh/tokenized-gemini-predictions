"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface Polled<T> {
  /** The last good value; kept while a later attempt fails. */
  data: T | undefined;
  /** The most recent failure, cleared by the next success. */
  error: Error | null;
  /** True until the first attempt has finished. */
  loading: boolean;
  /** Runs the function now, unless a run is already in flight. */
  refresh(): void;
}

/**
 * Calls `fn` now and then every `intervalMs`. Runs never overlap, and nothing runs while the tab
 * is hidden; it catches up when the tab is shown again. Pass `null` as the interval to stop.
 */
export function usePolling<T>(fn: (signal: AbortSignal) => Promise<T>, intervalMs: number | null): Polled<T> {
  const [state, setState] = useState<{ data: T | undefined; error: Error | null; loading: boolean }>({ data: undefined, error: null, loading: true });
  const latest = useRef(fn);
  latest.current = fn;
  const trigger = useRef<() => void>(() => {});

  useEffect(() => {
    if (intervalMs === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;

    const run = async () => {
      if (running || controller.signal.aborted) return;
      clearTimeout(timer);
      if (document.hidden) return;
      running = true;
      try {
        const data = await latest.current(controller.signal);
        if (!controller.signal.aborted) setState({ data, error: null, loading: false });
      } catch (error) {
        if (!controller.signal.aborted) {
          setState((previous) => ({ data: previous.data, error: error instanceof Error ? error : new Error(String(error)), loading: false }));
        }
      } finally {
        running = false;
        if (!controller.signal.aborted) timer = setTimeout(run, intervalMs);
      }
    };
    const onVisibility = () => {
      if (!document.hidden) void run();
    };

    trigger.current = () => void run();
    document.addEventListener("visibilitychange", onVisibility);
    void run();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      trigger.current = () => {};
    };
  }, [intervalMs]);

  const refresh = useCallback(() => trigger.current(), []);
  return { ...state, refresh };
}
