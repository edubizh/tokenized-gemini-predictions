"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiOrder } from "@outcome/relayer/api-types";
import { getReads, type Balances, type ChainMarket, type MarketQuery, type OpenOrder, type Position } from "@/lib/chain/reads";
import { clock } from "@/lib/clock";
import { useConfig } from "@/lib/config";
import { usePolling, type Polled } from "@/lib/polling";
import { useAccount } from "@/lib/privy/account";
import { getOrders } from "@/lib/relayer/client";
import { finishedOrders, type OrdersInProgress } from "./finished";
import { loadLocalOrders, storeLocalOrders, withOrder, type LocalOrders } from "./local-orders";
import type { LocalOrder } from "./timeline";

// Chain reads share the public RPC endpoint's budget with the relayer, so they are slow by
// default and faster only while something of the user's is about to change.
const OPEN_ORDERS_INTERVAL_MS = 5_000;
const OPEN_ORDERS_FAST_MS = 2_500;
const ORDERS_INTERVAL_MS = 3_000;
const ORDERS_FAST_MS = 1_500;
const POSITIONS_INTERVAL_MS = 10_000;
const CHAIN_MARKETS_INTERVAL_MS = 10_000;

const FINISHED: ReadonlySet<ApiOrder["state"]> = new Set(["chain_filled", "chain_cancelled", "orphaned", "failed"]);

/** True while the relayer still has work to do on the order. */
export function relayerIsWorking(order: Pick<ApiOrder, "state">): boolean {
  return !FINISHED.has(order.state);
}

/** SOL and test-dollar balances of the trading wallet, read every ten seconds by the account. */
export function useBalances(): { balances: Balances | null; stale: boolean; refresh(): void } {
  const { balances, stale, refresh } = useAccount();
  return { balances, stale, refresh };
}

/**
 * Polls a read of one wallet. A poll keeps its last value across a change of wallet, so each
 * value is tagged with the wallet it is about and left out until it is about the current one.
 */
function useWalletPolling<T>(wallet: string | null, read: (wallet: string, signal: AbortSignal) => Promise<T>, intervalMs: number): Polled<T> {
  const tagged = useCallback(
    async (signal: AbortSignal) => {
      if (!wallet) throw new Error("no wallet");
      return { wallet, value: await read(wallet, signal) };
    },
    [wallet, read],
  );
  const polled = usePolling(tagged, wallet ? intervalMs : null);
  const { refresh } = polled;
  // Another wallet is read at once, not at the next turn of the interval.
  const asked = useRef(wallet);
  useEffect(() => {
    if (wallet && wallet !== asked.current) refresh();
    asked.current = wallet;
  }, [wallet, refresh]);
  const current = wallet !== null && polled.data?.wallet === wallet;
  const waiting = wallet !== null && !current && polled.error === null;
  return { data: current ? polled.data?.value : undefined, error: polled.error, loading: polled.loading || waiting, refresh };
}

export interface OpenOrdersRead {
  orders: OpenOrder[];
  /** When the read began, unix milliseconds. An order placed after this may be missing from it. */
  startedAt: number;
}

/**
 * The wallet's open orders: its Trader account and the order addresses of its last 16 nonces in
 * one `getMultipleAccounts`. Read every five seconds, and twice as often while an order can
 * still be filled: one that has expired only waits to be reclaimed.
 */
export function useOpenOrders(): Polled<OpenOrdersRead> {
  const config = useConfig();
  const wallet = useAccount().wallet?.address ?? null;
  const [busy, setBusy] = useState(false);
  const read = useCallback(
    async (owner: string): Promise<OpenOrdersRead> => {
      const startedAt = Date.now();
      const orders = await getReads(config).fetchOpenOrders(owner);
      const chainSecs = clock.chainNowMs() / 1000;
      setBusy(orders.some((order) => order.expiresAt >= chainSecs));
      return { orders, startedAt };
    },
    [config],
  );
  return useWalletPolling(wallet, read, busy ? OPEN_ORDERS_FAST_MS : OPEN_ORDERS_INTERVAL_MS);
}

/** The relayer's record of the wallet's orders, newest first. Polls faster while any is in progress. */
export function useOrders(hurry = false): Polled<ApiOrder[]> {
  const wallet = useAccount().wallet?.address ?? null;
  const [working, setWorking] = useState(false);
  const read = useCallback(async (owner: string, signal: AbortSignal) => {
    const orders = await getOrders(owner, signal);
    setWorking(orders.some(relayerIsWorking));
    return orders;
  }, []);
  return useWalletPolling(wallet, read, working || hurry ? ORDERS_FAST_MS : ORDERS_INTERVAL_MS);
}

