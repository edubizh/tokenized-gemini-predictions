import { describe, expect, it } from "vitest";
import type { ApiDepth, ApiEvent, ApiEventDetail, ApiHistory, ApiMarket, ApiOrder, ApiTrade } from "@outcome/relayer/api-types";
import { feeCap } from "@outcome/relayer/money";
import { fixtureAddress } from "@/lib/relayer/fixtures";
import { matchRoute, type RelayerRoute } from "@/lib/relayer/proxy";
import { FixtureWorld } from "./world";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
// A Saturday. The hourly ladder that is listed expires at 22:13; the one before it expired at 22:08.
const NOW = Date.UTC(2026, 10, 14, 22, 8, 30);
// Three minutes on: the 22:08 ladder can be redeemed, and the fifteen-minute event of 22:11 has just settled.
const LATER = Date.UTC(2026, 10, 14, 22, 11, 30);
const WALLET = fixtureAddress("world-test-wallet");
const LADDER = "BTC2611142213";

const route = (method: string, path: string): RelayerRoute => {
  const [segments = "", search = ""] = path.split("?");
  return matchRoute(method, segments.split("/"), search) as RelayerRoute;
};
const get = <T>(world: FixtureWorld, path: string, nowMs = NOW) => world.respond(route("GET", path), nowMs).body as T;
const market = (world: FixtureWorld, symbol: string, nowMs = NOW) => get<ApiMarket>(world, `markets/${symbol}`, nowMs);
const held = (world: FixtureWorld, mint: string, nowMs: number) => world.chain(WALLET, nowMs).positions.find((position) => position.mint === mint)?.units ?? "0";
const stable = (world: FixtureWorld, nowMs: number) => BigInt(world.chain(WALLET, nowMs).balances.stableMicros);

describe("the simulated relayer: routes", () => {
  it("answers every route of the allow-list", () => {
    const world = new FixtureWorld();
    const symbol = `GEMI-${LADDER}-HI104200`;
    expect(world.respond(route("GET", "health"), NOW)).toMatchObject({ status: 200, body: { ok: true, venue: "mock", chainTime: NOW / SECOND } });
    expect(world.respond(route("GET", "status"), NOW)).toMatchObject({ status: 200, body: { solvency: { ok: true } } });
    expect(get<{ events: ApiEvent[] }>(world, "events").events).toHaveLength(11);
    expect(get<ApiEventDetail>(world, `events/${LADDER}`)).toMatchObject({ ticker: LADDER, shape: "ladder", cadence: "hourly" });
    expect(get<{ markets: ApiMarket[] }>(world, "markets").markets).toHaveLength(8);
    expect(market(world, symbol)).toMatchObject({ symbol, eventTicker: LADDER, label: "$104,200 or above" });
    expect(get<ApiDepth>(world, `markets/${symbol}/depth`).bids[0]).toEqual({ px: "5200", units: "2500" });
    expect(get<{ trades: ApiTrade[] }>(world, `markets/${symbol}/trades`).trades).toHaveLength(42);
    expect(get<ApiHistory>(world, `markets/${symbol}/history`)).toMatchObject({ stepSecs: 60 });
    expect(get<{ orders: ApiOrder[] }>(world, `orders?user=${WALLET}`).orders).toHaveLength(5);
    expect(world.respond(route("POST", `markets/${symbol}/ensure`), NOW)).toMatchObject({ status: 200, body: { symbol } });
  });

  it("lists events without what only an event's own page needs", () => {
    const world = new FixtureWorld();
    const [listed] = get<{ events: ApiEvent[] }>(world, "events").events;
    expect(Object.keys(listed as ApiEvent).sort()).toEqual(["cadence", "category", "expiresAt", "listedAt", "markets", "shape", "subcategory", "ticker", "title", "underlying", "venueStatus", "volumeUnits"]);
    const detail = get<ApiEventDetail>(world, `events/${LADDER}`);
    expect(detail.description).toContain("BTC price prediction event");
    expect(Object.keys(detail.rules)).toHaveLength(8);
  });

  it("answers 404 for what it does not know", () => {
    const world = new FixtureWorld();
    expect(world.respond(route("GET", "events/DOGE2611142213"), NOW)).toEqual({ status: 404, body: { error: "unknown event" } });
    for (const path of ["markets/GEMI-NOPE", "markets/GEMI-NOPE/depth", "markets/GEMI-NOPE/trades", "markets/GEMI-NOPE/history"]) {
      expect(world.respond(route("GET", path), NOW), path).toEqual({ status: 404, body: { error: "unknown market" } });
    }
    expect(world.respond(route("POST", "markets/GEMI-NOPE/ensure"), NOW)).toEqual({ status: 404, body: { error: "unknown market" } });
    expect(world.respond(route("GET", `orders/${WALLET}`), NOW)).toEqual({ status: 404, body: { error: "unknown order" } });
  });

  it("shows its orders to whichever wallet asks, and one of them by its address", () => {
    const world = new FixtureWorld();
    const orders = get<{ orders: ApiOrder[] }>(world, `orders?user=${WALLET}`).orders;
    expect(orders.map((order) => order.state)).toEqual(["seen", "chain_filled", "chain_cancelled", "orphaned", "failed"]);
    expect(orders.every((order) => order.user === WALLET)).toBe(true);
    expect(get<ApiOrder>(world, `orders/${orders[1]!.address}`)).toMatchObject({ address: orders[1]!.address, state: "chain_filled" });
  });
});

