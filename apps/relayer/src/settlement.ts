// Settlement watcher: looks at every unsettled on-chain market for the venue's resolution of its
// contract, checks that the venue paid what the outstanding tokens imply, and only then settles
// the market on-chain. A market is looked at on every tick from its expiry on, and once in a
// while before it, because a contract can resolve early.

import type { MarketChain } from "./chain/chain.ts";
import type { Journal } from "./journal.ts";
import { PAYOUT_PER_UNIT } from "./money.ts";
import { VENUE_STATUSES } from "./registry.ts";
import type { Registry, RegistryMarket } from "./registry.ts";
import type { ContractInfo, Venue } from "./venue/venue.ts";

export interface SettlementOptions {
  venue: Venue;
  chain: MarketChain;
  registry: Registry;
  journal: Journal;
  /** How long a resolution must be seen unchanged before it is acted on. */
  confirmMs: number;
  /** A market still unresolved this long after expiry is handed to a person. */
  reviewAfterMs: number;
  /**
   * How long after a resolution was first seen the venue may still be short of the expected
   * payout: the row of a settled position can be published some time after the resolution.
   */
  payoutGraceMs: number;
  /** How often a market is looked at before it expires. */
  sweepMs: number;
  /** The most markets one tick takes up. Each is read from the chain once, and once more when it is settled. */
  marketsPerTick: number;
  /**
   * The most reads of the venue in one tick: one for the due contracts of an event, one for each
   * payout. Two at least, or no payout could ever be read.
   */
  venueReadsPerTick: number;
  /** Unix milliseconds. */
  now(): number;
  alert(event: { kind: string; orderAddress: string | null; detail: string }): void;
}

export const DEFAULT_SETTLEMENT_OPTIONS = {
  confirmMs: 20_000,
  reviewAfterMs: 600_000,
  payoutGraceMs: 180_000,
  sweepMs: 60_000,
  marketsPerTick: 8,
  venueReadsPerTick: 4,
} as const;

export type SettlementInput = Omit<SettlementOptions, keyof typeof DEFAULT_SETTLEMENT_OPTIONS> &
  Partial<Pick<SettlementOptions, keyof typeof DEFAULT_SETTLEMENT_OPTIONS>>;

/** A resolution and when it was first seen. */
interface Sighting {
  side: "yes" | "no";
  at: number;
}

