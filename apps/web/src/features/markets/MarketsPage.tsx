"use client";

import { PageHeader } from "@/components/shell/Shell";
import { EmptyState } from "@/components/ui/EmptyState";
import { useMarkets } from "./hooks";
import { MarketsListSkeleton, MarketsListView } from "./MarketsList";
import { listedMarkets } from "./wording";

export function MarketsPage() {
  const markets = useMarkets("live");
  const now = Date.now();

  let body;
  if (markets.data === undefined) {
    body = markets.loading ? <MarketsListSkeleton /> : <EmptyState>Markets cannot be listed while the relayer is not answering. This page retries on its own.</EmptyState>;
  } else if (listedMarkets(markets.data, now).length === 0) {
    body = <EmptyState>The venue lists no fifteen-minute contracts right now. A new window opens every fifteen minutes and appears here on its own.</EmptyState>;
  } else {
    body = <MarketsListView markets={markets.data} nowMs={now} />;
  }

  return (
    <>
      <PageHeader title="Markets">Fifteen-minute contracts on the price of an asset. Prices are in test dollars, and the tokens you buy have no value.</PageHeader>
      {body}
    </>
  );
}
