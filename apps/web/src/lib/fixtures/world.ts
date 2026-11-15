// The simulated relayer and chain of fixtures mode, kept in the app server's memory. The events
// and their quotes come from the fixtures, which are a pure function of the time; what a browser
// does is recorded here: the markets it had created on-chain, the orders it placed, which walk
// through the relayer's states over a few seconds, and the tokens it redeemed. Server only.

import type { ApiEvent, ApiEventDetail, ApiMarket, ApiOnchainMarket, ApiOrder, SideName } from "@outcome/relayer/api-types";
import { complementPx, cost, takerFee } from "@outcome/relayer/money";
import {
  FIXTURE_ORDER_TTL_SECS,
  fixtureAddress,
  fixtureChainMarket,
  fixtureDepth,
  fixtureEvent,
  fixtureEvents,
  fixtureHealth,
  fixtureHistory,
  fixtureHoldings,
  fixtureMarket,
  fixtureOnchainMarkets,
  fixtureOrders,
  fixtureSignature,
  fixtureStatus,
  fixtureTrades,
} from "@/lib/relayer/fixtures";
import type { RelayerRoute } from "@/lib/relayer/proxy";
import type { FundingChain } from "@/server/onboard";
import type { FixtureChain, FixtureChainMarket, FixtureOpenOrder, MarketQuery } from "./chain-types";

const STARTING_STABLE_MICROS = 1_000_000_000n;
const STARTING_LAMPORTS = 50_000_000n;
const FIRST_NONCE = 16n;
/** How long the simulated relayer takes to create a market on-chain; the proxy route waits this long. */
export const ENSURE_DELAY_MS = 1_500;

// Milliseconds after placement at which a simulated order reaches each state.
const SEEN_AT = 1_200;
const SUBMITTING_AT = 2_400;
const VENUE_AT = 3_800;
const CHAIN_AT = 5_400;

interface SimOrder {
  address: string;
  user: string;
  symbol: string;
  market: string;
  kind: "buy" | "sell";
  /** The mint of the tokens bought or sold. */
  mint: string;
  side: SideName;
  units: bigint;
  limitPx: bigint;
  maxFeeMicros: bigint;
  nonce: bigint;
  placedAtMs: number;
  /** Cluster seconds. */
  expiresAt: number;
  /** The price it fills at, in its own terms; null when the book does not reach its limit or is too thin. */
  fillPx: bigint | null;
  /** Why the relayer refuses it before sending, if it does. */
  refusal: string | null;
}

export interface PlaceInput {
  user: string;
  market: string;
  order: string;
  side: SideName;
  units: bigint;
  limitPx: bigint;
  maxFeeMicros: bigint;
}

export interface PlaceSellInput extends PlaceInput {
  /** The mint of the tokens being sold. */
  outcomeMint: string;
}

export interface RedeemInput {
  holder: string;
  /** The on-chain market account. */
  market: string;
  outcomeMint: string;
  amount: bigint;
}

interface Redemption {
  holder: string;
  mint: string;
  units: bigint;
  payoutMicros: bigint;
}

export interface FixtureResponse {
  status: number;
  body: object;
}

type OnchainMarket = ApiMarket & { onchain: ApiOnchainMarket };

function simState(order: SimOrder, nowMs: number): ApiOrder["state"] | null {
  const age = nowMs - order.placedAtMs;
  if (age < SEEN_AT) return null;
  if (age < SUBMITTING_AT) return "seen";
  // An order the relayer refuses is cancelled without ever reaching the venue.
  if (order.refusal !== null) return "chain_cancelled";
  if (age < VENUE_AT) return "submitting";
  const filled = order.fillPx !== null;
  if (age < CHAIN_AT) return filled ? "venue_filled" : "venue_not_filled";
  return filled ? "chain_filled" : "chain_cancelled";
}

/** An event as the list gives it: without what only its own page needs. */
function listed({ description: _description, source: _source, termsUrl: _termsUrl, rules: _rules, ...event }: ApiEventDetail): ApiEvent {
  return event;
}

const answer = (body: object): FixtureResponse => ({ status: 200, body });
const known = (body: object | null, what: string): FixtureResponse => (body === null ? { status: 404, body: { error: `unknown ${what}` } } : answer(body));

