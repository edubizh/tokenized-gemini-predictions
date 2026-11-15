import { describe, expect, it } from "vitest";
import { chartLine, chartSummary, priceSeries } from "./chart";

const point = (at: number, px: number) => ({ at, px: String(px) });

describe("chartLine", () => {
  it("maps time across the width and 0 to 100 cents up the height", () => {
    const line = chartLine([point(0, 10_000), point(50, 5_000), point(100, 0)], 200, 100);
    expect(line).toEqual({ d: "M0 0L100 50L200 100", last: { x: 200, y: 100 } });
  });

  it("draws a single price as a level line across the width", () => {
    expect(chartLine([point(7, 2_500)], 200, 100)).toEqual({ d: "M0 75L200 75", last: { x: 200, y: 75 } });
  });

  it("keeps one decimal", () => {
    expect(chartLine([point(0, 3_333), point(3, 3_333)], 10, 10)?.d).toBe("M0 6.7L10 6.7");
  });

  it("draws nothing without points", () => {
    expect(chartLine([], 200, 100)).toBeNull();
  });
});

describe("chartSummary", () => {
  it("gives the last, the lowest and the highest price", () => {
    expect(chartSummary([point(0, 5_000), point(1, 4_200), point(2, 6_100), point(3, 5_500)])).toEqual({ last: 5_500n, low: 4_200n, high: 6_100n });
  });

  it("is null without points", () => {
    expect(chartSummary([])).toBeNull();
  });
});

describe("priceSeries", () => {
  const trade = (at: number, px: number) => ({ at, px: String(px) });
  const history = [point(60_000, 300), point(120_000, 300)];

  it("ends with the newest trade when it is later than the last history point, and takes its price as the last", () => {
    // Trades come newest first.
    expect(priceSeries(history, [trade(150_000, 900), trade(130_000, 700)], "300")).toEqual({ points: [...history, point(150_000, 900)], lastPx: "900" });
  });

  it("keeps the history alone when no trade is later than it", () => {
    expect(priceSeries(history, [trade(120_000, 900), trade(90_000, 700)], "600")).toEqual({ points: history, lastPx: "300" });
  });

  it("draws a lone trade when there is no history yet", () => {
    expect(priceSeries([], [trade(5_000, 400)], null)).toEqual({ points: [point(5_000, 400)], lastPx: "400" });
  });

  it("falls back to the listed last price without history or trades", () => {
    expect(priceSeries([], [], "600")).toEqual({ points: [], lastPx: "600" });
    expect(priceSeries([], [], null)).toEqual({ points: [], lastPx: null });
  });
});
