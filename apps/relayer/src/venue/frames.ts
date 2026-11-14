export type VenueFrame =
  | { kind: "ack"; id: string; status: number; result?: Record<string, unknown>; error?: { code: number; msg: string } }
  | {
      kind: "orderUpdate";
      orderId: string;
      clientOrderId: string | null;
      /** Upper-cased. */
      symbol: string;
      /** Verbatim; values outside the known set are passed through. */
      status: string;
      outcome: "YES" | "NO" | null;
      quantity: string | null;
      remaining: string | null;
      executed: string | null;
      lastPrice: string | null;
      avgPrice: string | null;
      limitPrice: string | null;
      tradeId: string | null;
      fee: string | null;
      maker: boolean | null;
      reason: string | null;
    }
  | { kind: "positionReport"; rows: Array<{ /** Upper-cased. */ symbol: string; position: string | null }> }
  | { kind: "balanceUpdate"; balances: Array<{ asset: string; free: string; current: string }> }
  | { kind: "contractStatus"; /** Upper-cased. */ symbol: string; from: string; to: string }
  | { kind: "unknown"; value: unknown }
  | { kind: "malformed"; raw: string };

type Frame<K extends VenueFrame["kind"]> = Extract<VenueFrame, { kind: K }>;

/**
 * Classifies one raw WebSocket text frame. Never throws: text that is not JSON comes back as
 * `malformed`, and JSON that is not a recognised frame as `unknown`.
 */
export function parseFrame(raw: string): VenueFrame {
  if (typeof raw !== "string") return { kind: "malformed", raw: "" };
  let value: unknown;
  try {
    value = parseLossless(raw);
  } catch {
    return { kind: "malformed", raw };
  }
  return (isRecord(value) ? classify(value) : null) ?? { kind: "unknown", value };
}

function classify(frame: Record<string, unknown>): VenueFrame | null {
  const acknowledgement = ack(frame);
  if (acknowledgement !== null) return acknowledgement;
  switch (frame.e) {
    case "orderUpdate":
      return orderUpdate(frame);
    case "positionReport":
      return positionReport(frame);
    case "balanceUpdate":
      return balanceUpdate(frame);
    case "contractStatus":
      return contractStatus(frame);
    default:
      return null;
  }
}

function ack(frame: Record<string, unknown>): Frame<"ack"> | null {
  const { id, status, result, error } = frame;
  if ((typeof id !== "string" && typeof id !== "number") || typeof status !== "number") return null;
  const ack: Frame<"ack"> = { kind: "ack", id: String(id), status };
  if (isRecord(result)) ack.result = result;
  if (isRecord(error) && typeof error.code === "number" && typeof error.msg === "string") {
    ack.error = { code: error.code, msg: error.msg };
  }
  return ack;
}

/** Wire keys of the id, decimal and free-text fields of an order update. */
const ORDER_UPDATE_TEXT = {
  orderId: "i",
  clientOrderId: "c",
  quantity: "q",
  remaining: "z",
  executed: "Z",
  lastPrice: "L",
  avgPrice: "a",
  limitPrice: "p",
  tradeId: "t",
  fee: "n",
  reason: "r",
} as const;

function orderUpdate(frame: Record<string, unknown>): Frame<"orderUpdate"> | null {
  const { s: symbol, X: status } = frame;
  if (typeof symbol !== "string" || typeof status !== "string") return null;
  const fields = readText(frame, ORDER_UPDATE_TEXT);
  if (fields === null || fields.orderId === null) return null;
  return {
    kind: "orderUpdate",
    ...fields,
    orderId: fields.orderId,
    symbol: symbol.toUpperCase(),
    status,
    outcome: outcome(frame.O),
    maker: typeof frame.m === "boolean" ? frame.m : null,
  };
}

function outcome(value: unknown): "YES" | "NO" | null {
  if (typeof value !== "string") return null;
  const upper = value.toUpperCase();
  return upper === "YES" || upper === "NO" ? upper : null;
}

function positionReport(frame: Record<string, unknown>): Frame<"positionReport"> | null {
  if (!Array.isArray(frame.P)) return null;
  const rows: Frame<"positionReport">["rows"] = [];
  for (const row of frame.P) {
    if (!isRecord(row) || typeof row.s !== "string") continue;
    rows.push({ symbol: row.s.toUpperCase(), position: positionOf(row.a) });
  }
  return { kind: "positionReport", rows };
}

/** The value of the entry tagged "position"; a row may carry other entries, or none. */
function positionOf(entries: unknown): string | null {
  if (!Array.isArray(entries)) return null;
  const entry: unknown = entries.find((candidate) => isRecord(candidate) && candidate.t === "position");
  return isRecord(entry) ? (text(entry.v) ?? null) : null;
}

function balanceUpdate(frame: Record<string, unknown>): Frame<"balanceUpdate"> | null {
  if (!Array.isArray(frame.B)) return null;
  const balances: Frame<"balanceUpdate">["balances"] = [];
  for (const entry of frame.B) {
    if (!isRecord(entry) || typeof entry.a !== "string") continue;
    const free = text(entry.f);
    const current = text(entry.c);
    if (typeof free !== "string" || typeof current !== "string") continue;
    balances.push({ asset: entry.a, free, current });
  }
  return { kind: "balanceUpdate", balances };
}

function contractStatus(frame: Record<string, unknown>): Frame<"contractStatus"> | null {
  const { s: symbol, o: from, n: to } = frame;
  if (typeof symbol !== "string" || typeof from !== "string" || typeof to !== "string") return null;
  return { kind: "contractStatus", symbol: symbol.toUpperCase(), from, to };
}

/** Reads the listed fields as text, or returns null when any of them has an unusable JSON type. */
function readText<K extends string>(
  frame: Record<string, unknown>,
  wireKeys: Readonly<Record<K, string>>,
): Record<K, string | null> | null {
  const fields = {} as Record<K, string | null>;
  for (const name of Object.keys(wireKeys) as K[]) {
    const value = text(frame[wireKeys[name]]);
    if (value === undefined) return null;
    fields[name] = value;
  }
  return fields;
}

/**
 * A scalar field as text: null when absent, undefined when its JSON type cannot be used. Ids and
 * decimals normally arrive as strings (long integers are strings already); an id short enough
 * for a Number arrives as one.
 */
function text(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Number.isSafeInteger(value) || !Number.isInteger(value) ? String(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LONG_INTEGER = /^-?\d{16,}$/;

/**
 * JSON.parse that returns integer literals of 16 or more digits as strings: venue order ids have
 * 18 digits and do not fit a Number. Relies on the reviver receiving the source text of each
 * number, and throws rather than rounding when the runtime does not provide it.
 */
function parseLossless(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== "number") return value;
    const source = context?.source;
    if (source === undefined) throw new Error("JSON.parse did not provide the source text of a number");
    return LONG_INTEGER.test(source) ? source : value;
  });
}
