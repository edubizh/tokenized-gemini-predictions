"use client";

import { useCallback, useReducer, useState } from "react";
import { PageHeader, useFaucet } from "@/components/shell/Shell";
import { chainNow, useHealth, useMarkets } from "@/features/markets/hooks";
import { knownMarkets } from "@/features/markets/known";
import { marketTitle } from "@/features/markets/wording";
import { useBalances, useChainMarkets, usePositions } from "@/features/ticket/hooks";
import { explorerAddressUrl, explorerTxUrl, useConfig } from "@/lib/config";
import { useReconnect } from "@/lib/privy/use-reconnect";
import { useRedeem } from "./actions";
import { PortfolioView, type RedemptionReceipt } from "./PortfolioView";
import { buildPortfolio, type PositionRow } from "./positions";

export function PortfolioPage() {
  const config = useConfig();
  const { offline } = useHealth();
  const { balances, stale } = useBalances();
  const positions = usePositions();
  const markets = useMarkets("all");
  const faucet = useFaucet();
  const redeeming = useRedeem();
  const reconnect = useReconnect();
  // Kept for as long as the page is open: the chain no longer has the tokens to show.
  const [receipts, setReceipts] = useState<RedemptionReceipt[]>([]);
  // Drawn again when a countdown reaches zero, so a position moves to its next group on time.
  const [, redraw] = useReducer((count: number) => count + 1, 0);

  const now = Date.now();
  // The relayer names the markets. For tokens it does not name, and for all of them while it is
  // not answering, the market accounts are read from Solana, which is enough to group and redeem.
  const relayerDown = offline || markets.error !== null;
  const relayerTried = markets.data !== undefined || !markets.loading;
  const held = positions.data;
  const named = new Set((markets.data ?? []).flatMap((market) => (market.onchain ? [market.onchain.yesMint, market.onchain.noMint] : [])));
  const chainMarkets = useChainMarkets(held === undefined || !relayerTried ? null : { mints: held.map((position) => position.mint).filter((mint) => relayerDown || !named.has(mint)) });
  const ready = held !== undefined && relayerTried && chainMarkets.settled;
  const portfolio = ready
    ? buildPortfolio(held, knownMarkets({ relayer: markets.data, chain: chainMarkets.markets, offline: relayerDown }), { wallMs: now, chainSecs: Math.floor(chainNow() / 1000) })
    : null;

  const { redeem } = redeeming;
  const { refresh } = positions;
  const onRedeem = useCallback(
    async (row: PositionRow) => {
      const signature = await redeem(row);
      if (!signature) return;
      setReceipts((previous) => [
        { mint: row.mint, title: marketTitle(row.market), side: row.side, units: row.units, payoutMicros: row.payoutMicros ?? 0n, signature, at: Date.now() },
        ...previous,
      ]);
      refresh();
    },
    [redeem, refresh],
  );

  return (
    <>
      <PageHeader title="Portfolio">Your test dollars and the outcome tokens in your wallet, read from Solana. Everything here is test money with no value.</PageHeader>
      <PortfolioView
        balances={balances}
        portfolio={portfolio}
        offline={relayerDown}
        chainFailing={positions.error !== null && !stale}
        faucet={{ status: faucet.status, onRequest: faucet.request }}
        receipts={receipts}
        redeeming={redeeming}
        onRedeem={(row) => void onRedeem(row)}
        reconnect={reconnect}
        nowMs={now}
        chainNow={chainNow}
        onDeadline={redraw}
        txUrl={(signature) => explorerTxUrl(config, signature)}
        addressUrl={(address) => explorerAddressUrl(config, address)}
      />
    </>
  );
}