describe("the simulated relayer: creating a market on-chain", () => {
  const symbol = `GEMI-${LADDER}-HI104000`;
  const ensure = (world: FixtureWorld, target = symbol, nowMs = NOW) => world.respond(route("POST", `markets/${target}/ensure`), nowMs);

  it("lists a contract without its on-chain market until someone asks for it", () => {
    const world = new FixtureWorld();
    expect(market(world, symbol).onchain).toBeNull();
    expect(get<{ markets: ApiMarket[] }>(world, "markets").markets.map((entry) => entry.symbol)).not.toContain(symbol);

    const created = ensure(world);
    expect(created.status).toBe(200);
    expect((created.body as ApiMarket).onchain).toMatchObject({ status: "open", market: fixtureAddress(`market:${symbol}`), yesSupply: "0", noSupply: "0" });
    expect(market(world, symbol).onchain).not.toBeNull();
    expect(get<ApiEventDetail>(world, `events/${LADDER}`).markets.filter((entry) => entry.onchain !== null).map((entry) => entry.symbol)).toEqual([symbol, `GEMI-${LADDER}-HI104100`, `GEMI-${LADDER}-HI104400`]);
    expect(get<{ markets: ApiMarket[] }>(world, "markets").markets.map((entry) => entry.symbol)).toContain(symbol);
    // Asking again changes nothing.
    expect(ensure(world).body).toEqual(created.body);
    expect(get<{ markets: ApiMarket[] }>(world, "markets").markets).toHaveLength(9);
  });

  it("refuses a contract that is not trading yet, and one that has expired", () => {
    const world = new FixtureWorld();
    expect(ensure(world, "GEMI-SOL2611272200-HI190")).toEqual({ status: 409, body: { error: "market not active" } });
    expect(ensure(world, symbol, NOW + 5 * MINUTE)).toEqual({ status: 409, body: { error: "market not active" } });
    expect(market(world, symbol).onchain).toBeNull();
  });

  it("creates the market of an up-or-down contract before its window opens, as the venue lists it as active", () => {
    const world = new FixtureWorld();
    expect(ensure(world, "GEMI-BTC05M2611142215-UP").status).toBe(200);
  });
});