export function createSettlementWatcher(input: SettlementInput): { tick(): Promise<void> } {
  const { venue, chain, registry, journal, now, alert } = input;
  const confirmMs = input.confirmMs ?? DEFAULT_SETTLEMENT_OPTIONS.confirmMs;
  const reviewAfterMs = input.reviewAfterMs ?? DEFAULT_SETTLEMENT_OPTIONS.reviewAfterMs;
  const payoutGraceMs = input.payoutGraceMs ?? DEFAULT_SETTLEMENT_OPTIONS.payoutGraceMs;
  const sweepMs = input.sweepMs ?? DEFAULT_SETTLEMENT_OPTIONS.sweepMs;
  const marketsPerTick = input.marketsPerTick ?? DEFAULT_SETTLEMENT_OPTIONS.marketsPerTick;
  const venueReadsPerTick = input.venueReadsPerTick ?? DEFAULT_SETTLEMENT_OPTIONS.venueReadsPerTick;
  /** The resolution last seen per symbol. Lost on restart, by design. */
  const sightings = new Map<string, Sighting>();
  /** When each unsettled market last had its turn. Lost on restart: every market is due then. */
  const lookedAt = new Map<string, number>();

  const raise = (kind: string, symbol: string, detail: string): void => alert({ kind, orderAddress: null, detail: `${symbol}: ${detail}` });

  /** Leaves the market to a person: it drops out of the unsettled list, so this happens once. */
  function review(symbol: string, detail: string): void {
    sightings.delete(symbol);
    registry.setSettle(symbol, "needs_review", { detail });
    raise("needs_review", symbol, detail);
  }

  const hasUnresolvedOrders = (symbol: string): boolean => journal.unresolved().some((row) => row.symbol === symbol);

  /** What the chain and the journal say about a market. True when the venue is to be asked about its contract. */
  async function needsVenue(market: RegistryMarket, started: number): Promise<boolean> {
    const { symbol } = market;
    if (market.settleState === "open" && market.expiresAt <= started) registry.setSettle(symbol, "awaiting_result");

    const onchain = await chain.market(symbol);
    if (onchain === null) {
      review(symbol, "on-chain market account not found");
      return false;
    }
    if (onchain.status === "settled") {
      sightings.delete(symbol);
      registry.setSettle(symbol, "settled");
      return false;
    }
    // An order still in flight can change the supplies and the venue position.
    return !hasUnresolvedOrders(symbol);
  }

  /**
   * What the venue says about a market's contract. Returns the resolution once it has been seen
   * unchanged for `confirmMs`; null before that, and when the market went to a person.
   */
  function confirmed(market: RegistryMarket, info: ContractInfo | null, started: number): Sighting | null {
    const { symbol } = market;
    if (info !== null) {
      try {
        registry.updateContract(info, now());
      } catch {
        // Display data only; the registry keeps what it had.
      }
      if (!VENUE_STATUSES.includes(info.status)) {
        review(symbol, `unknown venue status: ${info.status}`);
        return null;
      }
    }
    const settledAtVenue = info !== null && info.status === "settled";
    const side = settledAtVenue ? info.resolutionSide : null;
    if (side === null) {
      // A resolution that is gone again was a stale read: the wait starts afresh with the next one.
      sightings.delete(symbol);
      if (settledAtVenue) review(symbol, "settled at the venue without a yes or no resolution");
      else if (now() - market.expiresAt >= reviewAfterMs) review(symbol, `no resolution ${Math.floor(reviewAfterMs / 1_000)} s after expiry`);
      return null;
    }
    // Resolved before its expiry: from here on the market is looked at on every tick.
    if (market.settleState === "open" && started < market.expiresAt) registry.setSettle(symbol, "awaiting_result");

    let seen = sightings.get(symbol);
    if (seen === undefined || seen.side !== side) {
      if (seen !== undefined) raise("resolution_changed", symbol, `${seen.side} -> ${side}`);
      seen = { side, at: now() };
      sightings.set(symbol, seen);
    }
    return now() - seen.at < confirmMs ? null : seen;
  }

  /** Acts on a confirmed resolution: settles the market on-chain when the venue paid what the supplies imply. */
  async function settle(market: RegistryMarket, seen: Sighting): Promise<void> {
    const { symbol } = market;
    const { side } = seen;
    // The supplies are final only when no order was in flight before they are read, so check the
    // journal again and then read the market afresh.
    if (hasUnresolvedOrders(symbol)) return;
    const final = await chain.market(symbol);
    if (final === null || final.status === "settled") return; // the next tick sorts it out

    if (final.yesSupply === 0n && final.noSupply === 0n) {
      sightings.delete(symbol);
      registry.setSettle(symbol, "unused");
      return;
    }

    const net = final.yesSupply - final.noSupply + journal.houseInventoryUnits(symbol);
    const winningUnits = side === "yes" ? net : -net;
    const expected = winningUnits > 0n ? winningUnits * PAYOUT_PER_UNIT : 0n;
    // No settled row counts as nothing paid, which is right when nothing is expected.
    const paid = (await venue.settledPayoutMicros(symbol)) ?? 0n;
    // A shortfall can be a row that is not published yet: look again on later ticks. Too much is
    // never a matter of waiting.
    if (paid < expected && now() - seen.at < payoutGraceMs) return;
    if (paid !== expected) {
      const detail = `venue paid ${paid} micro-dollars, expected ${expected}`;
      sightings.delete(symbol);
      registry.setSettle(symbol, "needs_review", { detail });
      raise("payout_mismatch", symbol, detail);
      return;
    }

    let signature: string;
    try {
      signature = await chain.settleMarket(symbol, side === "yes" ? PAYOUT_PER_UNIT : 0n, side === "yes" ? 0n : PAYOUT_PER_UNIT);
    } catch (error) {
      raise("settle_failed", symbol, messageOf(error));
      return;
    }
    sightings.delete(symbol);
    registry.setSettle(symbol, "settled", { signature });
  }

  /**
   * The due markets of one event. Each is read from the chain; those that then need the venue's
   * word are asked about together, so that the adapter answers them from one read of the event.
   */
  async function advanceEvent(markets: RegistryMarket[], started: number, left: { venueReads: number }): Promise<void> {
    const done = (market: RegistryMarket): void => {
      lookedAt.set(market.symbol, started);
    };
    // One market's trouble must not hold up the others; it is retried at its next turn.
    const failed = (market: RegistryMarket, error: unknown): void => {
      raise("settlement_error", market.symbol, messageOf(error));
      done(market);
    };

    const asking: RegistryMarket[] = [];
    for (const market of markets) {
      try {
        if (await needsVenue(market, started)) asking.push(market);
        else done(market);
      } catch (error) {
        failed(market, error);
      }
    }
    if (asking.length === 0) return;

    left.venueReads -= 1;
    const answers = await Promise.allSettled(asking.map((market) => venue.contract(market.symbol)));
    for (const [i, market] of asking.entries()) {
      try {
        const answer = answers[i]!;
        if (answer.status === "rejected") throw answer.reason;
        const seen = confirmed(market, answer.value, started);
        if (seen !== null) {
          // Settling reads the payout. With no read left the market keeps its place and goes first in the next tick.
          if (left.venueReads === 0) continue;
          left.venueReads -= 1;
          await settle(market, seen);
        }
        done(market);
      } catch (error) {
        failed(market, error);
      }
    }
  }

  return {
    async tick() {
      const started = now();
      const unsettled = registry.onchainUnsettled();
      const watched = new Set(unsettled.map((market) => market.symbol));
      for (const symbol of lookedAt.keys()) if (!watched.has(symbol)) lookedAt.delete(symbol);

      // Due on every tick once the market has expired or a resolution was seen, every `sweepMs`
      // before. The markets that have been due the longest are taken up, event by event, until
      // the venue reads of the tick are spent; the others keep their place for the next tick.
      const dueAt = (market: RegistryMarket): number =>
        (lookedAt.get(market.symbol) ?? 0) + (market.expiresAt <= started || market.settleState === "awaiting_result" ? 0 : sweepMs);
      const due = unsettled
        .filter((market) => dueAt(market) <= started)
        .sort((a, b) => dueAt(a) - dueAt(b))
        .slice(0, marketsPerTick);
      const byEvent = new Map<string, RegistryMarket[]>();
      for (const market of due) {
        const siblings = byEvent.get(market.eventTicker);
        if (siblings === undefined) byEvent.set(market.eventTicker, [market]);
        else siblings.push(market);
      }
      const left = { venueReads: venueReadsPerTick };
      for (const markets of byEvent.values()) {
        if (left.venueReads === 0) break;
        await advanceEvent(markets, started, left);
      }
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
