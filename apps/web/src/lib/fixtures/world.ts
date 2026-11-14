// The simulated relayer and chain of fixtures mode, kept in the app server's memory. An order
// placed in the browser is recorded here and walks through the relayer's states over a few
// seconds, so every page can be driven without a chain. Server only.

import type { ApiMarket, ApiOrder, SideName } from "@outcome/relayer/api-types";
import { complementPx, cost, takerFee } from "@outcome/relayer/money";
import { buildFixtures, fixtureAddress, fixtureResponse, fixtureSignature, type FixtureResponse } from "@/lib/relayer/fixtures";
import type { RelayerRoute } from "@/lib/relayer/proxy";
import type { FixtureChain, FixtureOpenOrder } from "./chain-types";

/** Fixture times are offsets from an anchor that moves every five minutes, so countdowns run. */
export const FIXTURE_CYCLE_MS = 5 * 60 * 1000;
/** Symbols carry their expiry time and so change with the anchor; older ones stay resolvable. */
const ANCHORS_BACK = 6;

const STARTING_STABLE_MICROS = 1_000_000_000n;
const STARTING_LAMPORTS = 50_000_000n;
const FIRST_NONCE = 16n;
const ORDER_TTL_SECS = 45;
/** How long the simulated relayer takes to create a market on-chain; the proxy route waits this long. */
export const ENSURE_DELAY_MS = 1_500;

// Milliseconds after placement at which a simulated order reaches each state.
const SEEN_AT = 1_200;
const SUBMITTING_AT = 2_400;
const VENUE_AT = 3_800;
const CHAIN_AT = 5_400;

/** Base fixture orders the live app shows: one that the relayer never sends, and the finished ones. */
const LISTED_BASE_STATES: ReadonlySet<ApiOrder["state"]> = new Set(["seen", "chain_filled", "chain_cancelled", "orphaned", "failed"]);

interface SimOrder {
  address: string;
  user: string;
  symbol: string;
  market: string;
  side: SideName;
  units: bigint;
  limitPx: bigint;
  maxFeeMicros: bigint;
  nonce: bigint;
  placedAtMs: number;
  /** Cluster seconds. */
  expiresAt: number;
  /** The price it fills at; null when the limit is below the ask or the book is too thin. */
  fillPx: bigint | null;
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

function anchorOf(nowMs: number): number {
  return Math.floor(nowMs / FIXTURE_CYCLE_MS) * FIXTURE_CYCLE_MS;
}

function simState(order: SimOrder, nowMs: number): ApiOrder["state"] | null {
  const age = nowMs - order.placedAtMs;
  if (age < SEEN_AT) return null;
  if (age < SUBMITTING_AT) return "seen";
  if (age < VENUE_AT) return "submitting";
  const filled = order.fillPx !== null;
  if (age < CHAIN_AT) return filled ? "venue_filled" : "venue_not_filled";
  return filled ? "chain_filled" : "chain_cancelled";
}

/** Everything the world remembers. Kept apart from the class so a reload of this module keeps it. */
interface WorldState {
  placed: Map<string, SimOrder>;
  /** Orders the user cancelled themselves, with the time of the cancel. */
  cancelled: Map<string, number>;
  /** Markets the relayer has been asked to create on-chain. */
  ensured: Set<string>;
  transactions: number;
}

export class FixtureWorld {
  private readonly state: WorldState;

  constructor(state: WorldState = { placed: new Map(), cancelled: new Map(), ensured: new Set(), transactions: 0 }) {
    this.state = state;
  }

  private get placed() {
    return this.state.placed;
  }

  private get cancelled() {
    return this.state.cancelled;
  }

  private get ensured() {
    return this.state.ensured;
  }

  nextSignature(): string {
    this.state.transactions += 1;
    return fixtureSignature(`tx:${this.state.transactions}`);
  }

  /**
   * Markets of one anchor: the fixture set plus two more contracts in the first market's window,
   * as a venue lists several assets for the same fifteen minutes. The last of them starts without
   * its on-chain account, so opening it shows the market being prepared.
   */
  private markets(nowMs: number, anchor = anchorOf(nowMs)): ApiMarket[] {
    const base = buildFixtures(anchor, nowMs).markets;
    const template = base[0];
    if (!template) return base;
    const sibling = (underlying: string, name: string, strike: string, bidPx: string, askPx: string): ApiMarket => {
      const series = `${underlying}15M`;
      const eventTicker = template.eventTicker.replace(template.series, series);
      const symbol = `GEMI-${eventTicker}-UP`;
      const ready = underlying !== "SOL" || this.ensured.has(symbol);
      return {
        ...template,
        symbol,
        eventTicker,
        series,
        underlying,
        title: `${name} up or down in 15 minutes`,
        strike,
        book: template.book && { ...template.book, bidPx, askPx, bidUnits: "12000", askUnits: "9500" },
        onchain: template.onchain && ready
          ? { ...template.onchain, market: fixtureAddress(`market:${symbol}`), yesMint: fixtureAddress(`yes:${symbol}`), noMint: fixtureAddress(`no:${symbol}`), yesSupply: "0", noSupply: "0" }
          : null,
      };
    };
    return [...base, sibling("ETH", "Ether", "3415.2266666667", "3800", "4100"), sibling("SOL", "Solana", "187.9104166667", "6200", "6500")];
  }

