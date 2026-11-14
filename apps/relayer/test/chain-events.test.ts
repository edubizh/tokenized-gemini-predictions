import { address, getBase64Decoder, type Address } from "@solana/kit";
import {
  getOrderCancelledEventEncoder,
  getOrderFilledEventEncoder,
  getOrderPlacedEventEncoder,
} from "@outcome/program-client";
import { describe, expect, it } from "vitest";
import { orderClosure, programEvents } from "../src/chain/events.ts";

const PROGRAM = address("8TN1HWcEFTAcM7Vthmih1FKftTBrp3LDgTBkfhp1PRVn");
const OTHER_PROGRAM = address("ComputeBudget111111111111111111111111111111");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ORDER = address("So11111111111111111111111111111111111111112");
const OTHER_ORDER = address("SysvarC1ock11111111111111111111111111111111");
const USER = address("SysvarRent111111111111111111111111111111111");
const MARKET = address("Sysvar1nstructions1111111111111111111111111");

const base64 = (bytes: Parameters<ReturnType<typeof getBase64Decoder>["decode"]>[0]): string => getBase64Decoder().decode(bytes);

function filledLine(order: Address = ORDER): string {
  const bytes = getOrderFilledEventEncoder().encode({
    order,
    user: USER,
    market: MARKET,
    side: 0,
    kind: 0,
    fillQty: 200n,
    amount: 900_000n,
    fee: 40_000n,
  });
  return `Program data: ${base64(bytes)}`;
}

function cancelledLine(order: Address = ORDER): string {
  const bytes = getOrderCancelledEventEncoder().encode({ order, user: USER, market: MARKET, by: USER });
  return `Program data: ${base64(bytes)}`;
}

function placedLine(): string {
  const bytes = getOrderPlacedEventEncoder().encode({
    order: ORDER,
    user: USER,
    market: MARKET,
    side: 1,
    kind: 0,
    qtyUnits: 200n,
    limitPx: 4_500,
    maxFee: 70_000n,
    expiresAt: 1_800_000_000n,
    nonce: 3n,
  });
  return `Program data: ${base64(bytes)}`;
}

function wrap(program: string, ...inner: string[]): string[] {
  return [`Program ${program} invoke [1]`, ...inner, `Program ${program} consumed 1000 of 300000 compute units`, `Program ${program} success`];
}

describe("programEvents", () => {
  it("returns the events the program logged, in order", () => {
    const logs = [
      ...wrap(OTHER_PROGRAM),
      ...wrap(PROGRAM, "Program log: Instruction: PlaceBuy", placedLine()),
      ...wrap(PROGRAM, "Program log: Instruction: FillBuy", filledLine()),
    ];
    const events = programEvents(logs, PROGRAM);
    expect(events.map((event) => event.name)).toEqual(["OrderPlaced", "OrderFilled"]);
  });

  it("accepts an event logged after a nested call returned", () => {
    const logs = [
      `Program ${PROGRAM} invoke [1]`,
      `Program ${TOKEN_PROGRAM} invoke [2]`,
      "Program log: Instruction: TransferChecked",
      `Program ${TOKEN_PROGRAM} consumed 6000 of 200000 compute units`,
      `Program ${TOKEN_PROGRAM} success`,
      cancelledLine(),
      `Program ${PROGRAM} success`,
    ];
    expect(programEvents(logs, PROGRAM).map((event) => event.name)).toEqual(["OrderCancelled"]);
  });

  it("ignores data logged by any other program, at the top level or nested", () => {
    const topLevel = wrap(OTHER_PROGRAM, filledLine());
    const nested = [
      `Program ${PROGRAM} invoke [1]`,
      `Program ${OTHER_PROGRAM} invoke [2]`,
      filledLine(),
      `Program ${OTHER_PROGRAM} success`,
      `Program ${PROGRAM} success`,
    ];
    const afterFailure = [`Program ${PROGRAM} invoke [1]`, `Program ${PROGRAM} failed: custom program error: 0x1785`, filledLine()];
    expect(programEvents(topLevel, PROGRAM)).toEqual([]);
    expect(programEvents(nested, PROGRAM)).toEqual([]);
    expect(programEvents(afterFailure, PROGRAM)).toEqual([]);
  });

  it("is not misled by program log text that imitates the runtime's call lines", () => {
    // `msg!` output always carries the "Program log: " prefix; it must not move the call stack.
    const popped = [`Program ${PROGRAM} invoke [1]`, "Program log: success", "Program log: failed: nothing", filledLine(), `Program ${PROGRAM} success`];
    expect(programEvents(popped, PROGRAM).map((event) => event.name)).toEqual(["OrderFilled"]);
    const pushed = [`Program ${OTHER_PROGRAM} invoke [1]`, `Program log: ${PROGRAM} invoke [2]`, filledLine(), `Program ${OTHER_PROGRAM} success`];
    expect(programEvents(pushed, PROGRAM)).toEqual([]);
  });

  it("skips data that is not one of the program's events", () => {
    const logs = wrap(PROGRAM, "Program data: !!!not base64!!!", "Program data: AAECAwQFBgcICQ==", "Program data: ", filledLine());
    expect(programEvents(logs, PROGRAM).map((event) => event.name)).toEqual(["OrderFilled"]);
  });
});

describe("orderClosure", () => {
  it("finds the fill of the order with its decoded values", () => {
    const closure = orderClosure(wrap(PROGRAM, filledLine()), PROGRAM, ORDER);
    expect(closure).toEqual({
      kind: "filled",
      event: { order: ORDER, user: USER, market: MARKET, side: 0, kind: 0, fillQty: 200n, amount: 900_000n, fee: 40_000n },
    });
  });

  it("finds the cancel of the order", () => {
    const closure = orderClosure(wrap(PROGRAM, cancelledLine()), PROGRAM, ORDER);
    expect(closure).toEqual({ kind: "cancelled", event: { order: ORDER, user: USER, market: MARKET, by: USER } });
  });

  it("returns null for events of another order, a placement, or another program", () => {
    expect(orderClosure(wrap(PROGRAM, filledLine(OTHER_ORDER), cancelledLine(OTHER_ORDER)), PROGRAM, ORDER)).toBeNull();
    expect(orderClosure(wrap(PROGRAM, placedLine()), PROGRAM, ORDER)).toBeNull();
    expect(orderClosure(wrap(OTHER_PROGRAM, filledLine()), PROGRAM, ORDER)).toBeNull();
    expect(orderClosure([], PROGRAM, ORDER)).toBeNull();
  });
});
