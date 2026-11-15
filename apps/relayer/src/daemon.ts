// The relayer's four loops: orders, markets, settlement and reconciliation. Each loop runs one
// tick at a time, turns a failure into an alert and carries on. Health and status are built from
// what the ticks last saw, never from a network call.

import type { ApiHealth, ApiStatus } from "./api/types.ts";
import type { Chain, ChainConfig, MarketChain } from "./chain/chain.ts";
import type { Journal, OrderState } from "./journal.ts";
import { RefreshError } from "./markets.ts";
import type { MarketManager } from "./markets.ts";
import { DEFAULT_PIPELINE_CONFIG, processOrder, recover } from "./pipeline.ts";
import type { OrderVenue, PipelineConfig, PipelineDeps } from "./pipeline.ts";
import type { Reconciler } from "./reconcile.ts";

export interface AlertEvent {
  kind: string;
  orderAddress: string | null;
  detail: string;
}

export interface AlertLog {
  /** Records the alert and writes it to the log. */
  alert(event: AlertEvent): void;
  /** The alerts still kept, newest first. */
  recent(): ApiStatus["alerts"];
}

export const ALERT_CAPACITY = 100;

/** A ring buffer of the most recent alerts. Every alert is also one log line. */
export function createAlertLog(options: { log(line: string): void; now(): number; capacity?: number }): AlertLog {
  const capacity = options.capacity ?? ALERT_CAPACITY;
  const kept: ApiStatus["alerts"] = [];
  return {
    alert(event) {
      kept.unshift({ at: options.now(), kind: event.kind, orderAddress: event.orderAddress, detail: event.detail });
      if (kept.length > capacity) kept.length = capacity;
      options.log(`alert ${event.kind} ${event.orderAddress ?? "-"} ${event.detail}`);
    },
    recent() {
      return kept.map((alert) => ({ ...alert }));
    },
  };
}

export const ORDERS_INTERVAL_MS = 2_000;
export const MARKETS_INTERVAL_MS = 4_000;
export const SETTLEMENT_INTERVAL_MS = 5_000;
export const RECONCILE_INTERVAL_MS = 30_000;
/** How often `recover` may run for journal rows whose order is no longer open. */
const RECOVER_EVERY_MS = 30_000;
/** How long the cached chain config and cluster time are used before they are read again. */
const CHAIN_STATE_EVERY_MS = 10_000;
/** Below this the relayer may soon be unable to pay for fills, token accounts and markets. */
const LOW_SOL_LAMPORTS = 200_000_000n;

const ORDER_STATES: readonly OrderState[] = [
  "seen",
  "submitting",
  "venue_filled",
  "venue_not_filled",
  "venue_unknown",
  "chain_filled",
  "chain_cancelled",
  "orphaned",
  "failed",
];

export interface DaemonDeps {
  /** Constant facts reported by `health`. */
  identity: Pick<ApiHealth, "cluster" | "venue" | "programId" | "relayer" | "stableMint">;
  /** Where orders go. */
  venue: OrderVenue;
  chain: Chain & MarketChain;
  journal: Journal;
  manager: MarketManager;
  settlement: { tick(): Promise<void> };
  reconciler: Reconciler;
  alerts: AlertLog;
  /** Default `DEFAULT_PIPELINE_CONFIG`. */
  pipeline?: PipelineConfig;
  /** Whether the venue's order connection is up. Default: always. */
  venueConnected?: () => boolean;
  /** Unix milliseconds. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  setInterval?: (run: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  log?: (line: string) => void;
}

export interface Daemon {
  /** Resolves unfinished journal rows, reads the markets once, then starts the loops. */
  start(): Promise<void>;
  /** Stops the loops and waits for the ticks that are running. */
  stop(): Promise<void>;
  /** One pass of each loop. A call made while that loop's tick is running returns at once. */
  tickOrders(): Promise<void>;
  tickMarkets(): Promise<void>;
  tickSettlement(): Promise<void>;
  tickReconcile(): Promise<void>;
  health(): ApiHealth;
  status(): ApiStatus;
}

