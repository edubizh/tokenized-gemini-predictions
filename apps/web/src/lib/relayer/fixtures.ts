// Deterministic relayer data for the component gallery, screenshots and tests. Served by the
// proxy when RELAYER_URL=fixtures. Every time is an offset from the anchor passed in, so the same
// anchor always gives the same data.

import { getAddressDecoder, getBase58Decoder } from "@solana/kit";
import { OUTCOME_TOKENS_PROGRAM_ADDRESS } from "@outcome/program-client";
import { complementPx, cost, feeCap, takerFee } from "@outcome/relayer/money";
import type {
  ApiError,
  ApiHealth,
  ApiMarket,
  ApiOnchainMarket,
  ApiOrder,
  ApiReconcileMarket,
  ApiStatus,
} from "@outcome/relayer/api-types";
import type { FixtureChainMarket } from "@/lib/fixtures/chain-types";
import type { RelayerRoute } from "./proxy";

type OrderState = ApiOrder["state"];

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const WINDOW = 15 * MINUTE;

/** Pseudo-random bytes from a label (FNV-1a seed, xorshift32 stream). Not a hash; fixtures only. */
function bytesFor(label: string, length: number): Uint8Array {
  let state = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) state = Math.imul(state ^ label.charCodeAt(i), 0x01000193) >>> 0;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
}

export function fixtureAddress(label: string): string {
  return getAddressDecoder().decode(bytesFor(`address:${label}`, 32));
}

export function fixtureSignature(label: string): string {
  const bytes = bytesFor(`signature:${label}`, 64);
  bytes[0] = (bytes[0] ?? 0) | 0x80; // keeps the base58 form at full length
  return getBase58Decoder().decode(bytes);
}

export const FIXTURE_USER = fixtureAddress("user");
const RELAYER = fixtureAddress("relayer");
const STABLE_MINT = fixtureAddress("stable-mint");

