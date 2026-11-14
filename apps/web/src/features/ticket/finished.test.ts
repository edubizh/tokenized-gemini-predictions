import { describe, expect, it } from "vitest";
import { finishedOrders } from "./finished";

describe("finishedOrders", () => {
  it("is empty while nothing has been seen, and while the same orders are in progress", () => {
    expect(finishedOrders(null, { open: ["a"], working: [] })).toEqual([]);
    expect(finishedOrders({ open: ["a"], working: ["b"] }, { open: ["a"], working: ["b"] })).toEqual([]);
  });

  it("is empty when an order appears", () => {
    expect(finishedOrders({ open: [], working: [] }, { open: ["a"], working: ["a"] })).toEqual([]);
  });

  it("names an open order whose account is gone", () => {
    expect(finishedOrders({ open: ["a", "b"], working: [] }, { open: ["b"], working: [] })).toEqual(["a"]);
  });

  it("names an order the relayer has finished with, once even when its account went at the same time", () => {
    expect(finishedOrders({ open: ["a"], working: ["a"] }, { open: ["a"], working: [] })).toEqual(["a"]);
    expect(finishedOrders({ open: ["a", "b"], working: ["a"] }, { open: ["b"], working: [] })).toEqual(["a"]);
  });
});
