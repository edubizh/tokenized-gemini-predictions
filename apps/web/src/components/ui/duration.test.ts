import { describe, expect, it } from "vitest";
import { durationSpoken, durationText, msUntilTextChanges } from "./duration";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("durationText", () => {
  it("writes minutes and seconds under an hour", () => {
    expect(durationText(9 * MINUTE + 41 * SECOND)).toBe("9:41");
    expect(durationText(MINUTE)).toBe("1:00");
    expect(durationText(5 * SECOND)).toBe("0:05");
    expect(durationText(HOUR - SECOND)).toBe("59:59");
  });

  it("writes hours and minutes from an hour up, without the seconds", () => {
    expect(durationText(HOUR)).toBe("1h 0m");
    expect(durationText(19 * HOUR + 6 * MINUTE + 26 * SECOND)).toBe("19h 6m");
    expect(durationText(DAY - SECOND)).toBe("23h 59m");
  });

  it("writes days and hours from a day up", () => {
    expect(durationText(DAY)).toBe("1d 0h");
    expect(durationText(3 * DAY + 4 * HOUR + 20 * MINUTE)).toBe("3d 4h");
    expect(durationText(30 * DAY + 23 * HOUR + 59 * MINUTE)).toBe("30d 23h");
  });

  it("counts a partial second as a whole one, so zero appears exactly at the deadline", () => {
    expect(durationText(1)).toBe("0:01");
    expect(durationText(59 * SECOND + 1)).toBe("1:00");
    expect(durationText(HOUR - SECOND + 1)).toBe("1h 0m");
  });

  it("stops at zero", () => {
    expect(durationText(0)).toBe("0:00");
    expect(durationText(-4 * SECOND)).toBe("0:00");
  });
});

describe("msUntilTextChanges", () => {
  /** The text now, and the text one millisecond before and at the moment the wait is over. */
  const around = (remainingMs: number) => {
    const wait = msUntilTextChanges(remainingMs);
    return { wait, now: durationText(remainingMs), justBefore: durationText(remainingMs - wait + 1), after: durationText(remainingMs - wait) };
  };

  it("is the rest of the second under an hour", () => {
    expect(msUntilTextChanges(12 * MINUTE + 41 * SECOND)).toBe(SECOND);
    expect(msUntilTextChanges(12 * MINUTE + 40 * SECOND + 250)).toBe(250);
    expect(around(12 * MINUTE + 40 * SECOND + 250)).toMatchObject({ now: "12:41", justBefore: "12:41", after: "12:40" });
  });

  it("is the rest of the minute from an hour up", () => {
    expect(around(19 * HOUR + 6 * MINUTE + 26 * SECOND)).toEqual({ wait: 27 * SECOND, now: "19h 6m", justBefore: "19h 6m", after: "19h 5m" });
  });

  it("is the rest of the hour from a day up", () => {
    expect(around(3 * DAY + 4 * HOUR + 20 * MINUTE)).toEqual({ wait: 20 * MINUTE + SECOND, now: "3d 4h", justBefore: "3d 4h", after: "3d 3h" });
  });

  it("crosses from one form to the next at the right moment", () => {
    expect(around(DAY)).toMatchObject({ wait: SECOND, now: "1d 0h", after: "23h 59m" });
    expect(around(HOUR)).toMatchObject({ wait: SECOND, now: "1h 0m", after: "59:59" });
  });

  it("never asks for a wait of nothing", () => {
    expect(msUntilTextChanges(1)).toBe(1);
    expect(msUntilTextChanges(0.2)).toBeGreaterThanOrEqual(1);
  });
});

describe("durationSpoken", () => {
  it("rounds up to whole minutes under an hour", () => {
    expect(durationSpoken(12 * MINUTE + 41 * SECOND)).toBe("about 13 minutes");
    expect(durationSpoken(MINUTE)).toBe("about 1 minute");
    expect(durationSpoken(20 * SECOND)).toBe("about 1 minute");
  });

  it("gives minutes and seconds when asked to be exact", () => {
    expect(durationSpoken(MINUTE + 8 * SECOND, true)).toBe("1 minute 8 seconds");
    expect(durationSpoken(2 * MINUTE, true)).toBe("2 minutes");
    expect(durationSpoken(41 * SECOND, true)).toBe("41 seconds");
    expect(durationSpoken(SECOND, true)).toBe("1 second");
  });

  it("gives hours and minutes from an hour up, and days and hours from a day up", () => {
    expect(durationSpoken(19 * HOUR + 6 * MINUTE + 26 * SECOND)).toBe("19 hours 6 minutes");
    expect(durationSpoken(HOUR)).toBe("1 hour");
    expect(durationSpoken(3 * DAY + 4 * HOUR + 20 * MINUTE)).toBe("3 days 4 hours");
    expect(durationSpoken(DAY + HOUR, true)).toBe("1 day 1 hour");
    expect(durationSpoken(2 * DAY)).toBe("2 days");
  });
});
