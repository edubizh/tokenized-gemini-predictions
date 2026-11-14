import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.server";
import { explorerAddressUrl, explorerTxUrl } from "./config";

const deployment = {
  cluster: "devnet",
  programId: "8TN1HWcEFTAcM7Vthmih1FKftTBrp3LDgTBkfhp1PRVn",
  config: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
  stableMint: "So11111111111111111111111111111111111111112",
  treasury: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
  admin: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
  relayer: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
  settler: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
  registrar: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
  relayerFloat: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
  faucet: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
};
const env = { NEXT_PUBLIC_PRIVY_APP_ID: "app-id", SOLANA_RPC_URL: "https://api.devnet.solana.com" };

describe("resolveConfig", () => {
  it("returns the public part of a devnet deployment", () => {
    const resolved = resolveConfig(env, () => deployment);
    expect(resolved.public).toEqual({
      cluster: "devnet",
      rpcUrl: "https://api.devnet.solana.com",
      programId: deployment.programId,
      stableMint: deployment.stableMint,
      privyAppId: "app-id",
      explorerBase: "https://explorer.solana.com",
      bootstrapped: true,
    });
    expect(resolved.deployment?.faucet).toBe(deployment.faucet);
  });

  it("defaults to devnet and its public RPC", () => {
    const resolved = resolveConfig({ NEXT_PUBLIC_PRIVY_APP_ID: "app-id" }, () => deployment);
    expect(resolved.public.cluster).toBe("devnet");
    expect(resolved.public.rpcUrl).toBe("https://api.devnet.solana.com");
  });

  it("is not bootstrapped when the deployment file is missing", () => {
    const resolved = resolveConfig(env, () => null);
    expect(resolved.public.bootstrapped).toBe(false);
    expect(resolved.public.stableMint).toBeNull();
    expect(resolved.public.programId).toBe("8TN1HWcEFTAcM7Vthmih1FKftTBrp3LDgTBkfhp1PRVn");
    expect(resolved.deployment).toBeNull();
  });

  it("refuses any devnet RPC other than the public devnet endpoint", () => {
    for (const url of ["https://api.mainnet-beta.solana.com", "https://devnet.helius-rpc.com/?api-key=x", "http://127.0.0.1:8899"]) {
      expect(() => resolveConfig({ ...env, SOLANA_RPC_URL: url }, () => deployment)).toThrow(
        /SOLANA_RPC_URL must be https:\/\/api\.devnet\.solana\.com/,
      );
    }
  });

  it("accepts only a loopback RPC on localnet", () => {
    const local = { ...deployment, cluster: "localnet" };
    const resolved = resolveConfig({ ...env, CLUSTER: "localnet", SOLANA_RPC_URL: "http://127.0.0.1:8899" }, () => local);
    expect(resolved.public.cluster).toBe("localnet");
    expect(resolved.public.rpcUrl).toBe("http://127.0.0.1:8899");
    expect(resolveConfig({ ...env, CLUSTER: "localnet", SOLANA_RPC_URL: "http://localhost:8899" }, () => local).public.rpcUrl).toBe(
      "http://localhost:8899",
    );
    expect(() => resolveConfig({ ...env, CLUSTER: "localnet" }, () => local)).toThrow(/127\.0\.0\.1 or localhost/);
    expect(() => resolveConfig({ ...env, CLUSTER: "localnet", SOLANA_RPC_URL: "http://localhost.evil.example:8899" }, () => local)).toThrow(
      /127\.0\.0\.1 or localhost/,
    );
  });

  it("refuses an unknown cluster", () => {
    expect(() => resolveConfig({ ...env, CLUSTER: "mainnet" }, () => deployment)).toThrow(/CLUSTER must be devnet or localnet/);
  });

  it("refuses a deployment file written for another cluster or with missing fields", () => {
    expect(() => resolveConfig(env, () => ({ ...deployment, cluster: "localnet" }))).toThrow(/is for cluster "localnet"/);
    const { faucet: _faucet, ...partial } = deployment;
    expect(() => resolveConfig(env, () => partial)).toThrow(/missing "faucet"/);
  });

  it("requires the login app id", () => {
    expect(() => resolveConfig({ SOLANA_RPC_URL: env.SOLANA_RPC_URL }, () => deployment)).toThrow(/NEXT_PUBLIC_PRIVY_APP_ID/);
  });
});

describe("explorer links", () => {
  const base = { explorerBase: "https://explorer.solana.com", rpcUrl: "http://127.0.0.1:8899" };

  it("links to devnet", () => {
    expect(explorerTxUrl({ ...base, cluster: "devnet" }, "5sig")).toBe("https://explorer.solana.com/tx/5sig?cluster=devnet");
    expect(explorerAddressUrl({ ...base, cluster: "devnet" }, "8rj8")).toBe("https://explorer.solana.com/address/8rj8?cluster=devnet");
  });

  it("uses the custom-cluster form on localnet", () => {
    expect(explorerTxUrl({ ...base, cluster: "localnet" }, "5sig")).toBe(
      "https://explorer.solana.com/tx/5sig?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899",
    );
  });
});
