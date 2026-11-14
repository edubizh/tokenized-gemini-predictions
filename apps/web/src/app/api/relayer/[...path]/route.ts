import { fixturesMode } from "@/lib/config.server";
import { ENSURE_DELAY_MS, fixtureWorld } from "@/lib/fixtures/world";
import { fixtureSwitches, matchRoute } from "@/lib/relayer/proxy";

export const dynamic = "force-dynamic";

const DEFAULT_RELAYER_URL = "http://127.0.0.1:8787";
const UPSTREAM_TIMEOUT_MS = 8_000;

type Context = { params: Promise<{ path: string[] }> };

async function proxy(request: Request, context: Context): Promise<Response> {
  const { path } = await context.params;
  const route = matchRoute(request.method, path, new URL(request.url).search);
  if (!route) return Response.json({ error: "not_found" }, { status: 404 });

  const relayerUrl = process.env.RELAYER_URL ?? DEFAULT_RELAYER_URL;
  if (fixturesMode()) {
    // The switch that drives the offline state of every page: the answer an unreachable relayer gets.
    if (fixtureSwitches(request.headers.get("cookie")).relayerOffline) return Response.json({ error: "relayer_unreachable" }, { status: 502 });
    if (route.kind === "ensure") await new Promise((resolve) => setTimeout(resolve, ENSURE_DELAY_MS));
    const { status, body } = fixtureWorld().respond(route, Date.now());
    return Response.json(body, { status });
  }

  try {
    const upstream = await fetch(`${relayerUrl.replace(/\/$/, "")}${route.upstream}`, {
      method: request.method,
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const body: unknown = await upstream.json();
    return Response.json(body, { status: upstream.status });
  } catch {
    return Response.json({ error: "relayer_unreachable" }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
