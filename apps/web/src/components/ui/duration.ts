// How a length of time is written and spoken. Under an hour it is minutes and seconds (`12:41`);
// from an hour up, hours and minutes (`19h 6m`); from a day up, days and hours (`3d 4h`). The
// longer the wait, the less often the figure changes. Pure functions; Countdown drives them.

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Whole seconds left. A partial second counts as a whole one, so zero appears exactly at the deadline. */
function secondsLeft(remainingMs: number): number {
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

/** The figure: `0:09`, `12:41`, `19h 6m`, `3d 4h`. */
export function durationText(remainingMs: number): string {
  const total = secondsLeft(remainingMs);
  if (total >= DAY) return `${Math.floor(total / DAY)}d ${Math.floor((total % DAY) / HOUR)}h`;
  if (total >= HOUR) return `${Math.floor(total / HOUR)}h ${Math.floor((total % HOUR) / MINUTE)}m`;
  return `${Math.floor(total / MINUTE)}:${String(total % MINUTE).padStart(2, "0")}`;
}

/** Milliseconds until `durationText` next reads differently: how long a ticking figure can sleep. */
export function msUntilTextChanges(remainingMs: number): number {
  const total = secondsLeft(remainingMs);
  const step = total >= DAY ? HOUR : total >= HOUR ? MINUTE : 1;
  // The figure holds down to the last multiple of its step; one second below that it changes.
  const changesAt = Math.floor(total / step) * step - 1;
  return Math.max(1, remainingMs - changesAt * 1000);
}

function count(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Two units in words; the smaller one is left out when it is zero. */
function words(large: number, largeUnit: string, small: number, smallUnit: string): string {
  return small === 0 ? count(large, largeUnit) : `${count(large, largeUnit)} ${count(small, smallUnit)}`;
}

/**
 * The same length of time in words, for screen readers: "3 days 4 hours", "19 hours 6 minutes".
 * Under an hour it is rounded up to whole minutes ("about 13 minutes") unless `exact`, which gives
 * minutes and seconds for the last moments.
 */
export function durationSpoken(remainingMs: number, exact = false): string {
  const total = secondsLeft(remainingMs);
  if (total >= DAY) return words(Math.floor(total / DAY), "day", Math.floor((total % DAY) / HOUR), "hour");
  if (total >= HOUR) return words(Math.floor(total / HOUR), "hour", Math.floor((total % HOUR) / MINUTE), "minute");
  if (!exact) return `about ${count(Math.ceil(total / MINUTE), "minute")}`;
  return total >= MINUTE ? words(Math.floor(total / MINUTE), "minute", total % MINUTE, "second") : count(total, "second");
}
