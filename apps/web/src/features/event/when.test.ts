import { describe, expect, it } from "vitest";
import { formatWhen } from "./when";

describe("formatWhen", () => {
  it("writes a date and time with its zone, in plain spaces", () => {
    expect(formatWhen(Date.UTC(2026, 10, 15, 0, 50), { timeZone: "UTC" })).toBe("Nov 15, 12:50 AM UTC");
    expect(formatWhen(Date.UTC(2026, 10, 15, 0, 50), { timeZone: "America/New_York" })).toBe("Nov 14, 7:50 PM EST");
  });
});
