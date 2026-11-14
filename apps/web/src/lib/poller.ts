// The loop behind `usePolling`, apart from React so it can be tested: read now, then once per
// interval; never two reads at once; a failed read is reported and the loop goes on.

export interface PollerOptions<T> {
  fn(signal: AbortSignal): Promise<T>;
  intervalMs: number;
  onData(data: T): void;
  onError(error: Error): void;
  /** True while nothing should be read, as when the tab is hidden. */
  paused?(): boolean;
}

export interface Poller {
  /** Reads now. During a read, asks for one more as soon as it ends, so the answer is never older than the call. */
  refresh(): void;
  /** Ends the loop. The answer of a read still in flight is dropped. */
  stop(): void;
}

export function startPoller<T>(options: PollerOptions<T>): Poller {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;

  const run = async (): Promise<void> => {
    if (controller.signal.aborted) return;
    if (running) {
      again = true;
      return;
    }
    clearTimeout(timer);
    if (options.paused?.()) return;
    running = true;
    try {
      const data = await options.fn(controller.signal);
      if (!controller.signal.aborted) options.onData(data);
    } catch (error) {
      if (!controller.signal.aborted) options.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      running = false;
      if (!controller.signal.aborted) {
        if (again) {
          again = false;
          void run();
        } else {
          timer = setTimeout(() => void run(), options.intervalMs);
        }
      }
    }
  };

  void run();
  return {
    refresh: () => void run(),
    stop() {
      controller.abort();
      clearTimeout(timer);
    },
  };
}
