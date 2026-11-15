// Relayer configuration from the process environment and the deployment file, and the guards
// that must pass before anything is started. Error messages never contain a secret or a key.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ChainConfig } from "./chain/chain.ts";

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const LOCALNET_RPC_URL = "http://127.0.0.1:8899";

const DEFAULT_PORT = 8787;
const MOCK_WINDOW_SECS_DEFAULT = 900;
const MOCK_WINDOW_SECS_MIN = 180;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

export type Cluster = "devnet" | "localnet";
export type VenueName = "sandbox" | "mock";

const DEPLOYMENT_ADDRESSES = [
  "programId",
  "config",
  "stableMint",
  "treasury",
  "admin",
  "relayer",
  "settler",
  "registrar",
  "relayerFloat",
  "faucet",
] as const;

/** `deployments/<cluster>.json`, as the bootstrap script writes it. */
export type Deployment = { cluster: Cluster } & Record<(typeof DEPLOYMENT_ADDRESSES)[number], string>;

export interface RelayerConfig {
  cluster: Cluster;
  rpcUrl: string;
  venue: VenueName;
  geminiEnv: string | undefined;
  geminiApiKey: string | undefined;
  geminiApiSecret: string | undefined;
  port: number;
  dbPath: string;
  relayerKeyPath: string;
  settlerKeyPath: string;
  deploymentPath: string;
  deployment: Deployment;
  /** Only used by the mock venue. */
  mock: { windowSecs: number; resolve: "yes" | "no" | "random" };
}

/** Reads the configuration. Throws on any value it does not understand; nothing is guessed. */
export function loadConfig(env: Record<string, string | undefined>, repoRoot: string): RelayerConfig {
  const value = (name: string): string | undefined => {
    const text = env[name]?.trim();
    return text === undefined || text === "" ? undefined : text;
  };

  const cluster = value("CLUSTER") ?? "devnet";
  if (cluster !== "devnet" && cluster !== "localnet") throw new Error('CLUSTER must be "devnet" or "localnet"');
  const venue = value("VENUE") ?? "sandbox";
  if (venue !== "sandbox" && venue !== "mock") throw new Error('VENUE must be "sandbox" or "mock"');

  const mockResolve = value("MOCK_RESOLVE") ?? "random";
  if (mockResolve !== "yes" && mockResolve !== "no" && mockResolve !== "random") {
    throw new Error('MOCK_RESOLVE must be "yes", "no" or "random"');
  }
  const windowSecs = wholeNumber(value("MOCK_WINDOW_SECS")) ?? MOCK_WINDOW_SECS_DEFAULT;
  if (Number.isNaN(windowSecs) || windowSecs < MOCK_WINDOW_SECS_MIN) {
    throw new Error(`MOCK_WINDOW_SECS must be a whole number of seconds, at least ${MOCK_WINDOW_SECS_MIN}`);
  }
  const port = relayerPort(env);

  const deploymentPath = path.join(repoRoot, "deployments", `${cluster}.json`);
  return {
    cluster,
    rpcUrl: rpcUrlFor(cluster, value("SOLANA_RPC_URL")),
    venue,
    geminiEnv: value("GEMINI_ENV"),
    geminiApiKey: value("GEMINI_API_KEY"),
    geminiApiSecret: value("GEMINI_API_SECRET"),
    port,
    dbPath: value("RELAYER_DB") ?? path.join(repoRoot, ".data", `relayer-${cluster}-${venue}.sqlite`),
    relayerKeyPath: value("RELAYER_KEYPAIR") ?? path.join(repoRoot, ".keys", "relayer-keypair.json"),
    settlerKeyPath: value("SETTLER_KEYPAIR") ?? path.join(repoRoot, ".keys", "settler-keypair.json"),
    deploymentPath,
    deployment: readDeployment(deploymentPath, cluster),
    mock: { windowSecs, resolve: mockResolve },
  };
}

/** The port of the local HTTP API: `RELAYER_PORT`, default 8787. */
export function relayerPort(env: Record<string, string | undefined>): number {
  const text = env.RELAYER_PORT?.trim();
  const port = text === undefined || text === "" ? DEFAULT_PORT : (wholeNumber(text) ?? Number.NaN);
  if (Number.isNaN(port) || port < 1 || port > 65_535) throw new Error("RELAYER_PORT must be a port number");
  return port;
}

/**
 * The sandbox needs `GEMINI_ENV=sandbox`, an account-scoped key and a secret. The mock needs
 * nothing. The messages name the setting and never its value.
 */
