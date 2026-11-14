// The relayer's command line. Run from apps/relayer:
//
//   node --env-file=../../.env src/main.ts start            run the relayer
//   node --env-file=../../.env src/main.ts status           print /health and /status of a running relayer
//   node --env-file=../../.env src/main.ts pause            set both pause bits on-chain
//   node --env-file=../../.env src/main.ts cancel-expired   cancel every open order past its expiry
//   node --env-file=../../.env src/main.ts settle <symbol> <yes|no>
//                                                           settle a market by hand (one stuck in needs_review)
//
// Nothing is started, and nothing is sent, unless every guard in `config.ts` passes: sandbox
// venue only, devnet or a local validator only, and a deployment file that matches the chain.
// No output ever contains a secret or key material.

// Registers the resolver for the program client; the chain adapter is loaded after it, below.
import "./chain/client-loader.ts";

import { mkdirSync } from "node:fs";
import path from "node:path";
import { createApiHandlers, createApiServer } from "./api/server.ts";
import type { Chain, MarketChain } from "./chain/chain.ts";
import { assertClusterAllowed, assertDeploymentMatches, assertVenueAllowed, loadConfig, relayerPort } from "./config.ts";
import type { RelayerConfig } from "./config.ts";
import { createAlertLog, createDaemon } from "./daemon.ts";
import { openJournal } from "./journal.ts";
import type { Journal } from "./journal.ts";
import { createMarketManager } from "./markets.ts";
import { PAYOUT_PER_UNIT } from "./money.ts";
import { createReconciler } from "./reconcile.ts";
import { openRegistry } from "./registry.ts";
import type { Registry, RegistryMarket } from "./registry.ts";
import { createSettlementWatcher } from "./settlement.ts";
import { GeminiSandboxVenue } from "./venue/gemini/venue.ts";
import { RollingMockVenue } from "./venue/mock-feed.ts";
import type { Venue } from "./venue/venue.ts";

type FullChain = Chain & MarketChain & { close(): void };

const USAGE = `usage: node src/main.ts <command>

  start                     run the relayer
  status                    print /health and /status of a running relayer
  pause                     set both pause bits on-chain
  cancel-expired            cancel every open order past its expiry
  settle <symbol> <yes|no>  settle a market by hand`;

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SYMBOL = /^[A-Z0-9-]{1,64}$/;
/** How long shutdown waits for a tick that is still running. */
const STOP_WAIT_MS = 10_000;
const VENUE_RECONNECT_MS = 5_000;

function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The genesis hash as the endpoint itself reports it. Errors never carry the URL: it can hold a provider key. */
async function fetchGenesisHash(rpcUrl: string): Promise<string> {
  let body: unknown;
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.json();
  } catch (error) {
    throw new Error(`cannot read the genesis hash from the RPC endpoint: ${error instanceof Error ? error.name : "error"}`);
  }
  const hash = typeof body === "object" && body !== null ? (body as { result?: unknown }).result : undefined;
  if (typeof hash !== "string" || hash === "") throw new Error("the RPC endpoint returned no genesis hash");
  return hash;
}

/**
 * The chain adapter, behind the cluster guard and the deployment guard. Only reads happen here.
 */
async function openChain(config: RelayerConfig): Promise<FullChain> {
  assertClusterAllowed(config.cluster, config.rpcUrl, await fetchGenesisHash(config.rpcUrl));
  const { createSolanaChain, loadKeypairSigner } = await import("./chain/solana.ts");
  const relayer = await loadKeypairSigner(config.relayerKeyPath);
  const settler = await loadKeypairSigner(config.settlerKeyPath);
  const { deployment } = config;
  const chain = createSolanaChain({
    rpcUrl: config.rpcUrl,
    programId: deployment.programId,
    relayer,
    settler,
    stableMint: deployment.stableMint,
    treasury: deployment.treasury,
    relayerFloat: deployment.relayerFloat,
    log,
  });
  try {
    assertDeploymentMatches(deployment, await chain.config(), { relayer: relayer.address, settler: settler.address });
  } catch (error) {
    chain.close();
    throw error;
  }
  return chain;
}