/** Everything the world remembers. Kept apart from the class so a reload of this module keeps it. */
interface WorldState {
  placed: Map<string, SimOrder>;
  /** Orders the user cancelled themselves, with the time of the cancel. */
  cancelled: Map<string, number>;
  /** Symbols of the markets that exist on-chain beyond those of the fixtures: created through the relayer, or traded. */
  onchain: Set<string>;
  /** Every `redeem` the simulated chain has accepted. */
  redemptions: Redemption[];
  /** Wallets the registrar has registered, where new wallets start unregistered. */
  registered: Set<string>;
  transactions: number;
}

function emptyState(): WorldState {
  return { placed: new Map(), cancelled: new Map(), onchain: new Set(), redemptions: [], registered: new Set(), transactions: 0 };
}

export class FixtureWorld {
  private readonly state: WorldState;

  constructor(state: WorldState = emptyState()) {
    this.state = state;
  }

  nextSignature(): string {
    this.state.transactions += 1;
    return fixtureSignature(`tx:${this.state.transactions}`);
  }

  /** A market by its venue symbol, or by the address of its on-chain account or of one of its mints. */
  findMarket(key: string, nowMs: number): ApiMarket | undefined {
    return (
      fixtureMarket(key, nowMs, this.state.onchain) ??
      fixtureOnchainMarkets(nowMs, this.state.onchain).find((market) => market.onchain?.market === key || market.onchain?.yesMint === key || market.onchain?.noMint === key)
    );
  }

  /** The market accounts the simulated chain holds for a query, one per market. */
  chainMarkets(query: MarketQuery, nowMs: number): FixtureChainMarket[] {
    const found = new Map<string, FixtureChainMarket>();
    for (const key of [...(query.symbols ?? []), ...(query.markets ?? []), ...(query.mints ?? [])]) {
      const market = this.findMarket(key, nowMs);
      const account = market && fixtureChainMarket(market);
      if (account) found.set(account.symbol, account);
    }
    return [...found.values()];
  }

  /** What the relayer would answer for an allowed route. */
  respond(route: RelayerRoute, nowMs: number): FixtureResponse {
    const { onchain } = this.state;
    switch (route.kind) {
      case "health":
        return answer(fixtureHealth(nowMs));
      case "status":
        return answer(fixtureStatus(nowMs, onchain));
      case "events":
        return answer({ events: fixtureEvents(nowMs, onchain).map(listed) });
      case "event":
        return known(fixtureEvent(route.ticker, nowMs, onchain), "event");
      case "markets":
        return answer({ markets: fixtureOnchainMarkets(nowMs, onchain) });
      case "market":
        return known(fixtureMarket(route.symbol, nowMs, onchain), "market");
      case "ensure": {
        // The route waits `ENSURE_DELAY_MS` before asking, as creating a market takes a moment.
        const market = fixtureMarket(route.symbol, nowMs, onchain);
        if (market && (market.venueStatus !== "active" || nowMs >= market.expiresAt)) return { status: 409, body: { error: "market not active" } };
        if (market) onchain.add(route.symbol);
        return known(fixtureMarket(route.symbol, nowMs, onchain), "market");
      }
      case "depth":
        return known(fixtureDepth(route.symbol, nowMs), "market");
      case "trades": {
        const trades = fixtureTrades(route.symbol, nowMs);
        return known(trades && { trades }, "market");
      }
      case "history":
        return known(fixtureHistory(route.symbol, nowMs), "market");
      case "orders":
        return answer({ orders: this.orders(route.user, nowMs) });
      case "order": {
        const placed = this.state.placed.get(route.address);
        // The fixture orders are shown to whichever wallet asks; this route names none.
        return known(placed ? this.simApiOrder(placed, nowMs) : (this.baseOrders("", nowMs).find((order) => order.address === route.address) ?? null), "order");
      }
    }
  }

  private nextNonce(user: string): bigint {
    let count = 0n;
    for (const order of this.state.placed.values()) if (order.user === user) count += 1n;
    return FIRST_NONCE + count;
  }

