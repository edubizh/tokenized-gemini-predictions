import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChainConfig } from "../src/chain/chain.ts";
import {
  DEVNET_GENESIS_HASH,
  MAINNET_GENESIS_HASH,
  assertClusterAllowed,
  assertDeploymentMatches,
  assertVenueAllowed,
  loadConfig,
} from "../src/config.ts";
import type { Deployment } from "../src/config.ts";

// Synthetic addresses: valid base58 text, not real accounts.
const A = (letter: string): string => letter.repeat(43);
const DEPLOYMENT: Deployment = {
  cluster: "devnet",
  programId: A("P"),
  config: A("C"),
  stableMint: A("M"),
  treasury: A("T"),
  admin: A("A"),
  relayer: A("R"),
  settler: A("S"),
  registrar: A("G"),
  relayerFloat: A("F"),
  faucet: A("U"),
};
const SANDBOX_ENV = { GEMINI_ENV: "sandbox", GEMINI_API_KEY: "account-synthetic", GEMINI_API_SECRET: "synthetic-secret", SOLANA_RPC_URL: "https://rpc.example.test" };

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** A throwaway repository root holding deployment files for the given clusters. */
function repo(deployments: Record<string, unknown> = { devnet: DEPLOYMENT }): string {
  const root = mkdtempSync(path.join(tmpdir(), "relayer-config-"));
  roots.push(root);
  mkdirSync(path.join(root, "deployments"));
  for (const [cluster, body] of Object.entries(deployments)) {
    writeFileSync(path.join(root, "deployments", `${cluster}.json`), typeof body === "string" ? body : JSON.stringify(body));
  }
  return root;
}

