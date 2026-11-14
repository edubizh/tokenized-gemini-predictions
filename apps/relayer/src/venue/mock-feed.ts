// A mock venue that behaves like a live one for offline demos: it always lists one test contract
// per series for the current time window, moves their prices a little, closes them at expiry,
// resolves them a few seconds later and lists the next window. No network, no API key.

import { takerFee } from "../money.ts";
import { MockVenue } from "./mock.ts";
import type { VenueOrderRequest, VenueOrderResult } from "./types.ts";
import type { ContractInfo } from "./venue.ts";

export const MOCK_SERIES = ["BTC15M", "ETH15M", "SOL15M"] as const;
export const MOCK_WINDOW_SECS_DEFAULT = 900;
export const MOCK_WINDOW_SECS_MIN = 180;

export type MockResolve = "yes" | "no" | "random";

export interface RollingMockVenueOptions {
  /** Length of every contract, in seconds. Windows are aligned to the clock. */
  windowSecs: number;
  /** How contracts resolve. */
  resolve: MockResolve;
  /** Unix milliseconds. */
  now(): number;
  /** Uniform in [0, 1). Default `Math.random`. */
  random?: () => number;
  /** Time between expiry and resolution. Default 5 s. */
  resolveDelayMs?: number;
  /** Starting cash of the account in micro-dollars. Default one million dollars. */
  cashMicros?: bigint;
}

const TICK_PX = 100n;
const START_MID_PX = 5_000n;
const MIN_MID_PX = 1_000n;
const MAX_MID_PX = 9_000n;
/** Each side is quoted this far from the middle. */
const HALF_SPREAD_PX = 200n;
const LEVEL_UNITS = 20_000n;
/** Reference prices in cents, for display only. */
const BASE_STRIKE_CENTS: Record<string, bigint> = { BTC: 6_400_000n, ETH: 300_000n, SOL: 15_000n };

interface Tracked {
  info: ContractInfo;
  midPx: bigint;
  closed: boolean;
}

export class RollingMockVenue extends MockVenue {
  private readonly windowMs: number;
  private readonly resolveMode: MockResolve;
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly resolveDelayMs: number;
  /** Contracts that are not resolved yet, oldest first. */
  private readonly tracked = new Map<string, Tracked>();
  private seededEndMs = 0;

  constructor(options: RollingMockVenueOptions) {
    super({ feeFor: takerFee });
    if (!Number.isInteger(options.windowSecs) || options.windowSecs < MOCK_WINDOW_SECS_MIN) {
      throw new RangeError(`mock contract length must be a whole number of seconds, at least ${MOCK_WINDOW_SECS_MIN}`);
    }
    this.windowMs = options.windowSecs * 1_000;
    this.resolveMode = options.resolve;
    this.clock = options.now;
    this.random = options.random ?? Math.random;
    this.resolveDelayMs = options.resolveDelayMs ?? 5_000;
    this.setCash(options.cashMicros ?? 1_000_000_000_000n);
  }

  /**
   * Takes over a contract an earlier run listed, with the position the account held in it, so
   * that it resolves and pays like any other. With `resolution` it resolves at once, that way.
   */
  adopt(info: ContractInfo, signedUnits: bigint, resolution?: "yes" | "no"): void {
    const adopted: ContractInfo = { ...info, status: "active", resolutionSide: null };
    this.addContract(adopted);
    this.setPosition(info.symbol, signedUnits);
    const entry: Tracked = { info: adopted, midPx: START_MID_PX, closed: false };
    if (resolution !== undefined) this.settle(entry, resolution);
    else this.tracked.set(info.symbol, entry);
  }

