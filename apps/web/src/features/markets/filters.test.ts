import { describe, expect, it } from "vitest";
import { indexQueryString, readIndexQuery } from "./filters";

const read = (search: string) => readIndexQuery(new URLSearchParams(search));

describe("the markets index query", () => {
  it("defaults to every market, ending soon first", () => {
    expect(read("")).toEqual({ category: null, cadence: null, search: "", sort: "ending" });
  });

  it("reads each filter", () => {
    expect(read("?category=Crypto&cadence=15m&q=btc&sort=volume")).toEqual({ category: "Crypto", cadence: "15m", search: "btc", sort: "volume" });
  });

  it("ignores what it does not recognise", () => {
    expect(read("?cadence=yearly&sort=random&category=")).toEqual({ category: null, cadence: null, search: "", sort: "ending" });
  });

  it("writes only what differs from the default, and nothing for the default", () => {
    expect(indexQueryString({ category: null, cadence: null, search: "", sort: "ending" })).toBe("");
    expect(indexQueryString({ category: "Commodities", cadence: "daily", search: " gold ", sort: "newest" })).toBe("?category=Commodities&cadence=daily&q=gold&sort=newest");
  });

  it("reads back what it wrote", () => {
    const query = { category: "Crypto", cadence: "5m", search: "$68,000 or above", sort: "volume" } as const;
    expect(read(indexQueryString(query))).toEqual(query);
  });
});
