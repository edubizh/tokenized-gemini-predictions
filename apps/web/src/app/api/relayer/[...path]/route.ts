import { fixtureResponse } from "@/lib/relayer/fixtures";
import { matchRoute } from "@/lib/relayer/proxy";

export const dynamic = "force-dynamic";

const DEFAULT_RELAYER_URL = "http://127.0.0.1:8787";
const UPSTREAM_TIMEOUT_MS = 8_000;
/** Fixture times are offsets from an anchor that moves every five minutes, so countdowns run. */
const FIXTURE_CYCLE_MS = 5 * 60 * 1000;

type Context = { params: Promise<{ path: string[] }> };

async function proxy(request: Request, context: Context): Promise<Response> {
  const { path } = await context.params;
  const route = matchRoute(request.method, path, new URL(request.url).search);
  if (!route) return Response.json({ error: "not_found" }, { status: 404 });

  const relayerUrl = process.env.RELAYER_URL ?? DEFAULT_RELAYER_URL;
  if (relayerUrl === "fixtures") {
    const now = Date.now();
    const { status, body } = fixtureResponse(route, Math.floor(now / FIXTURE_CYCLE_MS) * FIXTURE_CYCLE_MS, now);
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
