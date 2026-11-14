// Venue-facing order types. All prices (`limitPx`, `px`) are in the order's OWN outcome space:
// a NO order's prices are NO prices.

export type Outcome = "YES" | "NO";

export type TimeInForce = "FOK" | "IOC";

export interface VenueOrderRequest {
  clientOrderId: string;
  symbol: string;
  outcome: Outcome;
  units: bigint;
  limitPx: bigint;
  timeInForce: TimeInForce;
}

export interface VenueFill {
  tradeId: string;
  units: bigint;
  px: bigint;
  feeMicros: bigint;
  /** "reported" when the venue stated the fee, "computed" when it came from the fee formula. */
  feeSource: "reported" | "computed";
}

export type VenueOrderResult =
  | {
      kind: "filled";
      venueOrderId: string;
      fills: VenueFill[];
      filledUnits: bigint;
      costMicros: bigint;
      feeMicros: bigint;
    }
  | { kind: "not_filled"; venueOrderId: string | null; reason: string }
  | { kind: "rejected"; code: number | null; message: string }
  | { kind: "unknown"; venueOrderId: string | null; reason: string };