  /** The market an order is placed in. Throws with a program error name when the program would not take an order for it. */
  private openMarket(address: string, nowMs: number): OnchainMarket {
    const market = this.findMarket(address, nowMs);
    if (!market?.onchain || market.onchain.status !== "open") throw new Error("MarketNotOpen");
    if (nowMs >= market.lastOrderAt) throw new Error("TooCloseToClose");
    return market as OnchainMarket;
  }

  /** Records an order of either kind once the program's checks have passed. */
  private record(input: PlaceInput, market: OnchainMarket, order: Pick<SimOrder, "kind" | "mint" | "fillPx" | "refusal">, nowMs: number): void {
    // A traded market stays on-chain after the fixtures have forgotten its event.
    this.state.onchain.add(market.symbol);
    this.state.placed.set(input.order, {
      ...order,
      address: input.order,
      user: input.user,
      symbol: market.symbol,
      market: market.onchain.market,
      side: input.side,
      units: input.units,
      limitPx: input.limitPx,
      maxFeeMicros: input.maxFeeMicros,
      nonce: this.nextNonce(input.user),
      placedAtMs: nowMs,
      expiresAt: Math.min(Math.floor(nowMs / 1000) + FIXTURE_ORDER_TTL_SECS, market.onchain.closeTs),
    });
  }

  /**
   * Records a `place_buy`. It fills when the offer for its side is at or below its limit and large
   * enough. Throws with a program error name when the program would refuse it.
   */
  place(input: PlaceInput, nowMs: number): void {
    const market = this.openMarket(input.market, nowMs);
    const ask = input.side === "YES" ? market.book?.askPx : market.book?.bidPx;
    const askPx = ask == null ? null : input.side === "YES" ? BigInt(ask) : complementPx(BigInt(ask));
    const offered = BigInt((input.side === "YES" ? market.book?.askUnits : market.book?.bidUnits) ?? "0");
    const fills = market.tradable && askPx !== null && input.limitPx >= askPx && input.units <= offered;
    this.record(input, market, { kind: "buy", mint: input.side === "YES" ? market.onchain.yesMint : market.onchain.noMint, fillPx: fills ? askPx : null, refusal: null }, nowMs);
  }

  /**
   * Records a `place_sell`: the tokens leave the wallet for the order's escrow. The relayer sends
   * the sale as a buy of the opposite outcome, so it fills when the bid for its side reaches the
   * minimum, and it is refused unsent when the least it could bring would not exceed the fee cap.
   * Throws with a program error name when the program would refuse it.
   */
  placeSell(input: PlaceSellInput, nowMs: number): void {
    const onchain = this.findMarket(input.market, nowMs)?.onchain;
    if (onchain && input.outcomeMint !== (input.side === "YES" ? onchain.yesMint : onchain.noMint)) throw new Error("WrongMint");
    const market = this.openMarket(input.market, nowMs);
    if (input.units <= 0n) throw new Error("BadQuantity");
    if (input.maxFeeMicros > input.units * input.limitPx) throw new Error("FeeCapTooHigh");
    const held = BigInt(this.chain(input.user, nowMs).positions.find((position) => position.mint === input.outcomeMint)?.units ?? "0");
    if (input.units > held) throw new Error("InsufficientFunds");
    const bid = input.side === "YES" ? market.book?.bidPx : market.book?.askPx;
    const bidPx = bid == null ? null : input.side === "YES" ? BigInt(bid) : complementPx(BigInt(bid));
    const wanted = BigInt((input.side === "YES" ? market.book?.bidUnits : market.book?.askUnits) ?? "0");
    const fills = market.tradable && bidPx !== null && input.limitPx <= bidPx && input.units <= wanted;
    this.record(input, market, { kind: "sell", mint: input.outcomeMint, fillPx: fills ? bidPx : null, refusal: input.units * input.limitPx > input.maxFeeMicros ? null : "fee_cap" }, nowMs);
  }

  /** Records a `cancel_order` sent by the user. */
  cancel(orderAddress: string, nowMs: number): void {
    this.state.cancelled.set(orderAddress, nowMs);
  }