/** A registry row as the contract the mock venue listed in an earlier run. */
function contractOf(market: RegistryMarket) {
  return {
    symbol: market.symbol,
    eventTicker: market.eventTicker,
    status: "active",
    marketState: "open",
    effectiveAt: new Date(market.effectiveAt),
    expiresAt: new Date(market.expiresAt),
    tickPx: market.tickPx,
    unitIncrement: market.unitIncrement,
    minUnits: market.minUnits,
    resolutionSide: null,
    title: market.title,
    label: market.label,
    series: market.series,
    strike: market.strike,
  };
}

/**
 * The mock venue keeps its positions in memory. After a restart it is given back the contracts
 * of the unsettled on-chain markets with the positions their token supplies imply, so that they
 * resolve, pay and reconcile as if the process had never stopped.
 */
async function adoptEarlierMarkets(mock: RollingMockVenue, chain: FullChain, registry: Registry, journal: Journal): Promise<void> {
  for (const market of registry.onchainUnsettled()) {
    const onchain = await chain.market(market.symbol);
    if (onchain === null || onchain.status === "settled") continue;
    const inFlight = journal
      .byState("venue_filled")
      .filter((row) => row.symbol === market.symbol)
      .reduce((sum, row) => ((row.kind === "buy") === (row.side === "YES") ? sum + row.filledUnits : sum - row.filledUnits), 0n);
    const position = onchain.yesSupply - onchain.noSupply + inFlight + journal.houseInventoryUnits(market.symbol);
    mock.adopt(contractOf(market), position, market.resolution ?? undefined);
    log(`mock venue: took over ${market.symbol} with a position of ${position} units`);
  }
}

async function start(config: RelayerConfig): Promise<void> {
  assertVenueAllowed(config);
  const chain = await openChain(config);

  mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const journal = openJournal(config.dbPath);
  const registry = openRegistry(config.dbPath);
  const alerts = createAlertLog({ log, now: Date.now });

  let venue: Venue;
  let venueConnected: (() => boolean) | undefined;
  let closeVenue = (): void => {};
  let reconnect: NodeJS.Timeout | undefined;
  if (config.venue === "mock") {
    const mock = new RollingMockVenue({ windowSecs: config.mock.windowSecs, resolve: config.mock.resolve, now: Date.now });
    await adoptEarlierMarkets(mock, chain, registry, journal);
    venue = mock;
    log(`venue: mock, ${config.mock.windowSecs} s contracts, resolution ${config.mock.resolve}`);
  } else {
    const sandbox = new GeminiSandboxVenue({
      // Checked by `assertVenueAllowed`.
      apiKey: config.geminiApiKey ?? "",
      apiSecret: config.geminiApiSecret ?? "",
      onDisconnect: (info) => log(`venue socket closed: ${info.reason}`),
    });
    venue = sandbox;
    venueConnected = () => sandbox.connected;
    closeVenue = () => sandbox.close();
    try {
      await sandbox.connect();
      log("venue: sandbox, socket connected");
    } catch (error) {
      log(`venue: sandbox, socket not connected yet: ${messageOf(error)}`);
    }
    let connecting = false;
    reconnect = setInterval(() => {
      if (sandbox.connected || connecting) return;
      connecting = true;
      sandbox
        .ensureConnected()
        .then(() => log("venue socket connected"))
        .catch((error: unknown) => log(`venue socket: connection failed: ${messageOf(error)}`))
        .finally(() => (connecting = false));
    }, VENUE_RECONNECT_MS);
  }

  const now = Date.now;
  const manager = createMarketManager({ venue, chain, registry, series: config.series, now });
  const settlement = createSettlementWatcher({ venue, chain, registry, journal, now, alert: alerts.alert });
  const reconciler = createReconciler({ venue, chain, registry, journal, alert: alerts.alert });
  const daemon = createDaemon({
    identity: {
      cluster: config.cluster,
      venue: config.venue,
      programId: config.deployment.programId,
      relayer: config.deployment.relayer,
      stableMint: config.deployment.stableMint,
    },
    venue,
    chain,
    journal,
    manager,
    settlement,
    reconciler,
    alerts,
    log,
    ...(venueConnected === undefined ? {} : { venueConnected }),
  });
  const server = createApiServer({ port: config.port, handlers: createApiHandlers({ daemon, manager, journal }), log });

  const closeAll = (): void => {
    clearInterval(reconnect);
    closeVenue();
    chain.close();
    registry.close();
    journal.close();
  };

  let port: number;
  try {
    // Listening first also keeps a second relayer from starting on the same journal and keys.
    port = await server.listen();
  } catch (error) {
    closeAll();
    throw new Error(`cannot listen on 127.0.0.1:${config.port}: ${messageOf(error)}`);
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: stopping`);
    void (async () => {
      await Promise.race([daemon.stop(), new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS))]);
      await server.close();
      closeAll();
      log("stopped");
      process.exit(0);
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await daemon.start();
  log(
    `relayer started: cluster ${config.cluster}, program ${config.deployment.programId}, relayer ${config.deployment.relayer}, ` +
      `series ${config.series.join(",")}, api http://127.0.0.1:${port}`,
  );
}

