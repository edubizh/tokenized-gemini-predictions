// The one module hooks call for chain data. Two implementations behind one interface: Solana
// through Kit, and the simulated chain of fixtures mode. The configuration chooses.

import { address, fetchEncodedAccounts, type Address } from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { decodeOrder } from "@outcome/program-client";
import type { PublicConfig } from "@/lib/config";
import type { FixtureChain } from "@/lib/fixtures/chain-types";
import { fetchBalances as fetchRpcBalances, fetchTrader as fetchRpcTrader, type Balances, type TraderAccount } from "./accounts";
import { findOrderAddress } from "./instructions";
import { getRpc } from "./rpc";

export type { Balances, TraderAccount };

/** An order account that exists, which means the order is still open. Times are cluster seconds. */
export interface OpenOrder {
  address: string;
  user: string;
  market: string;
  /** 0 YES, 1 NO. */
  side: number;
  /** 0 buy, 1 sell. */
  kind: number;
  qtyUnits: bigint;
  limitPx: bigint;
  maxFee: bigint;
  expiresAt: number;
  rentPayer: string;
  nonce: bigint;
}

/** Outcome tokens of one mint held by the wallet, in units. */
export interface Position {
  mint: string;
  units: bigint;
}

export interface ChainReads {
  /** Null when the wallet has not been registered. */
  fetchTrader(wallet: string): Promise<TraderAccount | null>;
  fetchBalances(wallet: string): Promise<Balances>;
  /** Every outcome-token balance of the wallet above zero. */
  fetchPositions(wallet: string): Promise<Position[]>;
  /** The wallet's open orders among its most recent ones, newest first. */
  fetchOpenOrders(wallet: string): Promise<OpenOrder[]>;
}

/** How many of a trader's most recent order addresses are checked for an open order. */
export const OPEN_ORDER_LOOKBACK = 16;

type ReadsConfig = Pick<PublicConfig, "fixtures" | "rpcUrl" | "programId" | "stableMint">;

const orderAddresses = new Map<string, Promise<Address>>();

/** Order addresses never change, so each is derived once. */
function orderAddress(programId: string, wallet: string, nonce: bigint): Promise<Address> {
  const key = `${programId}:${wallet}:${nonce}`;
  let pending = orderAddresses.get(key);
  if (!pending) {
    pending = findOrderAddress(programId, wallet, nonce);
    orderAddresses.set(key, pending);
  }
  return pending;
}

function rpcReads(config: ReadsConfig): ChainReads {
  const rpc = getRpc(config.rpcUrl);
  return {
    fetchTrader: (wallet) => fetchRpcTrader(rpc, config.programId, wallet),
    fetchBalances: (wallet) => fetchRpcBalances(rpc, wallet, config.stableMint),

    async fetchPositions(wallet) {
      const { value } = await rpc
        .getTokenAccountsByOwner(address(wallet), { programId: TOKEN_2022_PROGRAM_ADDRESS }, { encoding: "jsonParsed", commitment: "confirmed" })
        .send();
      const byMint = new Map<string, bigint>();
      for (const { account } of value) {
        const info = account.data.parsed.info;
        const units = BigInt(info.tokenAmount.amount);
        if (units > 0n) byMint.set(info.mint, (byMint.get(info.mint) ?? 0n) + units);
      }
      return [...byMint].map(([mint, units]) => ({ mint, units }));
    },

    async fetchOpenOrders(wallet) {
      const trader = await fetchRpcTrader(rpc, config.programId, wallet);
      if (!trader || trader.nextNonce === 0n) return [];
      const nonces: bigint[] = [];
      for (let nonce = trader.nextNonce - 1n; nonce >= 0n && nonces.length < OPEN_ORDER_LOOKBACK; nonce--) nonces.push(nonce);
      const addresses = await Promise.all(nonces.map((nonce) => orderAddress(config.programId, wallet, nonce)));
      // One getMultipleAccounts call for all of them.
      const accounts = await fetchEncodedAccounts(rpc, addresses, { commitment: "confirmed" });
      const open: OpenOrder[] = [];
      for (const account of accounts) {
        if (!account.exists) continue;
        const { data } = decodeOrder(account);
        open.push({
          address: account.address,
          user: data.user,
          market: data.market,
          side: data.side,
          kind: data.kind,
          qtyUnits: data.qtyUnits,
          limitPx: BigInt(data.limitPx),
          maxFee: data.maxFee,
          expiresAt: Number(data.expiresAt),
          rentPayer: data.rentPayer,
          nonce: data.nonce,
        });
      }
      return open;
    },
  };
}

/** The simulated chain, kept by the app server while `RELAYER_URL=fixtures`. */
function fixtureReads(): ChainReads {
  const read = async (wallet: string): Promise<FixtureChain> => {
    const response = await fetch(`/api/fixtures/chain?wallet=${encodeURIComponent(wallet)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`The simulated chain answered HTTP ${response.status}.`);
    return (await response.json()) as FixtureChain;
  };
  return {
    async fetchTrader(wallet) {
      const { trader } = await read(wallet);
      return { address: address(trader.address), nextNonce: BigInt(trader.nextNonce) };
    },
    async fetchBalances(wallet) {
      const { balances } = await read(wallet);
      return { lamports: BigInt(balances.lamports), stableMicros: BigInt(balances.stableMicros) };
    },
    async fetchPositions(wallet) {
      return (await read(wallet)).positions.map((position) => ({ mint: position.mint, units: BigInt(position.units) }));
    },
    async fetchOpenOrders(wallet) {
      return (await read(wallet)).openOrders.map((order) => ({
        ...order,
        qtyUnits: BigInt(order.qtyUnits),
        limitPx: BigInt(order.limitPx),
        maxFee: BigInt(order.maxFee),
        nonce: BigInt(order.nonce),
      }));
    },
  };
}

const cache = new Map<string, ChainReads>();

export function getReads(config: ReadsConfig): ChainReads {
  const key = config.fixtures ? "fixtures" : `${config.rpcUrl}|${config.programId}|${config.stableMint ?? ""}`;
  let reads = cache.get(key);
  if (!reads) {
    reads = config.fixtures ? fixtureReads() : rpcReads(config);
    cache.set(key, reads);
  }
  return reads;
}