function stamp(atMs: number): string {
  const d = new Date(atMs);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getUTCFullYear() % 100)}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}`;
}

interface MarketSpec {
  underlying: "BTC" | "ETH" | "SOL";
  name: string;
  /** Milliseconds from the anchor to the end of the 15-minute window. */
  expiresIn: number;
  strike: string;
  bidPx: bigint | null;
  askPx: bigint | null;
  supply: [yes: bigint, no: bigint] | null;
  phase: "live" | "not_started" | "awaiting_result" | "settled_yes" | "settled_no";
  settlementValue?: string;
}

const MARKETS: readonly MarketSpec[] = [
  { underlying: "BTC", name: "Bitcoin", expiresIn: 9 * MINUTE + 41 * SECOND, strike: "104212.5", bidPx: 5_500n, askPx: 5_700n, supply: [1_250n, 400n], phase: "live" },
  { underlying: "ETH", name: "Ether", expiresIn: 95 * SECOND, strike: "3412.0791666666", bidPx: 6_100n, askPx: 6_400n, supply: [300n, 0n], phase: "live" },
  { underlying: "SOL", name: "Solana", expiresIn: 9 * MINUTE + 41 * SECOND + WINDOW, strike: "", bidPx: null, askPx: null, supply: null, phase: "not_started" },
  { underlying: "BTC", name: "Bitcoin", expiresIn: 9 * MINUTE + 41 * SECOND - WINDOW, strike: "104180", bidPx: null, askPx: null, supply: [500n, 500n], phase: "awaiting_result" },
  { underlying: "ETH", name: "Ether", expiresIn: 95 * SECOND - 2 * WINDOW, strike: "3398.4", bidPx: null, askPx: null, supply: [800n, 200n], phase: "settled_yes", settlementValue: "3404.11" },
  { underlying: "SOL", name: "Solana", expiresIn: 9 * MINUTE + 41 * SECOND - 3 * WINDOW, strike: "187.3249583333", bidPx: null, askPx: null, supply: [100n, 600n], phase: "settled_no", settlementValue: "186.95" },
];

function buildMarket(spec: MarketSpec, anchor: number): ApiMarket {
  const expiresAt = anchor + spec.expiresIn;
  const startsAt = expiresAt - WINDOW;
  const series = `${spec.underlying}15M`;
  const eventTicker = `${series}${stamp(expiresAt)}`;
  const symbol = `GEMI-${eventTicker}-UP`;
  const settled = spec.phase === "settled_yes" || spec.phase === "settled_no";
  const live = spec.phase === "live";

  const onchain: ApiOnchainMarket | null = spec.supply && {
    market: fixtureAddress(`market:${symbol}`),
    yesMint: fixtureAddress(`yes:${symbol}`),
    noMint: fixtureAddress(`no:${symbol}`),
    status: settled ? "settled" : "open",
    closeTs: Math.floor(expiresAt / 1000),
    placeCutoffSecs: 60,
    yesSupply: spec.supply[0].toString(),
    noSupply: spec.supply[1].toString(),
    yesPayout: settled ? (spec.phase === "settled_yes" ? "10000" : "0") : null,
    noPayout: settled ? (spec.phase === "settled_yes" ? "0" : "10000") : null,
    redeemAfter: settled ? Math.floor((expiresAt + 3 * MINUTE) / 1000) : null,
  };

  return {
    symbol,
    eventTicker,
    series,
    underlying: spec.underlying,
    title: `${spec.name} up or down in 15 minutes`,
    label: "Up",
    startsAt,
    expiresAt,
    lastOrderAt: expiresAt - MINUTE,
    strike: spec.phase === "not_started" ? null : spec.strike,
    venueStatus: live ? "active" : spec.phase === "not_started" ? "approved" : settled ? "settled" : "closed",
    marketState: live ? "open" : spec.phase === "not_started" ? "pending" : "closed",
    tradable: live,
    notTradableReason: live ? null : spec.phase === "not_started" ? "not_started" : "market_not_open",
    tickPx: "100",
    minUnits: "1",
    unitIncrement: "1",
    book: live ? { bidPx: spec.bidPx?.toString() ?? null, bidUnits: "25000", askPx: spec.askPx?.toString() ?? null, askUnits: "18000", at: anchor - SECOND } : null,
    onchain,
    resolution: spec.phase === "settled_yes" ? "yes" : spec.phase === "settled_no" ? "no" : null,
    settlementValue: spec.settlementValue ?? null,
    settleState: live || spec.phase === "not_started" ? "open" : settled ? "settled" : "awaiting_result",
  };
}

interface OrderSpec {
  state: OrderState;
  market: number;
  side: "YES" | "NO";
  units: bigint;
  limitPx: bigint;
  /** Fill price in the order's own outcome space; null when nothing filled. */
  fillPx: bigint | null;
  /** Milliseconds before the anchor at which the order was placed. */
  age: number;
  detail: string | null;
}

const ORDERS: readonly OrderSpec[] = [
  { state: "seen", market: 0, side: "YES", units: 500n, limitPx: 5_700n, fillPx: null, age: 2 * SECOND, detail: null },
  { state: "submitting", market: 0, side: "NO", units: 200n, limitPx: 4_500n, fillPx: null, age: 6 * SECOND, detail: null },
  { state: "venue_filled", market: 1, side: "YES", units: 1_000n, limitPx: 6_400n, fillPx: 6_300n, age: 11 * SECOND, detail: null },
  { state: "venue_not_filled", market: 1, side: "NO", units: 100n, limitPx: 3_000n, fillPx: null, age: 14 * SECOND, detail: "no offers at or below the limit" },
  { state: "venue_unknown", market: 0, side: "YES", units: 300n, limitPx: 5_800n, fillPx: null, age: 40 * SECOND, detail: "no answer from the venue within 10 s; checking order history" },
  { state: "chain_filled", market: 3, side: "YES", units: 500n, limitPx: 5_700n, fillPx: 5_600n, age: 12 * MINUTE, detail: null },
  { state: "chain_cancelled", market: 4, side: "NO", units: 400n, limitPx: 4_000n, fillPx: null, age: 31 * MINUTE, detail: "no offers at or below the limit" },
  { state: "orphaned", market: 5, side: "NO", units: 150n, limitPx: 5_200n, fillPx: 5_100n, age: 44 * MINUTE, detail: "filled at the venue after the order expired on-chain; refunded, kept as operator inventory" },
  { state: "failed", market: 5, side: "YES", units: 250n, limitPx: 4_900n, fillPx: null, age: 47 * MINUTE, detail: "market closed before the order could be sent" },
];

function buildOrder(spec: OrderSpec, index: number, markets: readonly ApiMarket[], anchor: number): ApiOrder {
  const market = markets[spec.market] as ApiMarket;
  const address = fixtureAddress(`order:${index}`);
  const createdAt = anchor - spec.age;
  const filled = spec.fillPx !== null;
  const onChain = spec.state === "chain_filled" || spec.state === "chain_cancelled" || spec.state === "orphaned";
  const fee = filled ? takerFee(spec.units, spec.fillPx as bigint) : 0n;
  return {
    address,
    user: FIXTURE_USER,
    symbol: market.symbol,
    kind: "buy",
    side: spec.side,
    units: spec.units.toString(),
    limitPx: spec.limitPx.toString(),
    maxFeeMicros: feeCap(spec.units, spec.limitPx).toString(),
    expiresAt: Math.floor((createdAt + 45 * SECOND) / 1000),
    state: spec.state,
    venueOrderId: spec.state === "seen" || spec.state === "failed" ? null : `7361528${(40_000_000_000 + index * 1_117).toString()}`,
    filledUnits: filled ? spec.units.toString() : "0",
    amountMicros: filled ? cost(spec.units, spec.fillPx as bigint).toString() : "0",
    feeMicros: fee.toString(),
    fills: filled
      ? [{ tradeId: `28417300${5_120 + index}`, units: spec.units.toString(), px: (spec.fillPx as bigint).toString(), feeMicros: fee.toString() }]
      : [],
    chainSignature: onChain ? fixtureSignature(`order:${index}`) : null,
    detail: spec.detail,
    createdAt,
    updatedAt: createdAt + (spec.state === "seen" ? 0 : 3 * SECOND),
  };
}

/**
 * A market that settled NO a moment ago: redemption opens five and a half minutes after the
 * anchor, so within one fixture cycle it is first locked and then, in the next cycle, open.
 * Not part of `buildFixtures`; the simulated relayer lists it beside the others.
 */
export function buildJustSettledMarket(anchorMs: number): ApiMarket {
  const anchor = Math.floor(anchorMs / 1000) * 1000;
  const market = buildMarket(
    { underlying: "BTC", name: "Bitcoin", expiresIn: 9 * MINUTE + 41 * SECOND - 2 * WINDOW, strike: "104094.25", bidPx: null, askPx: null, supply: [0n, 200n], phase: "settled_no", settlementValue: "104061.8" },
    anchor,
  );
  return { ...market, onchain: market.onchain && { ...market.onchain, redeemAfter: Math.floor((anchor + 5 * MINUTE + 30 * SECOND) / 1000) } };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** The metadata name the relayer gives an outcome token: `BTC Up 22:00Z 14 Nov YES`. */
export function fixtureTokenName(market: Pick<ApiMarket, "underlying" | "label" | "expiresAt">, side: "YES" | "NO"): string {
  const expiry = new Date(market.expiresAt);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${market.underlying} ${market.label} ${two(expiry.getUTCHours())}:${two(expiry.getUTCMinutes())}Z ${expiry.getUTCDate()} ${MONTHS[expiry.getUTCMonth()] ?? ""} ${side}`;
}

