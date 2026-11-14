import { address, getAddressEncoder } from "@solana/kit";
import type { Config, Market, Order } from "@outcome/program-client";
import { describe, expect, it } from "vitest";
import { toChainConfig, toChainMarket, toChainOrder } from "../src/chain/mapping.ts";

const DEFAULT_ADDRESS = address("11111111111111111111111111111111");
const A = address("So11111111111111111111111111111111111111112");
const B = address("SysvarC1ock11111111111111111111111111111111");
const C = address("SysvarRent111111111111111111111111111111111");
const D = address("Sysvar1nstructions1111111111111111111111111");
const E = address("ComputeBudget111111111111111111111111111111");
const F = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

function order(overrides: Partial<Order> = {}): Order {
  return {
    discriminator: new Uint8Array(8),
    user: B,
    market: C,
    side: 0,
    kind: 0,
    qtyUnits: 200n,
    limitPx: 4_500,
    maxFee: 70_000n,
    expiresAt: 1_800_000_090n,
    rentPayer: B,
    nonce: 7n,
    bump: 254,
    reserved: new Uint8Array(16),
    ...overrides,
  };
}

function market(overrides: Partial<Market> = {}): Market {
  return {
    discriminator: new Uint8Array(8),
    symbolHash: new Uint8Array(32),
    symbol: "TEST-BTC15M-UP",
    yesMint: D,
    noMint: E,
    status: 0,
    closeTs: 1_800_000_600n,
    placeCutoffSecs: 150,
    tickPx: 100,
    maxSupplyUnits: 1_000_000n,
    yesPayout: 0n,
    noPayout: 0n,
    redeemAfter: 0n,
    bump: 255,
    reserved: new Uint8Array(64),
    ...overrides,
  };
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    discriminator: new Uint8Array(8),
    admin: A,
    relayer: B,
    settler: C,
    registrar: D,
    stableMint: E,
    treasury: F,
    orderTtlSecs: 90,
    minOrderUnits: 1n,
    maxOrderUnits: 10_000n,
    settleDelaySecs: 30,
    pauseFlags: 0,
    bump: 255,
    reserved: new Uint8Array(64),
    ...overrides,
  };
}

describe("toChainOrder", () => {
  it("maps a buy of YES", () => {
    expect(toChainOrder(A, order(), "TEST-BTC15M-UP")).toEqual({
      address: A,
      addressBytes: new Uint8Array(getAddressEncoder().encode(A)),
      user: B,
      symbol: "TEST-BTC15M-UP",
      side: "YES",
      kind: "buy",
      units: 200n,
      limitPx: 4_500n,
      maxFeeMicros: 70_000n,
      expiresAt: 1_800_000_090,
    });
    expect(toChainOrder(A, order(), "X").addressBytes).toHaveLength(32);
  });

  it("maps side 1 to NO and kind 1 to sell", () => {
    const mapped = toChainOrder(A, order({ side: 1, kind: 1 }), "X");
    expect(mapped.side).toBe("NO");
    expect(mapped.kind).toBe("sell");
  });

  it("rejects a side or a kind outside the enum", () => {
    expect(() => toChainOrder(A, order({ side: 2 }), "X")).toThrow("unknown order side: 2");
    expect(() => toChainOrder(A, order({ kind: 2 }), "X")).toThrow("unknown order kind: 2");
  });
});

describe("toChainMarket", () => {
  it("maps an open market with both mints", () => {
    expect(toChainMarket(A, market(), { yes: 200n, no: 50n })).toEqual({
      address: A,
      symbol: "TEST-BTC15M-UP",
      yesMint: D,
      noMint: E,
      status: "open",
      closeTs: 1_800_000_600,
      placeCutoffSecs: 150,
      tickPx: 100n,
      maxSupplyUnits: 1_000_000n,
      yesSupply: 200n,
      noSupply: 50n,
      yesPayout: null,
      noPayout: null,
      redeemAfter: null,
    });
  });

  it("reports a mint that is still the default address as null", () => {
    const mapped = toChainMarket(A, market({ yesMint: DEFAULT_ADDRESS, noMint: DEFAULT_ADDRESS }), { yes: 0n, no: 0n });
    expect(mapped.yesMint).toBeNull();
    expect(mapped.noMint).toBeNull();
  });

  it("maps halted, and settled with its payouts and redemption time", () => {
    expect(toChainMarket(A, market({ status: 1 }), { yes: 0n, no: 0n }).status).toBe("halted");
    const settled = toChainMarket(A, market({ status: 2, yesPayout: 10_000n, noPayout: 0n, redeemAfter: 1_800_000_700n }), { yes: 1n, no: 2n });
    expect(settled.status).toBe("settled");
    expect(settled.yesPayout).toBe(10_000n);
    expect(settled.noPayout).toBe(0n);
    expect(settled.redeemAfter).toBe(1_800_000_700);
  });

  it("rejects a status outside the enum", () => {
    expect(() => toChainMarket(A, market({ status: 3 }), { yes: 0n, no: 0n })).toThrow("unknown market status: 3");
  });
});

describe("toChainConfig", () => {
  it("maps the fields and decodes the pause bits", () => {
    expect(toChainConfig(config())).toEqual({
      admin: A,
      relayer: B,
      settler: C,
      registrar: D,
      stableMint: E,
      treasury: F,
      orderTtlSecs: 90,
      minOrderUnits: 1n,
      maxOrderUnits: 10_000n,
      settleDelaySecs: 30,
      pausePlace: false,
      pauseFill: false,
    });
    expect(toChainConfig(config({ pauseFlags: 1 }))).toMatchObject({ pausePlace: true, pauseFill: false });
    expect(toChainConfig(config({ pauseFlags: 2 }))).toMatchObject({ pausePlace: false, pauseFill: true });
    expect(toChainConfig(config({ pauseFlags: 3 }))).toMatchObject({ pausePlace: true, pauseFill: true });
  });
});
