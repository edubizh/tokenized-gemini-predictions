// Settlement watcher: after a market expires, waits for the venue's resolution, checks that the
// venue paid what the outstanding tokens imply, and only then settles the market on-chain.

import type { MarketChain } from "./chain/chain.ts";
import type { Journal } from "./journal.ts";
import { PAYOUT_PER_UNIT } from "./money.ts";
import type { Registry, RegistryMarket } from "./registry.ts";
import type { Venue } from "./venue/venue.ts";

export interface SettlementOptions {
  venue: Venue;
  chain: MarketChain;
  registry: Registry;
  journal: Journal;
  /** How long a resolution must be seen unchanged before it is acted on. */
  confirmMs: number;
  /** A market still unresolved this long after expiry is handed to a person. */
  reviewAfterMs: number;
  /** Unix milliseconds. */
  now(): number;
  alert(event: { kind: string; orderAddress: string | null; detail: string }): void;
}

export const DEFAULT_SETTLEMENT_OPTIONS = { confirmMs: 20_000, reviewAfterMs: 600_000 } as const;

export type SettlementInput = Omit<SettlementOptions, keyof typeof DEFAULT_SETTLEMENT_OPTIONS> &
  Partial<Pick<SettlementOptions, keyof typeof DEFAULT_SETTLEMENT_OPTIONS>>;

export function createSettlementWatcher(input: SettlementInput): { tick(): Promise<void> } {
  const { venue, chain, registry, journal, now, alert } = input;
  const confirmMs = input.confirmMs ?? DEFAULT_SETTLEMENT_OPTIONS.confirmMs;
  const reviewAfterMs = input.reviewAfterMs ?? DEFAULT_SETTLEMENT_OPTIONS.reviewAfterMs;
  /** The resolution last seen per symbol and when it was first seen. Lost on restart, by design. */
  const sightings = new Map<string, { side: "yes" | "no"; at: number }>();

  const raise = (kind: string, symbol: string, detail: string): void => alert({ kind, orderAddress: null, detail: `${symbol}: ${detail}` });

  /** Leaves the market to a person: it drops out of the unsettled list, so this happens once. */
  function review(symbol: string, detail: string): void {
    sightings.delete(symbol);
    registry.setSettle(symbol, "needs_review", { detail });
    raise("needs_review", symbol, detail);
  }

  const hasUnresolvedOrders = (symbol: string): boolean => journal.unresolved().some((row) => row.symbol === symbol);

  async function advance(market: RegistryMarket): Promise<void> {
    const { symbol } = market;
    if (market.settleState === "open") registry.setSettle(symbol, "awaiting_result");

    const onchain = await chain.market(symbol);
    if (onchain === null) return review(symbol, "on-chain market account not found");
    if (onchain.status === "settled") {
      sightings.delete(symbol);
      registry.setSettle(symbol, "settled");
      return;
    }

    // An order still in flight can change the supplies and the venue position.
    if (hasUnresolvedOrders(symbol)) return;

    const info = await venue.contract(symbol);
    if (info !== null) {
      try {
        registry.upsertContract(info, now());
      } catch {
        // Display data only; the registry keeps what it had.
      }
    }
    const settledAtVenue = info !== null && info.status === "settled";
    const side = settledAtVenue ? info.resolutionSide : null;
    if (side === null) {
      sightings.delete(symbol);
      if (settledAtVenue) return review(symbol, "settled at the venue without a yes or no resolution");
      if (now() - market.expiresAt >= reviewAfterMs) return review(symbol, `no resolution ${Math.floor(reviewAfterMs / 1_000)} s after expiry`);
      return;
    }

    const seen = sightings.get(symbol);
    if (seen === undefined || seen.side !== side) {
      sightings.set(symbol, { side, at: now() });
      if (seen !== undefined) raise("resolution_changed", symbol, `${seen.side} -> ${side}`);
    }
    if (now() - (sightings.get(symbol)?.at ?? now()) < confirmMs) return;

    // Confirmed. The supplies are final only when no order was in flight before they are read,
    // so check the journal again and then read the market afresh.
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
    const paid = (await venue.settledPayoutMicros(symbol)) ?? 0n;
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

  return {
    async tick() {
      const started = now();
      for (const market of registry.onchainUnsettled()) {
        if (!(market.expiresAt <= started)) continue;
        try {
          await advance(market);
        } catch (error) {
          // One market's trouble must not hold up the others; it is retried on the next tick.
          raise("settlement_error", market.symbol, messageOf(error));
        }
      }
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
