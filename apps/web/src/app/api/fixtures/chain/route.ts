import { fixturesMode } from "@/lib/config.server";
import { fixtureWorld } from "@/lib/fixtures/world";
import { fixtureSwitches } from "@/lib/relayer/proxy";

export const dynamic = "force-dynamic";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SYMBOL = /^[A-Z0-9-]{1,64}$/;

function list(value: string | null, pattern: RegExp): string[] {
  return (value ?? "").split(",").filter((item) => pattern.test(item));
}

/**
 * The simulated chain. With `wallet`: that wallet's accounts. With `read=markets`: the market
 * accounts asked for by `mints`, `markets` or `symbols` (comma separated). With `read=clock`: the
 * cluster clock. The `read` parameter otherwise only names what the caller is reading, so
 * requests can be counted by kind. Exists only in fixtures mode.
 */
export function GET(request: Request): Response {
  if (!fixturesMode()) return Response.json({ error: "not_found" }, { status: 404 });
  const switches = fixtureSwitches(request.headers.get("cookie"));
  // The switch that makes every read fail as a rate-limited RPC endpoint does.
  if (switches.chainFailing) return Response.json({ error: "too_many_requests" }, { status: 429 });
  const query = new URL(request.url).searchParams;
  if (query.get("read") === "clock") return Response.json({ chainTime: Math.floor(Date.now() / 1000) });
  if (query.get("read") === "markets") {
    const markets = fixtureWorld().chainMarkets(
      { mints: list(query.get("mints"), ADDRESS), markets: list(query.get("markets"), ADDRESS), symbols: list(query.get("symbols"), SYMBOL) },
      Date.now(),
    );
    return Response.json({ markets });
  }
  const wallet = query.get("wallet");
  if (wallet === null || !ADDRESS.test(wallet)) return Response.json({ error: "bad_request" }, { status: 400 });
  return Response.json(fixtureWorld().chain(wallet, Date.now(), switches.newWallet));
}
