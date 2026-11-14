"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { ApiMarket } from "@outcome/relayer/api-types";
import { ProblemView } from "@/components/shell/Problem";
import { Button, ButtonLink } from "@/components/ui/Button";
import { ActivityView } from "@/features/activity/ActivityView";
import { buildActivityRows } from "@/features/activity/rows";
import { knownMarkets } from "@/features/markets/known";
import { MarketHeaderView, OfflinePanel } from "@/features/markets/MarketViews";
import { ChainNoticeView, RelayerNoticeView } from "@/features/markets/RelayerNotice";
import { PortfolioView, type PortfolioViewProps } from "@/features/portfolio/PortfolioView";
import { buildPortfolio } from "@/features/portfolio/positions";
import { orderEntries } from "@/features/ticket/entries";
import type { ChainMarket, OpenOrder } from "@/lib/chain/reads";
import { buildFixtures, buildJustSettledMarket, FIXTURE_USER, fixtureAddress, fixtureChainMarket } from "@/lib/relayer/fixtures";
import styles from "./Gallery.module.css";
import marketStyles from "@/features/markets/Markets.module.css";

export const OFFLINE_SECTIONS = [
  ["offline", "Without the relayer"],
  ["chain-failing", "Solana not answering"],
  ["problem-pages", "Not found and error pages"],
] as const;

