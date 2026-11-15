// The one module hooks call for chain data. Two implementations behind one interface: Solana
// through Kit, and the simulated chain of fixtures mode. The configuration chooses.

import { address, fetchEncodedAccount, fetchEncodedAccounts, getUtf8Encoder, type Address, type EncodedAccount } from "@solana/kit";
import { decodeMint, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { decodeMarket, decodeOrder, decodeTrader, findMarketPda, findTraderPda, MarketStatus } from "@outcome/program-client";
import { clock, CLOCK_SYSVAR_ADDRESS, clusterTimeFromSysvar } from "@/lib/clock";
import type { PublicConfig } from "@/lib/config";
import type { FixtureChain, FixtureChainMarket, MarketQuery } from "@/lib/fixtures/chain-types";
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

/** A market account, with the metadata name of one of its outcome tokens where one was read. */
export interface ChainMarket {
  address: string;
  /** The venue symbol the market was created for. */
  symbol: string;
  yesMint: string;
  noMint: string;
  status: "open" | "halted" | "settled";
  /** Cluster seconds. */
  closeTs: number;
  placeCutoffSecs: number;
  tickPx: number;
  /** Micro-dollars per unit; zero until settled. */
  yesPayout: bigint;
  noPayout: bigint;
  /** Cluster seconds from which tokens can be redeemed; zero until settled. */
  redeemAfter: number;
  /** For example `BTC Up 22:00Z 14 Nov YES`. */
  tokenName: string | null;
}

export type { MarketQuery };

export interface ChainReads {
  /** Null when the wallet has not been registered. */
  fetchTrader(wallet: string): Promise<TraderAccount | null>;
  fetchBalances(wallet: string): Promise<Balances>;
  /** Every outcome-token balance of the wallet above zero. */
  fetchPositions(wallet: string): Promise<Position[]>;
  /** The wallet's open orders among its most recent ones, newest first. */
  fetchOpenOrders(wallet: string): Promise<OpenOrder[]>;
  /**
   * The market accounts behind outcome mints, market addresses or venue symbols, one per market.
   * This is how a token or an open order is matched to its market without the relayer. What
   * Solana does not hold is left out.
   */
  fetchMarkets(query: MarketQuery): Promise<ChainMarket[]>;
  /** The cluster clock in unix seconds, read from Solana itself for when the relayer cannot be asked. */
  fetchClusterTime(): Promise<number>;
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

const STATUS_NAMES = { [MarketStatus.Open]: "open", [MarketStatus.Halted]: "halted", [MarketStatus.Settled]: "settled" } as const;
const NO_MINT = "11111111111111111111111111111111";
/** `getMultipleAccounts` takes at most this many addresses. */
const MAX_ACCOUNTS = 100;

function orderOf(account: EncodedAccount): OpenOrder {
  const { data } = decodeOrder(account);
  return {
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
  };
}

/** A market whose settlement can no longer be revoked never changes again. */
function isFinal(market: ChainMarket): boolean {
  return market.status === "settled" && market.redeemAfter > 0 && clock.chainNowMs() / 1000 >= market.redeemAfter;
}

function rpcReads(config: ReadsConfig): ChainReads {
  const rpc = getRpc(config.rpcUrl);
  const programAddress = address(config.programId);
  // What never changes is read once: a trader's address, a mint's market and name, a symbol's
  // market address, and a market whose settlement is final.
  const traderAddresses = new Map<string, Promise<Address>>();
  const nextNonces = new Map<string, bigint>();
  const mintFacts = new Map<string, { market: string | null; name: string | null }>();
  const symbolAddresses = new Map<string, string>();
  const finalMarkets = new Map<string, ChainMarket>();

  const traderAddress = (wallet: string): Promise<Address> => {
    let pending = traderAddresses.get(wallet);
    if (!pending) {
      pending = findTraderPda({ user: address(wallet) }, { programAddress }).then(([pda]) => pda);
      traderAddresses.set(wallet, pending);
    }
    return pending;
  };

  /** An outcome mint's authority is its market, and its token metadata carries its name. */
  const readMints = async (mints: readonly string[]): Promise<void> => {
    const unseen = [...new Set(mints)].filter((mint) => mint !== NO_MINT && !mintFacts.has(mint)).slice(0, MAX_ACCOUNTS);
    if (unseen.length === 0) return;
    const accounts = await fetchEncodedAccounts(rpc, unseen.map((mint) => address(mint)), { commitment: "confirmed" });
    for (const account of accounts) {
      let facts: { market: string | null; name: string | null } = { market: null, name: null };
      if (account.exists && account.programAddress === TOKEN_2022_PROGRAM_ADDRESS) {
        try {
          const { data } = decodeMint(account);
          const metadata = data.extensions.__option === "Some" ? data.extensions.value.find((extension) => extension.__kind === "TokenMetadata") : undefined;
          facts = { market: data.mintAuthority.__option === "Some" ? data.mintAuthority.value : null, name: metadata?.__kind === "TokenMetadata" ? metadata.name : null };
        } catch {
          // Not a mint this app can read: it stays unmatched.
        }
      }
      mintFacts.set(account.address, facts);
    }
  };

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

    // One getMultipleAccounts call: the Trader account and the order addresses of the nonce it
    // had at the last read. Only when the nonce has moved since (the wallet placed an order) is
    // a second call needed for the new addresses.
    async fetchOpenOrders(wallet) {
      const trader = await traderAddress(wallet);
      let known = nextNonces.get(wallet);
      for (let attempt = 0; ; attempt++) {
        const nonces: bigint[] = [];
        for (let nonce = (known ?? 0n) - 1n; nonce >= 0n && nonces.length < OPEN_ORDER_LOOKBACK; nonce--) nonces.push(nonce);
        const addresses = await Promise.all(nonces.map((nonce) => orderAddress(config.programId, wallet, nonce)));
        const [traderAccount, ...orders] = await fetchEncodedAccounts(rpc, [trader, ...addresses], { commitment: "confirmed" });
        if (!traderAccount?.exists) return [];
        const next = decodeTrader(traderAccount).data.nextNonce;
        nextNonces.set(wallet, next);
        if (next === known || attempt >= 2) return orders.flatMap((account) => (account.exists ? [orderOf(account)] : []));
        known = next;
      }
    },

    async fetchMarkets(query) {
      const mints = query.mints ?? [];
      await readMints(mints);
      const wanted = new Set<string>(query.markets ?? []);
      for (const mint of mints) {
        const market = mintFacts.get(mint)?.market;
        if (market) wanted.add(market);
      }
      for (const symbol of query.symbols ?? []) {
        let known = symbolAddresses.get(symbol);
        if (!known) {
          const symbolHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(getUtf8Encoder().encode(symbol))));
          [known] = await findMarketPda({ symbolHash }, { programAddress });
          symbolAddresses.set(symbol, known);
        }
        wanted.add(known);
      }

      const found: ChainMarket[] = [];
      const toRead: string[] = [];
      for (const market of wanted) {
        const final = finalMarkets.get(market);
        if (final) found.push(final);
        else if (toRead.length < MAX_ACCOUNTS) toRead.push(market);
      }
      if (toRead.length > 0) {
        const accounts = await fetchEncodedAccounts(rpc, toRead.map((market) => address(market)), { commitment: "confirmed" });
        const read: ChainMarket[] = [];
        for (const account of accounts) {
          // Anything can be a mint's authority; only an account of this program is a market.
          if (!account.exists || account.programAddress !== programAddress) continue;
          try {
            const { data } = decodeMarket(account);
            read.push({
              address: account.address,
              symbol: data.symbol,
              yesMint: data.yesMint,
              noMint: data.noMint,
              status: STATUS_NAMES[data.status as MarketStatus] ?? "halted",
              closeTs: Number(data.closeTs),
              placeCutoffSecs: data.placeCutoffSecs,
              tickPx: data.tickPx,
              yesPayout: data.yesPayout,
              noPayout: data.noPayout,
              redeemAfter: Number(data.redeemAfter),
              tokenName: null,
            });
          } catch {
            // Not a market account.
          }
        }
        // A market reached by its address or symbol has not had a mint read yet: its name is there.
        await readMints(read.filter((market) => !mintFacts.has(market.yesMint) && !mintFacts.has(market.noMint)).map((market) => market.yesMint));
        for (const market of read) {
          const named = { ...market, tokenName: mintFacts.get(market.yesMint)?.name ?? mintFacts.get(market.noMint)?.name ?? null };
          if (isFinal(named)) finalMarkets.set(named.address, named);
          found.push(named);
        }
      }
      // A mint whose authority turned out not to be a market of this program is not asked about again.
      const markets = new Set(found.map((market) => market.address));
      for (const mint of mints) {
        const facts = mintFacts.get(mint);
        if (facts?.market && !markets.has(facts.market)) mintFacts.set(mint, { market: null, name: facts.name });
      }
      return found;
    },
    async fetchClusterTime() {
      const account = await fetchEncodedAccount(rpc, address(CLOCK_SYSVAR_ADDRESS), { commitment: "confirmed" });
      if (!account.exists) throw new Error("The cluster clock could not be read.");
      return clusterTimeFromSysvar(account.data);
    },
  };
}

