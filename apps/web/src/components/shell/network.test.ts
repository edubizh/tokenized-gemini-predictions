import { describe, expect, it } from "vitest";
import { networkNotice } from "./network";

describe("networkNotice", () => {
  it("names the exchange sandbox when the relayer trades there", () => {
    expect(networkNotice("sandbox")).toEqual(["Devnet and sandbox demo.", "Test tokens with no value."]);
  });

  it("says the venue is simulated when the relayer runs against the mock", () => {
    expect(networkNotice("mock")).toEqual(["Devnet demo with a simulated venue.", "Test tokens with no value."]);
  });
});
