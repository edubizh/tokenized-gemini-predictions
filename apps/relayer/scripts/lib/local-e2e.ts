// The run behind `scripts/local-e2e.ts`: starts `solana-test-validator` with the program loaded,
// bootstraps `localnet`, then takes one buy through the order pipeline to an on-chain fill and a
// second one to a cancel with a full refund, settles the market and redeems both sides, and lets
// the settlement watcher settle a second, short-lived market on its own.

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
import type { ChainOrder } from "../../src/chain/chain.ts";
import { createSender, waitForSignature, type ChainRpc } from "../../src/chain/send.ts";
import { createSolanaChain, loadKeypairSigner } from "../../src/chain/solana.ts";
import { openJournal } from "../../src/journal.ts";
import { createMarketManager } from "../../src/markets.ts";
import { feeCap, PAYOUT_PER_UNIT, takerFee } from "../../src/money.ts";
import { DEFAULT_PIPELINE_CONFIG, processOrder, type PipelineDeps } from "../../src/pipeline.ts";
import { openRegistry } from "../../src/registry.ts";
import { createSettlementWatcher } from "../../src/settlement.ts";
import { MockVenue } from "../../src/venue/mock.ts";
import { bootstrap, LOCALNET_RPC_URL } from "./bootstrap.ts";

