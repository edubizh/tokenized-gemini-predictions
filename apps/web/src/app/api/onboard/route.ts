import { fixturesMode } from "@/lib/config.server";
import { fixtureWorld } from "@/lib/fixtures/world";
import { fixtureSwitches } from "@/lib/relayer/proxy";
import { onboardDeps } from "@/server/deps";
import { handleOnboard } from "@/server/onboard";

export const dynamic = "force-dynamic";

/** Registers the caller's wallet as a trader and sends starter funds, once per wallet. */
export function POST(request: Request): Promise<Response> {
  // Fixtures mode: the login is verified as always, and the simulated registrar stands in for Solana.
  if (fixturesMode()) {
    const { newWallet } = fixtureSwitches(request.headers.get("cookie"));
    return handleOnboard(request, { ...onboardDeps, chain: () => fixtureWorld().funding(newWallet) });
  }
  return handleOnboard(request, onboardDeps);
}
