// The run behind `scripts/local-e2e.ts`: starts `solana-test-validator` with the program loaded,
// bootstraps `localnet`, then takes one buy through the order pipeline to an on-chain fill and a
// second one to a cancel with a full refund.

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
import * as programClient from "@outcome/program-client";
import {
  fetchTrader,
  findEscrowPda,
  findTraderPda,
  getPlaceBuyInstructionAsync,
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
import { feeCap, takerFee } from "../../src/money.ts";
import { DEFAULT_PIPELINE_CONFIG, processOrder, type PipelineDeps } from "../../src/pipeline.ts";
import { MockVenue } from "../../src/venue/mock.ts";
import { bootstrap, LOCALNET_RPC_URL } from "./bootstrap.ts";

const SYMBOL = "TEST-BTC15M-UP";
const PORTS = [8899, 8900, 9900];
const COMMITMENT = "confirmed";
const DUSD = 1_000_000n;
const LAMPORTS_PER_SOL = 1_000_000_000n;

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const programSo = process.env.PROGRAM_SO ?? path.join(repoRoot, ".data", "outcome_tokens.p3.so");
const ledgerDir = path.join(repoRoot, ".data", "local-e2e-ledger");
const programId = OUTCOME_TOKENS_PROGRAM_ADDRESS;

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

async function accountExists(rpc: ChainRpc, account: Address): Promise<boolean> {
  return (await fetchEncodedAccount(rpc, account, { commitment: COMMITMENT })).exists;
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

  // 1. A fresh user: SOL, a trader account, 1_000 dUSD from the faucet.
  say("--- step 1: user");
  const user = await generateKeyPairSigner();
  await waitForSignature(rpc, await rpc.requestAirdrop(user.address, lamports(LAMPORTS_PER_SOL), { commitment: COMMITMENT }).send(), COMMITMENT, 30_000);
  const [userStable] = await findAssociatedTokenPda({ owner: user.address, mint: stableMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  await sender.send(registrar, [
    await getRegisterTraderInstructionAsync({ registrar, payer: registrar, user: user.address }),
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: registrar, owner: user.address, mint: stableMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    getTransferCheckedInstruction({ source: faucet, mint: stableMint, destination: userStable, authority: registrar, amount: 1_000n * DUSD, decimals: 6 }),
  ]);
  assert.equal(await stableBalance(rpc, userStable), 1_000n * DUSD, "the user holds 1_000 dUSD");
  say(`  user ${user.address} registered and funded`);

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

  const placeBuy = async (limitPx: bigint): Promise<{ order: Address; escrow: Address }> => {
    const [trader] = await findTraderPda({ user: user.address });
    const nonce = (await fetchTrader(rpc, trader, { commitment: COMMITMENT })).data.nextNonce;
    const [order] = await getProgramDerivedAddress({
      programAddress: programId,
      seeds: [ORDER_SEED, getAddressEncoder().encode(user.address), getU64Encoder().encode(nonce)],
    });
    const [escrow] = await findEscrowPda({ order });
    await sender.send(user, [
      await getPlaceBuyInstructionAsync({
        user,
        payer: user,
        market: market.address as Address,
        order,
        userStable,
        stableMint,
        side: Side.Yes,
        qtyUnits: 200n,
        limitPx: Number(limitPx),
        maxFee: feeCap(200n, limitPx),
      }),
    ]);
    return { order, escrow };
  };
  const openOrder = async (order: Address): Promise<ChainOrder> => {
    const open = await chain.openOrders();
    const found = open.find((candidate) => candidate.address === order);
    assert.ok(found !== undefined, `openOrders returns ${order}`);
    return found;
  };

  // 3. and 4. A buy at the ask: filled at the venue, then on-chain.
  say("--- steps 3 and 4: a buy that fills");
  const treasuryBefore = await chain.treasuryMicros();
  const first = await placeBuy(4_500n);
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
  const [userYes] = await findAssociatedTokenPda({ owner: user.address, mint: market.yesMint as Address, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  assert.equal((await fetchOutcomeToken(rpc, userYes, { commitment: COMMITMENT })).data.amount, 200n, "the user holds 200 YES units");
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
  const second = await placeBuy(4_400n);
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

  say(
    `--- compute units of the 300000 limit: market and both mints ${await unitsConsumed(rpc, marketSignature)}, ` +
      `fill_buy with two token accounts ${await unitsConsumed(rpc, filledRow.chainSignature)}, ` +
      `cancel_order ${await unitsConsumed(rpc, cancelledRow.chainSignature)}`,
  );

  // Settlement and redemption: the chain adapter does not send `settle_market` in this build.
  const client = programClient as Record<string, unknown>;
  const inClient = typeof client["getSettleMarketInstructionAsync"] === "function" && typeof client["getRedeemInstructionAsync"] === "function";
  await assert.rejects(chain.settleMarket(SYMBOL, 10_000n, 0n), /^Error: settle_market is not in this build of the program$/);
  say(
    inClient
      ? "--- settle and redeem: skipped (the program client has the instructions, the chain adapter and the default program binary of this run do not)"
      : "--- settle and redeem: skipped (settle_market and redeem are not in this build of the program client)",
  );

  assert.ok((await chain.relayerLamports()) > 0n);
  journal.close();
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
try {
  await run();
} catch (error) {
  failure = error;
}
await stopValidator();
if (failure !== null) {
  console.error(`LOCAL E2E FAILED: ${failure instanceof Error ? failure.message : String(failure)}`);
  process.exit(1);
}
say("LOCAL E2E OK");
process.exit(0);