  /**
   * Records a `redeem`: burns the tokens and pays what the market's settlement gives their side,
   * which is nothing for the side that lost. Throws with a program error name when the program
   * would refuse it.
   */
  redeem(input: RedeemInput, nowMs: number): void {
    const onchain = this.findMarket(input.market, nowMs)?.onchain;
    if (!onchain) throw new Error("NotSettled");
    if (input.outcomeMint !== onchain.yesMint && input.outcomeMint !== onchain.noMint) throw new Error("WrongMint");
    if (onchain.status !== "settled" || onchain.redeemAfter === null) throw new Error("NotSettled");
    if (Math.floor(nowMs / 1000) < onchain.redeemAfter) throw new Error("RedeemLocked");
    if (input.amount <= 0n) throw new Error("BadQuantity");
    const held = BigInt(this.chain(input.holder, nowMs).positions.find((position) => position.mint === input.outcomeMint)?.units ?? "0");
    if (input.amount > held) throw new Error("InsufficientFunds");
    const payout = BigInt((input.outcomeMint === onchain.yesMint ? onchain.yesPayout : onchain.noPayout) ?? "0");
    this.state.redemptions.push({ holder: input.holder, mint: input.outcomeMint, units: input.amount, payoutMicros: input.amount * payout });
  }

  private wasCancelled(address: string, sinceMs: number): boolean {
    const at = this.state.cancelled.get(address);
    return at !== undefined && at >= sinceMs;
  }

  private simApiOrder(order: SimOrder, nowMs: number): ApiOrder | null {
    const state = simState(order, nowMs);
    if (state === null) return null;
    const filled = order.fillPx !== null && (state === "venue_filled" || state === "chain_filled");
    const selling = order.kind === "sell";
    // A sale is filled as a buy of the opposite outcome: its fills are priced at the complement.
    const venuePx = order.fillPx === null ? null : selling ? complementPx(order.fillPx) : order.fillPx;
    const fee = filled ? takerFee(order.units, venuePx as bigint) : 0n;
    const sent = state !== "seen" && order.refusal === null;
    return {
      address: order.address,
      user: order.user,
      symbol: order.symbol,
      kind: order.kind,
      side: order.side,
      units: order.units.toString(),
      limitPx: order.limitPx.toString(),
      maxFeeMicros: order.maxFeeMicros.toString(),
      expiresAt: order.expiresAt,
      state,
      venueOrderId: sent ? `7361528${(41_000_000_000n + order.nonce * 1_117n).toString()}` : null,
      filledUnits: filled ? order.units.toString() : "0",
      amountMicros: filled ? cost(order.units, order.fillPx as bigint).toString() : "0",
      feeMicros: fee.toString(),
      fills: filled ? [{ tradeId: `28417301${order.nonce}`, units: order.units.toString(), px: (venuePx as bigint).toString(), feeMicros: fee.toString() }] : [],
      chainSignature: state === "chain_filled" || state === "chain_cancelled" ? fixtureSignature(`settle:${order.address}`) : null,
      detail: order.refusal ?? (state === "venue_not_filled" || state === "chain_cancelled" ? (selling ? "no bids at or above the minimum" : "no offers at or below the limit") : null),
      createdAt: order.placedAtMs + SEEN_AT,
      updatedAt: order.placedAtMs + Math.min(nowMs - order.placedAtMs, CHAIN_AT),
    };
  }

  /** The orders of the fixtures. One the user cancelled reads as the relayer would record it. */
  private baseOrders(user: string, nowMs: number): ApiOrder[] {
    return fixtureOrders(nowMs).map((order) =>
      order.state === "seen" && this.wasCancelled(order.address, order.createdAt) ? { ...order, user, state: "failed" as const, detail: "order account gone before submission" } : { ...order, user },
    );
  }

