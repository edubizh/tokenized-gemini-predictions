import { describe, expect, it } from "vitest";
import { fixPrice, movedReference, ticketDefaults } from "./defaults";

const limits = { minUnits: 100n, maxUnits: 50_000n, incrementUnits: 100n, tickPx: 100n };

describe("ticketDefaults", () => {
  it("buys one contract and sells everything held, rounded down to the increment", () => {
    expect(ticketDefaults({ selling: false, heldUnits: 2_550n, limits }).quantity).toBe("1.00");
    expect(ticketDefaults({ selling: true, heldUnits: 2_550n, limits }).quantity).toBe("25.00");
    expect(ticketDefaults({ selling: true, heldUnits: 90_000n, limits }).quantity).toBe("500.00");
    expect(ticketDefaults({ selling: true, heldUnits: 0n, limits }).quantity).toBe("1.00");
  });

  it("steps from the contract's own minimum when selling as when buying", () => {
    expect(ticketDefaults({ selling: false, heldUnits: null, limits })).toMatchObject({ leastUnits: 100n, mostUnits: 50_000n });
    expect(ticketDefaults({ selling: true, heldUnits: 2_550n, limits })).toMatchObject({ leastUnits: 100n, mostUnits: 2_550n });
  });
});

describe("the limit price", () => {
  it("follows the reference until the panel is touched, then stays fixed as if typed", () => {
    expect(fixPrice(null, 5_600n)).toBe("56");
    expect(fixPrice("61", 5_600n)).toBe("61");
    expect(fixPrice(null, null)).toBeNull();
  });

  it("names the reference only when it moved away from a price fixed from it", () => {
    expect(movedReference({ typed: "56", fixed: "56" }, 7_000n)).toBe(7_000n);
    expect(movedReference({ typed: "56", fixed: "56" }, 5_600n)).toBeNull();
    expect(movedReference({ typed: "58", fixed: "56" }, 7_000n)).toBeNull();
    expect(movedReference({ typed: null, fixed: null }, 7_000n)).toBeNull();
    expect(movedReference({ typed: "56", fixed: "56" }, null)).toBeNull();
  });
});
