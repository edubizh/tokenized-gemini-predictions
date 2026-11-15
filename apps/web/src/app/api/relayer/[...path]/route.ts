import { fixturesMode } from "@/lib/config.server";
import { ENSURE_DELAY_MS, fixtureWorld } from "@/lib/fixtures/world";
import { fixtureSwitches, type RelayerRoute } from "@/lib/relayer/proxy";
import { verifyLogin } from "@/server/privy";
import { handleRelayer } from "@/server/relayer";

export const dynamic = "force-dynamic";

const DEFAULT_RELAYER_URL = "http://127.0.0.1:8787";
const UPSTREAM_TIMEOUT_MS = 8_000;

type Context = { params: Promise<{ path: string[] }> };

const unreachable = () => Response.json({ error: "relayer_unreachable" }, { status: 502 });

/** Fixtures mode: the simulated relayer's answer. */
async function simulated(route: RelayerRoute, request: Request): Promise<Response> {
  // The switch that drives the offline state of every page: the answer an unreachable relayer gets.
  if (fixtureSwitches(request.headers.get("cookie")).relayerOffline) return unreachable();
  if (route.kind === "ensure") await new Promise((resolve) => setTimeout(resolve, ENSURE_DELAY_MS));
  const { status, body } = fixtureWorld().respond(route, Date.now());
  return Response.json(body, { status });
}

async function upstream(route: RelayerRoute, method: string): Promise<Response> {
  const relayerUrl = (process.env.RELAYER_URL ?? DEFAULT_RELAYER_URL).replace(/\/$/, "");
  try {
    const response = await fetch(`${relayerUrl}${route.upstream}`, { method, cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    const body: unknown = await response.json();
    return Response.json(body, { status: response.status });
  } catch {
    return unreachable();
  }
}

async function proxy(request: Request, context: Context): Promise<Response> {
  const { path } = await context.params;
  return handleRelayer(request, path, {
    verify: verifyLogin,
    answer: (route) => (fixturesMode() ? simulated(route, request) : upstream(route, request.method)),
  });
}

export const GET = proxy;
export const POST = proxy;