  /** Brings the contracts up to date with the clock: close, resolve, list the current window. */
  roll(): void {
    const now = this.clock();
    for (const entry of [...this.tracked.values()]) {
      const expiresAt = entry.info.expiresAt.getTime();
      if (!entry.closed && now >= expiresAt) {
        entry.closed = true;
        entry.info = { ...entry.info, marketState: "closed" };
        this.addContract(entry.info);
        this.setBook(entry.info.symbol, { bids: [], asks: [] });
      }
      if (now >= expiresAt + this.resolveDelayMs) {
        const side = this.resolveMode === "random" ? (this.random() < 0.5 ? "yes" : "no") : this.resolveMode;
        this.settle(entry, side);
      }
    }

    const endMs = (Math.floor(now / this.windowMs) + 1) * this.windowMs;
    if (endMs === this.seededEndMs) return;
    this.seededEndMs = endMs;
    for (const series of MOCK_SERIES) {
      const entry: Tracked = { info: this.newContract(series, endMs), midPx: START_MID_PX, closed: false };
      this.tracked.set(entry.info.symbol, entry);
      this.addContract(entry.info);
      this.quote(entry);
    }
  }

  override async listContracts(): Promise<ContractInfo[]> {
    this.roll();
    for (const entry of this.tracked.values()) {
      if (entry.closed) continue;
      // Two ticks down to two ticks up.
      const moved = entry.midPx + BigInt(Math.floor(this.random() * 5) - 2) * TICK_PX;
      entry.midPx = moved < MIN_MID_PX ? MIN_MID_PX : moved > MAX_MID_PX ? MAX_MID_PX : moved;
      this.quote(entry);
    }
    return super.listContracts();
  }

  override async contract(symbol: string): Promise<ContractInfo | null> {
    this.roll();
    return super.contract(symbol);
  }

  override async placeOrder(request: VenueOrderRequest): Promise<VenueOrderResult> {
    this.roll();
    return super.placeOrder(request);
  }

  private quote(entry: Tracked): void {
    this.setBook(entry.info.symbol, {
      bids: [[entry.midPx - HALF_SPREAD_PX, LEVEL_UNITS]],
      asks: [[entry.midPx + HALF_SPREAD_PX, LEVEL_UNITS]],
    });
  }

  private settle(entry: Tracked, side: "yes" | "no"): void {
    const { info } = entry;
    this.tracked.delete(info.symbol);
    const strikeCents = info.strike == null ? null : toCents(info.strike);
    const settlementValue =
      strikeCents === null ? null : fromCents(strikeCents + (side === "yes" ? 1n : -1n) * max(strikeCents / 2_000n, 1n));
    this.addContract({ ...info, settlementValue });
    this.resolve(info.symbol, side);
  }

  private newContract(series: string, endMs: number): ContractInfo {
    const end = new Date(endMs);
    const two = (value: number): string => String(value).padStart(2, "0");
    const stamp = `${two(end.getUTCFullYear() % 100)}${two(end.getUTCMonth() + 1)}${two(end.getUTCDate())}${two(end.getUTCHours())}${two(end.getUTCMinutes())}`;
    const underlying = series.replace(/\d+[A-Z]+$/, "");
    const base = BASE_STRIKE_CENTS[underlying] ?? 10_000n;
    // Within one percent of the base, different for every window.
    const strikeCents = base + (BigInt(Math.floor(endMs / 60_000) % 201) - 100n) * (base / 10_000n);
    return {
      symbol: `TEST-${series}${stamp}-UP`,
      eventTicker: `${series}${stamp}`,
      status: "active",
      marketState: "open",
      effectiveAt: new Date(endMs - this.windowMs),
      expiresAt: end,
      tickPx: TICK_PX,
      unitIncrement: 1n,
      minUnits: 1n,
      resolutionSide: null,
      title: `${underlying} price up at ${two(end.getUTCHours())}:${two(end.getUTCMinutes())} UTC? (test)`,
      label: "Up",
      series,
      strike: fromCents(strikeCents),
      settlementValue: null,
    };
  }
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function fromCents(cents: bigint): string {
  const digits = cents.toString().padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** Dollars as printed, to cents; null when the text is not a plain amount. */
function toCents(dollars: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?\d*$/.exec(dollars);
  if (match === null) return null;
  return BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
}
