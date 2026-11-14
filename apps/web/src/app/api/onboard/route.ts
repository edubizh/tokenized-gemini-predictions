import { onboardDeps } from "@/server/deps";
import { handleOnboard } from "@/server/onboard";

export const dynamic = "force-dynamic";

/** Registers the caller's wallet as a trader and sends starter funds, once per wallet. */
export function POST(request: Request): Promise<Response> {
  return handleOnboard(request, onboardDeps);
}
