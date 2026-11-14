"use client";

import type { ReactNode } from "react";
import type { ApiMarket, ApiStatus } from "@outcome/relayer/api-types";
import { ActivityView } from "@/features/activity/ActivityView";
import { buildActivityRows } from "@/features/activity/rows";
import { PortfolioView, type PortfolioViewProps, type RedemptionReceipt } from "@/features/portfolio/PortfolioView";
import { buildPortfolio } from "@/features/portfolio/positions";
import { SystemView, type SystemViewProps } from "@/features/system/SystemView";
import { orderEntries } from "@/features/ticket/entries";
import type { LocalOrder } from "@/features/ticket/timeline";
import type { OpenOrder } from "@/lib/chain/reads";
import { buildFixtures, buildJustSettledMarket, FIXTURE_USER, fixtureAddress, fixtureSignature } from "@/lib/relayer/fixtures";
import styles from "./Gallery.module.css";

export const ACCOUNT_SECTIONS = [
  ["portfolio", "Portfolio"],
  ["activity", "Activity"],
  ["system", "System page"],
] as const;

const TZ = "UTC";
const txUrl = (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
const addressUrl = (address: string) => `https://explorer.solana.com/address/${address}?cluster=devnet`;

type SectionComponent = (props: { id: string; title: string; note?: string; children: ReactNode }) => ReactNode;
type SpecimenComponent = (props: { label: string; children: ReactNode; wide?: boolean }) => ReactNode;

export function AccountGallery({ anchorMs, Section, Specimen }: { anchorMs: number; Section: SectionComponent; Specimen: SpecimenComponent }) {
  const fixtures = buildFixtures(anchorMs);
  const [btc, , , awaiting, settledYes, settledNo] = fixtures.markets as [ApiMarket, ApiMarket, ApiMarket, ApiMarket, ApiMarket, ApiMarket];
  const justSettled = buildJustSettledMarket(anchorMs);
  const markets = [...fixtures.markets, justSettled];
  const chainSecs = Math.floor(anchorMs / 1000);
  const stray = fixtureAddress("gallery-stray-mint");

  // Portfolio: a wallet with something in every group, both sides of the live market among it.
  const held = [
    { mint: btc.onchain?.yesMint ?? "", units: 300n },
    { mint: btc.onchain?.noMint ?? "", units: 125n },
    { mint: awaiting.onchain?.yesMint ?? "", units: 500n },
    { mint: settledYes.onchain?.yesMint ?? "", units: 500n },
    { mint: settledNo.onchain?.yesMint ?? "", units: 250n },
    { mint: justSettled.onchain?.noMint ?? "", units: 200n },
  ];
  const portfolioOf = (balances: typeof held, known: readonly ApiMarket[] = markets) => buildPortfolio(balances, known, { wallMs: anchorMs, chainSecs });
  const receipts: RedemptionReceipt[] = [
    { mint: settledYes.onchain?.yesMint ?? "", title: "ETH Up", side: "YES", units: 500n, payoutMicros: 5_000_000n, signature: fixtureSignature("gallery-redeem"), at: anchorMs - 4_000 },
    { mint: settledNo.onchain?.yesMint ?? "", title: "SOL Up", side: "YES", units: 250n, payoutMicros: 0n, signature: fixtureSignature("gallery-clear"), at: anchorMs - 1_000 },
  ];
  const portfolio = (props: Partial<PortfolioViewProps>) => (
    <div className={styles.screen}>
      <PortfolioView
        balances={{ lamports: 50_000_000n, stableMicros: 994_100_000n }}
        portfolio={portfolioOf(held)}
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

  // Activity: the fixture orders in every journal state, ten seconds on, so one has expired.
  const later = chainSecs + 10;
  const unfinished = new Set(["seen", "submitting", "venue_filled", "venue_not_filled", "venue_unknown"]);
  const open: OpenOrder[] = fixtures.orders
    .filter((order) => unfinished.has(order.state))
    .map((order, index) => ({
      address: order.address,
      user: FIXTURE_USER,
      market: fixtures.markets.find((market) => market.symbol === order.symbol)?.onchain?.market ?? "",
      side: order.side === "YES" ? 0 : 1,
      kind: 0,
      qtyUnits: BigInt(order.units),
      limitPx: BigInt(order.limitPx),
      maxFee: BigInt(order.maxFeeMicros),
      expiresAt: order.expiresAt,
      rentPayer: FIXTURE_USER,
      nonce: BigInt(16 + index),
    }));
  const local: Record<string, LocalOrder> = Object.fromEntries(
    fixtures.orders.map((order) => [
      order.address,
      { address: order.address, signature: fixtureSignature(`gallery-place:${order.address}`), symbol: order.symbol, side: order.side, units: order.units, limitPx: order.limitPx, maxFeeMicros: order.maxFeeMicros, placedAt: order.createdAt - 1_200, expiresAt: order.expiresAt },
    ]),
  );
  const rows = buildActivityRows(orderEntries({ api: fixtures.orders, open: { orders: open, startedAt: anchorMs }, local, nowMs: anchorMs }), markets, later);
  const filled = fixtures.orders.find((order) => order.state === "chain_filled")?.address ?? "";
  const expired = fixtures.orders.find((order) => order.state === "venue_unknown")?.address ?? "";
  const refunded = fixtures.orders.find((order) => order.state === "chain_cancelled")?.address ?? "";
  const activity = (shown: typeof rows | null, expanded: string[] = [], failed?: string) => (
    <div className={styles.screen}>
      <ActivityView
        rows={shown}
        nowMs={anchorMs}
        chainNow={() => later * 1000}
        frozenAtMs={later * 1000}
        reclaim={{ address: failed ?? null, progress: null, error: failed ? "The order has not expired yet, so it cannot be reclaimed. Wait for the countdown." : null, onReclaim: () => {} }}
        txUrl={txUrl}
        addressUrl={addressUrl}
        defaultExpanded={expanded}
        timeZone={TZ}
      />
    </div>
  );

  // System: the relayer's status as it is, and with everything that can be off.
  const addresses = { program: fixtures.health.programId, config: fixtureAddress("config"), stableMint: fixtures.health.stableMint, treasury: fixtureAddress("treasury") };
  const troubled: ApiStatus = {
    ...fixtures.status,
    markets: fixtures.status.markets.map((row, index) => (index === 0 ? { ...row, inFlight: "200", venueNet: (BigInt(row.venueNet) - 300n).toString(), balanced: false } : row)),
    solvency: { ...fixtures.status.solvency, venueCashMicros: "4120000", treasuryMicros: "6500000", ok: false },
    alerts: [
      { at: anchorMs - 40_000, kind: "reconcile_mismatch", orderAddress: null, detail: "venue position differs from supply by 5.00 contracts" },
      ...fixtures.status.alerts,
    ],
  };
  const system = (props: Partial<SystemViewProps>) => (
    <div className={styles.screen}>
      <SystemView venue="sandbox" health={{ ...fixtures.health, venue: "sandbox" }} offline={false} status={fixtures.status} markets={markets} addresses={addresses} nowMs={anchorMs} addressUrl={addressUrl} timeZone={TZ} {...props} />
    </div>
  );

  return (
    <>
      <Section id="portfolio" title="Portfolio" note="Test dollars first, then the tokens grouped by where each market is in its life. A redeemed row gives way to its receipt.">
        <Specimen label="Something in every group, both sides of one market" wide>
          {portfolio({ portfolio: portfolioOf([...held, { mint: stray, units: 700n }]) })}
        </Specimen>
        <Specimen label="Redeeming: waiting for the wallet" wide>
          {portfolio({ portfolio: portfolioOf(held.slice(3, 5)), redeeming: { mint: settledYes.onchain?.yesMint ?? "", progress: "wallet", error: null } })}
        </Specimen>
        <Specimen label="After a redemption and a clear: receipts in the rows' place" wide>
          {portfolio({ balances: { lamports: 49_990_000n, stableMicros: 999_100_000n }, portfolio: portfolioOf(held.slice(0, 5)), receipts })}
        </Specimen>
        <Specimen label="The redemption was refused" wide>
          {portfolio({
            portfolio: portfolioOf(held.slice(3, 5)),
            redeeming: { mint: settledYes.onchain?.yesMint ?? "", progress: null, error: "Redemption has not opened for this market yet. Nothing was burned; wait for the countdown." },
          })}
        </Specimen>
        <Specimen label="Low on test dollars" wide>
          {portfolio({ balances: { lamports: 50_000_000n, stableMicros: 41_870_000n }, portfolio: portfolioOf(held.slice(0, 1)) })}
        </Specimen>
        <Specimen label="Low on SOL, faucet answered" wide>
          {portfolio({
            balances: { lamports: 4_200_000n, stableMicros: 994_100_000n },
            portfolio: portfolioOf(held.slice(0, 1)),
            faucet: { status: { kind: "error", text: "One top-up per ten minutes. Try again in 4 minutes." }, onRequest: () => {} },
          })}
        </Specimen>
        <Specimen label="No positions yet" wide>
          {portfolio({ portfolio: portfolioOf([]) })}
        </Specimen>
        <Specimen label="Relayer not answering: tokens listed by mint" wide>
          {portfolio({ portfolio: portfolioOf(held.slice(0, 2), []), unnamed: true })}
        </Specimen>
        <Specimen label="Loading" wide>
          {portfolio({ balances: null, portfolio: null })}
        </Specimen>
      </Section>

      <Section id="activity" title="Activity" note="Orders newest first. A row opens in place into its steps and its receipt.">
        <Specimen label="Every order state, closed" wide>
          {activity(rows)}
        </Specimen>
        <Specimen label="Opened: a filled order, a refunded one, and an expired one with Reclaim" wide>
          {activity(
            rows.filter((row) => [filled, refunded, expired].includes(row.address)),
            [filled, refunded, expired],
          )}
        </Specimen>
        <Specimen label="Reclaim failed" wide>
          {activity(
            rows.filter((row) => row.address === expired),
            [expired],
            expired,
          )}
        </Specimen>
        <Specimen label="A market the relayer no longer lists" wide>
          {activity(buildActivityRows(orderEntries({ api: fixtures.orders.slice(5, 6), open: { orders: [], startedAt: anchorMs }, local: {}, nowMs: anchorMs }), [], later))}
        </Specimen>
        <Specimen label="No orders yet" wide>
          {activity([])}
        </Specimen>
        <Specimen label="Loading" wide>
          {activity(null)}
        </Specimen>
      </Section>

      <Section id="system" title="System page" note="How it works, what is trusted, and the relayer's own books. Readable without a login.">
        <Specimen label="Exchange sandbox, all well" wide>
          {system({})}
        </Specimen>
        <Specimen label="Simulated venue, with everything that can be off" wide>
          {system({
            venue: "mock",
            health: { ...fixtures.health, venue: "mock", venueConnected: false, paused: { place: true, fill: true }, chainTime: fixtures.health.chainTime - 3 },
            status: troubled,
            addresses: { ...addresses, treasury: null },
          })}
        </Specimen>
        <Specimen label="Relayer not answering" wide>
          {system({ health: null, offline: true, status: null })}
        </Specimen>
        <Specimen label="Before the first answer" wide>
          {system({ health: null, offline: false, status: null })}
        </Specimen>
      </Section>
    </>
  );
}