async function printStatus(): Promise<number> {
  const base = `http://127.0.0.1:${relayerPort(process.env)}`;
  for (const route of ["/health", "/status"]) {
    let response: Response;
    try {
      response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(5_000) });
    } catch {
      console.error(`no relayer answers on ${base}`);
      return 1;
    }
    console.log(`${route} (${response.status})`);
    console.log(JSON.stringify(await response.json(), null, 2));
  }
  return 0;
}

async function pause(config: RelayerConfig): Promise<number> {
  const chain = await openChain(config);
  try {
    console.log(`about to set both pause bits (place and fill) on ${config.cluster}, program ${config.deployment.programId}`);
    console.log(`paused: ${await chain.pause({ place: true, fill: true })}`);
    return 0;
  } finally {
    chain.close();
  }
}

async function cancelExpired(config: RelayerConfig): Promise<number> {
  const chain = await openChain(config);
  try {
    const nowSecs = await chain.now();
    const expired = (await chain.openOrders()).filter((order) => order.expiresAt < nowSecs);
    console.log(`${expired.length} open order(s) past expiry on ${config.cluster}`);
    let failures = 0;
    for (const order of expired) {
      try {
        console.log(`cancelled ${order.address} (${order.kind} ${order.side} ${order.units} ${order.symbol}): ${await chain.cancel(order)}`);
      } catch (error) {
        failures += 1;
        console.error(`could not cancel ${order.address}: ${messageOf(error)}`);
      }
    }
    return failures === 0 ? 0 : 1;
  } finally {
    chain.close();
  }
}

async function settleByHand(config: RelayerConfig, symbol: string | undefined, side: string | undefined): Promise<number> {
  if (symbol === undefined || !SYMBOL.test(symbol) || (side !== "yes" && side !== "no")) {
    console.error("usage: node src/main.ts settle <symbol> <yes|no>");
    return 2;
  }
  const chain = await openChain(config);
  const registry = openRegistry(config.dbPath);
  try {
    const known = registry.get(symbol);
    if (known === undefined || known.marketAddress === null) throw new Error(`${symbol} is not an on-chain market in the registry`);
    const onchain = await chain.market(symbol);
    if (onchain === null) throw new Error(`${symbol} has no market account on ${config.cluster}`);
    if (onchain.status === "settled") {
      registry.setSettle(symbol, "settled", { detail: "found settled on-chain" });
      console.log(`${symbol} is already settled on-chain (YES pays ${onchain.yesPayout}, NO pays ${onchain.noPayout}); the registry now says so`);
      return 0;
    }
    const yesPayout = side === "yes" ? PAYOUT_PER_UNIT : 0n;
    const noPayout = PAYOUT_PER_UNIT - yesPayout;
    console.log(
      `about to settle ${symbol} on ${config.cluster}: ${side.toUpperCase()} wins (YES pays ${yesPayout}, NO pays ${noPayout} micro-dollars per unit); ` +
        `supplies YES ${onchain.yesSupply}, NO ${onchain.noSupply}; registry state ${known.settleState}`,
    );
    const signature = await chain.settleMarket(symbol, yesPayout, noPayout);
    registry.setSettle(symbol, "settled", { signature, detail: `settled by hand: ${side}` });
    console.log(`settled: ${signature}`);
    return 0;
  } finally {
    registry.close();
    chain.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case "start":
      await start(loadConfig(process.env, REPO_ROOT));
      return 0;
    case "status":
      return printStatus();
    case "pause":
      return pause(loadConfig(process.env, REPO_ROOT));
    case "cancel-expired":
      return cancelExpired(loadConfig(process.env, REPO_ROOT));
    case "settle":
      return settleByHand(loadConfig(process.env, REPO_ROOT), args[0], args[1]);
    default:
      console.error(USAGE);
      return 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`relayer: ${messageOf(error)}`);
  process.exitCode = 1;
}
