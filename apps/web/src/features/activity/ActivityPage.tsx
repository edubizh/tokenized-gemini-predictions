"use client";

import { PageHeader } from "@/components/shell/Shell";
import { AccountOnly } from "@/features/account/LoggedOut";
import { ChainNotice, RelayerNotice } from "@/features/markets/RelayerNotice";
import { explorerAddressUrl, explorerTxUrl, useConfig } from "@/lib/config";
import { chainNow } from "@/lib/relayer/hooks";
import { ActivityView } from "./ActivityView";
import { useOrderRows } from "./useOrderRows";

/** Everyone can open the page; what it shows belongs to an account. */
export function ActivityPage() {
  return (
    <AccountOnly title="Activity" sentence="Every order you place is listed here once you are logged in, with each step it took and its transactions on Solana.">
      <Activity />
    </AccountOnly>
  );
}

function Activity() {
  const config = useConfig();
  const { rows, relayerDown, reclaiming, redraw } = useOrderRows();

  return (
    <>
      <RelayerNotice />
      <ChainNotice />
      <PageHeader title="Activity">Your orders, newest first. Open one to see each step it took, where its test dollars went, and the transactions on Solana.</PageHeader>
      <ActivityView
        rows={rows}
        offline={relayerDown}
        nowMs={Date.now()}
        chainNow={chainNow}
        onExpired={redraw}
        reclaim={reclaiming}
        txUrl={(signature) => explorerTxUrl(config, signature)}
        addressUrl={(address) => explorerAddressUrl(config, address)}
      />
    </>
  );
}
