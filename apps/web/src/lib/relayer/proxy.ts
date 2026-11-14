// Allow-list for the relayer proxy. The browser can reach exactly these routes and nothing else.

const SYMBOL = /^[A-Z0-9-]{1,64}$/;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type RelayerRoute =
  | { kind: "health"; upstream: string }
  | { kind: "status"; upstream: string }
  | { kind: "markets"; scope: "live" | "all"; upstream: string }
  | { kind: "market"; symbol: string; upstream: string }
  | { kind: "ensure"; symbol: string; upstream: string }
  | { kind: "orders"; user: string; upstream: string }
  | { kind: "order"; address: string; upstream: string };

/**
 * @param segments path after `/api/relayer/`
 * @param search the query string, with or without the leading `?`
 * @returns the route with a rebuilt upstream path, or null when the request is not allowed
 */
export function matchRoute(method: string, segments: readonly string[], search: string): RelayerRoute | null {
  const query = new URLSearchParams(search);
  const [head, id, action, ...rest] = segments;
  if (rest.length > 0) return null;

  if (method === "POST") {
    if (head === "markets" && id !== undefined && SYMBOL.test(id) && action === "ensure") {
      return { kind: "ensure", symbol: id, upstream: `/markets/${id}/ensure` };
    }
    return null;
  }
  if (method !== "GET" || action !== undefined) return null;

  if (id === undefined) {
    if (head === "health") return { kind: "health", upstream: "/health" };
    if (head === "status") return { kind: "status", upstream: "/status" };
    if (head === "markets") {
      const scope = query.get("scope") ?? "live";
      if (scope !== "live" && scope !== "all") return null;
      return { kind: "markets", scope, upstream: `/markets?scope=${scope}` };
    }
    if (head === "orders") {
      const user = query.get("user");
      if (user === null || !ADDRESS.test(user)) return null;
      return { kind: "orders", user, upstream: `/orders?user=${user}` };
    }
    return null;
  }
  if (head === "markets" && SYMBOL.test(id)) return { kind: "market", symbol: id, upstream: `/markets/${id}` };
  if (head === "orders" && ADDRESS.test(id)) return { kind: "order", address: id, upstream: `/orders/${id}` };
  return null;
}

/** Cookies that make the simulated relayer and chain of fixtures mode fail, to drive those states. */
export const FIXTURE_RELAYER_COOKIE = "fixtures-relayer";
export const FIXTURE_CHAIN_COOKIE = "fixtures-chain";

export interface FixtureSwitches {
  /** The proxy answers as it does when the relayer cannot be reached. */
  relayerOffline: boolean;
  /** Chain reads answer HTTP 429, as a rate-limited RPC endpoint does. */
  chainFailing: boolean;
}

/** Reads the switches from a request's `cookie` header. Honoured in fixtures mode only. */
export function fixtureSwitches(cookieHeader: string | null): FixtureSwitches {
  const cookies = new Map<string, string>();
  for (const part of (cookieHeader ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) cookies.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return { relayerOffline: cookies.get(FIXTURE_RELAYER_COOKIE) === "offline", chainFailing: cookies.get(FIXTURE_CHAIN_COOKIE) === "failing" };
}
