"use client";

import { useCallback, useReducer, useState } from "react";
import { PageHeader, useFaucet } from "@/components/shell/Shell";
import { chainNow, useMarkets } from "@/features/markets/hooks";
import { marketTitle } from "@/features/markets/wording";
import { useBalances, usePositions } from "@/features/ticket/hooks";
import { explorerAddressUrl, explorerTxUrl, useConfig } from "@/lib/config";
import { useReconnect } from "@/lib/privy/use-reconnect";
import { useRedeem } from "./actions";
import { PortfolioView, type RedemptionReceipt } from "./PortfolioView";
import { buildPortfolio, type PositionRow } from "./positions";

export function PortfolioPage() {
  const config = useConfig();
  const { balances } = useBalances();
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
  // Without the relayer the tokens are still listed, by mint, until it answers again.
  const marketsKnown = markets.data !== undefined;
  const ready = positions.data !== undefined && (marketsKnown || !markets.loading);
  const portfolio = ready ? buildPortfolio(positions.data ?? [], markets.data ?? [], { wallMs: now, chainSecs: Math.floor(chainNow() / 1000) }) : null;

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
        unnamed={!marketsKnown}
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
