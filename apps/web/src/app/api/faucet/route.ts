import { onboardDeps } from "@/server/deps";
import { handleFaucet } from "@/server/onboard";

export const dynamic = "force-dynamic";

/** Tops up a registered trader whose test-dollar or SOL balance is low. */
export function POST(request: Request): Promise<Response> {
  return handleFaucet(request, onboardDeps);
}