export function assertVenueAllowed(config: Pick<RelayerConfig, "venue" | "geminiEnv" | "geminiApiKey" | "geminiApiSecret">): void {
  if (config.venue === "mock") return;
  if (config.venue !== "sandbox") throw new Error("refusing to start: unknown venue");
  if (config.geminiEnv !== "sandbox") throw new Error('refusing to start: GEMINI_ENV must be "sandbox"');
  if (typeof config.geminiApiKey !== "string" || !config.geminiApiKey.startsWith("account-")) {
    throw new Error('refusing to start: GEMINI_API_KEY must be an account-scoped key (it starts with "account-")');
  }
  if (typeof config.geminiApiSecret !== "string" || config.geminiApiSecret === "") {
    throw new Error("refusing to start: GEMINI_API_SECRET is not set");
  }
}

/**
 * `genesisHash` is what the RPC endpoint itself reports. Devnet must report devnet's hash; a
 * local cluster is only accepted on this machine; mainnet is refused under every setting.
 */
export function assertClusterAllowed(cluster: Cluster, rpcUrl: string, genesisHash: string): void {
  if (genesisHash === MAINNET_GENESIS_HASH) {
    throw new Error(`refusing to start: the RPC endpoint is mainnet (genesis hash ${MAINNET_GENESIS_HASH}), which is never allowed`);
  }
  if (cluster === "devnet") {
    if (genesisHash !== DEVNET_GENESIS_HASH) {
      throw new Error(`refusing to start: the RPC endpoint is not devnet (genesis hash ${genesisHash}, expected ${DEVNET_GENESIS_HASH})`);
    }
    return;
  }
  if (cluster === "localnet") {
    if (!isLocalUrl(rpcUrl)) throw new Error("refusing to start: localnet needs an RPC endpoint on 127.0.0.1 or localhost");
    return;
  }
  throw new Error("refusing to start: unknown cluster");
}

/**
 * The deployment file must describe the program the chain actually runs, and the key files must
 * hold the keys that program expects. `keys` are the addresses of the loaded signers.
 */
export function assertDeploymentMatches(
  deployment: Pick<Deployment, "relayer" | "settler" | "stableMint" | "treasury">,
  chainConfig: Pick<ChainConfig, "relayer" | "settler" | "stableMint" | "treasury">,
  keys: { relayer: string; settler: string },
): void {
  for (const field of ["relayer", "settler", "stableMint", "treasury"] as const) {
    if (deployment[field] !== chainConfig[field]) {
      throw new Error(`refusing to start: ${field} in the deployment file (${deployment[field]}) is not the on-chain one (${chainConfig[field]})`);
    }
  }
  for (const role of ["relayer", "settler"] as const) {
    if (keys[role] !== deployment[role]) {
      throw new Error(`refusing to start: the ${role} key file holds ${keys[role]}, the deployment expects ${deployment[role]}`);
    }
  }
}

/** Devnet takes the endpoint from the environment. Localnet only accepts one on this machine. */
function rpcUrlFor(cluster: Cluster, fromEnv: string | undefined): string {
  if (cluster === "localnet") return fromEnv !== undefined && isLocalUrl(fromEnv) ? fromEnv : LOCALNET_RPC_URL;
  if (fromEnv === undefined) throw new Error("SOLANA_RPC_URL is required for devnet");
  let url: URL | null = null;
  try {
    url = new URL(fromEnv);
  } catch {
    // Reported below without echoing the value: an RPC URL can carry a provider key.
  }
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) throw new Error("SOLANA_RPC_URL is not a valid http(s) URL");
  return fromEnv;
}

function isLocalUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** Undefined when unset, NaN when it is not a plain whole number. */
function wholeNumber(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  return /^\d{1,9}$/.test(text) ? Number(text) : Number.NaN;
}

function readDeployment(file: string, cluster: Cluster): Deployment {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`cannot read ${file}: run the bootstrap script for ${cluster} first`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${file} is not a deployment file`);
  const fields = parsed as Record<string, unknown>;
  if (fields.cluster !== cluster) throw new Error(`${file} is for cluster ${JSON.stringify(fields.cluster)}, not "${cluster}"`);
  const deployment = { cluster } as Deployment;
  for (const name of DEPLOYMENT_ADDRESSES) {
    const address = fields[name];
    if (typeof address !== "string" || !ADDRESS.test(address)) throw new Error(`${file}: ${name} is not an address`);
    deployment[name] = address;
  }
  return deployment;
}
