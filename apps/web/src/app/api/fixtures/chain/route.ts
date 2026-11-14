import { fixturesMode } from "@/lib/config.server";
import { fixtureWorld } from "@/lib/fixtures/world";

export const dynamic = "force-dynamic";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The simulated chain's view of one wallet. Exists only in fixtures mode. */
export function GET(request: Request): Response {
  if (!fixturesMode()) return Response.json({ error: "not_found" }, { status: 404 });
  const wallet = new URL(request.url).searchParams.get("wallet");
  if (wallet === null || !ADDRESS.test(wallet)) return Response.json({ error: "bad_request" }, { status: 400 });
  return Response.json(fixtureWorld().chain(wallet, Date.now()));
}