/** The simulated chain, kept by the app server while `RELAYER_URL=fixtures`. */
function fixtureReads(): ChainReads {
  const get = async <T>(search: URLSearchParams): Promise<T> => {
    const response = await fetch(`/api/fixtures/chain?${search.toString()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`The simulated chain answered HTTP ${response.status}.`);
    return (await response.json()) as T;
  };
  // `read` names the kind of read, so the requests a page makes can be counted by kind.
  const read = (wallet: string, kind: string): Promise<FixtureChain> => get(new URLSearchParams({ wallet, read: kind }));
  return {
    async fetchTrader(wallet) {
      const { trader } = await read(wallet, "trader");
      return trader && { address: address(trader.address), nextNonce: BigInt(trader.nextNonce) };
    },
    async fetchBalances(wallet) {
      const { balances } = await read(wallet, "balances");
      return { lamports: BigInt(balances.lamports), stableMicros: BigInt(balances.stableMicros) };
    },
    async fetchPositions(wallet) {
      return (await read(wallet, "positions")).positions.map((position) => ({ mint: position.mint, units: BigInt(position.units) }));
    },
    async fetchOpenOrders(wallet) {
      return (await read(wallet, "open-orders")).openOrders.map((order) => ({
        ...order,
        qtyUnits: BigInt(order.qtyUnits),
        limitPx: BigInt(order.limitPx),
        maxFee: BigInt(order.maxFee),
        nonce: BigInt(order.nonce),
      }));
    },
    async fetchMarkets(query) {
      const search = new URLSearchParams({ read: "markets" });
      for (const key of ["mints", "markets", "symbols"] as const) if (query[key]?.length) search.set(key, query[key].join(","));
      const { markets } = await get<{ markets: FixtureChainMarket[] }>(search);
      return markets.map((market) => ({ ...market, yesPayout: BigInt(market.yesPayout), noPayout: BigInt(market.noPayout) }));
    },
    async fetchClusterTime() {
      return (await get<{ chainTime: number }>(new URLSearchParams({ read: "clock" }))).chainTime;
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
