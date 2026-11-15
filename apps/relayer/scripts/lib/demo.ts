// The steps behind `scripts/demo.ts`: one test user (key in `.keys/demo-user-keypair.json`, or the
// file named by DEMO_USER_KEYPAIR) placing orders on-chain and following them through a running
// relayer's API.

import path from "node:path";
import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
  lamports,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import {
  fetchMarket,
  fetchMaybeMarket,
  fetchMaybeOrder,
  fetchMaybeTrader,
  fetchTrader,
  findMarketPda,
  findTraderPda,
  getCancelOrderInstructionAsync,
  getPlaceBuyInstructionAsync,
  getPlaceSellInstructionAsync,
  getRedeemInstructionAsync,
  getRegisterTraderInstructionAsync,
  ORDER_SEED,
  OUTCOME_TOKENS_PROGRAM_ADDRESS,
  Side,
} from "@outcome/program-client";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  fetchMaybeToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { fetchMaybeToken as fetchMaybeOutcomeToken, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import type { ApiEvent, ApiHealth, ApiMarket, ApiOrder } from "../../src/api/types.ts";
import { ensureKeypairFile, loadKeypairSigner } from "../../src/chain/keys.ts";
import { createRetryingRpc } from "../../src/chain/rpc.ts";
import { createSender } from "../../src/chain/send.ts";
import { complementPx, feeCap, formatPx, formatUnits, parsePx, parseUnits, PAYOUT_PER_UNIT } from "../../src/money.ts";
import { fetchSysvarClock } from "@solana/sysvars";
import { assertClusterAllowed, LOCALNET_RPC_URL, type Cluster, type Deployment } from "./bootstrap.ts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const COMMITMENT = "confirmed";
/** The relayer's default fee slack, used when it cannot be asked. */
const DEFAULT_FEE_SLACK = 30_000n;
const DUSD = 1_000_000n;
const STARTER_DUSD = 1_000n * DUSD;
const STARTER_LAMPORTS = 50_000_000n;
const TERMINAL = new Set(["chain_filled", "chain_cancelled", "orphaned", "failed"]);
const USAGE = `usage: node scripts/demo.ts <command>

  setup                                          create the test user, register it, send starter funds
  markets                                        list the contracts of every event the relayer lists
  buy  <symbol|auto> <yes|no> <contracts> [limit]    place a buy and follow it (limit in dollars, default: the ask)
  sell <symbol> <yes|no> <contracts> [minimum]       sell tokens back (minimum in dollars, default: the bid)
  redeem <symbol>                                redeem every token of a settled market
  reclaim <order address>                        take back the hold of an expired order (works without the relayer)
  status                                         balances and positions`;

function say(line: string): void {
  console.log(line);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dollars(micros: bigint): string {
  const sign = micros < 0n ? "-" : "";
  const abs = micros < 0n ? -micros : micros;
  const cents = abs / 10_000n;
  const rest = abs % 10_000n;
  const text = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
  return `${sign}$${text}${rest === 0n ? "" : String(rest).padStart(4, "0")}`;
}

function sideOf(text: string | undefined): { side: Side; name: "YES" | "NO" } {
  if (text?.toLowerCase() === "yes") return { side: Side.Yes, name: "YES" };
  if (text?.toLowerCase() === "no") return { side: Side.No, name: "NO" };
  throw new Error(`side must be yes or no, not ${String(text)}`);
}

async function api<T>(base: string, route: string, method: "GET" | "POST" = "GET"): Promise<T> {
  const response = await fetch(`${base}${route}`, { method, signal: AbortSignal.timeout(60_000) });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(`relayer ${method} ${route}: ${response.status} ${body.error ?? ""}`.trim());
  return body;
}

export async function runCli(argv: readonly string[], env: Record<string, string | undefined>): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || !["setup", "markets", "buy", "sell", "redeem", "reclaim", "status"].includes(command)) {
    console.error(USAGE);
    return 2;
  }
  const repoRoot = path.resolve(import.meta.dirname, "../../../..");
  const cluster: Cluster = env["CLUSTER"] === "localnet" ? "localnet" : "devnet";
  const rpcUrl = cluster === "localnet" ? LOCALNET_RPC_URL : env["SOLANA_RPC_URL"];
  if (!rpcUrl) throw new Error("SOLANA_RPC_URL must be set for devnet");
  const relayerUrl = env["RELAYER_URL"] ?? `http://127.0.0.1:${env["RELAYER_PORT"] ?? "8787"}`;

  const rpc = createRetryingRpc(rpcUrl);
  assertClusterAllowed(cluster, rpcUrl, await rpc.getGenesisHash().send());
  const deployment = JSON.parse(await readFile(path.join(repoRoot, "deployments", `${cluster}.json`), "utf8")) as Deployment;
  const programId = OUTCOME_TOKENS_PROGRAM_ADDRESS;
  const stableMint = address(deployment.stableMint);
  const sender = createSender({ rpc, programId, commitment: COMMITMENT, computeUnitLimit: 300_000, confirmTimeoutMs: 60_000 });

  // DEMO_USER_KEYPAIR points every command at another test wallet's key file (a path relative to
  // the repository root, or an absolute one).
  const userKeyPath = path.resolve(repoRoot, process.env.DEMO_USER_KEYPAIR ?? path.join(".keys", "demo-user-keypair.json"));
  if (command === "setup" && (await ensureKeypairFile(userKeyPath))) say(`created ${path.relative(repoRoot, userKeyPath)}`);
  const user: KeyPairSigner = await loadKeypairSigner(userKeyPath).catch(() => {
    throw new Error("no test user yet: run `scripts/demo.ts setup` first");
  });
  const [userStable] = await findAssociatedTokenPda({ owner: user.address, mint: stableMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [traderAddress] = await findTraderPda({ user: user.address });

  const stableBalance = async (): Promise<bigint> => {
    const account = await fetchMaybeToken(rpc, userStable, { commitment: COMMITMENT });
    return account.exists ? account.data.amount : 0n;
  };
  const outcomeAccount = async (mint: Address): Promise<Address> =>
    (await findAssociatedTokenPda({ owner: user.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];
  const outcomeBalance = async (mint: Address): Promise<bigint> => {
    const account = await fetchMaybeOutcomeToken(rpc, await outcomeAccount(mint), { commitment: COMMITMENT });
    return account.exists ? account.data.amount : 0n;
  };
  const solBalance = async (): Promise<bigint> => (await rpc.getBalance(user.address, { commitment: COMMITMENT }).send()).value;
  const printBalances = async (): Promise<void> => {
    say(`  wallet ${user.address}: ${dollars(await stableBalance())} test dollars, ${(Number(await solBalance()) / 1e9).toFixed(4)} SOL`);
  };

  if (command === "setup") {
    const trader = await fetchMaybeTrader(rpc, traderAddress, { commitment: COMMITMENT });
    if (trader.exists) {
      say("the test user is already registered");
    } else {
      const registrar = await loadKeypairSigner(path.join(repoRoot, ".keys", "registrar-keypair.json"));
      const signature = await sender.send(registrar, [
        await getRegisterTraderInstructionAsync({ registrar, payer: registrar, user: user.address }),
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: registrar, owner: user.address, mint: stableMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
        getTransferCheckedInstruction({ source: address(deployment.faucet), mint: stableMint, destination: userStable, authority: registrar, amount: STARTER_DUSD, decimals: 6 }),
        getTransferSolInstruction({ source: registrar, destination: user.address, amount: lamports(STARTER_LAMPORTS) }),
      ]);
      say(`registered and funded in ${signature}`);
    }
    await printBalances();
    return 0;
  }

  if (command === "markets") {
    const { events } = await api<{ events: ApiEvent[] }>(relayerUrl, "/events");
    for (const market of events.flatMap((event) => event.markets)) say(describeMarket(market));
    if (events.length === 0) say("the relayer lists no event right now");
    return 0;
  }

  if (command === "status") {
    await printBalances();
    const { markets } = await api<{ markets: ApiMarket[] }>(relayerUrl, "/markets");
    for (const market of markets) {
      if (market.onchain === null) continue;
      const yes = await outcomeBalance(address(market.onchain.yesMint));
      const no = await outcomeBalance(address(market.onchain.noMint));
      if (yes === 0n && no === 0n) continue;
      say(`  ${market.symbol} (${market.onchain.status}, ${market.settleState}): ${formatUnits(yes)} YES, ${formatUnits(no)} NO`);
    }
    const { orders } = await api<{ orders: ApiOrder[] }>(relayerUrl, `/orders?user=${user.address}`);
    for (const order of orders.slice(0, 10)) say(`  order ${order.address}: ${describeOrder(order)}`);
    return 0;
  }

  if (command === "redeem") {
    const symbol = rest[0];
    if (!symbol) throw new Error("usage: redeem <symbol>");
    const market = await api<ApiMarket>(relayerUrl, `/markets/${symbol}`);
    if (market.onchain === null || market.onchain.status !== "settled") throw new Error(`${symbol} is not settled on-chain yet (${market.settleState})`);
    const health = await api<ApiHealth>(relayerUrl, "/health");
    const wait = (market.onchain.redeemAfter ?? 0) - health.chainTime;
    if (wait > 0) {
      say(`redemption opens in ${wait} s; waiting`);
      await sleep((wait + 3) * 1000);
    }
    const before = await stableBalance();
    for (const [name, mintText] of [["YES", market.onchain.yesMint], ["NO", market.onchain.noMint]] as const) {
      const mint = address(mintText);
      const amount = await outcomeBalance(mint);
      if (amount === 0n) continue;
      const signature = await sender.send(user, [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: user, owner: user.address, mint: stableMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
        await getRedeemInstructionAsync({ holder: user, market: address(market.onchain.market), outcomeMint: mint, holderOutcome: await outcomeAccount(mint), holderStable: userStable, stableMint, amount }),
      ]);
      say(`redeemed ${formatUnits(amount)} ${name} in ${signature}`);
    }
    say(`received ${dollars((await stableBalance()) - before)}`);
    await printBalances();
    return 0;
  }

  if (command === "reclaim") {
    const orderText = rest[0];
    if (!orderText) throw new Error("usage: reclaim <order address>");
    const orderAddress = address(orderText);
    const open = await fetchMaybeOrder(rpc, orderAddress, { commitment: COMMITMENT });
    if (!open.exists) {
      say("that order is already closed: it was filled, cancelled or reclaimed");
      return 0;
    }
    const clock = Number((await fetchSysvarClock(rpc, { commitment: COMMITMENT })).unixTimestamp);
    const left = Number(open.data.expiresAt) - clock;
    if (left >= 0) {
      say(`the order expires in ${left + 1} s; waiting`);
      await sleep((left + 3) * 1000);
    }
    const sell = open.data.kind === 1;
    const onMarket = await fetchMarket(rpc, open.data.market, { commitment: COMMITMENT });
    const escrowMint = !sell ? stableMint : open.data.side === Side.Yes ? onMarket.data.yesMint : onMarket.data.noMint;
    const tokenProgram = sell ? TOKEN_2022_PROGRAM_ADDRESS : TOKEN_PROGRAM_ADDRESS;
    const [userToken] = await findAssociatedTokenPda({ owner: open.data.user, mint: escrowMint, tokenProgram });
    const before = await stableBalance();
    const signature = await sender.send(user, [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: user, owner: open.data.user, mint: escrowMint, tokenProgram }),
      await getCancelOrderInstructionAsync({ caller: user, market: open.data.market, order: orderAddress, escrowMint, userToken, rentPayer: open.data.rentPayer, tokenProgram }),
    ]);
    say(`reclaimed in ${signature}`);
    say(`  test dollars: ${dollars((await stableBalance()) - before)}`);
    await printBalances();
    return 0;
  }

  // buy and sell
  const [symbolArg, sideArg, contractsArg, priceArg] = rest;
  if (!symbolArg || !sideArg || !contractsArg) throw new Error(`usage: ${command} <symbol${command === "buy" ? "|auto" : ""}> <yes|no> <contracts> [price]`);
  const { side, name: sideName } = sideOf(sideArg);
  const units = parseUnits(contractsArg);
  // Without a reachable relayer the order is still placed on-chain; nobody will fill it, and
  // after it expires `reclaim` takes the hold back. That is the program's own safety valve.
  const health = await api<ApiHealth>(relayerUrl, "/health").catch(() => null);
  let symbol = symbolArg;
  let market: ApiMarket | null = null;
  let marketAddress: Address;
  let outcomeMint: Address;
  if (health === null) {
    say("the relayer is not reachable: placing the order directly on-chain");
    if (symbol === "auto" || !priceArg) throw new Error("without the relayer, name the market and the price");
    const [found] = await findMarketPda({ symbolHash: createHash("sha256").update(symbol).digest() });
    const account = await fetchMaybeMarket(rpc, found, { commitment: COMMITMENT });
    if (!account.exists) throw new Error(`${symbol} does not exist on-chain, and the relayer is not reachable to create it`);
    marketAddress = found;
    outcomeMint = side === Side.Yes ? account.data.yesMint : account.data.noMint;
  } else {
    if (symbol === "auto") {
      // The soonest-expiring contract that takes orders right now.
      const { events } = await api<{ events: ApiEvent[] }>(relayerUrl, "/events");
      const pick = events.flatMap((event) => event.markets).find((candidate) => candidate.tradable);
      if (!pick) throw new Error("no tradable market right now: try again when a contract is open and has offers");
      symbol = pick.symbol;
    }
    market = await api<ApiMarket>(relayerUrl, `/markets/${symbol}`);
    if (market.onchain === null) {
      say(`creating ${symbol} on-chain through the relayer`);
      market = await api<ApiMarket>(relayerUrl, `/markets/${symbol}/ensure`, "POST");
    }
    if (market.onchain === null) throw new Error(`${symbol} could not be created on-chain`);
    say(describeMarket(market));
    // An order on a market without offers is still allowed: it shows the refund path.
    if (!market.tradable && market.notTradableReason !== "no_offers") {
      throw new Error(`${symbol} does not take orders right now (${market.notTradableReason})`);
    }
    marketAddress = address(market.onchain.market);
    outcomeMint = address(side === Side.Yes ? market.onchain.yesMint : market.onchain.noMint);
  }
  const slack = health === null ? DEFAULT_FEE_SLACK : BigInt(health.feeSlackMicros);

  const nonce = (await fetchTrader(rpc, traderAddress, { commitment: COMMITMENT })).data.nextNonce;
  const [order] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [ORDER_SEED, getAddressEncoder().encode(user.address), getU64Encoder().encode(nonce)],
  });
  const stableBefore = await stableBalance();
  const tokensBefore = await outcomeBalance(outcomeMint);
  const createOutcomeAccount = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: user, owner: user.address, mint: outcomeMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });

  let placed: string;
  if (command === "buy") {
    const book = market?.book;
    const ask = side === Side.Yes ? book?.askPx : book?.bidPx ? String(PAYOUT_PER_UNIT - BigInt(book.bidPx)) : null;
    const limitPx = priceArg ? parsePx(priceArg) : ask ? BigInt(ask) : null;
    if (limitPx === null) throw new Error("no offer on that side right now: pass a limit price");
    const maxFee = feeCap(units, limitPx, slack);
    say(`placing BUY ${formatUnits(units)} ${sideName} at up to $${formatPx(limitPx)}: hold ${dollars(units * limitPx + maxFee)} (fee cap ${dollars(maxFee)})`);
    placed = await sender.send(user, [
      createOutcomeAccount,
      await getPlaceBuyInstructionAsync({ user, payer: user, market: marketAddress, order, userStable, stableMint, side, qtyUnits: units, limitPx: Number(limitPx), maxFee }),
    ]);
  } else {
    const book = market?.book;
    const bid = side === Side.Yes ? book?.bidPx : book?.askPx ? String(PAYOUT_PER_UNIT - BigInt(book.askPx)) : null;
    const minPx = priceArg ? parsePx(priceArg) : bid ? BigInt(bid) : null;
    if (minPx === null) throw new Error("no bid on that side right now: pass a minimum price");
    // The venue order is a buy of the opposite side at the complement. The relayer only sends a sale
    // whose minimum proceeds exceed that order's fee cap.
    const maxFee = feeCap(units, complementPx(minPx), slack);
    if (maxFee >= units * minPx) {
      throw new Error(
        `a sale of ${formatUnits(units)} at $${formatPx(minPx)} brings at least ${dollars(units * minPx)}, which does not cover the fee cap of ${dollars(maxFee)}: sell more contracts or set a higher minimum`,
      );
    }
    say(`placing SELL ${formatUnits(units)} ${sideName} at no less than $${formatPx(minPx)}: at least ${dollars(units * minPx - maxFee)} after fees`);
    placed = await sender.send(user, [
      await getPlaceSellInstructionAsync({ user, payer: user, market: marketAddress, order, userOutcome: await outcomeAccount(outcomeMint), outcomeMint, side, qtyUnits: units, minPx: Number(minPx), maxFee }),
    ]);
  }
  say(`  placed on-chain in ${placed}`);
  say(`  order ${order}`);
  if (health === null) {
    say(`  nobody is filling orders right now; once it has expired run: scripts/demo.ts reclaim ${order}`);
    return 0;
  }

  // Follow the order through the relayer.
  const deadline = Date.now() + (health.orderTtlSecs + 60) * 1000;
  let last = "";
  let final: ApiOrder | null = null;
  while (Date.now() < deadline) {
    await sleep(1_500);
    let row: ApiOrder;
    try {
      row = await api<ApiOrder>(relayerUrl, `/orders/${order}`);
    } catch {
      continue;
    }
    if (row.state !== last) {
      say(`  ${new Date().toISOString().slice(11, 19)} ${describeOrder(row)}`);
      last = row.state;
    }
    if (TERMINAL.has(row.state)) {
      final = row;
      break;
    }
  }
  if (final === null) say("  the relayer did not finish this order in time; after it expires anyone can cancel it for a full refund");
  await sleep(1_500);
  say(`  test dollars: ${dollars((await stableBalance()) - stableBefore)}; ${sideName} tokens: ${formatUnits(tokensBefore)} -> ${formatUnits(await outcomeBalance(outcomeMint))}`);
  await printBalances();
  return final !== null && (final.state === "chain_filled" || final.state === "chain_cancelled") ? 0 : 1;
}

