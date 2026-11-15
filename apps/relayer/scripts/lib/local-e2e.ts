// The run behind `scripts/local-e2e.ts`: starts `solana-test-validator` with the program loaded,
// bootstraps `localnet` and puts the relayer's parts around the simulated venue. An up-or-down
// contract and a ladder contract are picked from the events the venue lists; buys go through the
// order pipeline to an on-chain fill, one to a cancel with a full refund; the venue resolves both
// contracts after their expiry, the settlement watcher settles their markets, and every holder
// redeems.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import {
  createSolanaRpc,
  fetchEncodedAccount,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
  lamports,
  type Address,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import {
  fetchTrader,
  findEscrowPda,
  findTraderPda,
  findVaultPda,
  getPlaceBuyInstructionAsync,
  getRedeemInstructionAsync,
  getRegisterTraderInstructionAsync,
  ORDER_SEED,
  OUTCOME_TOKENS_PROGRAM_ADDRESS,
  Side,
} from "@outcome/program-client";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { fetchToken as fetchOutcomeToken, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import type { ApiEvent, ApiMarket } from "../../src/api/types.ts";
import type { ChainOrder } from "../../src/chain/chain.ts";
import { createSender, waitForSignature, type ChainRpc } from "../../src/chain/send.ts";
import { createSolanaChain, loadKeypairSigner } from "../../src/chain/solana.ts";
import { openJournal } from "../../src/journal.ts";
import { createMarketManager } from "../../src/markets.ts";
import { feeCap, PAYOUT_PER_UNIT, takerFee } from "../../src/money.ts";
import { DEFAULT_PIPELINE_CONFIG, processOrder, type PipelineDeps } from "../../src/pipeline.ts";
import { openRegistry } from "../../src/registry.ts";
import { createSettlementWatcher } from "../../src/settlement.ts";
import { RollingMockVenue } from "../../src/venue/mock-feed.ts";
import type { ContractInfo, EventInfo } from "../../src/venue/venue.ts";
import { bootstrap, LOCALNET_RPC_URL } from "./bootstrap.ts";

/** Length of the venue's 15-minute window, the shortest it takes. An hourly ladder then lives four of them. */
const WINDOW_SECS = 180;
const LADDER_LIFE_SECS = 4 * WINDOW_SECS;
/** Where the run meets the venue's schedule: this long before an hourly ladder and an up-or-down window expire together. */
const EXPIRES_IN_SECS = 210;
/** The top of the price grid: a buy with this limit takes the offer wherever the quote has moved to. */
const TAKE_PX = 9_900n;
/** The bottom of it: below every offer. */
const MISS_PX = 100n;
/** More YES than NO in each market: the venue account ends long, so a YES result pays it and the watcher has a payout to check. */
const YES_UNITS = 200n;
const NO_UNITS = 100n;
/** The whole run is abandoned (and the validator stopped) after this long. */
const RUN_TIMEOUT_MS = 480_000;
const PORTS = [8899, 8900, 9900];
const COMMITMENT = "confirmed";
const DUSD = 1_000_000n;
const LAMPORTS_PER_SOL = 1_000_000_000n;

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const programSo = process.env.PROGRAM_SO ?? path.join(repoRoot, "anchor", "target", "deploy", "outcome_tokens.so");
const ledgerDir = path.join(repoRoot, ".data", "local-e2e-ledger");
const programId = OUTCOME_TOKENS_PROGRAM_ADDRESS;

/** A registered user and their associated stable token account. */
interface Trader {
  signer: KeyPairSigner;
  stable: Address;
}

/**
 * The simulated venue on a clock that runs ahead, with every date it reports set back by as much.
 * The relayer and the chain keep one clock, and the run meets the venue's schedule at the point
 * it needs instead of waiting most of a ladder's life for one to come within reach.
 */
class MovedVenue extends RollingMockVenue {
  readonly #aheadMs: number;

  constructor(aheadMs: number) {
    super({ windowSecs: WINDOW_SECS, resolve: "yes", now: () => Date.now() + aheadMs });
    this.#aheadMs = aheadMs;
  }

  override async listEvents(): Promise<EventInfo[]> {
    return (await super.listEvents()).map((event) => ({
      ...event,
      listedAt: this.#back(event.listedAt),
      expiresAt: this.#back(event.expiresAt),
      contracts: event.contracts.map((info) => this.#moved(info)),
    }));
  }

  override async contract(symbol: string): Promise<ContractInfo | null> {
    const info = await super.contract(symbol);
    return info === null ? null : this.#moved(info);
  }

  #moved(info: ContractInfo): ContractInfo {
    return { ...info, effectiveAt: this.#back(info.effectiveAt), expiresAt: this.#back(info.expiresAt) };
  }

  #back(date: Date): Date {
    return new Date(date.getTime() - this.#aheadMs);
  }
}

let validator: ChildProcess | null = null;
let validatorExited = false;

function say(line: string): void {
  console.log(line);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(1_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const free = (): void => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", free);
    socket.once("timeout", free);
  });
}

async function startValidator(deployer: Address): Promise<void> {
  mkdirSync(path.dirname(ledgerDir), { recursive: true });
  const toolchain = path.join(homedir(), ".local/share/solana/install/active_release/bin");
  const child = spawn(
    "solana-test-validator",
    ["--reset", "--quiet", "--ledger", ledgerDir, "--upgradeable-program", programId, programSo, deployer],
    { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PATH: `${process.env.PATH ?? ""}${path.delimiter}${toolchain}` } },
  );
  validator = child;
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2_000);
  });
  let spawnError: Error | null = null;
  child.once("error", (error) => {
    spawnError = error;
    validatorExited = true;
  });
  child.once("exit", () => {
    validatorExited = true;
  });

  const rpc = createSolanaRpc(LOCALNET_RPC_URL);
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (spawnError !== null) throw new Error(`solana-test-validator could not be started: ${(spawnError as Error).message}`);
    if (validatorExited) throw new Error(`solana-test-validator exited during startup: ${stderr.trim() || `see ${ledgerDir}/validator.log`}`);
    try {
      if ((await rpc.getHealth().send()) === "ok") return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error("solana-test-validator did not become healthy within 90 s");
    await sleep(500);
  }
}

