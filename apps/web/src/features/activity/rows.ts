// One row of the activity list per order: its entry, its market where the relayer still lists
// it, the derived timeline and the figures read off it. Pure.

import type { ApiMarket } from "@outcome/relayer/api-types";
import { marketTitle } from "@/features/markets/wording";
import type { OrderEntry } from "@/features/ticket/entries";
import { deriveTimeline, type DerivedTimeline } from "@/features/ticket/timeline";
import { orderFigures, type OrderFigures } from "./figures";

export interface ActivityRow {
  address: string;
  entry: OrderEntry;
  market: ApiMarket | null;
  /** "BTC Up"; null when the relayer does not list the order's market. */
  title: string | null;
  kind: "buy" | "sell";
  timeline: DerivedTimeline;
  figures: OrderFigures;
}

export function buildActivityRows(entries: readonly OrderEntry[], markets: readonly ApiMarket[], chainNowSecs: number, relayerAway = false): ActivityRow[] {
  return entries.map((entry) => {
    const market =
      markets.find((candidate) => (entry.symbol !== null && candidate.symbol === entry.symbol) || (entry.marketAddress !== null && candidate.onchain?.market === entry.marketAddress)) ?? null;
    const timeline = deriveTimeline({ chainOrder: entry.chain, apiOrder: entry.api, local: entry.local, chainNowSecs, relayerAway });
    return {
      address: entry.address,
      entry,
      market,
      title: market ? marketTitle(market) : null,
      kind: timeline.kind,
      timeline,
      figures: orderFigures(timeline, entry.api),
    };
  });
}