function describeMarket(market: ApiMarket): string {
  const book = market.book;
  const price = (px: string | null | undefined): string => (px ? `$${formatPx(BigInt(px))}` : "-");
  const left = Math.round((market.lastOrderAt - Date.now()) / 1000);
  return `${market.symbol}  ${market.title}: ${market.label}  strike ${market.strike ?? "-"}  bid ${price(book?.bidPx)} ask ${price(book?.askPx)}  ${
    market.tradable ? `tradable, orders close in ${left} s` : `not tradable (${market.notTradableReason})`
  }  ${market.onchain ? `on-chain ${market.onchain.status}` : "not on-chain yet"}  ${market.settleState}`;
}

function describeOrder(order: ApiOrder): string {
  const head = `${order.kind.toUpperCase()} ${formatUnits(BigInt(order.units))} ${order.side} ${order.symbol}: ${order.state}`;
  const filled = BigInt(order.filledUnits);
  const parts: string[] = [];
  if (order.venueOrderId) parts.push(`venue order ${order.venueOrderId}`);
  if (filled > 0n) parts.push(`filled ${formatUnits(filled)} for ${dollars(BigInt(order.amountMicros))}, fee ${dollars(BigInt(order.feeMicros))}`);
  if (order.chainSignature) parts.push(`tx ${order.chainSignature}`);
  if (order.detail) parts.push(order.detail);
  return parts.length === 0 ? head : `${head} (${parts.join("; ")})`;
}