/** Stops the validator and waits until its process is gone. */
async function stopValidator(): Promise<void> {
  const child = validator;
  validator = null;
  if (child === null) return;
  if (!validatorExited) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(killTimer);
  }
  rmSync(ledgerDir, { recursive: true, force: true });
}

// Last line of defence: never leave the child running, whatever ends this process.
process.on("exit", () => {
  if (validator !== null && !validatorExited) validator.kill("SIGKILL");
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    void stopValidator().finally(() => process.exit(1));
  });
}

async function stableBalance(rpc: ChainRpc, account: Address): Promise<bigint> {
  return (await fetchToken(rpc, account, { commitment: COMMITMENT })).data.amount;
}

/** Compute units a confirmed transaction consumed, for the report. */
async function unitsConsumed(rpc: ChainRpc, signature: string | null | undefined): Promise<string> {
  if (!signature) return "unknown";
  const transaction = await rpc
    .getTransaction(signature as Signature, { commitment: COMMITMENT, encoding: "json", maxSupportedTransactionVersion: 0 })
    .send();
  return transaction?.meta?.computeUnitsConsumed?.toString() ?? "unknown";
}

/** Compute units the program's own instruction consumed in a confirmed transaction. */
async function programUnits(rpc: ChainRpc, signature: string): Promise<string> {
  const transaction = await rpc
    .getTransaction(signature as Signature, { commitment: COMMITMENT, encoding: "json", maxSupportedTransactionVersion: 0 })
    .send();
  const line = new RegExp(`^Program ${programId} consumed (\\d+) of \\d+ compute units$`);
  const consumed = (transaction?.meta?.logMessages ?? []).map((log) => line.exec(log)?.[1]).filter((units) => units !== undefined);
  return consumed.at(-1) ?? "unknown";
}

async function accountExists(rpc: ChainRpc, account: Address): Promise<boolean> {
  return (await fetchEncodedAccount(rpc, account, { commitment: COMMITMENT })).exists;
}

/** Waits until the cluster clock (unix seconds) has reached `target`. */
async function waitForClusterTime(chain: { now(): Promise<number> }, target: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await chain.now()) >= target) return;
    if (Date.now() > deadline) throw new Error(`the cluster clock did not reach ${target} within ${timeoutMs} ms`);
    await sleep(1_000);
  }
}

