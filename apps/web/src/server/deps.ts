import { loadConfig } from "@/lib/config.server";
import { createRateLimiter, type OnboardDeps } from "./onboard";
import { verifyLogin } from "./privy";
import { createFundingChain } from "./registrar";

/** At most one faucet top-up per wallet per ten minutes, kept in memory. */
const limiter = createRateLimiter(10 * 60 * 1000);

export const onboardDeps: OnboardDeps = {
  config: loadConfig,
  verify: verifyLogin,
  chain: createFundingChain,
  limiter,
};