  /** The relayer's record of a wallet's orders, newest first. */
  orders(user: string, nowMs: number): ApiOrder[] {
    const simulated = [...this.state.placed.values()].filter((order) => order.user === user).flatMap((order) => this.simApiOrder(order, nowMs) ?? []);
    return [...simulated, ...this.baseOrders(user, nowMs)].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * What the wallet's accounts would hold on-chain. With `newWallets`, a wallet has nothing, not
   * even a Trader account, until the registrar has registered it.
   */
  chain(wallet: string, nowMs: number, newWallets = false): FixtureChain {
    if (newWallets && !this.state.registered.has(wallet)) return { trader: null, balances: { lamports: "0", stableMicros: "0" }, positions: [], openOrders: [] };

    const positions = new Map<string, bigint>();
    const add = (mint: string, units: bigint) => positions.set(mint, (positions.get(mint) ?? 0n) + units);
    for (const holding of fixtureHoldings(nowMs)) add(holding.mint, holding.units);

    let stable = STARTING_STABLE_MICROS;
    const openOrders: FixtureOpenOrder[] = [];
    const open = (order: Pick<ApiOrder, "address" | "kind" | "side" | "units" | "limitPx" | "maxFeeMicros" | "expiresAt">, market: string, nonce: bigint): void => {
      openOrders.push({
        address: order.address,
        user: wallet,
        market,
        side: order.side === "YES" ? 0 : 1,
        kind: order.kind === "sell" ? 1 : 0,
        qtyUnits: order.units,
        limitPx: order.limitPx,
        maxFee: order.maxFeeMicros,
        expiresAt: order.expiresAt,
        rentPayer: wallet,
        nonce: nonce.toString(),
      });
    };
    for (const order of this.state.placed.values()) {
      if (order.user !== wallet) continue;
      const state = simState(order, nowMs);
      const selling = order.kind === "sell";
      if (state === "chain_filled") {
        const price = order.fillPx as bigint;
        // A sale burns the tokens and pays the proceeds less the fee; a buy pays the cost and the fee, and mints.
        add(order.mint, selling ? -order.units : order.units);
        stable += selling ? cost(order.units, price) - takerFee(order.units, complementPx(price)) : -(cost(order.units, price) + takerFee(order.units, price));
      } else if (state !== "chain_cancelled" && !this.wasCancelled(order.address, order.placedAtMs)) {
        // In the order's escrow until it fills, is cancelled or is reclaimed: the tokens of a sale, the test dollars of a buy.
        if (selling) add(order.mint, -order.units);
        else stable -= order.units * order.limitPx + order.maxFeeMicros;
        open({ ...order, units: order.units.toString(), limitPx: order.limitPx.toString(), maxFeeMicros: order.maxFeeMicros.toString() }, order.market, order.nonce);
      }
    }
    // The fixture order the relayer never sends stays open until the user reclaims it.
    for (const [index, order] of fixtureOrders(nowMs).entries()) {
      const market = order.state === "seen" && !this.wasCancelled(order.address, order.createdAt) ? this.findMarket(order.symbol, nowMs)?.onchain?.market : undefined;
      if (market) open(order, market, BigInt(index));
    }

    for (const redemption of this.state.redemptions) {
      if (redemption.holder !== wallet) continue;
      stable += redemption.payoutMicros;
      add(redemption.mint, -redemption.units);
    }

    return {
      trader: { address: fixtureAddress(`trader:${wallet}`), nextNonce: this.nextNonce(wallet).toString() },
      balances: { lamports: STARTING_LAMPORTS.toString(), stableMicros: stable.toString() },
      positions: [...positions].filter(([, units]) => units > 0n).map(([mint, units]) => ({ mint, units: units.toString() })),
      openOrders,
    };
  }

  /**
   * The registrar of the simulated chain, for the route that registers and funds a wallet. Unless
   * `newWallets`, every wallet is a registered trader already.
   */
  funding(newWallets: boolean): FundingChain {
    const { registered } = this.state;
    return {
      traderExists: async (wallet) => !newWallets || registered.has(wallet),
      balances: async () => ({ lamports: STARTING_LAMPORTS, stableMicros: STARTING_STABLE_MICROS }),
      registerAndFund: async (wallet) => {
        registered.add(wallet);
        return this.nextSignature();
      },
      topUp: async () => this.nextSignature(),
    };
  }
}

const holder = globalThis as { __outcomeFixtureState?: WorldState };

/** One world per server process, shared by every route. */
export function fixtureWorld(): FixtureWorld {
  // A state kept across a reload of this module may predate a field.
  holder.__outcomeFixtureState = Object.assign(emptyState(), holder.__outcomeFixtureState);
  return new FixtureWorld(holder.__outcomeFixtureState);
}