async function run(): Promise<void> {
  if (!existsSync(programSo)) throw new Error(`program binary not found: ${programSo} (set PROGRAM_SO)`);
  for (const port of PORTS) {
    if (await portInUse(port)) {
      throw new Error(`port ${port} is already in use: stop whatever is listening there (a validator?) and run again; nothing was started or stopped`);
    }
  }
  const deployer = await loadKeypairSigner(path.join(repoRoot, ".keys", "deployer-keypair.json"));

  say(`starting solana-test-validator with ${path.relative(repoRoot, programSo)}`);
  await startValidator(deployer.address);

  say("--- bootstrap localnet");
  const { deployment, configDifferences } = await bootstrap({ cluster: "localnet", rpcUrl: LOCALNET_RPC_URL, repoRoot, log: (line) => say(`  ${line}`) });
  assert.deepEqual(configDifferences, [], "a freshly initialized config matches the expected values");

  const again = await bootstrap({ cluster: "localnet", rpcUrl: LOCALNET_RPC_URL, repoRoot, log: () => {} });
  assert.deepEqual(again.deployment, deployment, "a second bootstrap changes nothing");
  assert.deepEqual(again.configDifferences, [], "a second bootstrap finds the config as expected");

  const rpc = createSolanaRpc(LOCALNET_RPC_URL);
  const sender = createSender({ rpc, programId, commitment: COMMITMENT, computeUnitLimit: 300_000, confirmTimeoutMs: 45_000 });
  const relayer = await loadKeypairSigner(path.join(repoRoot, ".keys", "relayer-keypair.json"));
  const settler = await loadKeypairSigner(path.join(repoRoot, ".keys", "settler-keypair.json"));
  const registrar = await loadKeypairSigner(path.join(repoRoot, ".keys", "registrar-keypair.json"));
  const stableMint = deployment.stableMint as Address;
  const treasury = deployment.treasury as Address;
  const faucet = deployment.faucet as Address;

  const chainLog: string[] = [];
  const chain = createSolanaChain({
    rpcUrl: LOCALNET_RPC_URL,
    programId,
    relayer,
    settler,
    stableMint,
    treasury,
    relayerFloat: deployment.relayerFloat,
    log: (line) => {
      chainLog.push(line);
      say(`  chain: ${line}`);
    },
  });
  const chainConfig = await chain.config();
  assert.equal(chainConfig.relayer, relayer.address);
  assert.equal(chainConfig.treasury, treasury);
  assert.equal(chainConfig.orderTtlSecs, 90);
  assert.equal(chainConfig.pausePlace, false);

  // Open question: does `init` work on an address that already holds lamports?
  say("--- prefunded trader account");
  await prefundProbe(rpc, sender, registrar);

  // 1. Fresh users: SOL, a trader account, 1_000 dUSD from the faucet each.
  say("--- step 1: users");
  const newUser = async (role: string): Promise<Trader> => {
    const signer = await generateKeyPairSigner();
    await waitForSignature(rpc, await rpc.requestAirdrop(signer.address, lamports(LAMPORTS_PER_SOL), { commitment: COMMITMENT }).send(), COMMITMENT, 30_000);
    const [stable] = await findAssociatedTokenPda({ owner: signer.address, mint: stableMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    await sender.send(registrar, [
      await getRegisterTraderInstructionAsync({ registrar, payer: registrar, user: signer.address }),
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: registrar, owner: signer.address, mint: stableMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
      getTransferCheckedInstruction({ source: faucet, mint: stableMint, destination: stable, authority: registrar, amount: 1_000n * DUSD, decimals: 6 }),
    ]);
    assert.equal(await stableBalance(rpc, stable), 1_000n * DUSD, "the user holds 1_000 dUSD");
    say(`  ${role} ${signer.address} registered and funded`);
    return { signer, stable };
  };
  const yesHolder = await newUser("YES buyer of the up-or-down contract");
  const noHolder = await newUser("NO buyer of the up-or-down contract");
  const ladderYes = await newUser("YES buyer of the ladder contract");
  const ladderNo = await newUser("NO buyer of the ladder contract");
  const user = yesHolder.signer;
  const userStable = yesHolder.stable;

  // 2. The simulated venue, met a few minutes before one of its hourly ladders and an up-or-down
  // window expire together, and the relayer's parts around it.
  say("--- step 2: the venue");
  const aheadSecs = LADDER_LIFE_SECS - ((Math.floor(Date.now() / 1_000) + EXPIRES_IN_SECS) % LADDER_LIFE_SECS);
  const venue = new MovedVenue(aheadSecs * 1_000);
  const journal = openJournal(":memory:");
  const registry = openRegistry(":memory:");
  const manager = createMarketManager({ venue, chain, registry, now: () => Date.now() });
  const alerts: string[] = [];
  const deps: PipelineDeps = {
    venue,
    chain,
    journal,
    config: DEFAULT_PIPELINE_CONFIG,
    sleep,
    alert: (event) => {
      alerts.push(`${event.kind}: ${event.detail}`);
      say(`  alert ${event.kind}: ${event.detail}`);
    },
  };
  const watcherAlerts: string[] = [];
  const watcher = createSettlementWatcher({
    venue,
    chain,
    registry,
    journal,
    confirmMs: 2_000,
    now: () => Date.now(),
    alert: (event) => {
      watcherAlerts.push(`${event.kind}: ${event.detail}`);
      say(`  watcher alert ${event.kind}: ${event.detail}`);
    },
  });

  const placeBuy = async (buyer: Trader, onMarket: Address, side: Side, units: bigint, limitPx: bigint): Promise<{ order: Address; escrow: Address }> => {
    const [trader] = await findTraderPda({ user: buyer.signer.address });
    const nonce = (await fetchTrader(rpc, trader, { commitment: COMMITMENT })).data.nextNonce;
    const [order] = await getProgramDerivedAddress({
      programAddress: programId,
      seeds: [ORDER_SEED, getAddressEncoder().encode(buyer.signer.address), getU64Encoder().encode(nonce)],
    });
    const [escrow] = await findEscrowPda({ order });
    await sender.send(buyer.signer, [
      await getPlaceBuyInstructionAsync({
        user: buyer.signer,
        payer: buyer.signer,
        market: onMarket,
        order,
        userStable: buyer.stable,
        stableMint,
        side,
        qtyUnits: units,
        limitPx: Number(limitPx),
        maxFee: feeCap(units, limitPx),
      }),
    ]);
    return { order, escrow };
  };
  const outcomeBalance = async (owner: Address, mint: Address): Promise<bigint> => {
    const [account] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    return (await fetchOutcomeToken(rpc, account, { commitment: COMMITMENT })).data.amount;
  };
  /** One transaction signed by the holder: the stable account if it is missing, then `redeem`. */
  const redeem = async (holder: Trader, onMarket: Address, outcomeMint: Address, amount: bigint): Promise<string> => {
    const [holderOutcome] = await findAssociatedTokenPda({ owner: holder.signer.address, mint: outcomeMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    return sender.send(holder.signer, [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: holder.signer, owner: holder.signer.address, mint: stableMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
      await getRedeemInstructionAsync({ holder: holder.signer, market: onMarket, outcomeMint, holderOutcome, holderStable: holder.stable, stableMint, amount }),
    ]);
  };
  const openOrder = async (order: Address): Promise<ChainOrder> => {
    const open = await chain.openOrders();
    const found = open.find((candidate) => candidate.address === order);
    assert.ok(found !== undefined, `openOrders returns ${order}`);
    return found;
  };
  /** The first contract that can be traded now among the events of a shape, soonest expiry first. */
  const offered = async (shape: ApiEvent["shape"]): Promise<ApiMarket | undefined> => {
    await manager.refresh();
    return manager
      .eventViews()
      .filter((event) => event.shape === shape)
      .flatMap((event) => event.markets)
      .find((market) => market.tradable);
  };
  /** Creates the on-chain market of a listed contract through the market manager. */
  const createMarket = async (listed: ApiMarket, placeCutoffSecs: number): Promise<{ address: Address; yesMint: Address; noMint: Address }> => {
    assert.equal(await chain.market(listed.symbol), null, "the market does not exist yet");
    const onchain = (await manager.ensureOnchain(listed.symbol)).onchain;
    assert.ok(onchain !== null, `the market of ${listed.symbol} exists on-chain`);
    assert.deepEqual(
      { status: onchain.status, closeTs: onchain.closeTs, placeCutoffSecs: onchain.placeCutoffSecs, yesSupply: onchain.yesSupply, noSupply: onchain.noSupply },
      { status: "open", closeTs: listed.expiresAt / 1_000, placeCutoffSecs, yesSupply: "0", noSupply: "0" },
    );
    assert.equal(registry.get(listed.symbol)?.marketAddress, onchain.market);
    assert.deepEqual((await manager.ensureOnchain(listed.symbol)).onchain, onchain, "a second request leaves the market as it is");
    say(`  market ${onchain.market} for ${listed.symbol}, mints ${onchain.yesMint} / ${onchain.noMint}`);
    return { address: onchain.market as Address, yesMint: onchain.yesMint as Address, noMint: onchain.noMint as Address };
  };
  /** The first buy of a user: it takes the venue's offer and goes through the pipeline to its on-chain fill. */
  const buy = async (buyer: Trader, onMarket: Address, side: Side, units: bigint) => {
    const placed = await placeBuy(buyer, onMarket, side, units, TAKE_PX);
    const chainOrder = await openOrder(placed.order);
    assert.equal(await processOrder(chainOrder, deps), "chain_filled");
    const row = journal.get(placed.order);
    assert.equal(row?.state, "chain_filled", "journal row is chain_filled");
    const fills = journal.fills(placed.order);
    assert.equal(fills.length, 1, "the venue filled the order in one trade");
    const px = fills[0]!.px;
    assert.equal(row.amountMicros, units * px, "the cost is the units at the fill price");
    assert.equal(row.feeMicros, takerFee(units, px));
    assert.equal(await stableBalance(rpc, buyer.stable), 1_000n * DUSD - row.amountMicros - row.feeMicros, "the buyer paid cost + fee and nothing else");
    return { chainOrder, px };
  };

  // 3. A contract of the ladder that expires within the run: its market, a YES and a NO buy.
  say("--- step 3: a ladder contract");
  const ladder = await offered("ladder");
  assert.ok(ladder !== undefined, "the venue offers a ladder contract that can be traded now");
  assert.ok(ladder.expiresAt - Date.now() <= EXPIRES_IN_SECS * 1_000, "it is a contract of the ladder that expires within the run");
  say(
    `  ${ladder.symbol} (${ladder.title}: ${ladder.label}) expires in ${Math.round((ladder.expiresAt - Date.now()) / 1_000)} s; ` +
      `the cluster clock is ${(await chain.now()) - Math.floor(Date.now() / 1_000)} s ahead of the local clock`,
  );
  const ladderMarket = await createMarket(ladder, 150); // up to 15 minutes of life: 2 minutes before expiry, plus the 30 s buffer
  const marketSignature = /^market \S+: 3 instruction\(s\) in (\S+)$/.exec(chainLog.at(-1) ?? "")?.[1];
  const ladderYesBuy = await buy(ladderYes, ladderMarket.address, Side.Yes, YES_UNITS);
  const ladderNoBuy = await buy(ladderNo, ladderMarket.address, Side.No, NO_UNITS);
  assert.equal(await outcomeBalance(ladderYes.signer.address, ladderMarket.yesMint), YES_UNITS, "the YES buyer holds the YES units");
  assert.equal(await outcomeBalance(ladderNo.signer.address, ladderMarket.noMint), NO_UNITS, "the NO buyer holds the NO units");
  say(`  YES filled at ${ladderYesBuy.px}, NO at ${ladderNoBuy.px}`);

  // 4. An up-or-down contract, as soon as its window has opened.
  say("--- step 4: an up-or-down contract");
  const opensBy = Date.now() + 90_000;
  let up = await offered("binary");
  while (up === undefined) {
    assert.ok(Date.now() < opensBy, "an up-or-down contract became tradable within 90 s");
    await sleep(1_000);
    up = await offered("binary");
  }
  // The pipeline goes by the cluster clock, which can be behind the local one.
  await waitForClusterTime(chain, up.startsAt / 1_000 + 1, 30_000);
  say(`  ${up.symbol} (${up.title}: ${up.label}) expires in ${Math.round((up.expiresAt - Date.now()) / 1_000)} s`);
  const upMarket = await createMarket(up, 90); // up to 5 minutes of life: 1 minute before expiry, plus the 30 s buffer
  const { yesMint, noMint } = upMarket;

  // 5. A buy with room above the offer: filled at the venue's price, then on-chain.
  say("--- step 5: a buy that fills");
  const treasuryBefore = await chain.treasuryMicros();
  const first = await placeBuy(yesHolder, upMarket.address, Side.Yes, YES_UNITS, TAKE_PX);
  const maxFee = feeCap(YES_UNITS, TAKE_PX);
  assert.equal(await stableBalance(rpc, userStable), 1_000n * DUSD - YES_UNITS * TAKE_PX - maxFee, "the cost at the limit and the fee allowance are escrowed");
  const firstOrder = await openOrder(first.order);
  assert.deepEqual(
    { ...firstOrder, addressBytes: null, expiresAt: null },
    { address: first.order, addressBytes: null, user: user.address, symbol: up.symbol, side: "YES", kind: "buy", units: YES_UNITS, limitPx: TAKE_PX, maxFeeMicros: maxFee, expiresAt: null },
  );
  assert.equal(await chain.orderExists(first.order), true);
  assert.equal(await processOrder(firstOrder, deps), "chain_filled");
  const filledRow = journal.get(first.order);
  assert.equal(filledRow?.state, "chain_filled", "journal row is chain_filled");
  assert.ok(filledRow.chainSignature !== null, "the fill signature is journaled");
  const fillPx = journal.fills(first.order)[0]?.px;
  assert.ok(fillPx !== undefined && fillPx < TAKE_PX, "the venue filled at its offer, below the limit");
  const costMicros = YES_UNITS * fillPx;
  const feeMicros = takerFee(YES_UNITS, fillPx);
  assert.equal(filledRow.amountMicros, costMicros);
  assert.equal(filledRow.feeMicros, feeMicros);
  assert.equal(await outcomeBalance(user.address, yesMint), YES_UNITS, "the user holds the YES units");
  assert.equal((await chain.treasuryMicros()) - treasuryBefore, costMicros + feeMicros, "the treasury received exactly cost + fee");
  assert.equal(await stableBalance(rpc, userStable), 1_000n * DUSD - costMicros - feeMicros, "what the fill did not use of the escrow was refunded");
  assert.equal(await accountExists(rpc, first.order), false, "the order account is closed");
  assert.equal(await accountExists(rpc, first.escrow), false, "the escrow account is closed");
  assert.equal(await chain.orderExists(first.order), false);
  assert.equal((await chain.market(up.symbol))?.yesSupply, YES_UNITS, "the YES supply is what was bought");
  assert.equal(
    await chain.fillBuy(firstOrder, { fillUnits: YES_UNITS, costMicros, feeMicros }),
    filledRow.chainSignature,
    "a repeated fillBuy resolves with the signature of the fill that landed",
  );
  await assert.rejects(chain.cancel(firstOrder), /^Error: order closed: filled in /, "a cancel of a filled order is refused");
  say(`  filled at ${fillPx} in ${filledRow.chainSignature}`);

  // 6. A buy below every offer: not filled, cancelled, fully refunded.
  say("--- step 6: a buy that does not fill");
  const stableBefore = await stableBalance(rpc, userStable);
  const second = await placeBuy(yesHolder, upMarket.address, Side.Yes, YES_UNITS, MISS_PX);
  const secondOrder = await openOrder(second.order);
  assert.equal(await processOrder(secondOrder, deps), "chain_cancelled");
  const cancelledRow = journal.get(second.order);
  assert.equal(cancelledRow?.state, "chain_cancelled", "journal row is chain_cancelled");
  assert.ok(cancelledRow.chainSignature !== null, "the cancel signature is journaled");
  assert.equal(await stableBalance(rpc, userStable), stableBefore, "the escrow was refunded in full");
  assert.equal(await accountExists(rpc, second.order), false, "the order account is closed");
  assert.equal(await accountExists(rpc, second.escrow), false, "the escrow account is closed");
  assert.equal((await chain.market(up.symbol))?.yesSupply, YES_UNITS, "nothing was minted");
  assert.equal(await chain.cancel(secondOrder), cancelledRow.chainSignature, "a repeated cancel resolves with the signature of the cancel that landed");
  await assert.rejects(
    chain.fillBuy(secondOrder, { fillUnits: YES_UNITS, costMicros: YES_UNITS * MISS_PX, feeMicros: 0n }),
    /^Error: order closed: cancelled in /,
    "a fill of a cancelled order is refused",
  );
  say(`  cancelled in ${cancelledRow.chainSignature}`);

  // 7. A second user buys NO: the venue order takes from the bids.
  say("--- step 7: a NO buy that fills");
  const noBuy = await buy(noHolder, upMarket.address, Side.No, NO_UNITS);
  assert.equal(noBuy.chainOrder.side, "NO");
  assert.equal(await outcomeBalance(noHolder.signer.address, noMint), NO_UNITS, "the second user holds the NO units");
  const beforeSettlement = await chain.market(up.symbol);
  assert.deepEqual(
    { status: beforeSettlement?.status, yes: beforeSettlement?.yesSupply, no: beforeSettlement?.noSupply, yesPayout: beforeSettlement?.yesPayout, redeemAfter: beforeSettlement?.redeemAfter },
    { status: "open", yes: YES_UNITS, no: NO_UNITS, yesPayout: null, redeemAfter: null },
  );
  assert.deepEqual(await chain.openOrders(), [], "no order is left open");
  assert.deepEqual(alerts, [], "the pipeline raised no alert");

  // 8. The automatic path: the venue resolves both contracts after their expiry and the watcher
  // settles their markets, funding each vault from the treasury.
  say("--- step 8: the settlement watcher");
  const held = [
    { listed: up, market: upMarket, yes: yesHolder, no: noHolder },
    { listed: ladder, market: ladderMarket, yes: ladderYes, no: ladderNo },
  ];
  const vaults: Address[] = [];
  for (const { market } of held) {
    const [vault] = await findVaultPda({ market: market.address });
    assert.equal(await accountExists(rpc, vault), false, "the vault does not exist before settlement");
    vaults.push(vault);
  }
  await watcher.tick();
  for (const { listed } of held) {
    assert.equal(registry.get(listed.symbol)?.settleState, "open", "the watcher looks at a market before its expiry and leaves it open");
  }
  const expiry = Math.max(up.expiresAt, ladder.expiresAt);
  say(`  waiting ${Math.max(0, Math.round((expiry - Date.now()) / 1_000))} s for the expiry`);
  await sleep(Math.max(0, expiry - Date.now()) + 250);
  const treasuryBeforeSettlement = await chain.treasuryMicros();
  const watcherDeadline = Date.now() + 60_000;
  let ticks = 0;
  for (;;) {
    await watcher.tick();
    ticks += 1;
    const rows = held.map(({ listed }) => registry.get(listed.symbol));
    if (rows.every((row) => row?.settleState === "settled")) break;
    for (const row of rows) {
      assert.ok(
        row?.settleState === "awaiting_result" || row?.settleState === "settled",
        `${row?.symbol} is waiting for its settlement (${row?.settleState}: ${row?.detail ?? "no detail"})`,
      );
    }
    assert.ok(Date.now() < watcherDeadline, "the watcher settled both markets within 60 s of their expiry");
    await sleep(1_000);
  }
  assert.ok(ticks >= 2, "the resolutions were confirmed over more than one tick");
  assert.deepEqual(watcherAlerts, [], "the watcher raised no alert");
  const settledAt = await chain.now();
  say(`  both markets settled after ${ticks} ticks`);

  // 9. Redemption is locked until redeemAfter.
  say("--- step 9: a redeem before redeemAfter");
  const lockedUntil = (await chain.market(up.symbol))?.redeemAfter;
  assert.ok(lockedUntil != null, "a settled market has a redeemAfter");
  assert.ok((await chain.now()) < lockedUntil, "the early redeem is sent before redeemAfter");
  await assert.rejects(redeem(yesHolder, upMarket.address, yesMint, YES_UNITS), /RedeemLocked/, "an early redeem fails with RedeemLocked");
  assert.equal(await outcomeBalance(user.address, yesMint), YES_UNITS, "nothing was burned");
  say("  refused with RedeemLocked");

  // 10. What the watcher did: each market settled the way the venue resolved its contract.
  say("--- step 10: the settlements");
  assert.equal(registry.get(up.symbol)?.resolution, "yes", "the up-or-down contract resolved the way the venue was told to");
  const settlements: Array<{ side: "yes" | "no"; signature: string }> = [];
  let funded = 0n;
  let redeemAfter = 0;
  for (const [index, { listed }] of held.entries()) {
    const row = registry.get(listed.symbol);
    const side = row?.resolution;
    assert.ok(side === "yes" || side === "no", `the registry has the resolution of ${listed.symbol}`);
    const [yesPayout, noPayout] = side === "yes" ? [PAYOUT_PER_UNIT, 0n] : [0n, PAYOUT_PER_UNIT];
    const settled = await chain.market(listed.symbol);
    assert.deepEqual(
      { status: settled?.status, yesPayout: settled?.yesPayout, noPayout: settled?.noPayout, yes: settled?.yesSupply, no: settled?.noSupply },
      { status: "settled", yesPayout, noPayout, yes: YES_UNITS, no: NO_UNITS },
      `${listed.symbol} is settled on-chain the way the venue resolved it`,
    );
    assert.ok(settled?.redeemAfter != null, "a settled market has a redeemAfter");
    assert.ok(
      settled.redeemAfter <= settledAt + chainConfig.settleDelaySecs && settled.redeemAfter >= settledAt + chainConfig.settleDelaySecs - 20,
      `redeemAfter ${settled.redeemAfter} is settle_delay_secs after the settlement (cluster clock then ${settledAt})`,
    );
    redeemAfter = Math.max(redeemAfter, settled.redeemAfter);
    const funding = (side === "yes" ? YES_UNITS : NO_UNITS) * PAYOUT_PER_UNIT;
    assert.equal(await stableBalance(rpc, vaults[index]!), funding, "the vault holds exactly what the winning side can claim");
    funded += funding;
    const signature = row?.settleSignature;
    assert.ok(typeof signature === "string", "the registry has the settlement signature");
    assert.equal(await chain.settleMarket(listed.symbol, yesPayout, noPayout), signature, "a repeated settleMarket resolves with the signature of the watcher's settlement");
    await assert.rejects(chain.settleMarket(listed.symbol, noPayout, yesPayout), /^Error: already settled: /, "other payouts for a settled market are refused");
    settlements.push({ side, signature });
    say(`  ${listed.symbol}: ${side.toUpperCase()} wins, settled in ${signature}, redemption opens at ${settled.redeemAfter}`);
  }
  assert.equal(treasuryBeforeSettlement - (await chain.treasuryMicros()), funded, "the treasury funded both vaults");
  const settleSignature = settlements[0]!.signature;

  // 11. Winners are paid 10_000 per unit, losers nothing; the vaults end empty.
  say(`--- step 11: redeem, once the cluster clock has reached ${redeemAfter}`);
  await waitForClusterTime(chain, redeemAfter, 120_000);
  const redeems: Array<{ yes: string; no: string }> = [];
  for (const [index, { listed, market, yes, no }] of held.entries()) {
    const { side } = settlements[index]!;
    const yesStableBefore = await stableBalance(rpc, yes.stable);
    const yesSignature = await redeem(yes, market.address, market.yesMint, YES_UNITS);
    assert.equal((await stableBalance(rpc, yes.stable)) - yesStableBefore, side === "yes" ? YES_UNITS * PAYOUT_PER_UNIT : 0n, "the YES holder received units * 10_000 if YES won, else nothing");
    assert.equal(await outcomeBalance(yes.signer.address, market.yesMint), 0n, "the YES units were burned");
    const noStableBefore = await stableBalance(rpc, no.stable);
    const noSignature = await redeem(no, market.address, market.noMint, NO_UNITS);
    assert.equal((await stableBalance(rpc, no.stable)) - noStableBefore, side === "no" ? NO_UNITS * PAYOUT_PER_UNIT : 0n, "the NO holder received units * 10_000 if NO won, else nothing");
    assert.equal(await outcomeBalance(no.signer.address, market.noMint), 0n, "the NO units were burned");
    const redeemed = await chain.market(listed.symbol);
    assert.deepEqual({ status: redeemed?.status, yes: redeemed?.yesSupply, no: redeemed?.noSupply }, { status: "settled", yes: 0n, no: 0n }, "both supplies are zero");
    assert.equal(await stableBalance(rpc, vaults[index]!), 0n, "the vault is empty");
    redeems.push({ yes: yesSignature, no: noSignature });
    say(`  ${listed.symbol}: YES redeemed in ${yesSignature}, NO in ${noSignature}`);
  }
  const redeemYesSignature = redeems[0]!.yes;
  const redeemNoSignature = redeems[0]!.no;
  assert.deepEqual(alerts, [], "the pipeline raised no alert");

  say(
    `--- compute units of the 300000 limit (whole transaction): market and both mints ${await unitsConsumed(rpc, marketSignature)}, ` +
      `fill_buy with two token accounts ${await unitsConsumed(rpc, filledRow.chainSignature)}, ` +
      `cancel_order ${await unitsConsumed(rpc, cancelledRow.chainSignature)}, ` +
      `settle_market ${await unitsConsumed(rpc, settleSignature)}, ` +
      `redeem YES with the token-account instruction ${await unitsConsumed(rpc, redeemYesSignature)}, ` +
      `redeem NO ${await unitsConsumed(rpc, redeemNoSignature)}`,
  );
  say(
    `--- compute units of the program instruction alone: settle_market ${await programUnits(rpc, settleSignature)}, ` +
      `redeem with a payout ${await programUnits(rpc, redeemYesSignature)}, redeem without a payout ${await programUnits(rpc, redeemNoSignature)}`,
  );

  assert.ok((await chain.relayerLamports()) > 0n);
  journal.close();
  registry.close();
  chain.close();
}

/**
 * Sends lamports to a trader address that does not exist yet, then registers that trader, and
 * reports what happened. Informational: it never fails the run.
 */
async function prefundProbe(rpc: ChainRpc, sender: ReturnType<typeof createSender>, registrar: KeyPairSigner): Promise<void> {
  try {
    const stranger = await generateKeyPairSigner();
    const [trader] = await findTraderPda({ user: stranger.address });
    let prefund = 1n;
    try {
      await sender.send(registrar, [getTransferSolInstruction({ source: registrar, destination: trader, amount: prefund })]);
    } catch (error) {
      say(`  PREFUND PROBE: sending 1 lamport to the trader address was refused (${(error as Error).message})`);
      prefund = await rpc.getMinimumBalanceForRentExemption(0n).send();
      await sender.send(registrar, [getTransferSolInstruction({ source: registrar, destination: trader, amount: prefund })]);
    }
    const before = (await rpc.getBalance(trader, { commitment: COMMITMENT }).send()).value;
    say(`  PREFUND PROBE: trader address holds ${before} lamports before register_trader`);
    try {
      const signature = await sender.send(registrar, [await getRegisterTraderInstructionAsync({ registrar, payer: registrar, user: stranger.address })]);
      const account = await fetchTrader(rpc, trader, { commitment: COMMITMENT });
      say(`  PREFUND PROBE: register_trader SUCCEEDED on a prefunded address (${prefund} lamports sent first; account now holds ${account.lamports} lamports; ${signature})`);
    } catch (error) {
      say(`  PREFUND PROBE: register_trader FAILED on a prefunded address (${prefund} lamports sent first): ${(error as Error).message}`);
    }
  } catch (error) {
    say(`  PREFUND PROBE: could not be completed: ${(error as Error).message}`);
  }
}

let failure: unknown = null;
let watchdog: NodeJS.Timeout | undefined;
try {
  await Promise.race([
    run(),
    new Promise<never>((_resolve, reject) => {
      watchdog = setTimeout(() => reject(new Error(`the run did not finish within ${RUN_TIMEOUT_MS / 1000} s`)), RUN_TIMEOUT_MS);
    }),
  ]);
} catch (error) {
  failure = error;
}
clearTimeout(watchdog);
await stopValidator();
if (failure !== null) {
  console.error(`LOCAL E2E FAILED: ${failure instanceof Error ? failure.message : String(failure)}`);
  process.exit(1);
}
say("LOCAL E2E OK");
process.exit(0);
