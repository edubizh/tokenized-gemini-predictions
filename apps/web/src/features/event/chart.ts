// The geometry of the price chart: the Yes price over time on a fixed 0 to 100 cent scale. Pure.

import type { ApiHistory } from "@outcome/relayer/api-types";

type Points = ApiHistory["points"];

const FULL_PX = 10_000;

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * An SVG path for the points in a `width` by `height` box, oldest at the left and 100 cents at
 * the top, and where the last point sits. A single price is drawn as a level line. Null for none.
 */
export function chartLine(points: Points, width: number, height: number): { d: string; last: { x: number; y: number } } | null {
  const first = points[0];
  const final = points.at(-1);
  if (!first || !final) return null;
  const y = (px: string) => round(height * (1 - Number(px) / FULL_PX));
  const span = final.at - first.at;
  const placed = points.length === 1 ? [{ x: 0, y: y(first.px) }, { x: width, y: y(first.px) }] : points.map((p) => ({ x: span === 0 ? width : round(((p.at - first.at) / span) * width), y: y(p.px) }));
  const last = placed.at(-1) as { x: number; y: number };
  return { d: placed.map((p, index) => `${index === 0 ? "M" : "L"}${p.x} ${p.y}`).join(""), last };
}

/** The last, lowest and highest price, for the chart's text alternative. Null without points. */
export function chartSummary(points: Points): { last: bigint; low: bigint; high: bigint } | null {
  if (points.length === 0) return null;
  const prices = points.map((p) => BigInt(p.px));
  const pick = (better: (a: bigint, b: bigint) => boolean) => prices.reduce((kept, px) => (better(px, kept) ? px : kept));
  return { last: prices.at(-1) as bigint, low: pick((a, b) => a < b), high: pick((a, b) => a > b) };
}