describe("loadConfig", () => {
  it("keeps a separate database per venue, so sandbox and mock markets never mix", () => {
    const root = repo();
    expect(loadConfig(SANDBOX_ENV, root).dbPath).toBe(path.join(root, ".data", "relayer-devnet-sandbox.sqlite"));
    expect(loadConfig({ ...SANDBOX_ENV, VENUE: "mock" }, root).dbPath).toBe(path.join(root, ".data", "relayer-devnet-mock.sqlite"));
  });

  it("applies the defaults for devnet and the sandbox", () => {
    const root = repo();
    expect(loadConfig(SANDBOX_ENV, root)).toEqual({
      cluster: "devnet",
      rpcUrl: "https://rpc.example.test",
      venue: "sandbox",
      geminiEnv: "sandbox",
      geminiApiKey: "account-synthetic",
      geminiApiSecret: "synthetic-secret",
      port: 8787,
      dbPath: path.join(root, ".data", "relayer-devnet-sandbox.sqlite"),
      relayerKeyPath: path.join(root, ".keys", "relayer-keypair.json"),
      settlerKeyPath: path.join(root, ".keys", "settler-keypair.json"),
      deploymentPath: path.join(root, "deployments", "devnet.json"),
      deployment: DEPLOYMENT,
      mock: { windowSecs: 900, resolve: "random" },
    });
  });

  it("reads every setting from the environment", () => {
    const root = repo({ localnet: { ...DEPLOYMENT, cluster: "localnet" } });
    const config = loadConfig(
      {
        CLUSTER: "localnet",
        VENUE: "mock",
        RELAYER_PORT: "9001",
        RELAYER_DB: "/tmp/elsewhere.sqlite",
        RELAYER_KEYPAIR: "/keys/r.json",
        SETTLER_KEYPAIR: "/keys/s.json",
        MOCK_WINDOW_SECS: "180",
        MOCK_RESOLVE: "yes",
      },
      root,
    );
    expect(config).toMatchObject({
      cluster: "localnet",
      rpcUrl: "http://127.0.0.1:8899",
      venue: "mock",
      geminiApiKey: undefined,
      port: 9001,
      dbPath: "/tmp/elsewhere.sqlite",
      relayerKeyPath: "/keys/r.json",
      settlerKeyPath: "/keys/s.json",
      mock: { windowSecs: 180, resolve: "yes" },
    });
    expect(config.deployment.cluster).toBe("localnet");
  });

  it("on localnet uses SOLANA_RPC_URL only when it points at this machine", () => {
    const root = repo({ localnet: { ...DEPLOYMENT, cluster: "localnet" } });
    expect(loadConfig({ CLUSTER: "localnet", VENUE: "mock", SOLANA_RPC_URL: "https://rpc.example.test" }, root).rpcUrl).toBe("http://127.0.0.1:8899");
    expect(loadConfig({ CLUSTER: "localnet", VENUE: "mock", SOLANA_RPC_URL: "http://localhost:9999" }, root).rpcUrl).toBe("http://localhost:9999");
  });

  it("refuses values it does not know", () => {
    const root = repo();
    const load = (env: Record<string, string>) => () => loadConfig({ ...SANDBOX_ENV, ...env }, root);
    expect(load({ CLUSTER: "mainnet-beta" })).toThrow('CLUSTER must be "devnet" or "localnet"');
    expect(load({ VENUE: "production" })).toThrow('VENUE must be "sandbox" or "mock"');
    expect(load({ SOLANA_RPC_URL: "" })).toThrow("SOLANA_RPC_URL is required for devnet");
    expect(load({ SOLANA_RPC_URL: "not a url" })).toThrow("SOLANA_RPC_URL is not a valid http(s) URL");
    expect(load({ RELAYER_PORT: "80a" })).toThrow("RELAYER_PORT must be a port number");
    expect(load({ RELAYER_PORT: "70000" })).toThrow("RELAYER_PORT must be a port number");
    expect(load({ MOCK_WINDOW_SECS: "179" })).toThrow("MOCK_WINDOW_SECS must be a whole number of seconds, at least 180");
    expect(load({ MOCK_RESOLVE: "maybe" })).toThrow('MOCK_RESOLVE must be "yes", "no" or "random"');
  });

  it("refuses a missing, unreadable or mismatched deployment file", () => {
    expect(() => loadConfig(SANDBOX_ENV, repo({}))).toThrow(/deployments\/devnet\.json.*run the bootstrap script/);
    expect(() => loadConfig(SANDBOX_ENV, repo({ devnet: "{ not json" }))).toThrow("is not valid JSON");
    expect(() => loadConfig(SANDBOX_ENV, repo({ devnet: { ...DEPLOYMENT, cluster: "localnet" } }))).toThrow('is for cluster "localnet", not "devnet"');
    expect(() => loadConfig(SANDBOX_ENV, repo({ devnet: { ...DEPLOYMENT, treasury: "0OIl" } }))).toThrow("treasury is not an address");
    const { relayerFloat: _dropped, ...partial } = DEPLOYMENT;
    expect(() => loadConfig(SANDBOX_ENV, repo({ devnet: partial }))).toThrow("relayerFloat is not an address");
  });
});

describe("assertVenueAllowed", () => {
  const base = { venue: "sandbox", geminiEnv: "sandbox", geminiApiKey: "account-synthetic", geminiApiSecret: "synthetic-secret" } as const;

  it("accepts the sandbox with an account key, and the mock without any", () => {
    expect(() => assertVenueAllowed(base)).not.toThrow();
    expect(() => assertVenueAllowed({ venue: "mock", geminiEnv: undefined, geminiApiKey: undefined, geminiApiSecret: undefined })).not.toThrow();
  });

  it("refuses anything but the sandbox environment, never echoing a value", () => {
    const refusal = (overrides: Record<string, unknown>): string => {
      try {
        assertVenueAllowed({ ...base, ...overrides } as Parameters<typeof assertVenueAllowed>[0]);
      } catch (error) {
        return (error as Error).message;
      }
      return "no error";
    };
    expect(refusal({ geminiEnv: "production" })).toBe('refusing to start: GEMINI_ENV must be "sandbox"');
    expect(refusal({ geminiEnv: undefined })).toBe('refusing to start: GEMINI_ENV must be "sandbox"');
    expect(refusal({ geminiApiKey: "master-SECRETKEYVALUE" })).toBe('refusing to start: GEMINI_API_KEY must be an account-scoped key (it starts with "account-")');
    expect(refusal({ geminiApiKey: undefined })).toContain("GEMINI_API_KEY");
    expect(refusal({ geminiApiSecret: "" })).toBe("refusing to start: GEMINI_API_SECRET is not set");
    expect(refusal({ venue: "live" })).toBe("refusing to start: unknown venue");
    expect(refusal({ geminiEnv: "PRODSECRET", geminiApiKey: "master-SECRETKEYVALUE" })).not.toMatch(/SECRET(KEY)?VALUE|PRODSECRET/);
  });
});