/** A market's account as the simulated chain holds it; null for a market that is not on-chain. */
export function fixtureChainMarket(market: ApiMarket): FixtureChainMarket | null {
  const onchain = market.onchain;
  if (!onchain) return null;
  return {
    address: onchain.market,
    symbol: market.symbol,
    yesMint: onchain.yesMint,
    noMint: onchain.noMint,
    status: onchain.status,
    closeTs: onchain.closeTs,
    placeCutoffSecs: onchain.placeCutoffSecs,
    tickPx: Number(market.tickPx),
    yesPayout: onchain.yesPayout ?? "0",
    noPayout: onchain.noPayout ?? "0",
    redeemAfter: onchain.redeemAfter ?? 0,
    tokenName: fixtureTokenName(market, "YES"),
  };
}

export interface Fixtures {
  markets: ApiMarket[];
  orders: ApiOrder[];
  health: ApiHealth;
  status: ApiStatus;
}

/**
 * A market as it stands at `nowMs`: orders close at `lastOrderAt`, and after expiry a market that
 * was open awaits its result. Fixture markets are built at their anchor and aged with this.
 */
export function ageMarket(market: ApiMarket, nowMs: number): ApiMarket {
  if (market.settleState !== "open" || market.startsAt > nowMs) return market;
  if (nowMs >= market.expiresAt) {
    return { ...market, venueStatus: "closed", marketState: "closed", tradable: false, notTradableReason: "market_not_open", book: null, settleState: "awaiting_result" };
  }
  if (market.tradable && nowMs >= market.lastOrderAt) return { ...market, tradable: false, notTradableReason: "too_close_to_expiry" };
  return market;
}