  /** By venue symbol or by on-chain market address, across recent anchors. */
  findMarket(key: string, nowMs: number): ApiMarket | undefined {
    for (let back = 0; back < ANCHORS_BACK; back++) {
      const found = this.markets(nowMs, anchorOf(nowMs) - back * FIXTURE_CYCLE_MS).find((market) => market.symbol === key || market.onchain?.market === key);
      if (found) return found;
    }
    return undefined;
  }

  private nextNonce(user: string): bigint {
    let count = 0n;
    for (const order of this.placed.values()) if (order.user === user) count += 1n;
    return FIRST_NONCE + count;
  }

  /** Records a `place_buy`. Throws with a program error name when the program would refuse it. */
  place(input: PlaceInput, nowMs: number): void {
    const market = this.findMarket(input.market, nowMs);
    if (!market?.onchain) throw new Error("MarketNotOpen");
    if (nowMs >= market.lastOrderAt) throw new Error("TooCloseToClose");
    const ask = input.side === "YES" ? market.book?.askPx : market.book?.bidPx;
    const askPx = ask == null ? null : input.side === "YES" ? BigInt(ask) : complementPx(BigInt(ask));
    const offered = BigInt((input.side === "YES" ? market.book?.askUnits : market.book?.bidUnits) ?? "0");
    const fills = market.tradable && askPx !== null && input.limitPx >= askPx && input.units <= offered;
    this.placed.set(input.order, {
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
      expiresAt: Math.min(Math.floor(nowMs / 1000) + ORDER_TTL_SECS, market.onchain.closeTs),
      fillPx: fills ? askPx : null,
    });
  }

  /** Records a `cancel_order` sent by the user. */
  cancel(orderAddress: string, nowMs: number): void {
    this.cancelled.set(orderAddress, nowMs);
  }

  private wasCancelled(address: string, sinceMs: number): boolean {
    const at = this.cancelled.get(address);
    return at !== undefined && at >= sinceMs;
  }

  private simApiOrder(order: SimOrder, nowMs: number): ApiOrder | null {
    const state = simState(order, nowMs);
    if (state === null) return null;
    const filled = order.fillPx !== null && (state === "venue_filled" || state === "chain_filled");
    const fee = filled ? takerFee(order.units, order.fillPx as bigint) : 0n;
    const sent = state !== "seen";
    return {
      address: order.address,
      user: order.user,
      symbol: order.symbol,
      kind: "buy",
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
      fills: filled ? [{ tradeId: `28417301${order.nonce}`, units: order.units.toString(), px: (order.fillPx as bigint).toString(), feeMicros: fee.toString() }] : [],
      chainSignature: state === "chain_filled" || state === "chain_cancelled" ? fixtureSignature(`settle:${order.address}`) : null,
      detail: state === "venue_not_filled" || state === "chain_cancelled" ? "no offers at or below the limit" : null,
      createdAt: order.placedAtMs + SEEN_AT,
      updatedAt: order.placedAtMs + Math.min(nowMs - order.placedAtMs, CHAIN_AT),
    };
  }

  /** The base orders the live app lists. One the user cancelled reads as the relayer would record it. */
  private baseOrders(user: string, nowMs: number): ApiOrder[] {
    return buildFixtures(anchorOf(nowMs), nowMs)
      .orders.filter((order) => LISTED_BASE_STATES.has(order.state))
      .map((order) =>
        order.state === "seen" && this.wasCancelled(order.address, order.createdAt)
          ? { ...order, user, state: "failed" as const, detail: "order account gone before submission" }
          : { ...order, user },
      );
  }