/** The wallet's outcome-token balances, read every ten seconds. */
export function usePositions(): Polled<Position[]> {
  const config = useConfig();
  const wallet = useAccount().wallet?.address ?? null;
  const read = useCallback((owner: string) => getReads(config).fetchPositions(owner), [config]);
  return useWalletPolling(wallet, read, POSITIONS_INTERVAL_MS);
}

export interface ChainMarketsRead {
  /** The market accounts found so far; empty while nothing is asked. */
  markets: ChainMarket[];
  /**
   * False until the first question has had its answer, so a page can wait for it before it draws.
   * It stays true afterwards: while a later, wider question is on its way the last answer is shown.
   */
  settled: boolean;
}

const unique = (values: readonly string[] | undefined) => [...new Set(values ?? [])].sort();

/**
 * Market accounts read from Solana, for tokens and orders the relayer does not name. Pass null
 * while it is not yet known what to ask. Nothing is read for an empty query, which is the normal
 * case: the relayer names everything.
 */
export function useChainMarkets(query: MarketQuery | null): ChainMarketsRead {
  const config = useConfig();
  const asked = { mints: unique(query?.mints), markets: unique(query?.markets), symbols: unique(query?.symbols) };
  const empty = asked.mints.length + asked.markets.length + asked.symbols.length === 0;
  const key = JSON.stringify(asked);
  const read = useCallback(async () => ({ key, markets: await getReads(config).fetchMarkets(JSON.parse(key) as MarketQuery) }), [config, key]);
  const polled = usePolling(read, empty ? null : CHAIN_MARKETS_INTERVAL_MS);
  const { refresh } = polled;
  // A new question is asked at once, not at the next turn of the interval.
  useEffect(() => {
    if (!empty) refresh();
  }, [empty, key, refresh]);

  // Answered: nothing to ask, this question's answer is in, or the read failed (the page does not wait on a failing chain).
  const answered = query !== null && (empty || polled.data?.key === key || polled.error !== null);
  const settledOnce = useRef(false);
  if (answered) settledOnce.current = true;
  return { markets: empty ? [] : (polled.data?.markets ?? []), settled: settledOnce.current };
}

/**
 * Calls `onFinished` once each time an order of the wallet finishes: its account is gone from
 * Solana, or the relayer has nothing more to do with it. That is when balances and tokens have
 * changed, so they are read again at once and not at the next turn of their interval.
 */
export function useOrdersFinished(open: OpenOrdersRead | undefined, orders: readonly ApiOrder[] | undefined, onFinished: () => void): void {
  const previous = useRef<OrdersInProgress | null>(null);
  // An order is seen to finish twice, by its account and by the relayer; it is announced once.
  const announced = useRef(new Set<string>());
  const latest = useRef(onFinished);
  latest.current = onFinished;
  const openKey = open?.orders.map((order) => order.address).join(",");
  const workingKey = orders?.filter(relayerIsWorking).map((order) => order.address).join(",");
  useEffect(() => {
    // Until both have been read once there is nothing to compare with.
    if (openKey === undefined && workingKey === undefined) return;
    const next: OrdersInProgress = {
      open: openKey === undefined ? (previous.current?.open ?? []) : openKey.split(",").filter(Boolean),
      working: workingKey === undefined ? (previous.current?.working ?? []) : workingKey.split(",").filter(Boolean),
    };
    const fresh = finishedOrders(previous.current, next).filter((address) => !announced.current.has(address));
    for (const address of fresh) announced.current.add(address);
    previous.current = next;
    if (fresh.length > 0) latest.current();
  }, [openKey, workingKey]);
}

export interface LocalOrderStore {
  orders: LocalOrders;
  save(order: LocalOrder): void;
  markReclaimed(order: LocalOrder, signature: string): void;
}

/** The browser's own record of placed orders, kept in localStorage by order address. */
export function useLocalOrders(): LocalOrderStore {
  const wallet = useAccount().wallet?.address ?? null;
  const [orders, setOrders] = useState<LocalOrders>({});

  useEffect(() => {
    setOrders(wallet ? loadLocalOrders(wallet) : {});
  }, [wallet]);

  const save = useCallback(
    (order: LocalOrder) => {
      if (!wallet) return;
      setOrders((previous) => {
        const next = withOrder(previous, order);
        storeLocalOrders(wallet, next);
        return next;
      });
    },
    [wallet],
  );
  const markReclaimed = useCallback((order: LocalOrder, signature: string) => save({ ...order, reclaimSignature: signature }), [save]);

  return { orders, save, markReclaimed };
}
