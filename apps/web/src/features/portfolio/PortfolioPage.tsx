"use client";

import { useCallback, useState } from "react";
import { PageHeader } from "@/components/shell/Shell";
import { GetTestFunds, needsTestFunds } from "@/features/account/GetTestFunds";
import { AccountOnly } from "@/features/account/LoggedOut";
import { useOrderRows } from "@/features/activity/useOrderRows";
import { knownMarkets } from "@/features/markets/known";
import { ChainNotice, RelayerNotice } from "@/features/markets/RelayerNotice";
import { useBalances, useChainMarkets, usePositions } from "@/features/ticket/hooks";
import { explorerAddressUrl, explorerTxUrl, useConfig } from "@/lib/config";
import { useAccount } from "@/lib/privy/account";
import { useReconnect } from "@/lib/privy/use-reconnect";
import { chainNow, useHealth, useOnchainMarkets } from "@/lib/relayer/hooks";
import { useRedeem } from "./actions";
import { PortfolioView, type Redemption } from "./PortfolioView";
import { buildPortfolio, type PositionRow } from "./positions";
import styles from "./Portfolio.module.css";

/** Everyone can open the page; what it shows belongs to an account. */
export function PortfolioPage() {
  return (
    <AccountOnly title="Portfolio" sentence="Your test dollars, outcome tokens and open orders are read from Solana once you are logged in.">
      <Portfolio />
    </AccountOnly>
  );
}

function Portfolio() {
  const config = useConfig();
  const account = useAccount();
  const { offline } = useHealth();
  const { balances } = useBalances();
  const positions = usePositions();
  const markets = useOnchainMarkets();
  const orders = useOrderRows();
  const redeeming = useRedeem();
  const reconnect = useReconnect();
  // Kept while the page is open: once burned, the tokens are no longer on Solana to be shown.
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);

  // The relayer names the markets. For tokens it does not name, and for all of them while it is
  // not answering, the market accounts are read from Solana, which is enough to group and redeem.
  const relayerDown = offline || markets.error !== null;
  const relayerTried = markets.data !== undefined || !markets.loading;
  const held = positions.data;
  const named = new Set((markets.data ?? []).flatMap((market) => (market.onchain ? [market.onchain.yesMint, market.onchain.noMint] : [])));
  const chainMarkets = useChainMarkets(held === undefined || !relayerTried ? null : { mints: held.map((position) => position.mint).filter((mint) => relayerDown || !named.has(mint)) });
  const portfolio =
    held !== undefined && relayerTried && chainMarkets.settled
      ? buildPortfolio(held, knownMarkets({ relayer: markets.data, chain: chainMarkets.markets, offline: relayerDown }), {
          wallMs: Date.now(),
          chainSecs: Math.floor(chainNow() / 1000),
          pricesKnown: !relayerDown,
        })
      : null;

  const { redeem } = redeeming;
  const { refresh } = positions;
  const onRedeem = useCallback(
    async (row: PositionRow) => {
      const signature = await redeem(row);
      if (!signature) return;
      setRedemptions((previous) => [{ mint: row.mint, market: row.market, side: row.side, units: row.units, payoutMicros: row.payoutMicros ?? 0n, signature }, ...previous]);
      refresh();
    },
    [redeem, refresh],
  );

  return (
    <>
      <RelayerNotice />
      <ChainNotice />
      <PageHeader title="Portfolio">Your test dollars, outcome tokens and open orders, read from Solana devnet. Test money with no value.</PageHeader>
      <div className={styles.firstRun}>
        {/* The first-run step for a wallet that is not a trader yet; it draws nothing otherwise. */}
        <GetTestFunds />
      </div>
      <PortfolioView
        balances={balances}
        portfolio={portfolio}
        openOrders={orders.rows === null ? null : orders.rows.filter((row) => row.timeline.open)}
        offline={relayerDown}
        chainFailing={positions.error !== null}
        firstRun={needsTestFunds(config, account)}
        redemptions={redemptions}
        redeeming={redeeming}
        onRedeem={(row) => void onRedeem(row)}
        reclaiming={orders.reclaiming}
        reconnect={reconnect}
        chainNow={chainNow}
        onDeadline={orders.redraw}
        txUrl={(signature) => explorerTxUrl(config, signature)}
        addressUrl={(address) => explorerAddressUrl(config, address)}
      />
    </>
  );
}
