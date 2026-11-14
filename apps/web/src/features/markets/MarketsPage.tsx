"use client";

import Link from "next/link";
import { PageHeader } from "@/components/shell/Shell";
import { EmptyState } from "@/components/ui/EmptyState";
import { useHealth, useMarkets } from "./hooks";
import { MarketsListSkeleton, MarketsListView } from "./MarketsList";
import { RelayerNoticeView } from "./RelayerNotice";
import { listedMarkets } from "./wording";
import styles from "./Markets.module.css";

export function MarketsPage() {
  const markets = useMarkets("live");
  const { health, offline } = useHealth();
  const now = Date.now();

  let body;
  if (offline || (markets.data === undefined && !markets.loading)) {
    // Prices from before the relayer went quiet are not shown as if they were current.
    body = (
      <>
        <RelayerNoticeView health={health} offline />
        <p className={styles.offlineNote}>
          This page retries on its own. Your tokens are in <Link href="/portfolio">Portfolio</Link> and your open orders in <Link href="/activity">Activity</Link>.
        </p>
      </>
    );
  } else if (markets.data === undefined) {
    body = <MarketsListSkeleton />;
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
