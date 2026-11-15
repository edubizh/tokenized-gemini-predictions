// Request handling for the relayer proxy, separated from the relayer and the login provider so
// the rules can be tested on their own.

import { matchRoute, type RelayerRoute } from "@/lib/relayer/proxy";
import { AuthError } from "./auth-error";

export interface RelayerProxyDeps {
  /** Throws `AuthError` unless the request carries a valid login token. */
  verify(request: Request): Promise<unknown>;
  /** The relayer's answer for an allowed route. */
  answer(route: RelayerRoute): Promise<Response>;
}

/**
 * Only the routes of the allow-list pass. Creating a market on-chain costs the relayer rent, so
 * that one passes only for a logged-in user.
 *
 * @param path the path after `/api/relayer/`, in segments
 */
export async function handleRelayer(request: Request, path: readonly string[], deps: RelayerProxyDeps): Promise<Response> {
  const route = matchRoute(request.method, path, new URL(request.url).search);
  if (!route) return Response.json({ error: "not_found" }, { status: 404 });

  if (route.kind === "ensure") {
    try {
      await deps.verify(request);
    } catch (error) {
      if (error instanceof AuthError) return Response.json({ error: "unauthorized" }, { status: 401 });
      throw error;
    }
  }
  return deps.answer(route);
}
