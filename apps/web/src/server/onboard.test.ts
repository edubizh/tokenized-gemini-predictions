import { describe, expect, it } from "vitest";
import type { Deployment, ResolvedConfig } from "@/lib/config.server";
import { AuthError } from "./auth-error";
import { createRateLimiter, handleFaucet, handleOnboard, STARTER, TOP_UP, type FundingChain, type OnboardDeps } from "./onboard";

const WALLET = "8TN1HWcEFTAcM7Vthmih1FKftTBrp3LDgTBkfhp1PRVn";
const OTHER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";

function config(bootstrapped: boolean): ResolvedConfig {
  return {
    public: {
      cluster: "devnet",
      rpcUrl: "https://api.devnet.solana.com",
      programId: WALLET,
      stableMint: bootstrapped ? OTHER : null,
      privyAppId: "app",
      explorerBase: "https://explorer.solana.com",
      bootstrapped,
      fixtures: false,
    },
    deployment: bootstrapped ? ({ cluster: "devnet", programId: WALLET, stableMint: OTHER, faucet: OTHER } as Deployment) : null,
  };
}

interface World {
  registered: Set<string>;
  balances: { lamports: bigint; stableMicros: bigint };
  sent: string[];
  failRegister?: Error;
}

function deps(world: World, options: { bootstrapped?: boolean; wallets?: string[]; now?: () => number } = {}): OnboardDeps {
  const chain: FundingChain = {
    traderExists: async (wallet) => world.registered.has(wallet),
    balances: async () => world.balances,
    registerAndFund: async (wallet) => {
      if (world.failRegister) throw world.failRegister;
      world.registered.add(wallet);
      world.sent.push(`register:${wallet}`);
      return "sig-register";
    },
    topUp: async (wallet, amounts) => {
      world.sent.push(`topup:${wallet}:${amounts.stableMicros}:${amounts.lamports}`);
      return "sig-topup";
    },
  };
  return {
    config: () => config(options.bootstrapped ?? true),
    verify: async (request) => {
      if (request.headers.get("authorization") !== "Bearer good") throw new AuthError("invalid token");
      return { userId: "did:privy:1", wallets: options.wallets ?? [WALLET] };
    },
    chain: () => chain,
    limiter: createRateLimiter(10 * 60 * 1000, options.now),
  };
}

function post(body: unknown, token: string | null = "good"): Request {
  return new Request("http://localhost/api/onboard", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const world = (over: Partial<World> = {}): World => ({
  registered: new Set(),
  balances: { lamports: 50_000_000n, stableMicros: 1_000_000_000n },
  sent: [],
  ...over,
});

describe("POST /api/onboard", () => {
  it("answers 503 before anything else when the deployment file is missing", async () => {
    const w = world();
    const response = await handleOnboard(post({ wallet: WALLET }, null), deps(w, { bootstrapped: false }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not_bootstrapped" });
    expect(w.sent).toEqual([]);
  });

  it("answers 401 for a missing or bad token", async () => {
    for (const token of [null, "bad"]) {
      const response = await handleOnboard(post({ wallet: WALLET }, token), deps(world()));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("answers 400 for a body without a wallet address", async () => {
    for (const body of ["not json", {}, { wallet: 7 }, { wallet: "0OIl" }]) {
      const response = await handleOnboard(post(body), deps(world()));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_request" });
    }
  });

  it("answers 403 for a wallet that is not linked to the login", async () => {
    const w = world();
    const response = await handleOnboard(post({ wallet: OTHER }), deps(w));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "wallet_not_linked" });
    expect(w.sent).toEqual([]);
  });

  it("registers and funds a new wallet in one transaction", async () => {
    const w = world();
    const response = await handleOnboard(post({ wallet: WALLET }), deps(w));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ registered: true, signature: "sig-register" });
    expect(w.sent).toEqual([`register:${WALLET}`]);
  });

  it("sends nothing to a wallet that is already registered", async () => {
    const w = world({ registered: new Set([WALLET]) });
    const response = await handleOnboard(post({ wallet: WALLET }), deps(w));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ registered: false });
    expect(w.sent).toEqual([]);
  });

  it("reports already registered when a concurrent request won the race", async () => {
    const w = world();
    const d = deps(w);
    const chain = d.chain(config(true).deployment!, "");
    d.chain = () => ({
      ...chain,
      registerAndFund: async (wallet) => {
        w.registered.add(wallet);
        throw new Error("account already in use");
      },
    });
    const response = await handleOnboard(post({ wallet: WALLET }), d);
    expect(await response.json()).toEqual({ registered: false });
  });

  it("answers 502 with the reason when the transaction fails", async () => {
    const response = await handleOnboard(post({ wallet: WALLET }), deps(world({ failRegister: new Error("faucet is empty") })));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "transaction_failed", detail: "faucet is empty" });
  });
});

describe("POST /api/faucet", () => {
  const low = { lamports: 5_000_000n, stableMicros: 99_999_999n };

  it("shares the 503, 401 and 403 answers", async () => {
    expect((await handleFaucet(post({ wallet: WALLET }), deps(world(), { bootstrapped: false }))).status).toBe(503);
    expect((await handleFaucet(post({ wallet: WALLET }, "bad"), deps(world()))).status).toBe(401);
    expect((await handleFaucet(post({ wallet: OTHER }), deps(world()))).status).toBe(403);
  });

  it("refuses a wallet that is not a registered trader", async () => {
    const response = await handleFaucet(post({ wallet: WALLET }), deps(world({ balances: low })));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "not_registered" });
  });

  it("sends nothing when both balances are above their floors", async () => {
    const w = world({ registered: new Set([WALLET]), balances: { lamports: 10_000_000n, stableMicros: 100_000_000n } });
    const response = await handleFaucet(post({ wallet: WALLET }), deps(w));
    expect(await response.json()).toEqual({ toppedUp: false });
    expect(w.sent).toEqual([]);
  });

  it("tops up test dollars below 100 and SOL below 0.01", async () => {
    const w = world({ registered: new Set([WALLET]), balances: low });
    const response = await handleFaucet(post({ wallet: WALLET }), deps(w));
    expect(await response.json()).toEqual({ toppedUp: true, signature: "sig-topup", stableMicros: "1000000000", lamports: "30000000" });
    expect(w.sent).toEqual([`topup:${WALLET}:${TOP_UP.stableMicros}:${TOP_UP.lamports}`]);
  });

  it("tops up only the balance that is low", async () => {
    const w = world({ registered: new Set([WALLET]), balances: { lamports: 9_999_999n, stableMicros: 500_000_000n } });
    await handleFaucet(post({ wallet: WALLET }), deps(w));
    expect(w.sent).toEqual([`topup:${WALLET}:0:30000000`]);
  });

  it("allows one top-up per wallet per ten minutes", async () => {
    let now = 1_000_000;
    const w = world({ registered: new Set([WALLET]), balances: low });
    const d = deps(w, { now: () => now });
    expect((await handleFaucet(post({ wallet: WALLET }), d)).status).toBe(200);
    now += 9 * 60 * 1000;
    const limited = await handleFaucet(post({ wallet: WALLET }), d);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited", retryAfterSecs: 60 });
    now += 60 * 1000;
    expect((await handleFaucet(post({ wallet: WALLET }), d)).status).toBe(200);
    expect(w.sent).toHaveLength(2);
  });

  it("states the starter amounts", () => {
    expect(STARTER).toEqual({ stableMicros: 1_000_000_000n, lamports: 50_000_000n });
  });
});
