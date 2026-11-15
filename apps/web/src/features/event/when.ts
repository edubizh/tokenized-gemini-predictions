// Moments as the event page writes them. Pure.

/** A moment as a date and a time in the viewer's zone, with the zone named: `Nov 15, 7:50 PM EST`. Plain spaces only. */
export function formatWhen(atMs: number, options: { timeZone?: string } = {}): string {
  const text = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: options.timeZone }).format(new Date(atMs));
  return text.replace(/\s/g, " ");
}