const SYMBOL = "TEST-BTC15M-UP";
/** The short-lived market the settlement watcher settles. */
const FAST_SYMBOL = "TEST-FAST3M-UP";
const FAST_SERIES = "FAST3M";
/** Seconds from its creation to its expiry, and how long before that it "started". */
const FAST_EXPIRES_IN_SECS = 150;
const FAST_STARTED_AGO_SECS = 60;
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
  const yesHolder = await newUser("YES buyer");
  const noHolder = await newUser("NO buyer");
  const fastBuyer = await newUser("buyer in the fast market");
  const user = yesHolder.signer;
  const userStable = yesHolder.stable;

  // 2. The mock venue with one contract, and its market on-chain.
  say("--- step 2: market");
  const now = await chain.now();
  const expiresAt = now + 600;
  const venue = new MockVenue({ feeFor: takerFee });
  venue.addContract({
    symbol: SYMBOL,
    eventTicker: "TEST-BTC15M",
    status: "active",
    marketState: "open",
    effectiveAt: new Date((now - 300) * 1000),
    expiresAt: new Date(expiresAt * 1000),
    tickPx: 100n,
    unitIncrement: 1n,
    minUnits: 1n,
    resolutionSide: null,
  });
  venue.setBook(SYMBOL, { bids: [[4_000n, 1_000_000n]], asks: [[4_500n, 1_000_000n]] });
  venue.setCash(1_000_000n * DUSD);
  assert.equal(await chain.market(SYMBOL), null, "the market does not exist yet");
  const spec = {
    symbol: SYMBOL,
    closeTs: expiresAt,
    placeCutoffSecs: 150,
    tickPx: 100n,
    maxSupplyUnits: 1_000_000n,
    yes: { name: "BTC Up test YES", ticker: "BTCYTEST", uri: "" },
    no: { name: "BTC Up test NO", ticker: "BTCNTEST", uri: "" },
  };
  const market = await chain.ensureMarket(spec);
  assert.equal(market.symbol, SYMBOL);
  assert.equal(market.status, "open");
  assert.equal(market.closeTs, expiresAt);
  assert.equal(market.tickPx, 100n);
  assert.ok(market.yesMint !== null && market.noMint !== null, "both outcome mints exist");
  const marketAddress = market.address as Address;
  const yesMint = market.yesMint as Address;
  const noMint = market.noMint as Address;
  assert.equal(market.yesSupply, 0n);
  assert.deepEqual(await chain.ensureMarket(spec), market, "ensureMarket leaves an existing market alone");
  const marketSignature = /^market \S+: 3 instruction\(s\) in (\S+)$/.exec(chainLog.at(-1) ?? "")?.[1];
  say(`  market ${market.address} with mints ${market.yesMint} / ${market.noMint}`);

  const journal = openJournal(":memory:");
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

  // The market of the automatic settlement path. It is created now so that its short life runs
  // while the steps below take place; the watcher settles it at the end.
  say("--- fast market: created through the market manager, one YES buy");
  const fastCreatedAt = await chain.now();
  const fastExpiresAt = fastCreatedAt + FAST_EXPIRES_IN_SECS;
  say(`  expires at ${fastExpiresAt}; the cluster clock is ${fastCreatedAt - Math.floor(Date.now() / 1000)} s ahead of the local clock`);
  venue.addContract({
    symbol: FAST_SYMBOL,
    eventTicker: "TEST-FAST3M",
    series: FAST_SERIES,
    title: "Fast test market",
    label: "Up",
    status: "active",
    marketState: "open",
    effectiveAt: new Date((fastCreatedAt - FAST_STARTED_AGO_SECS) * 1000),
    expiresAt: new Date(fastExpiresAt * 1000),
    tickPx: 100n,
    unitIncrement: 1n,
    minUnits: 1n,
    resolutionSide: null,
  });
  venue.setBook(FAST_SYMBOL, { bids: [[4_000n, 1_000_000n]], asks: [[4_500n, 1_000_000n]] });
  const registry = openRegistry(":memory:");
  const manager = createMarketManager({ venue, chain, registry, series: [FAST_SERIES], now: () => Date.now() });
  await manager.refresh();
  assert.equal(registry.get(SYMBOL), undefined, "only the curated series is in the registry");
  const fastOnchain = (await manager.ensureOnchain(FAST_SYMBOL)).onchain;
  assert.ok(fastOnchain !== null, "the fast market exists on-chain");
  assert.equal(fastOnchain.status, "open");
  assert.equal(fastOnchain.closeTs, fastExpiresAt);
  assert.equal(fastOnchain.placeCutoffSecs, 90, "a market of up to 5 minutes stops 60 s before expiry, plus the 30 s buffer");
  assert.equal(registry.get(FAST_SYMBOL)?.marketAddress, fastOnchain.market);
  const fastOrder = await placeBuy(fastBuyer, fastOnchain.market as Address, Side.Yes, 200n, 4_500n);
  assert.equal(await processOrder(await openOrder(fastOrder.order), deps), "chain_filled");
  assert.equal((await chain.market(FAST_SYMBOL))?.yesSupply, 200n, "the fast market has 200 YES units outstanding");
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
  await watcher.tick();
  assert.equal(registry.get(FAST_SYMBOL)?.settleState, "open", "the watcher leaves a market alone before its expiry");

  // 3. and 4. A buy at the ask: filled at the venue, then on-chain.
  say("--- steps 3 and 4: a buy that fills");
  const treasuryBefore = await chain.treasuryMicros();
  const first = await placeBuy(yesHolder, marketAddress, Side.Yes, 200n, 4_500n);
  const maxFee = feeCap(200n, 4_500n);
  assert.equal(await stableBalance(rpc, userStable), 1_000n * DUSD - 200n * 4_500n - maxFee, "cost and fee allowance are escrowed");
  const firstOrder = await openOrder(first.order);
  assert.deepEqual(
    { ...firstOrder, addressBytes: null, expiresAt: null },
    { address: first.order, addressBytes: null, user: user.address, symbol: SYMBOL, side: "YES", kind: "buy", units: 200n, limitPx: 4_500n, maxFeeMicros: maxFee, expiresAt: null },
  );
  assert.equal(await chain.orderExists(first.order), true);
  assert.equal(await processOrder(firstOrder, deps), "chain_filled");
  const filledRow = journal.get(first.order);
  assert.equal(filledRow?.state, "chain_filled", "journal row is chain_filled");
  assert.ok(filledRow.chainSignature !== null, "the fill signature is journaled");
  const costMicros = 200n * 4_500n;
  const feeMicros = takerFee(200n, 4_500n);
  assert.equal(filledRow.amountMicros, costMicros);
  assert.equal(filledRow.feeMicros, feeMicros);
  assert.equal(await outcomeBalance(user.address, yesMint), 200n, "the user holds 200 YES units");
  assert.equal((await chain.treasuryMicros()) - treasuryBefore, costMicros + feeMicros, "the treasury received exactly cost + fee");
  assert.equal(await stableBalance(rpc, userStable), 1_000n * DUSD - costMicros - feeMicros, "the unused fee allowance was refunded");
  assert.equal(await accountExists(rpc, first.order), false, "the order account is closed");
  assert.equal(await accountExists(rpc, first.escrow), false, "the escrow account is closed");
  assert.equal(await chain.orderExists(first.order), false);
  assert.equal((await chain.market(SYMBOL))?.yesSupply, 200n, "the YES supply is 200");
  assert.equal(
    await chain.fillBuy(firstOrder, { fillUnits: 200n, costMicros, feeMicros }),
    filledRow.chainSignature,
    "a repeated fillBuy resolves with the signature of the fill that landed",
  );
  await assert.rejects(chain.cancel(firstOrder), /^Error: order closed: filled in /, "a cancel of a filled order is refused");
  say(`  filled in ${filledRow.chainSignature}`);

  // 5. A buy below the ask: not filled, cancelled, fully refunded.
  say("--- step 5: a buy that does not fill");
  const stableBefore = await stableBalance(rpc, userStable);
  const second = await placeBuy(yesHolder, marketAddress, Side.Yes, 200n, 4_400n);
  const secondOrder = await openOrder(second.order);
  assert.equal(await processOrder(secondOrder, deps), "chain_cancelled");
  const cancelledRow = journal.get(second.order);
  assert.equal(cancelledRow?.state, "chain_cancelled", "journal row is chain_cancelled");
  assert.ok(cancelledRow.chainSignature !== null, "the cancel signature is journaled");
  assert.equal(await stableBalance(rpc, userStable), stableBefore, "the escrow was refunded in full");
  assert.equal(await accountExists(rpc, second.order), false, "the order account is closed");
  assert.equal(await accountExists(rpc, second.escrow), false, "the escrow account is closed");
  assert.equal((await chain.market(SYMBOL))?.yesSupply, 200n, "nothing was minted");
  assert.equal(await chain.cancel(secondOrder), cancelledRow.chainSignature, "a repeated cancel resolves with the signature of the cancel that landed");
  await assert.rejects(
    chain.fillBuy(secondOrder, { fillUnits: 200n, costMicros: 200n * 4_400n, feeMicros: 0n }),
    /^Error: order closed: cancelled in /,
    "a fill of a cancelled order is refused",
  );
  assert.deepEqual(await chain.openOrders(), [], "no order is left open");
  assert.deepEqual(alerts, [], "the pipeline raised no alert");
  say(`  cancelled in ${cancelledRow.chainSignature}`);

  // 6. A second user buys NO: the venue order takes from the bids, at 10_000 less the bid.
  say("--- step 6: a NO buy that fills");
  const noUnits = 300n;
  const noPx = PAYOUT_PER_UNIT - 4_000n;
  const third = await placeBuy(noHolder, marketAddress, Side.No, noUnits, noPx);
  const thirdOrder = await openOrder(third.order);
  assert.equal(thirdOrder.side, "NO");
  assert.equal(await processOrder(thirdOrder, deps), "chain_filled");
  const noRow = journal.get(third.order);
  assert.equal(noRow?.state, "chain_filled", "journal row is chain_filled");
  assert.equal(noRow.amountMicros, noUnits * noPx);
  assert.equal(await outcomeBalance(noHolder.signer.address, noMint), noUnits, "the second user holds 300 NO units");
  assert.equal(await stableBalance(rpc, noHolder.stable), 1_000n * DUSD - noUnits * noPx - takerFee(noUnits, noPx), "the second user paid cost + fee");
  const beforeSettlement = await chain.market(SYMBOL);
  assert.deepEqual(
    { status: beforeSettlement?.status, yes: beforeSettlement?.yesSupply, no: beforeSettlement?.noSupply, yesPayout: beforeSettlement?.yesPayout, redeemAfter: beforeSettlement?.redeemAfter },
    { status: "open", yes: 200n, no: noUnits, yesPayout: null, redeemAfter: null },
  );
  assert.deepEqual(alerts, [], "the pipeline raised no alert");

  // 7. Settlement: the settler funds the vault from the treasury.
  say("--- step 7: settle (10_000, 0)");
  const [vault] = await findVaultPda({ market: marketAddress });
  assert.equal(await accountExists(rpc, vault), false, "the vault does not exist before settlement");
  const treasuryBeforeSettlement = await chain.treasuryMicros();
  const settleSignature = await chain.settleMarket(SYMBOL, PAYOUT_PER_UNIT, 0n);
  const settledAt = await chain.now();
  const settled = await chain.market(SYMBOL);
  assert.ok(settled !== null);
  assert.equal(settled.status, "settled", "the market reads as settled");
  assert.equal(settled.yesPayout, 10_000n);
  assert.equal(settled.noPayout, 0n);
  const redeemAfter = settled.redeemAfter;
  assert.ok(redeemAfter !== null, "a settled market has a redeemAfter");
  assert.ok(
    redeemAfter <= settledAt + chainConfig.settleDelaySecs && redeemAfter >= settledAt + chainConfig.settleDelaySecs - 20,
    `redeemAfter ${redeemAfter} is settle_delay_secs after the settlement (cluster clock now ${settledAt})`,
  );
  const funding = settled.yesSupply * PAYOUT_PER_UNIT;
  assert.equal(funding, 200n * 10_000n);
  assert.equal(await stableBalance(rpc, vault), funding, "the vault holds exactly yesSupply * 10_000");
  assert.equal(treasuryBeforeSettlement - (await chain.treasuryMicros()), funding, "the treasury funded the vault");
  assert.equal(await chain.settleMarket(SYMBOL, PAYOUT_PER_UNIT, 0n), settleSignature, "a repeated settleMarket resolves with the signature of the settlement that landed");
  await assert.rejects(chain.settleMarket(SYMBOL, 0n, PAYOUT_PER_UNIT), /^Error: already settled: /, "other payouts for a settled market are refused");
  say(`  settled in ${settleSignature}, redemption opens at ${redeemAfter}`);

  // 8. Redemption is locked until redeemAfter.
  say("--- step 8: a redeem before redeemAfter");
  assert.ok((await chain.now()) < redeemAfter, "the early redeem is sent before redeemAfter");
  await assert.rejects(redeem(yesHolder, marketAddress, yesMint, 200n), /RedeemLocked/, "an early redeem fails with RedeemLocked");
  assert.equal(await outcomeBalance(user.address, yesMint), 200n, "nothing was burned");
  say(`  refused with RedeemLocked; waiting for the cluster clock to reach ${redeemAfter}`);
  await waitForClusterTime(chain, redeemAfter, 120_000);

  // 9. Winners are paid 10_000 per unit, losers nothing; the vault ends empty.
  say("--- step 9: redeem");
  const yesStableBefore = await stableBalance(rpc, userStable);
  const redeemYesSignature = await redeem(yesHolder, marketAddress, yesMint, 200n);
  assert.equal((await stableBalance(rpc, userStable)) - yesStableBefore, 200n * 10_000n, "the YES holder received exactly units * 10_000");
  assert.equal(await outcomeBalance(user.address, yesMint), 0n, "the YES units were burned");
  const noStableBefore = await stableBalance(rpc, noHolder.stable);
  const redeemNoSignature = await redeem(noHolder, marketAddress, noMint, noUnits);
  assert.equal(await stableBalance(rpc, noHolder.stable), noStableBefore, "the NO holder received nothing");
  assert.equal(await outcomeBalance(noHolder.signer.address, noMint), 0n, "the NO units were burned");
  const redeemed = await chain.market(SYMBOL);
  assert.deepEqual({ status: redeemed?.status, yes: redeemed?.yesSupply, no: redeemed?.noSupply }, { status: "settled", yes: 0n, no: 0n }, "both supplies are zero");
  assert.equal(await stableBalance(rpc, vault), 0n, "the vault is empty");
  say(`  YES redeemed in ${redeemYesSignature}, NO in ${redeemNoSignature}`);

  // 10. The automatic path: expiry, the venue's resolution, then the watcher settles on-chain.
  say("--- step 10: the settlement watcher settles the fast market");
  assert.equal(registry.get(FAST_SYMBOL)?.settleState, "open");
  await waitForClusterTime(chain, fastExpiresAt, 240_000);
  const untilLocalExpiry = fastExpiresAt * 1000 - Date.now();
  if (untilLocalExpiry >= 0) await sleep(untilLocalExpiry + 250);
  venue.resolve(FAST_SYMBOL, "yes");
  const watcherDeadline = Date.now() + 60_000;
  let ticks = 0;
  for (;;) {
    await watcher.tick();
    ticks += 1;
    const row = registry.get(FAST_SYMBOL);
    if (row?.settleState === "settled") break;
    assert.equal(row?.settleState, "awaiting_result", `the fast market is waiting for its settlement (${row?.detail ?? "no detail"})`);
    assert.ok(Date.now() < watcherDeadline, "the watcher settled the fast market within 60 s");
    await sleep(1_000);
  }
  assert.ok(ticks >= 2, "the resolution was confirmed over more than one tick");
  const fastSignature = registry.get(FAST_SYMBOL)?.settleSignature;
  assert.ok(typeof fastSignature === "string", "the registry has the settlement signature");
  const fastSettled = await chain.market(FAST_SYMBOL);
  assert.deepEqual(
    { status: fastSettled?.status, yesPayout: fastSettled?.yesPayout, noPayout: fastSettled?.noPayout },
    { status: "settled", yesPayout: 10_000n, noPayout: 0n },
    "the fast market is settled (10_000, 0) on-chain",
  );
  assert.ok(fastSettled?.redeemAfter != null, "the fast market has a redeemAfter");
  const [fastVault] = await findVaultPda({ market: fastOnchain.market as Address });
  assert.equal(await stableBalance(rpc, fastVault), 200n * 10_000n, "the fast market's vault holds the winners' payout");
  assert.equal(await chain.settleMarket(FAST_SYMBOL, PAYOUT_PER_UNIT, 0n), fastSignature, "the adapter finds the watcher's settlement");
  assert.deepEqual(watcherAlerts, [], "the watcher raised no alert");
  assert.deepEqual(alerts, [], "the pipeline raised no alert");
  say(`  settled by the watcher in ${fastSignature} after ${ticks} ticks`);

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