export function createDaemon(deps: DaemonDeps): Daemon {
  const { venue, chain, journal, manager, settlement, reconciler, alerts } = deps;
  const pipeline = deps.pipeline ?? DEFAULT_PIPELINE_CONFIG;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const startInterval = deps.setInterval ?? ((run, ms) => setInterval(run, ms));
  const stopInterval = deps.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));

  let chainConfig: ChainConfig | null = null;
  /** Cluster time in unix seconds as last read, and the wall-clock time of that read. */
  let chainClock: { secs: number; readAt: number } | null = null;
  let chainStateAt = Number.NEGATIVE_INFINITY;
  let venueListOk = false;
  let ordersTickFailed = false;
  let lastRecoverAt = Number.NEGATIVE_INFINITY;
  let relayerLamports: bigint | null = null;
  let lowSol = false;
  /** The last error reported per open order, so a repeating one is reported once. */
  const orderErrors = new Map<string, string>();

  let stopped = false;
  let started = false;
  let handles: unknown[] = [];
  const running = new Set<Promise<void>>();

  // While fills are paused on-chain a venue fill could not be recorded there, so no order goes
  // to the venue: it is refused here and the pipeline cancels it on-chain.
  const gatedVenue: OrderVenue = {
    placeOrder: (request) =>
      chainConfig?.pauseFill === true
        ? Promise.resolve({ kind: "rejected", code: null, message: "fills are paused on-chain" })
        : venue.placeOrder(request),
    findOrder: (clientOrderId, symbol, sinceMs) => venue.findOrder(clientOrderId, symbol, sinceMs),
    contract: (symbol) => venue.contract(symbol),
    topOfBook: (symbol) => venue.topOfBook(symbol),
  };
  const pipelineDeps: PipelineDeps = {
    venue: gatedVenue,
    chain,
    journal,
    config: pipeline,
    sleep: deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    alert: alerts.alert,
  };

  /** Wraps a loop body: one run at a time, nothing after `stop`, failures become alerts. */
  function loop(name: string, body: () => Promise<void>): () => Promise<void> {
    let current: Promise<void> | null = null;
    let lastError: string | null = null;
    return () => {
      if (stopped || current !== null) return Promise.resolve();
      const run = (async () => {
        try {
          await body();
          if (lastError !== null) log(`${name} tick recovered`);
          lastError = null;
        } catch (error) {
          const detail = messageOf(error);
          // A failure that repeats tick after tick is reported once.
          if (detail !== lastError) alerts.alert({ kind: "tick_error", orderAddress: null, detail: `${name}: ${detail}` });
          lastError = detail;
        }
      })().finally(() => {
        current = null;
        running.delete(run);
      });
      current = run;
      running.add(run);
      return run;
    };
  }

  async function refreshChainState(): Promise<void> {
    const [config, secs] = await Promise.all([chain.config(), chain.now()]);
    if (chainConfig !== null && (chainConfig.pausePlace !== config.pausePlace || chainConfig.pauseFill !== config.pauseFill)) {
      log(`pause flags changed: place=${config.pausePlace} fill=${config.pauseFill}`);
    }
    chainConfig = config;
    chainClock = { secs, readAt: now() };
    chainStateAt = now();
    manager.setPaused(config.pausePlace || config.pauseFill);
  }

  const tickOrders = loop("orders", async () => {
    let open;
    try {
      open = (await chain.openOrders()).sort((a, b) => a.expiresAt - b.expiresAt);
    } catch (error) {
      ordersTickFailed = true;
      throw error;
    }
    ordersTickFailed = false;
    const openAddresses = new Set(open.map((order) => order.address));
    for (const address of [...orderErrors.keys()]) if (!openAddresses.has(address)) orderErrors.delete(address);

    for (const order of open) {
      if (stopped) return;
      const before = journal.get(order.address)?.state;
      try {
        await processOrder(order, pipelineDeps);
        orderErrors.delete(order.address);
      } catch (error) {
        // The row stays where it was; the next tick takes the order up again.
        const detail = messageOf(error);
        if (orderErrors.get(order.address) !== detail) alerts.alert({ kind: "order_error", orderAddress: order.address, detail });
        orderErrors.set(order.address, detail);
        continue;
      }
      const after = journal.get(order.address)?.state;
      if (after !== undefined && after !== before) {
        log(`order ${order.address} ${order.kind} ${order.side} ${order.units} ${order.symbol}: ${after}`);
      }
    }

    if (stopped || now() - lastRecoverAt < RECOVER_EVERY_MS) return;
    if (journal.unresolved().some((row) => !openAddresses.has(row.orderAddress))) {
      lastRecoverAt = now();
      await recover(pipelineDeps);
    }
  });

  const tickMarkets = loop("markets", async () => {
    const errors: unknown[] = [];
    if (now() - chainStateAt >= CHAIN_STATE_EVERY_MS) {
      try {
        await refreshChainState();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await manager.refresh();
      venueListOk = true;
    } catch (error) {
      // Only a failed event list says the venue is unreachable.
      if (error instanceof RefreshError) venueListOk = !error.parts.some(({ part }) => part === "venue_list");
      errors.push(error);
    }
    manager.setVenueOnline(venueListOk);
    if (errors.length > 0) throw new Error(errors.map(messageOf).join("; "));
  });

  const tickSettlement = loop("settlement", () => settlement.tick());

  const tickReconcile = loop("reconcile", async () => {
    const errors: unknown[] = [];
    try {
      await reconciler.run();
    } catch (error) {
      errors.push(error);
    }
    // A run may have paused order placement: read the flags again on the next market tick.
    chainStateAt = Number.NEGATIVE_INFINITY;
    try {
      relayerLamports = await chain.relayerLamports();
      const low = relayerLamports < LOW_SOL_LAMPORTS;
      if (low && !lowSol) alerts.alert({ kind: "relayer_low_sol", orderAddress: null, detail: `${Number(relayerLamports) / 1e9} SOL left` });
      lowSol = low;
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new Error(errors.map(messageOf).join("; "));
  });

  function venueConnected(): boolean {
    return venueListOk && (deps.venueConnected?.() ?? true);
  }

  return {
    async start() {
      if (started) return;
      started = true;
      stopped = false;
      try {
        // The pause flags must be known before any unfinished order is taken up again.
        await refreshChainState();
      } catch (error) {
        alerts.alert({ kind: "chain_state_error", orderAddress: null, detail: messageOf(error) });
      }
      try {
        await recover(pipelineDeps);
      } catch (error) {
        alerts.alert({ kind: "recover_error", orderAddress: null, detail: messageOf(error) });
      }
      lastRecoverAt = now();
      await tickMarkets();
      handles = [
        startInterval(() => void tickOrders(), ORDERS_INTERVAL_MS),
        startInterval(() => void tickMarkets(), MARKETS_INTERVAL_MS),
        startInterval(() => void tickSettlement(), SETTLEMENT_INTERVAL_MS),
        startInterval(() => void tickReconcile(), RECONCILE_INTERVAL_MS),
      ];
      void tickReconcile();
    },

    async stop() {
      stopped = true;
      started = false;
      for (const handle of handles) stopInterval(handle);
      handles = [];
      await Promise.allSettled([...running]);
    },

    tickOrders,
    tickMarkets,
    tickSettlement,
    tickReconcile,

    health() {
      const at = now();
      return {
        ok: chainConfig !== null && chainClock !== null && venueConnected() && !ordersTickFailed,
        ...deps.identity,
        paused: { place: chainConfig?.pausePlace ?? false, fill: chainConfig?.pauseFill ?? false },
        venueConnected: venueConnected(),
        // The cluster clock as last read, moved on by the wall-clock time since.
        chainTime: chainClock === null ? 0 : chainClock.secs + Math.floor((at - chainClock.readAt) / 1_000),
        serverTime: at,
        orderTtlSecs: chainConfig?.orderTtlSecs ?? 0,
        minOrderUnits: (chainConfig?.minOrderUnits ?? 0n).toString(),
        maxOrderUnits: (chainConfig?.maxOrderUnits ?? 0n).toString(),
        feeSlackMicros: pipeline.feeSlackMicros.toString(),
      };
    },

    status() {
      const last = reconciler.last();
      const counts = Object.fromEntries(ORDER_STATES.map((state) => [state, journal.byState(state).length])) as Record<OrderState, number>;
      return {
        markets: last?.markets ?? [],
        // Not known to be solvent until a reconciliation has completed.
        solvency: last?.solvency ?? { venueCashMicros: "0", treasuryMicros: "0", requiredMicros: "0", ok: false },
        journal: counts,
        relayerLamports: (relayerLamports ?? 0n).toString(),
        alerts: alerts.recent(),
      };
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