export function buildFixtures(anchorMs: number, nowMs: number = anchorMs): Fixtures {
  const anchor = Math.floor(anchorMs / 1000) * 1000;
  const markets = MARKETS.map((spec) => ageMarket(buildMarket(spec, anchor), nowMs));
  const orders = ORDERS.map((spec, index) => buildOrder(spec, index, markets, anchor));

  const health: ApiHealth = {
    ok: true,
    cluster: "devnet",
    venue: "mock",
    programId: OUTCOME_TOKENS_PROGRAM_ADDRESS,
    relayer: RELAYER,
    stableMint: STABLE_MINT,
    paused: { place: false, fill: false },
    venueConnected: true,
    chainTime: Math.floor(nowMs / 1000),
    serverTime: nowMs,
    orderTtlSecs: 45,
    minOrderUnits: "1",
    maxOrderUnits: "100000",
    feeSlackMicros: "30000",
  };

  const reconcile: ApiReconcileMarket[] = markets
    .filter((market) => market.onchain !== null)
    .map((market) => {
      const yes = BigInt(market.onchain?.yesSupply ?? "0");
      const no = BigInt(market.onchain?.noSupply ?? "0");
      const orphan = orders.find((o) => o.state === "orphaned" && o.symbol === market.symbol);
      const house = orphan ? -BigInt(orphan.filledUnits) : 0n;
      return {
        symbol: market.symbol,
        yesSupply: yes.toString(),
        noSupply: no.toString(),
        venueNet: (yes - no + house).toString(),
        inFlight: "0",
        houseInventory: house.toString(),
        balanced: true,
      };
    });
  const journal = Object.fromEntries(
    (["seen", "submitting", "venue_filled", "venue_not_filled", "venue_unknown", "chain_filled", "chain_cancelled", "orphaned", "failed"] as const).map(
      (state) => [state, orders.filter((o) => o.state === state).length],
    ),
  ) as ApiStatus["journal"];
  const orphaned = orders.find((o) => o.state === "orphaned");
  const status: ApiStatus = {
    markets: reconcile,
    solvency: { venueCashMicros: "9412350000", treasuryMicros: "1000038420000", requiredMicros: "17000000", ok: true },
    journal,
    relayerLamports: "2871450000",
    alerts: orphaned ? [{ at: orphaned.updatedAt, kind: "orphaned_fill", orderAddress: orphaned.address, detail: orphaned.detail ?? "" }] : [],
  };

  return { markets, orders, health, status };
}

/** Ask prices of both sides in px. The NO ask is the complement of the YES bid. */
export function askPrices(market: ApiMarket): { yes: bigint | null; no: bigint | null } {
  const ask = market.book?.askPx ?? null;
  const bid = market.book?.bidPx ?? null;
  return { yes: ask === null ? null : BigInt(ask), no: bid === null ? null : complementPx(BigInt(bid)) };
}

export interface FixtureResponse {
  status: number;
  body: ApiHealth | ApiMarket | ApiOrder | ApiStatus | ApiError | { markets: ApiMarket[] } | { orders: ApiOrder[] };
}

/** What the relayer would answer for an allowed route. Orders are shown to whichever wallet asks. */
export function fixtureResponse(route: RelayerRoute, anchorMs: number, nowMs: number = anchorMs): FixtureResponse {
  const fixtures = buildFixtures(anchorMs, nowMs);
  switch (route.kind) {
    case "health":
      return { status: 200, body: fixtures.health };
    case "status":
      return { status: 200, body: fixtures.status };
    case "markets":
      return { status: 200, body: { markets: route.scope === "all" ? fixtures.markets : fixtures.markets.filter((m) => m.settleState === "open") } };
    case "market":
    case "ensure": {
      const market = fixtures.markets.find((m) => m.symbol === route.symbol);
      return market ? { status: 200, body: market } : { status: 404, body: { error: "unknown market" } };
    }
    case "orders":
      return { status: 200, body: { orders: fixtures.orders.map((order) => ({ ...order, user: route.user })) } };
    case "order": {
      const order = fixtures.orders.find((o) => o.address === route.address);
      return order ? { status: 200, body: order } : { status: 404, body: { error: "unknown order" } };
    }
  }
}
