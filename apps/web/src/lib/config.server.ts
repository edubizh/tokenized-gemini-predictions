// Server-side configuration: the environment plus `deployments/<cluster>.json` from the repo root.
// Never import this file from a client component.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { OUTCOME_TOKENS_PROGRAM_ADDRESS } from "@outcome/program-client";
import type { PublicConfig } from "./config";

export type Cluster = PublicConfig["cluster"];

/** Shape written by the relayer's bootstrap script. */
export interface Deployment {
  cluster: Cluster;
  programId: string;
  config: string;
  stableMint: string;
  treasury: string;
  admin: string;
  relayer: string;
  settler: string;
  registrar: string;
  relayerFloat: string;
  faucet: string;
}

export interface ResolvedConfig {
  public: PublicConfig;
  deployment: Deployment | null;
}

/** The value of `RELAYER_URL` that replaces the relayer and the chain with simulated ones. */
export const FIXTURES = "fixtures";

/** True when this server simulates the relayer and the chain. */
export function fixturesMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.RELAYER_URL === FIXTURES;
}

const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const EXPLORER_BASE = "https://explorer.solana.com";
const DEPLOYMENT_FIELDS = [
  "programId", "config", "stableMint", "treasury", "admin", "relayer", "settler", "registrar", "relayerFloat", "faucet",
] as const;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const REPO_ROOT = path.resolve(/* turbopackIgnore: true */ process.cwd(), "../..");

function guardRpcUrl(cluster: Cluster, raw: string | undefined): string {
  if (cluster === "devnet") {
    const url = (raw ?? DEVNET_RPC_URL).replace(/\/$/, "");
    if (url !== DEVNET_RPC_URL) {
      throw new Error(`SOLANA_RPC_URL must be ${DEVNET_RPC_URL} when CLUSTER is devnet. This build only runs against devnet or a local validator.`);
    }
    return url;
  }
  let host = "";
  try {
    const parsed = new URL(raw ?? "");
    if (parsed.protocol === "http:" || parsed.protocol === "https:") host = parsed.hostname;
  } catch {
    // reported below
  }
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("SOLANA_RPC_URL must point at 127.0.0.1 or localhost when CLUSTER is localnet.");
  }
  return (raw as string).replace(/\/$/, "");
}

function parseDeployment(cluster: Cluster, raw: unknown): Deployment {
  const file = `deployments/${cluster}.json`;
  if (typeof raw !== "object" || raw === null) throw new Error(`${file} is not a JSON object.`);
  const record = raw as Record<string, unknown>;
  if (record.cluster !== cluster) throw new Error(`${file} is for cluster ${JSON.stringify(record.cluster)}, expected "${cluster}".`);
  for (const field of DEPLOYMENT_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || !ADDRESS.test(value)) throw new Error(`${file} is missing "${field}" or it is not an address.`);
  }
  return record as unknown as Deployment;
}

/** Pure: everything it needs is passed in. Throws with a clear message on any unsafe setting. */
export function resolveConfig(
  env: Record<string, string | undefined>,
  readDeployment: (cluster: Cluster) => unknown | null,
): ResolvedConfig {
  const cluster = env.CLUSTER ?? "devnet";
  if (cluster !== "devnet" && cluster !== "localnet") throw new Error(`CLUSTER must be devnet or localnet, not ${JSON.stringify(cluster)}.`);
  const rpcUrl = guardRpcUrl(cluster, env.SOLANA_RPC_URL);
  const privyAppId = env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!privyAppId) throw new Error("NEXT_PUBLIC_PRIVY_APP_ID is not set. The app cannot offer a login without it.");
  const raw = readDeployment(cluster);
  const deployment = raw === null ? null : parseDeployment(cluster, raw);
  return {
    public: {
      cluster,
      rpcUrl,
      programId: deployment?.programId ?? OUTCOME_TOKENS_PROGRAM_ADDRESS,
      stableMint: deployment?.stableMint ?? null,
      privyAppId,
      explorerBase: EXPLORER_BASE,
      bootstrapped: deployment !== null,
      fixtures: env.RELAYER_URL === FIXTURES,
    },
    deployment,
  };
}

function readDeploymentFile(cluster: Cluster): unknown | null {
  const file = path.join(REPO_ROOT, "deployments", `${cluster}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Reads the environment and the deployment file. The file is re-read on every call so the app
 * picks up a deployment made while it is running.
 */
export function loadConfig(): ResolvedConfig {
  return resolveConfig(process.env, readDeploymentFile);
}
