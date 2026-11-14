import { describe, expect, it } from "vitest";
import { networkMark, networkNotice, venueLine } from "./network";

describe("networkMark", () => {
  it("names Solana devnet and says the funds are test funds", () => {
    expect(networkMark("devnet")).toEqual({ full: "Solana devnet · test funds", short: "Devnet · test funds" });
  });

  it("names a local validator when the app runs against one", () => {
    expect(networkMark("localnet")).toEqual({ full: "Local validator · test funds", short: "Localnet · test funds" });
  });
});

describe("venueLine", () => {
  it("names the exchange sandbox when the relayer trades there", () => {
    expect(venueLine("sandbox")).toBe("Orders are placed on the exchange sandbox.");
  });

  it("says the venue is simulated when the relayer runs against the mock", () => {
    expect(venueLine("mock")).toBe("Orders are placed on a simulated venue.");
  });
});

describe("networkNotice", () => {
  it("names the exchange sandbox when the relayer trades there", () => {
    expect(networkNotice("sandbox")).toEqual(["Devnet and sandbox demo.", "Test tokens with no value."]);
  });

  it("says the venue is simulated when the relayer runs against the mock", () => {
    expect(networkNotice("mock")).toEqual(["Devnet demo with a simulated venue.", "Test tokens with no value."]);
  });
});
