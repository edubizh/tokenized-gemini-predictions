"use client";

import type { ReactNode } from "react";
import type { ApiHealth, ApiMarket, ApiOrder } from "@outcome/relayer/api-types";
import { EmptyState } from "@/components/ui/EmptyState";
import { MarketsListSkeleton, MarketsListView } from "@/features/markets/MarketsList";
import { ClosedPanel, HowItWorks, MarketHeaderView, PositionView, PreparingPanel } from "@/features/markets/MarketViews";
import { RelayerNoticeView } from "@/features/markets/RelayerNotice";
import { OrderTimelineView } from "@/features/ticket/OrderTimeline";
import { Ticket, type TicketProps } from "@/features/ticket/Ticket";
import { deriveTimeline, type ChainOrderView, type LocalOrder, type TimelineInput } from "@/features/ticket/timeline";
import { otherAccountMessage, type ReconnectView } from "@/lib/privy/reconnect";
import { buildFixtures, FIXTURE_USER, fixtureAddress, fixtureSignature } from "@/lib/relayer/fixtures";
import styles from "./Gallery.module.css";

export const TRADING_SECTIONS = [
  ["relayer-notice", "Relayer notice"],
  ["markets-list", "Markets list"],
  ["market-header", "Market header"],
  ["ticket", "Ticket"],
  ["ticket-panels", "In the ticket's place"],
  ["order-paths", "Order timeline paths"],
  ["reconnect", "Reconnect wallet"],
  ["position", "Position and explanation"],
] as const;