  orders(user: string, nowMs: number): ApiOrder[] {
    const simulated = [...this.placed.values()].filter((order) => order.user === user).flatMap((order) => this.simApiOrder(order, nowMs) ?? []);
    return [...simulated, ...this.baseOrders(user, nowMs)].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** What the wallet's accounts would hold on-chain. */
  chain(wallet: string, nowMs: number): FixtureChain {
    const markets = buildFixtures(anchorOf(nowMs), nowMs).markets;
    const positions = new Map<string, bigint>();
    const add = (mint: string | undefined, units: bigint) => {
      if (mint) positions.set(mint, (positions.get(mint) ?? 0n) + units);
    };
    // One live position, one awaiting its result, one that won and one that lost.
    add(markets[0]?.onchain?.yesMint, 300n);
    add(markets[3]?.onchain?.yesMint, 500n);
    add(markets[4]?.onchain?.yesMint, 500n);
    add(markets[5]?.onchain?.yesMint, 250n);

    let stable = STARTING_STABLE_MICROS;
    const openOrders: FixtureOpenOrder[] = [];
    for (const order of this.placed.values()) {
      if (order.user !== wallet) continue;
      const state = simState(order, nowMs);
      const hold = order.units * order.limitPx + order.maxFeeMicros;
      if (state === "chain_filled") {
        const price = order.fillPx as bigint;
        stable -= cost(order.units, price) + takerFee(order.units, price);
        const market = this.findMarket(order.market, nowMs);
        add(order.side === "YES" ? market?.onchain?.yesMint : market?.onchain?.noMint, order.units);
      } else if (state !== "chain_cancelled" && !this.wasCancelled(order.address, order.placedAtMs)) {
        stable -= hold;
        openOrders.push({
          address: order.address,
          user: order.user,
          market: order.market,
          side: order.side === "YES" ? 0 : 1,
          kind: 0,
          qtyUnits: order.units.toString(),
          limitPx: order.limitPx.toString(),
          maxFee: order.maxFeeMicros.toString(),
          expiresAt: order.expiresAt,
          rentPayer: order.user,
          nonce: order.nonce.toString(),
        });
      }
    }
    // The base order the relayer never sends stays open until the user reclaims it.
    for (const [index, order] of buildFixtures(anchorOf(nowMs), nowMs).orders.entries()) {
      if (order.state !== "seen" || this.wasCancelled(order.address, order.createdAt)) continue;
      const market = markets.find((candidate) => candidate.symbol === order.symbol);
      if (!market?.onchain) continue;
      openOrders.push({
        address: order.address,
        user: wallet,
        market: market.onchain.market,
        side: order.side === "YES" ? 0 : 1,
        kind: 0,
        qtyUnits: order.units,
        limitPx: order.limitPx,
        maxFee: order.maxFeeMicros,
        expiresAt: order.expiresAt,
        rentPayer: wallet,
        nonce: index.toString(),
      });
    }

    return {
      trader: { address: fixtureAddress(`trader:${wallet}`), nextNonce: this.nextNonce(wallet).toString() },
      balances: { lamports: STARTING_LAMPORTS.toString(), stableMicros: stable.toString() },
      positions: [...positions].map(([mint, units]) => ({ mint, units: units.toString() })),
      openOrders,
    };
  }

  /** What the relayer would answer for an allowed route. */
  respond(route: RelayerRoute, nowMs: number): FixtureResponse {
    switch (route.kind) {
      case "markets": {
        const markets = this.markets(nowMs);
        return { status: 200, body: { markets: route.scope === "all" ? markets : markets.filter((market) => market.expiresAt > nowMs && market.settleState === "open") } };
      }
      case "ensure":
      case "market": {
        // The route waits `ENSURE_DELAY_MS` before asking, as creating a market takes a moment.
        if (route.kind === "ensure") this.ensured.add(route.symbol);
        const market = this.findMarket(route.symbol, nowMs);
        return market ? { status: 200, body: market } : { status: 404, body: { error: "unknown market" } };
      }
      case "orders":
        return { status: 200, body: { orders: this.orders(route.user, nowMs) } };
      case "order": {
        for (const order of this.placed.values()) {
          if (order.address !== route.address) continue;
          const view = this.simApiOrder(order, nowMs);
          return view ? { status: 200, body: view } : { status: 404, body: { error: "unknown order" } };
        }
        const base = this.baseOrders("", nowMs).find((order) => order.address === route.address);
        return base ? { status: 200, body: base } : { status: 404, body: { error: "unknown order" } };
      }
      default:
        return fixtureResponse(route, anchorOf(nowMs), nowMs);
    }
  }
}

const holder = globalThis as { __outcomeFixtureState?: WorldState };

/** One world per server process, shared by every route. */
export function fixtureWorld(): FixtureWorld {
  holder.__outcomeFixtureState ??= { placed: new Map(), cancelled: new Map(), ensured: new Set(), transactions: 0 };
  return new FixtureWorld(holder.__outcomeFixtureState);
}
