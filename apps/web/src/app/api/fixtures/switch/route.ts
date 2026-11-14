import { fixturesMode } from "@/lib/config.server";
import { FIXTURE_CHAIN_COOKIE, FIXTURE_RELAYER_COOKIE, fixtureSwitches } from "@/lib/relayer/proxy";

export const dynamic = "force-dynamic";

/**
 * Turns the failure switches of fixtures mode on and off for this browser, as cookies:
 * `?relayer=offline` makes the relayer proxy answer as an unreachable relayer, `?chain=failing`
 * makes every chain read answer HTTP 429; `?relayer=online` and `?chain=ok` undo them. Answers
 * with the switches as they now stand. Exists only in fixtures mode.
 */
export function GET(request: Request): Response {
  if (!fixturesMode()) return Response.json({ error: "not_found" }, { status: 404 });
  const query = new URL(request.url).searchParams;
  const now = fixtureSwitches(request.headers.get("cookie"));
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  const set = (name: string, value: string | null, on: string) => {
    if (value === null) return;
    headers.append("set-cookie", value === on ? `${name}=${on}; Path=/; SameSite=Lax` : `${name}=; Path=/; Max-Age=0; SameSite=Lax`);
  };
  const relayer = query.get("relayer");
  const chain = query.get("chain");
  set(FIXTURE_RELAYER_COOKIE, relayer, "offline");
  set(FIXTURE_CHAIN_COOKIE, chain, "failing");
  const body = { relayerOffline: relayer === null ? now.relayerOffline : relayer === "offline", chainFailing: chain === null ? now.chainFailing : chain === "failing" };
  return new Response(JSON.stringify(body), { headers });
}