const TZ = "UTC";
const txUrl = (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;

type SectionComponent = (props: { id: string; title: string; note?: string; children: ReactNode }) => ReactNode;
type SpecimenComponent = (props: { label: string; children: ReactNode; wide?: boolean }) => ReactNode;

export function TradingGallery({ anchorMs, Section, Specimen }: { anchorMs: number; Section: SectionComponent; Specimen: SpecimenComponent }) {
  const fixtures = buildFixtures(anchorMs);
  const [btc, eth, sol, awaiting, settledYes] = fixtures.markets as [ApiMarket, ApiMarket, ApiMarket, ApiMarket, ApiMarket, ApiMarket];
  const health = fixtures.health;
  const rich = { lamports: 50_000_000n, stableMicros: 1_000_000_000n };
  const chainSecs = Math.floor(anchorMs / 1000);

  const listVariants: ApiMarket[] = [
    btc,
    eth,
    { ...eth, symbol: "X-ORDERS-CLOSED", underlying: "SOL", strike: "187.3249583333", tradable: false, notTradableReason: "too_close_to_expiry", expiresAt: anchorMs + 48_000 },
    { ...btc, symbol: "X-NO-OFFERS", underlying: "XRP", strike: "0.9908752722666667", tradable: false, notTradableReason: "no_offers", book: { bidPx: null, bidUnits: "0", askPx: null, askUnits: "0", at: anchorMs } },
    { ...btc, symbol: "X-ONE-SIDED", underlying: "DOGE", strike: "0.2164", book: { bidPx: null, bidUnits: "0", askPx: "3100", askUnits: "4000", at: anchorMs } },
    sol,
    { ...awaiting, symbol: "X-AWAITING", expiresAt: anchorMs - 20_000 },
  ];

  const ticket = (props: Partial<TicketProps>) => (
    <div className={styles.ticketColumn}>
      <Ticket market={btc} health={health} balances={rich} onSubmit={() => {}} onGetTestFunds={() => {}} timeZone={TZ} initialQuantity="5.00" {...props} />
    </div>
  );
  const paused: ApiHealth = { ...health, paused: { place: true, fill: false } };
  // A wallet holding 3.00 YES and 1.25 NO of the first market, which is what its ticket can sell.
  const holding = { YES: 300n, NO: 125n };
  const sellTicket = (props: Partial<TicketProps>) => ticket({ held: holding, initialAction: "sell", initialQuantity: undefined, ...props });
  // The wallet of a wallet login is not connected in the tab after a reload: nothing can sign.
  const reconnect: ReconnectView = { onReconnect: () => {}, problem: null };
  const wrongWallet: ReconnectView = { onReconnect: () => {}, problem: otherAccountMessage(FIXTURE_USER, [fixtureAddress("another-wallet")]) };

  // 2.00 YES at a limit of $0.57 on the first market: cost $1.14, fee cap $0.07, hold $1.21.
  const address = fixtureAddress("gallery-order");
  const placedAt = anchorMs - 9_000;
  const expiresAt = chainSecs + 36;
  const local: LocalOrder = { address, signature: fixtureSignature("gallery-place"), symbol: btc.symbol, side: "YES", units: "200", limitPx: "5700", maxFeeMicros: "70000", placedAt, expiresAt };
  const chain: ChainOrderView = { address, user: FIXTURE_USER, market: btc.onchain?.market ?? "", side: 0, kind: 0, qtyUnits: 200n, limitPx: 5_700n, maxFee: 70_000n, expiresAt, rentPayer: FIXTURE_USER, nonce: 16n };
  const api = (patch: Partial<ApiOrder>): ApiOrder => ({
    address,
    user: FIXTURE_USER,
    symbol: btc.symbol,
    kind: "buy",
    side: "YES",
    units: "200",
    limitPx: "5700",
    maxFeeMicros: "70000",
    expiresAt,
    state: "seen",
    venueOrderId: null,
    filledUnits: "0",
    amountMicros: "0",
    feeMicros: "0",
    fills: [],
    chainSignature: null,
    detail: null,
    createdAt: placedAt + 1_200,
    updatedAt: anchorMs - 2_000,
    ...patch,
  });
  const venue = { venueOrderId: "736152841000018989" };
  const fill = { ...venue, filledUnits: "200", amountMicros: "1120000", feeMicros: "40000", fills: [{ tradeId: "2841730116", units: "200", px: "5600", feeMicros: "40000" }] };
  const settleSig = fixtureSignature("gallery-settle");
  const later = chainSecs + 90;

  // A sale of 3.00 YES at no less than $0.55: the venue order is a buy of NO at $0.45, fee cap $0.09.
  const sellLocal: LocalOrder = { ...local, kind: "sell", units: "300", limitPx: "5500", maxFeeMicros: "90000" };
  const sellChain: ChainOrderView = { ...chain, kind: 1, qtyUnits: 300n, limitPx: 5_500n, maxFee: 90_000n };
  const sellApi = (patch: Partial<ApiOrder>) => api({ kind: "sell", units: "300", limitPx: "5500", maxFeeMicros: "90000", ...patch });
  const sold = { ...venue, filledUnits: "300", amountMicros: "1680000", feeMicros: "60000", fills: [{ tradeId: "2841730117", units: "300", px: "4400", feeMicros: "60000" }] };
  const selling = { chainOrder: sellChain, local: sellLocal };

  const paths: Array<[label: string, input: Partial<TimelineInput>, extra?: { reclaim?: "idle" | "wallet" | "error" | "reconnect"; another?: boolean }]> = [
    ["Just placed: waiting for the relayer", { chainOrder: undefined }],
    ["Picked up by the relayer", { apiOrder: api({ state: "seen" }) }],
    ["At the venue", { apiOrder: api({ state: "submitting", ...venue }) }],
    ["Filled at the venue, minting", { apiOrder: api({ state: "venue_filled", ...fill }) }],
    ["Filled and minted", { chainOrder: null, apiOrder: api({ state: "chain_filled", ...fill, chainSignature: settleSig }) }, { another: true }],
    ["Not filled, hold on its way back", { apiOrder: api({ state: "venue_not_filled", ...venue }) }],
    ["Not filled, refunded", { chainOrder: null, apiOrder: api({ state: "chain_cancelled", ...venue, chainSignature: settleSig }) }, { another: true }],
    ["Refused: too close to the close", { chainOrder: null, apiOrder: api({ state: "chain_cancelled", detail: "expiry_window", chainSignature: settleSig }) }],
    ["Refused: no offers on that side", { chainOrder: null, apiOrder: api({ state: "chain_cancelled", detail: "book_side_empty", chainSignature: settleSig }) }],
    ["Refused: fee cap too low", { chainOrder: null, apiOrder: api({ state: "chain_cancelled", detail: "fee_cap", chainSignature: settleSig }) }],
    ["Refused: market not tradable", { chainOrder: null, apiOrder: api({ state: "chain_cancelled", detail: "not_tradable:market_not_open", chainSignature: settleSig }) }],
    ["Expired and still open: Reclaim", { chainNowSecs: later }, { reclaim: "idle" }],
    ["Reclaim, waiting for the wallet", { chainNowSecs: later }, { reclaim: "wallet" }],
    ["Reclaim failed", { chainNowSecs: later }, { reclaim: "error" }],
    ["Reclaimed by the user", { chainOrder: null, chainNowSecs: later, local: { ...local, reclaimSignature: fixtureSignature("gallery-reclaim") } }],
    ["Venue result unknown", { apiOrder: api({ state: "venue_unknown", ...venue }) }],
    ["Venue result unknown, expired", { apiOrder: api({ state: "venue_unknown", ...venue }), chainNowSecs: later }, { reclaim: "idle" }],
    ["Orphaned: filled too late, refunded", { chainOrder: null, apiOrder: api({ state: "orphaned", ...fill, chainSignature: settleSig }), chainNowSecs: later }],
    ["Failed, before expiry", { apiOrder: api({ state: "failed", detail: "market closed before the order could be sent" }) }],
    ["Failed, expired", { apiOrder: api({ state: "failed" }), chainNowSecs: later }, { reclaim: "idle" }],
    ["Sell: tokens held, waiting for the relayer", { ...selling, chainOrder: undefined }],
    ["Sell: at the venue, as a buy of the opposite outcome", { ...selling, apiOrder: sellApi({ state: "submitting", ...venue }) }],
    ["Sell: filled at the venue, burning and paying", { ...selling, apiOrder: sellApi({ state: "venue_filled", ...sold }) }],
    ["Sell: filled, tokens burned and test dollars paid", { ...selling, chainOrder: null, apiOrder: sellApi({ state: "chain_filled", ...sold, chainSignature: settleSig }) }, { another: true }],
    ["Sell: not filled, tokens returned", { ...selling, chainOrder: null, apiOrder: sellApi({ state: "chain_cancelled", ...venue, chainSignature: settleSig }) }, { another: true }],
    ["Sell: refused, it would not have covered the fee cap", { ...selling, chainOrder: null, apiOrder: sellApi({ state: "chain_cancelled", detail: "fee_cap", chainSignature: settleSig }) }],
    ["Sell: expired and still open, Reclaim tokens", { ...selling, chainNowSecs: later }, { reclaim: "idle" }],
    ["Sell: reclaimed by the user", { ...selling, chainOrder: null, chainNowSecs: later, local: { ...sellLocal, reclaimSignature: fixtureSignature("gallery-reclaim-sell") } }],
  ];

  return (
    <>
      <Section id="relayer-notice" title="Relayer notice" note="At the top of every page that needs the relayer, when something is off.">
        <div className={styles.stack}>
          <RelayerNoticeView health={null} offline />
          <RelayerNoticeView health={paused} offline={false} />
          <RelayerNoticeView health={{ ...health, paused: { place: false, fill: true } }} offline={false} />
          <RelayerNoticeView health={{ ...health, venueConnected: false }} offline={false} />
        </div>
      </Section>

      <Section id="markets-list" title="Markets list" note="What YES pays for, the time left, and the price of each side. A contract that cannot be traded stays, with the reason in words.">
        <Specimen label="Every row state" wide>
          <MarketsListView markets={listVariants} nowMs={anchorMs} frozen timeZone={TZ} />
        </Specimen>
        <Specimen label="Loading" wide>
          <MarketsListSkeleton />
        </Specimen>
        <Specimen label="Nothing listed" wide>
          <EmptyState>The venue lists no fifteen-minute contracts right now. A new window opens every fifteen minutes and appears here on its own.</EmptyState>
        </Specimen>
      </Section>

      <Section id="market-header" title="Market header" note="The countdown is the one large number on the page.">
        <Specimen label="Live" wide>
          <MarketHeaderView market={btc} nowMs={anchorMs} frozen timeZone={TZ} />
        </Specimen>
        <Specimen label="Closing soon" wide>
          <MarketHeaderView market={eth} nowMs={anchorMs} frozen timeZone={TZ} />
        </Specimen>
        <Specimen label="Not started" wide>
          <MarketHeaderView market={sol} nowMs={anchorMs} frozen timeZone={TZ} />
        </Specimen>
        <Specimen label="Awaiting the result" wide>
          <MarketHeaderView market={awaiting} nowMs={anchorMs} frozen timeZone={TZ} />
        </Specimen>
        <Specimen label="Settled" wide>
          <MarketHeaderView market={settledYes} nowMs={anchorMs} frozen timeZone={TZ} />
        </Specimen>
      </Section>

      <Section id="ticket" title="Ticket" note="One decision: which side, how many, at what price. The button names the amount that will be held.">
        <div className={styles.grid}>
          <Specimen label="Ready, YES">{ticket({})}</Specimen>
          <Specimen label="Ready, NO">{ticket({ initialSide: "NO" })}</Specimen>
          <Specimen label="More than is offered">{ticket({ initialQuantity: "250.00" })}</Specimen>
          <Specimen label="Limit below the lowest offer">{ticket({ initialPrice: "0.50" })}</Specimen>
          <Specimen label="Quantity not allowed">{ticket({ initialQuantity: "0" })}</Specimen>
          <Specimen label="Price off the tick">{ticket({ initialPrice: "0.575" })}</Specimen>
          <Specimen label="Not enough test dollars">{ticket({ balances: { lamports: 50_000_000n, stableMicros: 1_250_000n } })}</Specimen>
          <Specimen label="Faucet answered">{ticket({ balances: { lamports: 50_000_000n, stableMicros: 1_250_000n }, fundsNote: "One top-up per ten minutes. Try again in 4 minutes." })}</Specimen>
          <Specimen label="Not enough SOL for fees">{ticket({ balances: { lamports: 1_200_000n, stableMicros: 1_000_000_000n } })}</Specimen>
          <Specimen label="Orders closed">{ticket({ market: { ...eth, tradable: false, notTradableReason: "too_close_to_expiry" } })}</Specimen>
          <Specimen label="Not started">{ticket({ market: sol })}</Specimen>
          <Specimen label="Trading paused">{ticket({ health: paused })}</Specimen>
          <Specimen label="Relayer offline">{ticket({ health: null })}</Specimen>
          <Specimen label="Check your wallet">{ticket({ progress: "wallet" })}</Specimen>
          <Specimen label="Sending">{ticket({ progress: "sending" })}</Specimen>
          <Specimen label="The send failed">{ticket({ error: "Orders for this market have closed. Nothing was held." })}</Specimen>
          <Specimen label="Balances not read yet">{ticket({ balances: null })}</Specimen>
          <Specimen label="Holding tokens: Buy and Sell tabs">{ticket({ held: holding })}</Specimen>
          <Specimen label="Sell, YES: everything held, at the bid">{sellTicket({})}</Specimen>
          <Specimen label="Sell, NO">{sellTicket({ initialSide: "NO" })}</Specimen>
          <Specimen label="Sell: more than is held">{sellTicket({ initialQuantity: "4.00" })}</Specimen>
          <Specimen label="Sell: none of this side held">{sellTicket({ held: { YES: 300n, NO: 0n }, initialSide: "NO" })}</Specimen>
          <Specimen label="Sell: minimum above the highest bid">{sellTicket({ initialPrice: "0.60" })}</Specimen>
          <Specimen label="Sell: more than buyers want">{sellTicket({ held: { YES: 30_000n, NO: 0n } })}</Specimen>
          <Specimen label="Sell: would not cover the fee cap">{sellTicket({ initialPrice: "0.03" })}</Specimen>
          <Specimen label="Sell: no quantity covers the fee cap">{sellTicket({ initialPrice: "0.01" })}</Specimen>
          <Specimen label="Sell: check your wallet">{sellTicket({ progress: "wallet" })}</Specimen>
          <Specimen label="Sell: tokens not read yet">{sellTicket({ held: null })}</Specimen>
        </div>
      </Section>

      <Section id="ticket-panels" title="In the ticket's place" note="What the ticket column shows while there is no ticket to fill in.">
        <div className={styles.grid}>
          <Specimen label="Preparing the market">
            <div className={styles.ticketColumn}>
              <PreparingPanel failed={false} onRetry={() => {}} />
            </div>
          </Specimen>
          <Specimen label="Preparing failed">
            <div className={styles.ticketColumn}>
              <PreparingPanel failed onRetry={() => {}} />
            </div>
          </Specimen>
          <Specimen label="Closed, awaiting the result">
            <div className={styles.ticketColumn}>
              <ClosedPanel market={awaiting} />
            </div>
          </Specimen>
          <Specimen label="Closed, settled">
            <div className={styles.ticketColumn}>
              <ClosedPanel market={settledYes} />
            </div>
          </Specimen>
          <Specimen label="The ticket after an order is sent">
            <div className={styles.ticketColumn}>
              <OrderTimelineView
                variant="slip"
                timeline={deriveTimeline({ chainOrder: chain, apiOrder: api({ state: "submitting", ...venue }), local, chainNowSecs: chainSecs })}
                txUrl={txUrl}
                chainNow={() => anchorMs}
                frozenAtMs={anchorMs}
                timeZone={TZ}
                onPlaceAnother={() => {}}
              />
            </div>
          </Specimen>
          <Specimen label="The ticket as a receipt">
            <div className={styles.ticketColumn}>
              <OrderTimelineView
                variant="slip"
                timeline={deriveTimeline({ chainOrder: null, apiOrder: api({ state: "chain_filled", ...fill, chainSignature: settleSig }), local, chainNowSecs: chainSecs })}
                txUrl={txUrl}
                chainNow={() => anchorMs}
                frozenAtMs={anchorMs}
                timeZone={TZ}
                onPlaceAnother={() => {}}
              />
            </div>
          </Specimen>
        </div>
      </Section>

      <Section id="order-paths" title="Order timeline paths" note="Every way an order can go, derived from the same function the pages use.">
        <div className={styles.pathList}>
          {paths.map(([label, input, extra]) => (
            <Specimen key={label} label={label} wide>
              <div className={styles.pathWidth}>
                <OrderTimelineView
                  timeline={deriveTimeline({ chainOrder: chain, apiOrder: null, local, chainNowSecs: chainSecs, ...input })}
                  txUrl={txUrl}
                  chainNow={() => (input.chainNowSecs ?? chainSecs) * 1000}
                  frozenAtMs={(input.chainNowSecs ?? chainSecs) * 1000}
                  timeZone={TZ}
                  onPlaceAnother={extra?.another ? () => {} : undefined}
                  reclaim={
                    extra?.reclaim
                      ? {
                          onReclaim: () => {},
                          progress: extra.reclaim === "wallet" ? "wallet" : null,
                          error: extra.reclaim === "error" ? "The order has not expired yet, so it cannot be reclaimed. Wait for the countdown." : null,
                          reconnect: extra.reclaim === "reconnect" ? reconnect : null,
                        }
                      : undefined
                  }
                />
              </div>
            </Specimen>
          ))}
        </div>
      </Section>

      <Section id="reconnect" title="Reconnect wallet" note="After a page reload a wallet login is still logged in, but its wallet is no longer connected in the tab. Wherever a signature is needed, Reconnect wallet takes the action's place.">
        <div className={styles.grid} style={{ marginBottom: "var(--space-6)" }}>
          <Specimen label="Ticket">{ticket({ reconnect })}</Specimen>
          <Specimen label="Ticket, selling">{sellTicket({ reconnect })}</Specimen>
          <Specimen label="A different wallet was connected">{ticket({ reconnect: wrongWallet })}</Specimen>
        </div>
        <div className={styles.pathList}>
          {(
            [
              ["Reclaim on an expired order", reconnect],
              ["Reclaim, after a different wallet was connected", wrongWallet],
            ] as const
          ).map(([label, state]) => (
            <Specimen key={label} label={label} wide>
              <div className={styles.pathWidth}>
                <OrderTimelineView
                  timeline={deriveTimeline({ chainOrder: chain, apiOrder: null, local, chainNowSecs: later })}
                  txUrl={txUrl}
                  chainNow={() => later * 1000}
                  frozenAtMs={later * 1000}
                  timeZone={TZ}
                  reclaim={{ onReclaim: () => {}, progress: null, error: null, reconnect: state }}
                />
              </div>
            </Specimen>
          ))}
        </div>
      </Section>

      <Section id="position" title="Position and explanation" note="Under the orders on a market page.">
        <Specimen label="Holding both sides" wide>
          <PositionView
            market={btc}
            positions={[
              { mint: btc.onchain?.yesMint ?? "", units: 300n },
              { mint: btc.onchain?.noMint ?? "", units: 125n },
            ]}
          />
        </Specimen>
        <Specimen label="After settlement" wide>
          <PositionView market={settledYes} positions={[{ mint: settledYes.onchain?.yesMint ?? "", units: 500n }]} />
        </Specimen>
        <Specimen label="Nothing held" wide>
          <PositionView market={btc} positions={[]} />
        </Specimen>
        <Specimen label="What happens to an order" wide>
          <HowItWorks />
        </Specimen>
      </Section>
    </>
  );
}