describe("assertClusterAllowed", () => {
  it("devnet needs the devnet genesis hash", () => {
    expect(() => assertClusterAllowed("devnet", "https://rpc.example.test", DEVNET_GENESIS_HASH)).not.toThrow();
    expect(() => assertClusterAllowed("devnet", "https://rpc.example.test", "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY")).toThrow(
      `refusing to start: the RPC endpoint is not devnet (genesis hash 4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY, expected ${DEVNET_GENESIS_HASH})`,
    );
  });

  it("localnet needs an RPC endpoint on this machine", () => {
    expect(() => assertClusterAllowed("localnet", "http://127.0.0.1:8899", "AnyLocalGenesisHash")).not.toThrow();
    expect(() => assertClusterAllowed("localnet", "http://localhost:8899", "AnyLocalGenesisHash")).not.toThrow();
    expect(() => assertClusterAllowed("localnet", "https://rpc.example.test", "AnyLocalGenesisHash")).toThrow(
      "refusing to start: localnet needs an RPC endpoint on 127.0.0.1 or localhost",
    );
    expect(() => assertClusterAllowed("localnet", "http://127.0.0.1.example.test:8899", "AnyLocalGenesisHash")).toThrow("localnet needs an RPC endpoint");
    expect(() => assertClusterAllowed("localnet", "nonsense", "AnyLocalGenesisHash")).toThrow("localnet needs an RPC endpoint");
  });

  it("never accepts mainnet, whatever the cluster setting", () => {
    expect(MAINNET_GENESIS_HASH).toBe("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
    const message = `refusing to start: the RPC endpoint is mainnet (genesis hash ${MAINNET_GENESIS_HASH}), which is never allowed`;
    expect(() => assertClusterAllowed("devnet", "https://rpc.example.test", MAINNET_GENESIS_HASH)).toThrow(message);
    expect(() => assertClusterAllowed("localnet", "http://127.0.0.1:8899", MAINNET_GENESIS_HASH)).toThrow(message);
    expect(() => assertClusterAllowed("testnet" as "devnet", "https://rpc.example.test", DEVNET_GENESIS_HASH)).toThrow("refusing to start: unknown cluster");
  });
});

describe("assertDeploymentMatches", () => {
  const chainConfig: ChainConfig = {
    admin: DEPLOYMENT.admin,
    relayer: DEPLOYMENT.relayer,
    settler: DEPLOYMENT.settler,
    registrar: DEPLOYMENT.registrar,
    stableMint: DEPLOYMENT.stableMint,
    treasury: DEPLOYMENT.treasury,
    orderTtlSecs: 90,
    minOrderUnits: 1n,
    maxOrderUnits: 10_000n,
    settleDelaySecs: 30,
    pausePlace: false,
    pauseFill: false,
  };
  const keys = { relayer: DEPLOYMENT.relayer, settler: DEPLOYMENT.settler };

  it("accepts a deployment file that agrees with the chain and the loaded keys", () => {
    expect(() => assertDeploymentMatches(DEPLOYMENT, chainConfig, keys)).not.toThrow();
  });

  it.each(["relayer", "settler", "stableMint", "treasury"] as const)("refuses a %s that differs from the on-chain config", (field) => {
    expect(() => assertDeploymentMatches(DEPLOYMENT, { ...chainConfig, [field]: A("X") }, keys)).toThrow(
      `refusing to start: ${field} in the deployment file (${DEPLOYMENT[field]}) is not the on-chain one (${A("X")})`,
    );
  });

  it.each(["relayer", "settler"] as const)("refuses a %s key that is not the deployed one", (role) => {
    expect(() => assertDeploymentMatches(DEPLOYMENT, chainConfig, { ...keys, [role]: A("K") })).toThrow(
      `refusing to start: the ${role} key file holds ${A("K")}, the deployment expects ${DEPLOYMENT[role]}`,
    );
  });
});
