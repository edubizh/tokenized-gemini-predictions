import { describe, expect, it } from "vitest";
import { chartLine, chartSummary } from "./chart";

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
