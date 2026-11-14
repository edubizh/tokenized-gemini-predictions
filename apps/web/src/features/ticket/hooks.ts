"use client";

import { useCallback, useEffect, useState } from "react";
import type { ApiOrder } from "@outcome/relayer/api-types";
import { getReads, type Balances, type OpenOrder, type Position } from "@/lib/chain/reads";
import { useConfig } from "@/lib/config";
import { usePolling, type Polled } from "@/lib/polling";
import { useAccount } from "@/lib/privy/account";
import { getOrders } from "@/lib/relayer/client";
import { loadLocalOrders, storeLocalOrders, withOrder, type LocalOrders } from "./local-orders";
import type { LocalOrder } from "./timeline";

const OPEN_ORDERS_INTERVAL_MS = 4_000;
const OPEN_ORDERS_FAST_MS = 2_000;
const ORDERS_INTERVAL_MS = 3_000;
const ORDERS_FAST_MS = 1_500;
const POSITIONS_INTERVAL_MS = 5_000;

const FINISHED: ReadonlySet<ApiOrder["state"]> = new Set(["chain_filled", "chain_cancelled", "orphaned", "failed"]);

/** True while the relayer still has work to do on the order. */
export function relayerIsWorking(order: Pick<ApiOrder, "state">): boolean {
  return !FINISHED.has(order.state);
}

/** SOL and test-dollar balances of the trading wallet, read every five seconds by the account. */
export function useBalances(): { balances: Balances | null; stale: boolean; refresh(): void } {
  const { balances, stale, refresh } = useAccount();
  return { balances, stale, refresh };
}

export interface OpenOrdersRead {
  orders: OpenOrder[];
  /** When the read began, unix milliseconds. An order placed after this may be missing from it. */
  startedAt: number;
}

/** The wallet's open orders: the order addresses of its last 16 nonces in one `getMultipleAccounts`. */
export function useOpenOrders(): Polled<OpenOrdersRead> {
  const config = useConfig();
  const wallet = useAccount().wallet?.address ?? null;
  const [busy, setBusy] = useState(false);
  const read = useCallback(async (): Promise<OpenOrdersRead> => {
    if (!wallet) throw new Error("no wallet");
    const startedAt = Date.now();
    const orders = await getReads(config).fetchOpenOrders(wallet);
    setBusy(orders.length > 0);
    return { orders, startedAt };
  }, [config, wallet]);
  return usePolling(read, wallet ? (busy ? OPEN_ORDERS_FAST_MS : OPEN_ORDERS_INTERVAL_MS) : null);
}

/** The relayer's record of the wallet's orders, newest first. Polls faster while any is in progress. */
export function useOrders(hurry = false): Polled<ApiOrder[]> {
  const wallet = useAccount().wallet?.address ?? null;
  const [working, setWorking] = useState(false);
  const read = useCallback(
    async (signal: AbortSignal) => {
      if (!wallet) throw new Error("no wallet");
      const orders = await getOrders(wallet, signal);
      setWorking(orders.some(relayerIsWorking));
      return orders;
    },
    [wallet],
  );
  return usePolling(read, wallet ? (working || hurry ? ORDERS_FAST_MS : ORDERS_INTERVAL_MS) : null);
}

/** The wallet's outcome-token balances. */
export function usePositions(): Polled<Position[]> {
  const config = useConfig();
  const wallet = useAccount().wallet?.address ?? null;
  const read = useCallback(async () => {
    if (!wallet) throw new Error("no wallet");
    return getReads(config).fetchPositions(wallet);
  }, [config, wallet]);
  return usePolling(read, wallet ? POSITIONS_INTERVAL_MS : null);
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
