// Allow-list for the relayer proxy. The browser can reach exactly these routes and nothing else.

const TICKER = /^[A-Z0-9]{1,32}$/;
const SYMBOL = /^[A-Z0-9-]{1,64}$/;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** What can be read about one contract beyond the contract itself. */
const MARKET_READS = ["depth", "trades", "history"] as const;

export type RelayerRoute =
  | { kind: "health" | "status" | "events" | "markets"; upstream: string }
  | { kind: "event"; ticker: string; upstream: string }
  | { kind: "market" | "ensure" | (typeof MARKET_READS)[number]; symbol: string; upstream: string }
  | { kind: "orders"; user: string; upstream: string }
  | { kind: "order"; address: string; upstream: string };

/**
 * @param segments path after `/api/relayer/`
 * @param search the query string, with or without the leading `?`
 * @returns the route with a rebuilt upstream path, or null when the request is not allowed
 */
export function matchRoute(method: string, segments: readonly string[], search: string): RelayerRoute | null {
  const [head, id, action, ...rest] = segments;
  if (rest.length > 0) return null;

  if (method === "POST") {
    if (head === "markets" && id !== undefined && SYMBOL.test(id) && action === "ensure") {
      return { kind: "ensure", symbol: id, upstream: `/markets/${id}/ensure` };
    }
    return null;
  }
  if (method !== "GET") return null;

  if (action !== undefined) {
    const read = MARKET_READS.find((name) => name === action);
    if (head === "markets" && id !== undefined && SYMBOL.test(id) && read) return { kind: read, symbol: id, upstream: `/markets/${id}/${read}` };
    return null;
  }
  if (id === undefined) {
    if (head === "health" || head === "status" || head === "events" || head === "markets") return { kind: head, upstream: `/${head}` };
    if (head === "orders") {
      const user = new URLSearchParams(search).get("user");
      if (user === null || !ADDRESS.test(user)) return null;
      return { kind: "orders", user, upstream: `/orders?user=${user}` };
    }
    return null;
  }
  if (head === "events" && TICKER.test(id)) return { kind: "event", ticker: id, upstream: `/events/${id}` };
  if (head === "markets" && SYMBOL.test(id)) return { kind: "market", symbol: id, upstream: `/markets/${id}` };
  if (head === "orders" && ADDRESS.test(id)) return { kind: "order", address: id, upstream: `/orders/${id}` };
  return null;
}

/** Cookies that drive the states of fixtures mode that do not come about by themselves. */
export const FIXTURE_RELAYER_COOKIE = "fixtures-relayer";
export const FIXTURE_CHAIN_COOKIE = "fixtures-chain";
export const FIXTURE_WALLET_COOKIE = "fixtures-wallet";

export interface FixtureSwitches {
  /** The proxy answers as it does when the relayer cannot be reached. */
  relayerOffline: boolean;
  /** Chain reads answer HTTP 429, as a rate-limited RPC endpoint does. */
  chainFailing: boolean;
  /** A wallet is not a registered trader until it has asked for test funds. */
  newWallet: boolean;
}

/** Reads the switches from a request's `cookie` header. Honoured in fixtures mode only. */
export function fixtureSwitches(cookieHeader: string | null): FixtureSwitches {
  const cookies = new Map<string, string>();
  for (const part of (cookieHeader ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) cookies.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return {
    relayerOffline: cookies.get(FIXTURE_RELAYER_COOKIE) === "offline",
    chainFailing: cookies.get(FIXTURE_CHAIN_COOKIE) === "failing",
    newWallet: cookies.get(FIXTURE_WALLET_COOKIE) === "new",
  };
}