const TZ = "UTC";
const txUrl = (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
const addressUrl = (address: string) => `https://explorer.solana.com/address/${address}?cluster=devnet`;

type SectionComponent = (props: { id: string; title: string; note?: string; children: ReactNode }) => ReactNode;
type SpecimenComponent = (props: { label: string; children: ReactNode; wide?: boolean }) => ReactNode;

/** What a market's account on Solana holds, from a fixture market. */
function accountOf(market: ApiMarket): ChainMarket {
  const account = fixtureChainMarket(market);
  if (!account) throw new Error("the fixture market is not on-chain");
  return { ...account, yesPayout: BigInt(account.yesPayout), noPayout: BigInt(account.noPayout) };
}

export function OfflineGallery({ anchorMs, Section, Specimen }: { anchorMs: number; Section: SectionComponent; Specimen: SpecimenComponent }) {
  const fixtures = buildFixtures(anchorMs);
  const [btc, , , awaiting, settledYes, settledNo] = fixtures.markets as [ApiMarket, ApiMarket, ApiMarket, ApiMarket, ApiMarket, ApiMarket];
  const justSettled = buildJustSettledMarket(anchorMs);
  const chainSecs = Math.floor(anchorMs / 1000);
  const stray = fixtureAddress("gallery-stray-mint");

  // The relayer never answered: every market is put together from its account and its token's name.
  const accounts = [btc, awaiting, settledYes, settledNo, justSettled].map(accountOf);
  const fromSolana = knownMarkets({ relayer: undefined, chain: accounts, offline: true });
  // The relayer answered and then went quiet: its names are kept, the state is Solana's.
  const lastKnown = knownMarkets({ relayer: fixtures.markets, chain: accounts, offline: true });

  const held = [
    { mint: btc.onchain?.yesMint ?? "", units: 300n },
    { mint: awaiting.onchain?.yesMint ?? "", units: 500n },
    { mint: settledYes.onchain?.yesMint ?? "", units: 500n },
    { mint: settledNo.onchain?.yesMint ?? "", units: 250n },
    { mint: justSettled.onchain?.noMint ?? "", units: 200n },
    { mint: stray, units: 700n },
  ];
  const portfolio = (props: Partial<PortfolioViewProps>) => (
    <div className={styles.screen}>
      <PortfolioView
        balances={{ lamports: 50_000_000n, stableMicros: 994_100_000n }}
        portfolio={buildPortfolio(held, fromSolana, { wallMs: anchorMs, chainSecs })}
        offline
        faucet={{ status: { kind: "idle" }, onRequest: () => {} }}
        receipts={[]}
        redeeming={{ mint: null, progress: null, error: null }}
        onRedeem={() => {}}
        nowMs={anchorMs}
        chainNow={() => anchorMs}
        frozen
        txUrl={txUrl}
        addressUrl={addressUrl}
        timeZone={TZ}
        {...props}
      />
    </div>
  );

  // Two open orders read from Solana, of which the relayer says nothing: one can still fill, one has expired.
  const order = (label: string, expiresAt: number, patch: Partial<OpenOrder> = {}): OpenOrder => ({
    address: fixtureAddress(`gallery-offline-${label}`),
    user: FIXTURE_USER,
    market: btc.onchain?.market ?? "",
    side: 0,
    kind: 0,
    qtyUnits: 200n,
    limitPx: 5_700n,
    maxFee: 70_000n,
    expiresAt,
    rentPayer: FIXTURE_USER,
    nonce: 16n,
    ...patch,
  });
  const open = [order("open", chainSecs + 31), order("expired", chainSecs - 40, { side: 1, kind: 1, qtyUnits: 125n, limitPx: 4_300n, maxFee: 60_000n, nonce: 15n })];
  const rows = buildActivityRows(orderEntries({ api: undefined, open: { orders: open, startedAt: anchorMs }, local: {}, nowMs: anchorMs }), fromSolana, chainSecs);
  const activity = (shown: typeof rows) => (
    <div className={styles.screen}>
      <ActivityView
        rows={shown}
        offline
        nowMs={anchorMs}
        chainNow={() => anchorMs}
        frozenAtMs={anchorMs}
        reclaim={{ address: null, progress: null, error: null, onReclaim: () => {} }}
        txUrl={txUrl}
        addressUrl={addressUrl}
        timeZone={TZ}
      />
    </div>
  );

  const solanaBtc = fromSolana.find((market) => market.symbol === btc.symbol) as ApiMarket;
  const lastBtc = lastKnown.find((market) => market.symbol === btc.symbol) as ApiMarket;

  return (
    <>
      <Section
        id="offline"
        title="Without the relayer"
        note="Balances, tokens and open orders are read from Solana, so they stay, and Redeem, Clear and Reclaim keep working. What only the relayer knows is said to be missing where it would have been."
      >
        <Specimen label="Markets: the notice in the list's place" wide>
          <RelayerNoticeView health={null} offline />
          <p className={marketStyles.offlineNote}>
            This page retries on its own. Your tokens are in <Link href="#offline">Portfolio</Link> and your open orders in <Link href="#offline">Activity</Link>.
          </p>
        </Specimen>
        <Specimen label="Market header, read from Solana alone" wide>
          <MarketHeaderView market={solanaBtc} nowMs={anchorMs} frozen offline timeZone={TZ} />
        </Specimen>
        <Specimen label="Market header, with the relayer's last answer" wide>
          <MarketHeaderView market={lastBtc} nowMs={anchorMs} frozen offline timeZone={TZ} />
        </Specimen>
        <Specimen label="In the ticket's place">
          <div className={styles.ticketColumn}>
            <OfflinePanel />
          </div>
        </Specimen>
        <Specimen label="Portfolio: grouped from market accounts, Redeem and Clear in place, no prices and no Sell" wide>
          {portfolio({})}
        </Specimen>
        <Specimen label="Activity: open orders from Solana, Reclaim on the expired one" wide>
          {activity(rows)}
        </Specimen>
        <Specimen label="Activity: no open orders" wide>
          {activity([])}
        </Specimen>
      </Section>

      <Section id="chain-failing" title="Solana not answering" note="A failed read keeps the last good values on screen and says so. Nothing is blanked.">
        <Specimen label="At the top of the page" wide>
          <ChainNoticeView />
        </Specimen>
        <Specimen label="Portfolio: tokens as last read" wide>
          {portfolio({ offline: false, chainFailing: true, portfolio: buildPortfolio(held.slice(0, 3), fixtures.markets, { wallMs: anchorMs, chainSecs }) })}
        </Specimen>
      </Section>

      <Section id="problem-pages" title="Not found and error pages" note="One sentence and one way back, inside the usual frame.">
        <Specimen label="Page not found" wide>
          <div className={styles.screen}>
            <ProblemView kind="Page not found" title="There is nothing at this address" action={<ButtonLink href="#problem-pages">Back to the start</ButtonLink>}>
              The link may be mistyped, or it pointed to something this demo no longer keeps.
            </ProblemView>
          </div>
        </Specimen>
        <Specimen label="A page that threw" wide>
          <div className={styles.screen}>
            <ProblemView kind="Something went wrong" title="This page could not be shown" action={<Button>Try again</Button>}>
              The app hit an error while drawing this page; nothing was signed or sent, and what you hold on Solana is unchanged.
            </ProblemView>
          </div>
        </Specimen>
      </Section>
    </>
  );
}
