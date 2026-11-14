// Request handling for /api/onboard and /api/faucet, separated from the chain and the login
// provider so the rules can be tested on their own.

import type { Deployment, ResolvedConfig } from "@/lib/config.server";
import { AuthError } from "./auth-error";

/** Sent once, in the transaction that registers the wallet. 1,000 dUSD and 0.05 SOL. */
export const STARTER = { stableMicros: 1_000_000_000n, lamports: 50_000_000n } as const;
/** Sent by the faucet to a balance below its floor. 1,000 dUSD and 0.03 SOL. */
export const TOP_UP = { stableMicros: 1_000_000_000n, lamports: 30_000_000n } as const;
/** Below 100 dUSD or 0.01 SOL the faucet tops up. */
export const FLOOR = { stableMicros: 100_000_000n, lamports: 10_000_000n } as const;

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface FundingChain {
  traderExists(wallet: string): Promise<boolean>;
  balances(wallet: string): Promise<{ lamports: bigint; stableMicros: bigint }>;
  /** One transaction: register_trader, create the dUSD account, starter dUSD, starter SOL. */
  registerAndFund(wallet: string): Promise<string>;
  /** One transaction with whichever amounts are non-zero. */
  topUp(wallet: string, amounts: { stableMicros: bigint; lamports: bigint }): Promise<string>;
}

export interface RateLimiter {
  /** Seconds until the key may act again; 0 when it may act now. */
  retryAfterSecs(key: string): number;
  record(key: string): void;
}

export function createRateLimiter(windowMs: number, now: () => number = Date.now): RateLimiter {
  const last = new Map<string, number>();
  return {
    retryAfterSecs(key) {
      const at = last.get(key);
      if (at === undefined) return 0;
      return Math.max(0, Math.ceil((at + windowMs - now()) / 1000));
    },
    record(key) {
      last.set(key, now());
    },
  };
}

export interface OnboardDeps {
  config(): ResolvedConfig;
  /** Throws `AuthError` unless the request carries a valid login token. */
  verify(request: Request): Promise<{ userId: string; wallets: string[] }>;
  chain(deployment: Deployment, rpcUrl: string): FundingChain;
  limiter: RateLimiter;
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

/** The checks both routes share. Returns the wallet and the chain, or the response to send. */
async function authorise(request: Request, deps: OnboardDeps): Promise<{ wallet: string; chain: FundingChain } | Response> {
  const { public: publicConfig, deployment } = deps.config();
  if (!deployment) return json(503, { error: "not_bootstrapped" });

  let wallets: string[];
  try {
    ({ wallets } = await deps.verify(request));
  } catch (error) {
    if (error instanceof AuthError) return json(401, { error: "unauthorized" });
    throw error;
  }

  const body: unknown = await request.json().catch(() => null);
  const wallet = typeof body === "object" && body !== null ? (body as { wallet?: unknown }).wallet : undefined;
  if (typeof wallet !== "string" || !ADDRESS.test(wallet)) return json(400, { error: "bad_request" });
  if (!wallets.includes(wallet)) return json(403, { error: "wallet_not_linked" });

  return { wallet, chain: deps.chain(deployment, publicConfig.rpcUrl) };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function handleOnboard(request: Request, deps: OnboardDeps): Promise<Response> {
  const checked = await authorise(request, deps);
  if (checked instanceof Response) return checked;
  const { wallet, chain } = checked;

  if (await chain.traderExists(wallet)) return json(200, { registered: false });
  try {
    const signature = await chain.registerAndFund(wallet);
    return json(200, { registered: true, signature });
  } catch (error) {
    // register_trader fails for an existing trader, so a lost race sends nothing twice.
    if (await chain.traderExists(wallet).catch(() => false)) return json(200, { registered: false });
    return json(502, { error: "transaction_failed", detail: reason(error) });
  }
}

export async function handleFaucet(request: Request, deps: OnboardDeps): Promise<Response> {
  const checked = await authorise(request, deps);
  if (checked instanceof Response) return checked;
  const { wallet, chain } = checked;

  if (!(await chain.traderExists(wallet))) return json(409, { error: "not_registered" });
  const retryAfterSecs = deps.limiter.retryAfterSecs(wallet);
  if (retryAfterSecs > 0) return json(429, { error: "rate_limited", retryAfterSecs });

  const balances = await chain.balances(wallet);
  const amounts = {
    stableMicros: balances.stableMicros < FLOOR.stableMicros ? TOP_UP.stableMicros : 0n,
    lamports: balances.lamports < FLOOR.lamports ? TOP_UP.lamports : 0n,
  };
  if (amounts.stableMicros === 0n && amounts.lamports === 0n) return json(200, { toppedUp: false });

  deps.limiter.record(wallet);
  try {
    const signature = await chain.topUp(wallet, amounts);
    return json(200, { toppedUp: true, signature, stableMicros: amounts.stableMicros.toString(), lamports: amounts.lamports.toString() });
  } catch (error) {
    return json(502, { error: "transaction_failed", detail: reason(error) });
  }
}
