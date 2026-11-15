import { fixturesMode } from "@/lib/config.server";
import { FIXTURE_CHAIN_COOKIE, FIXTURE_RELAYER_COOKIE, FIXTURE_WALLET_COOKIE, fixtureSwitches } from "@/lib/relayer/proxy";

export const dynamic = "force-dynamic";

/**
 * Turns the switches of fixtures mode on and off for this browser, as cookies: `?relayer=offline`
 * makes the relayer proxy answer as an unreachable relayer, `?chain=failing` makes every chain
 * read answer HTTP 429, and `?wallet=new` leaves a wallet unregistered until it asks for test
 * funds; `?relayer=online`, `?chain=ok` and `?wallet=registered` undo them. Answers with the
 * switches as they now stand. Exists only in fixtures mode.
 */
export function GET(request: Request): Response {
  if (!fixturesMode()) return Response.json({ error: "not_found" }, { status: 404 });
  const query = new URL(request.url).searchParams;
  const now = fixtureSwitches(request.headers.get("cookie"));
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  /** Sets or clears one cookie when the query names its switch, and gives the switch as it now stands. */
  const turn = (name: string, param: string, on: string, was: boolean): boolean => {
    const value = query.get(param);
    if (value === null) return was;
    headers.append("set-cookie", value === on ? `${name}=${on}; Path=/; SameSite=Lax` : `${name}=; Path=/; Max-Age=0; SameSite=Lax`);
    return value === on;
  };
  const body = {
    relayerOffline: turn(FIXTURE_RELAYER_COOKIE, "relayer", "offline", now.relayerOffline),
    chainFailing: turn(FIXTURE_CHAIN_COOKIE, "chain", "failing", now.chainFailing),
    newWallet: turn(FIXTURE_WALLET_COOKIE, "wallet", "new", now.newWallet),
  };
  return new Response(JSON.stringify(body), { headers });
}