describe("the simulated chain and relayer: an order from placement to redemption", () => {
  const EXPIRY = Date.UTC(2026, 10, 14, 22, 13);
  const ORDER = fixtureAddress("world-test-order");

  /** Creates the market of one strike of the listed ladder and places a buy of 2.00 YES on it. */
  function buy(code: string, limitPx: bigint, units = 200n) {
    const world = new FixtureWorld();
    const symbol = `GEMI-${LADDER}-${code}`;
    const { onchain } = world.respond(route("POST", `markets/${symbol}/ensure`), NOW).body as ApiMarket;
    world.place({ user: WALLET, market: onchain!.market, order: ORDER, side: "YES", units, limitPx, maxFeeMicros: feeCap(units, limitPx) }, NOW);
    const order = (nowMs: number) => world.orders(WALLET, nowMs).find((entry) => entry.address === ORDER);
    return { world, symbol, onchain: onchain!, order };
  }

  it("holds the test dollars, sends the order, fills it and mints the tokens", () => {
    // The ask is 86 cents: 2.00 contracts cost $1.72, and the fee cap is 7 cents.
    const { world, symbol, onchain, order } = buy("HI104000", 8_600n);
    expect(order(NOW + SECOND)).toBeUndefined();
    expect(stable(world, NOW + SECOND)).toBe(1_000_000_000n - 1_790_000n);
    expect(world.chain(WALLET, NOW + SECOND).openOrders.find((entry) => entry.address === ORDER)).toMatchObject({ market: onchain.market, side: 0, kind: 0, qtyUnits: "200", limitPx: "8600", maxFee: "70000" });
    expect(held(world, onchain.yesMint, NOW + SECOND)).toBe("0");

    expect(order(NOW + 2 * SECOND)).toMatchObject({ state: "seen", symbol, venueOrderId: null });
    expect(order(NOW + 3 * SECOND)?.state).toBe("submitting");
    expect(order(NOW + 4 * SECOND)).toMatchObject({ state: "venue_filled", filledUnits: "200", chainSignature: null });
    expect(held(world, onchain.yesMint, NOW + 4 * SECOND)).toBe("0");

    const done = NOW + 6 * SECOND;
    expect(order(done)).toMatchObject({ state: "chain_filled", kind: "buy", side: "YES", filledUnits: "200", amountMicros: "1720000", feeMicros: "20000", fills: [{ units: "200", px: "8600", feeMicros: "20000" }] });
    expect(order(done)?.chainSignature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    expect(held(world, onchain.yesMint, done)).toBe("200");
    expect(stable(world, done)).toBe(1_000_000_000n - 1_720_000n - 20_000n);
    expect(world.chain(WALLET, done).openOrders.some((entry) => entry.address === ORDER)).toBe(false);
    expect(get<ApiOrder>(world, `orders/${ORDER}`, done).state).toBe("chain_filled");
  });

  it("settles the market when the venue reports the result, and pays a winning token one test dollar", () => {
    const { world, symbol, onchain } = buy("HI104000", 8_600n);
    const redeem = (nowMs: number) => world.redeem({ holder: WALLET, market: onchain.market, outcomeMint: onchain.yesMint, amount: 200n }, nowMs);

    expect(() => redeem(NOW + MINUTE)).toThrow("NotSettled");
    expect(market(world, symbol, EXPIRY + 5 * SECOND)).toMatchObject({ settleState: "awaiting_result", resolution: null, onchain: { status: "open" } });
    expect(() => redeem(EXPIRY + 5 * SECOND)).toThrow("NotSettled");
    expect(market(world, symbol, EXPIRY + 12 * SECOND)).toMatchObject({ settleState: "settled", resolution: "yes", onchain: { status: "settled", yesPayout: "10000", noPayout: "0" } });
    expect(() => redeem(EXPIRY + 60 * SECOND)).toThrow("RedeemLocked");

    const open = EXPIRY + 102 * SECOND;
    redeem(open);
    expect(held(world, onchain.yesMint, open)).toBe("0");
    expect(stable(world, open)).toBe(1_000_000_000n - 1_720_000n - 20_000n + 2_000_000n);
    expect(() => redeem(open)).toThrow("InsufficientFunds");
  });

  it("keeps a traded market among the on-chain ones after the fixtures have forgotten its event", () => {
    const { world, symbol, onchain } = buy("HI104000", 8_600n);
    const muchLater = EXPIRY + 3 * 60 * MINUTE;
    expect(get<{ markets: ApiMarket[] }>(world, "markets", muchLater).markets.map((entry) => entry.symbol)).toContain(symbol);
    expect(held(world, onchain.yesMint, muchLater)).toBe("200");
    expect(world.chainMarkets({ mints: [onchain.yesMint] }, muchLater)).toMatchObject([{ symbol, status: "settled", yesPayout: "10000" }]);
    world.redeem({ holder: WALLET, market: onchain.market, outcomeMint: onchain.yesMint, amount: 200n }, muchLater);
    expect(held(world, onchain.yesMint, muchLater)).toBe("0");
  });

  it("burns the tokens of a strike that resolved No for nothing", () => {
    // $104,500 or above, offered at 13 cents; the ladder settles at $104,212.50.
    const { world, onchain } = buy("HI104500", 1_300n);
    const open = EXPIRY + 102 * SECOND;
    expect(held(world, onchain.yesMint, open)).toBe("200");
    const before = stable(world, open);
    world.redeem({ holder: WALLET, market: onchain.market, outcomeMint: onchain.yesMint, amount: 200n }, open);
    expect(held(world, onchain.yesMint, open)).toBe("0");
    expect(stable(world, open)).toBe(before);
  });

  it("refunds an order whose limit is below the offer, and one larger than what is offered", () => {
    for (const { world, onchain, order } of [buy("HI104000", 8_500n), buy("HI104000", 8_600n, 1_801n)]) {
      expect(order(NOW + 4 * SECOND)).toMatchObject({ state: "venue_not_filled", filledUnits: "0" });
      expect(stable(world, NOW + 4 * SECOND)).toBeLessThan(1_000_000_000n);
      expect(order(NOW + 6 * SECOND)).toMatchObject({ state: "chain_cancelled", amountMicros: "0", fills: [], detail: "no offers at or below the limit" });
      expect(stable(world, NOW + 6 * SECOND)).toBe(1_000_000_000n);
      expect(held(world, onchain.yesMint, NOW + 6 * SECOND)).toBe("0");
    }
  });

  it("returns the hold when the user reclaims the order themselves", () => {
    const { world } = buy("HI104000", 8_500n);
    world.cancel(ORDER, NOW + SECOND);
    expect(stable(world, NOW + SECOND)).toBe(1_000_000_000n);
    expect(world.chain(WALLET, NOW + SECOND).openOrders.some((entry) => entry.address === ORDER)).toBe(false);
  });

  it("refuses an order as the program would", () => {
    const world = new FixtureWorld();
    const input = { user: WALLET, order: ORDER, side: "YES" as const, units: 200n, limitPx: 8_600n, maxFeeMicros: 70_000n };
    // No market account: the contract was never created on-chain.
    expect(() => world.place({ ...input, market: fixtureAddress(`market:GEMI-${LADDER}-HI104000`) }, NOW)).toThrow("MarketNotOpen");
    const seeded = market(world, `GEMI-${LADDER}-HI104100`).onchain!.market;
    expect(() => world.place({ ...input, market: seeded }, EXPIRY - 30 * SECOND)).toThrow("TooCloseToClose");
    expect(() => world.place({ ...input, market: seeded }, EXPIRY + MINUTE)).toThrow("MarketNotOpen");
    expect(world.orders(WALLET, EXPIRY + MINUTE).map((order) => order.address)).not.toContain(ORDER);
  });

  it("leaves the one order the relayer never sends open until the user reclaims it", () => {
    const world = new FixtureWorld();
    const [seen] = world.orders(WALLET, NOW);
    expect(world.chain(WALLET, NOW).openOrders).toMatchObject([{ address: seen!.address, user: WALLET, market: market(world, seen!.symbol).onchain!.market, kind: 0, side: 0, qtyUnits: "500" }]);
    world.cancel(seen!.address, NOW);
    expect(world.chain(WALLET, NOW).openOrders).toEqual([]);
    expect(world.orders(WALLET, NOW)[0]).toMatchObject({ address: seen!.address, state: "failed", detail: "order account gone before submission" });
    // It is placed afresh in the next beat.
    expect(world.chain(WALLET, NOW + 5 * MINUTE).openOrders).toHaveLength(1);
  });
});

function setup() {
  const world = new FixtureWorld();
  return {
    world,
    live: market(world, "GEMI-BTC15M2611142216-UP", LATER),
    won: market(world, "GEMI-BTC2611142208-HI104100", LATER),
    lost: market(world, "GEMI-BTC2611142208-HI104400", LATER),
    locked: market(world, "GEMI-BTC15M2611142211-UP", LATER),
  };
}

describe("the simulated chain: redeem", () => {
  it("starts the wallet with a winning, a losing and a not yet redeemable settled position", () => {
    const { world, won, lost, locked, live } = setup();
    expect(won).toMatchObject({ resolution: "yes", onchain: { status: "settled", yesPayout: "10000" } });
    expect(lost).toMatchObject({ resolution: "no", onchain: { status: "settled", yesPayout: "0" } });
    expect(locked).toMatchObject({ resolution: "yes", onchain: { status: "settled" } });
    expect(locked.onchain!.redeemAfter).toBeGreaterThan(LATER / SECOND);
    expect(won.onchain!.redeemAfter).toBeLessThanOrEqual(LATER / SECOND);
    expect(held(world, won.onchain!.yesMint, LATER)).toBe("200");
    expect(held(world, lost.onchain!.yesMint, LATER)).toBe("250");
    expect(held(world, locked.onchain!.yesMint, LATER)).toBe("300");
    expect(held(world, live.onchain!.yesMint, LATER)).toBe("300");
    expect(stable(world, LATER)).toBe(1_000_000_000n);
  });

  it("burns winning tokens and pays one test dollar per contract", () => {
    const { world, won } = setup();
    world.redeem({ holder: WALLET, market: won.onchain!.market, outcomeMint: won.onchain!.yesMint, amount: 200n }, LATER);
    expect(held(world, won.onchain!.yesMint, LATER)).toBe("0");
    expect(stable(world, LATER)).toBe(1_002_000_000n);
    // The balance stays moved later on.
    expect(stable(world, LATER + MINUTE)).toBe(1_002_000_000n);
  });

  it("burns losing tokens for nothing, and still succeeds", () => {
    const { world, lost } = setup();
    world.redeem({ holder: WALLET, market: lost.onchain!.market, outcomeMint: lost.onchain!.yesMint, amount: 250n }, LATER);
    expect(held(world, lost.onchain!.yesMint, LATER)).toBe("0");
    expect(stable(world, LATER)).toBe(1_000_000_000n);
  });

  it("redeems part of a balance", () => {
    const { world, won } = setup();
    world.redeem({ holder: WALLET, market: won.onchain!.market, outcomeMint: won.onchain!.yesMint, amount: 120n }, LATER);
    expect(held(world, won.onchain!.yesMint, LATER)).toBe("80");
    expect(stable(world, LATER)).toBe(1_001_200_000n);
  });

  it("refuses as the program would", () => {
    const { world, won, live, locked } = setup();
    const redeem = (target: ApiMarket, mint: string, amount: bigint) => () => world.redeem({ holder: WALLET, market: target.onchain!.market, outcomeMint: mint, amount }, LATER);
    expect(redeem(live, live.onchain!.yesMint, 100n)).toThrow("NotSettled");
    expect(redeem(locked, locked.onchain!.yesMint, 300n)).toThrow("RedeemLocked");
    expect(redeem(won, won.onchain!.yesMint, 0n)).toThrow("BadQuantity");
    expect(redeem(won, won.onchain!.yesMint, 201n)).toThrow("InsufficientFunds");
    expect(redeem(won, live.onchain!.yesMint, 100n)).toThrow("WrongMint");
    expect(stable(world, LATER)).toBe(1_000_000_000n);
    expect(held(world, won.onchain!.yesMint, LATER)).toBe("200");
  });

  it("opens the locked market's redemption once the cluster clock passes redeemAfter", () => {
    const { world, locked } = setup();
    const open = locked.onchain!.redeemAfter! * SECOND;
    world.redeem({ holder: WALLET, market: locked.onchain!.market, outcomeMint: locked.onchain!.yesMint, amount: 300n }, open);
    expect(stable(world, open)).toBe(1_003_000_000n);
  });
});

describe("the simulated chain and relayer: place_sell", () => {
  const ORDER = fixtureAddress("world-test-sell");
  const sellInput = (live: ApiMarket, patch: Partial<Parameters<FixtureWorld["placeSell"]>[0]> = {}) => ({
    user: WALLET,
    market: live.onchain!.market,
    order: ORDER,
    outcomeMint: live.onchain!.yesMint,
    side: "YES" as const,
    units: 300n,
    limitPx: 5_500n,
    maxFeeMicros: 90_000n,
    ...patch,
  });
  const order = (world: FixtureWorld, nowMs: number) => world.orders(WALLET, nowMs).find((entry) => entry.address === ORDER);

  it("holds the tokens in an open sell order", () => {
    const { world, live } = setup();
    expect(held(world, live.onchain!.yesMint, LATER)).toBe("300");
    world.placeSell(sellInput(live), LATER);
    expect(held(world, live.onchain!.yesMint, LATER)).toBe("0");
    expect(stable(world, LATER)).toBe(1_000_000_000n);
    expect(world.chain(WALLET, LATER).openOrders.find((entry) => entry.address === ORDER)).toMatchObject({ kind: 1, side: 0, qtyUnits: "300", limitPx: "5500", maxFee: "90000" });
  });

  it("fills a sale at or below the bid: tokens burned, proceeds less the fee paid", () => {
    const { world, live } = setup();
    world.placeSell(sellInput(live), LATER);
    const later = LATER + 6_000;
    // Sold at the $0.55 bid: $1.65, less a fee of 6 cents.
    expect(order(world, later)).toMatchObject({ kind: "sell", state: "chain_filled", filledUnits: "300", amountMicros: "1650000", feeMicros: "60000", fills: [{ units: "300", px: "4500" }] });
    expect(held(world, live.onchain!.yesMint, later)).toBe("0");
    expect(stable(world, later)).toBe(1_001_590_000n);
    expect(world.chain(WALLET, later).openOrders.some((entry) => entry.address === ORDER)).toBe(false);
  });

  it("does not fill a sale above the bid, and returns the tokens", () => {
    const { world, live } = setup();
    world.placeSell(sellInput(live, { limitPx: 5_600n }), LATER);
    expect(order(world, LATER + 4_000)).toMatchObject({ state: "venue_not_filled", filledUnits: "0" });
    expect(held(world, live.onchain!.yesMint, LATER + 4_000)).toBe("0");
    const later = LATER + 6_000;
    expect(order(world, later)).toMatchObject({ kind: "sell", state: "chain_cancelled", amountMicros: "0", fills: [], detail: "no bids at or above the minimum" });
    expect(held(world, live.onchain!.yesMint, later)).toBe("300");
    expect(stable(world, later)).toBe(1_000_000_000n);
  });

  it("is refused by the relayer when the minimum proceeds do not exceed the fee cap", () => {
    const { world, live } = setup();
    world.placeSell(sellInput(live, { limitPx: 300n, maxFeeMicros: 90_000n }), LATER);
    expect(order(world, LATER + 6_000)).toMatchObject({ state: "chain_cancelled", venueOrderId: null, detail: "fee_cap" });
    expect(held(world, live.onchain!.yesMint, LATER + 6_000)).toBe("300");
  });

  it("returns the tokens when the user reclaims the order", () => {
    const { world, live } = setup();
    world.placeSell(sellInput(live, { limitPx: 5_600n }), LATER);
    world.cancel(ORDER, LATER + 1_000);
    expect(held(world, live.onchain!.yesMint, LATER + 1_000)).toBe("300");
    expect(world.chain(WALLET, LATER + 1_000).openOrders.some((entry) => entry.address === ORDER)).toBe(false);
  });

  it("refuses as the program would", () => {
    const { world, live, won } = setup();
    expect(() => world.placeSell(sellInput(live, { units: 301n }), LATER)).toThrow("InsufficientFunds");
    expect(() => world.placeSell(sellInput(live, { maxFeeMicros: 1_650_001n }), LATER)).toThrow("FeeCapTooHigh");
    expect(() => world.placeSell(sellInput(live, { outcomeMint: won.onchain!.yesMint }), LATER)).toThrow("WrongMint");
    expect(() => world.placeSell(sellInput(won, { outcomeMint: won.onchain!.yesMint }), LATER)).toThrow("MarketNotOpen");
    expect(held(world, live.onchain!.yesMint, LATER)).toBe("300");
  });
});

describe("the simulated chain: markets", () => {
  it("finds a market by one of its mints, with the name its token carries", () => {
    const { world, live } = setup();
    const found = world.chainMarkets({ mints: [live.onchain!.noMint] }, LATER);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      address: live.onchain!.market,
      symbol: live.symbol,
      yesMint: live.onchain!.yesMint,
      noMint: live.onchain!.noMint,
      status: "open",
      closeTs: live.onchain!.closeTs,
      yesPayout: "0",
      noPayout: "0",
      redeemAfter: 0,
      tokenName: "BTC Up 15m 14Nov26 22:16 YES",
    });
  });

  it("carries a settlement's payouts and the time redemption opens", () => {
    const { world, won } = setup();
    expect(world.chainMarkets({ markets: [won.onchain!.market] }, LATER)[0]).toMatchObject({ status: "settled", yesPayout: "10000", noPayout: "0", redeemAfter: won.onchain!.redeemAfter, tokenName: "BTC >=104100 14Nov26 22:08 YES" });
  });

  it("answers once per market however it was asked for, and not at all for what it does not hold", () => {
    const { world, live, lost } = setup();
    const found = world.chainMarkets(
      { mints: [live.onchain!.yesMint, live.onchain!.noMint, fixtureAddress("someone-else's-mint")], markets: [live.onchain!.market], symbols: [live.symbol, lost.symbol, "GEMI-NOSUCH-UP", "GEMI-BTC2611142213-HI103900"] },
      LATER,
    );
    expect(found.map((entry) => entry.symbol).sort()).toEqual([live.symbol, lost.symbol].sort());
  });

  it("still finds by its symbol a market the relayer no longer lists, so its tokens and orders can be named", () => {
    const world = new FixtureWorld();
    const old = "GEMI-BTC15M2611142156-UP";
    expect(get<{ markets: ApiMarket[] }>(world, "markets", LATER).markets.map((entry) => entry.symbol)).not.toContain(old);
    expect(world.chainMarkets({ symbols: [old] }, LATER)).toMatchObject([{ symbol: old, status: "settled", tokenName: "BTC Up 15m 14Nov26 21:56 YES" }]);
  });
});

describe("the simulated chain: a wallet that has not asked for test funds", () => {
  it("is a registered trader with the fixture tokens unless new wallets start unregistered", () => {
    const world = new FixtureWorld();
    expect(world.chain(WALLET, NOW).trader).toEqual({ address: fixtureAddress(`trader:${WALLET}`), nextNonce: "16" });
    expect(world.chain(WALLET, NOW, true)).toEqual({ trader: null, balances: { lamports: "0", stableMicros: "0" }, positions: [], openOrders: [] });
  });

  it("is registered and funded by the simulated registrar, once", async () => {
    const world = new FixtureWorld();
    const funding = world.funding(true);
    expect(await funding.traderExists(WALLET)).toBe(false);
    expect(await funding.registerAndFund(WALLET)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    expect(await funding.traderExists(WALLET)).toBe(true);
    expect(world.chain(WALLET, NOW, true)).toMatchObject({ trader: { nextNonce: "16" }, balances: { stableMicros: "1000000000", lamports: "50000000" } });
    // Every wallet is a trader already where new wallets do not start unregistered.
    expect(await world.funding(false).traderExists(fixtureAddress("another-wallet"))).toBe(true);
  });
});
