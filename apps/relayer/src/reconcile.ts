// Reconciliation: compares the venue account's position in each unsettled on-chain market with
// what the token supplies, in-flight fills and orphaned fills imply, and checks that the treasury
// could fund the worst case of those markets. Every contract stands alone, the strikes of one
// ladder included: several of them can pay, so nothing nets across them.

import type { ApiReconcileMarket, ApiStatus } from "./api/types.ts";
import type { MarketChain } from "./chain/chain.ts";
import type { Journal, JournalOrder } from "./journal.ts";
import { PAYOUT_PER_UNIT } from "./money.ts";
import type { Registry } from "./registry.ts";
import type { Venue } from "./venue/venue.ts";

export interface ReconcileDeps {
  venue: Venue;
  chain: MarketChain;
  registry: Registry;
  journal: Journal;
}

export type ReconcileResult = Pick<ApiStatus, "markets" | "solvency">;

/** Consecutive unbalanced runs of one market that trigger the automatic pause. */
export const UNBALANCED_RUNS_TO_PAUSE = 3;

/** Signed units the venue account gained from the row's fill. The venue only ever buys: a buy
 *  holds the order's own side, a sell holds the opposite one. YES is positive. */
function signedFilledUnits(row: JournalOrder): bigint {
  const venueBoughtYes = (row.kind === "buy") === (row.side === "YES");
  return venueBoughtYes ? row.filledUnits : -row.filledUnits;
}

export async function reconcile({ venue, chain, registry, journal }: ReconcileDeps): Promise<ReconcileResult> {
  // Not settled: still trading, awaiting a result, or held for review. Unused markets have no supply.
  const candidates = [...registry.onchainUnsettled(), ...registry.onchainUnderReview()];
  // One read for the whole run. A contract the account is flat in has no row.
  const positions = await venue.positions();
  const markets: ApiReconcileMarket[] = [];
  let requiredMicros = 0n;
  for (const { symbol } of candidates) {
    const onchain = await chain.market(symbol);
    if (onchain === null || onchain.status === "settled") continue;
    const venueNet = positions.get(symbol) ?? 0n;
    const inFlight = journal
      .byState("venue_filled")
      .filter((row) => row.symbol === symbol)
      .reduce((sum, row) => sum + signedFilledUnits(row), 0n);
    const houseInventory = journal.houseInventoryUnits(symbol);
    markets.push({
      symbol,
      yesSupply: onchain.yesSupply.toString(),
      noSupply: onchain.noSupply.toString(),
      venueNet: venueNet.toString(),
      inFlight: inFlight.toString(),
      houseInventory: houseInventory.toString(),
      balanced: venueNet === onchain.yesSupply - onchain.noSupply + inFlight + houseInventory,
    });
    // Only one side can win: the most the treasury could have to fund is the larger supply.
    const largerSupply = onchain.yesSupply > onchain.noSupply ? onchain.yesSupply : onchain.noSupply;
    requiredMicros += largerSupply * PAYOUT_PER_UNIT;
  }

  const venueCashMicros = await venue.cashMicros();
  const treasuryMicros = await chain.treasuryMicros();
  return {
    markets,
    solvency: {
      venueCashMicros: venueCashMicros.toString(),
      treasuryMicros: treasuryMicros.toString(),
      requiredMicros: requiredMicros.toString(),
      ok: treasuryMicros >= requiredMicros,
    },
  };
}

export interface ReconcilerDeps extends ReconcileDeps {
  alert(event: { kind: string; orderAddress: string | null; detail: string }): void;
}

export interface Reconciler {
  /** Reconciles, remembers the result, and pauses order placement when the books do not add up. */
  run(): Promise<ReconcileResult>;
  /** The result of the last completed run. */
  last(): ReconcileResult | null;
}

/**
 * Pauses placement (`chain.pause({ place: true })`) and alerts `auto_paused` when one market is
 * unbalanced `UNBALANCED_RUNS_TO_PAUSE` runs in a row or the treasury cannot cover the open
 * markets. One pause per episode: it is not repeated until a run comes back clean.
 */
export function createReconciler(deps: ReconcilerDeps): Reconciler {
  const unbalancedRuns = new Map<string, number>();
  let lastResult: ReconcileResult | null = null;
  let tripped = false;

  return {
    async run() {
      const result = await reconcile(deps);
      lastResult = result;

      const reported = new Set(result.markets.map((market) => market.symbol));
      for (const symbol of [...unbalancedRuns.keys()]) {
        if (!reported.has(symbol)) unbalancedRuns.delete(symbol);
      }
      for (const market of result.markets) {
        if (market.balanced) unbalancedRuns.delete(market.symbol);
        else unbalancedRuns.set(market.symbol, (unbalancedRuns.get(market.symbol) ?? 0) + 1);
      }

      const stuck = [...unbalancedRuns].filter(([, runs]) => runs >= UNBALANCED_RUNS_TO_PAUSE).map(([symbol]) => symbol);
      const reasons: string[] = [];
      if (stuck.length > 0) reasons.push(`unbalanced for ${UNBALANCED_RUNS_TO_PAUSE} runs: ${stuck.join(", ")}`);
      if (!result.solvency.ok) {
        reasons.push(
          `treasury ${result.solvency.treasuryMicros} micro-dollars is below the ${result.solvency.requiredMicros} the open markets could require`,
        );
      }
      if (reasons.length === 0) {
        tripped = false;
      } else if (!tripped) {
        await deps.chain.pause({ place: true });
        tripped = true;
        deps.alert({ kind: "auto_paused", orderAddress: null, detail: reasons.join("; ") });
      }
      return result;
    },

    last() {
      return lastResult;
    },
  };
}
