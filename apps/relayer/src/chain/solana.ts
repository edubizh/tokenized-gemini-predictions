// The program on a Solana cluster, behind the `Chain` and `MarketChain` interfaces. HTTP RPC only.

import { createHash } from "node:crypto";
import {
  address,
  fetchEncodedAccount,
  getBase58Decoder,
  getBase64Encoder,
  type Address,
  type Base58EncodedBytes,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  fetchConfig,
  fetchMaybeMarket,
  findConfigPda,
  findMarketPda,
  findMintPda,
  getCancelOrderInstructionAsync,
  getCreateMarketInstructionAsync,
  getCreateOutcomeMintInstructionAsync,
  getFillBuyInstructionAsync,
  getFillSellInstructionAsync,
  getOrderDecoder,
  getOrderSize,
  getSetMarketInstructionAsync,
  getSetPauseInstructionAsync,
  getSettleMarketInstructionAsync,
  MarketStatus,
  ORDER_DISCRIMINATOR,
  PAUSE_FILL,
  PAUSE_PLACE,
  Side,
  type Market,
  type Order,
} from "@outcome/program-client";
import {
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { fetchAllMaybeMint as fetchAllMaybeOutcomeMint, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { fetchSysvarClock } from "@solana/sysvars";
import { createRetryingRpc } from "./rpc.ts";
import type { Chain, ChainConfig, ChainMarket, ChainOrder, MarketChain, NewChainMarket } from "./chain.ts";
import { marketSettlement, orderClosure, type OrderClosure } from "./events.ts";
import { toChainConfig, toChainMarket, toChainOrder } from "./mapping.ts";
import { createSender } from "./send.ts";

export { loadKeypairSigner } from "./keys.ts";

export interface SolanaChainOptions {
  rpcUrl: string;
  programId: string;
  /** Fills, cancels, market creation, pause. */
  relayer: KeyPairSigner;
  /** `settle_market`; funds the vault from the treasury. */
  settler: KeyPairSigner;
  stableMint: string;
  /** Must equal `config.treasury`; owned by the settler. */
  treasury: string;
  /** Stable account owned by the relayer (sell proceeds). */
  relayerFloat: string;
  /** Default "confirmed". */
  commitment?: "confirmed" | "finalized";
  /** Default 300_000. */
  computeUnitLimit?: number;
  /** Default 45_000. */
  confirmTimeoutMs?: number;
  log?: (line: string) => void;
}

const DEFAULT_ADDRESS = "11111111111111111111111111111111";
const ORDER_KIND_BUY = 0;
const ORDER_KIND_SELL = 1;
/** How many of an order's newest transactions are searched for the one that closed it. */
const CLOSURE_SIGNATURES = 10;
/** The transaction index can trail the account state by a moment. */
const CLOSURE_READS = 3;
const CLOSURE_READ_DELAY_MS = 500;
/** How many of a market's newest transactions are searched for the one that settled it. */
const SETTLEMENT_SIGNATURES = 25;

export function createSolanaChain(options: SolanaChainOptions): Chain & MarketChain & { close(): void } {
  const rpc = createRetryingRpc(options.rpcUrl);
  const programId = address(options.programId);
  const program = { programAddress: programId };
  const commitment = options.commitment ?? "confirmed";
  const { relayer, settler } = options;
  const stableMint = address(options.stableMint);
  const treasury = address(options.treasury);
  const relayerFloat = address(options.relayerFloat);
  const log = options.log ?? (() => {});
  const sender = createSender({
    rpc,
    programId,
    commitment,
    computeUnitLimit: options.computeUnitLimit ?? 300_000,
    confirmTimeoutMs: options.confirmTimeoutMs ?? 45_000,
  });

  /** Market address -> symbol. A market's symbol never changes. */
  const symbols = new Map<string, string>();
  /** Order address -> decoded account. An order's fields never change while it exists. */
  const orders = new Map<string, Order>();
  let configAddress: Promise<Address> | undefined;

  function configPda(): Promise<Address> {
    configAddress ??= findConfigPda(program).then(([pda]) => pda);
    return configAddress;
  }

  async function marketPda(symbol: string): Promise<Address> {
    const symbolHash = createHash("sha256").update(symbol).digest();
    const [pda] = await findMarketPda({ symbolHash }, program);
    return pda;
  }

  async function symbolOf(market: Address): Promise<string | null> {
    const cached = symbols.get(market);
    if (cached !== undefined) return cached;
    const account = await fetchMaybeMarket(rpc, market, { commitment });
    if (!account.exists || account.programAddress !== programId) return null;
    symbols.set(market, account.data.symbol);
    return account.data.symbol;
  }

  async function orderExists(orderAddress: string): Promise<boolean> {
    const account = await fetchEncodedAccount(rpc, address(orderAddress), { commitment });
    return account.exists && account.programAddress === programId;
  }

  /** The decoded order, from the map or from the cluster. */
  async function orderData(orderAddress: Address): Promise<Order> {
    const cached = orders.get(orderAddress);
    if (cached !== undefined) return cached;
    const account = await fetchEncodedAccount(rpc, orderAddress, { commitment });
    if (!account.exists || account.programAddress !== programId) throw new Error(`order account ${orderAddress} does not exist`);
    const data = getOrderDecoder().decode(account.data);
    orders.set(orderAddress, data);
    return data;
  }

  /** The transaction that filled or cancelled the order, searched in its newest transactions. */
  async function findClosure(orderAddress: Address): Promise<(OrderClosure & { signature: string }) | null> {
    for (let read = 0; read < CLOSURE_READS; read++) {
      if (read > 0) await new Promise((resolve) => setTimeout(resolve, CLOSURE_READ_DELAY_MS));
      const entries = await rpc.getSignaturesForAddress(orderAddress, { commitment, limit: CLOSURE_SIGNATURES }).send();
      for (const entry of entries) {
        if (entry.err !== null) continue;
        const transaction = await rpc
          .getTransaction(entry.signature, { commitment, encoding: "json", maxSupportedTransactionVersion: 0 })
          .send();
        const meta = transaction?.meta;
        if (!meta || meta.err !== null || !meta.logMessages) continue;
        const closure = orderClosure(meta.logMessages, programId, orderAddress);
        if (closure !== null) return { ...closure, signature: entry.signature };
      }
    }
    return null;
  }

  /**
   * The transaction of the market's current settlement, searched in its newest transactions. The
   * redemption time tells it apart from a settlement that was revoked.
   */
  async function findSettlement(marketAddress: Address, settled: Market): Promise<string | null> {
    for (let read = 0; read < CLOSURE_READS; read++) {
      if (read > 0) await new Promise((resolve) => setTimeout(resolve, CLOSURE_READ_DELAY_MS));
      const entries = await rpc.getSignaturesForAddress(marketAddress, { commitment, limit: SETTLEMENT_SIGNATURES }).send();
      for (const entry of entries) {
        if (entry.err !== null) continue;
        const transaction = await rpc
          .getTransaction(entry.signature, { commitment, encoding: "json", maxSupportedTransactionVersion: 0 })
          .send();
        const meta = transaction?.meta;
        if (!meta || meta.err !== null || !meta.logMessages) continue;
        const event = marketSettlement(meta.logMessages, programId, marketAddress);
        if (event === null) continue;
        if (event.yesPayout === settled.yesPayout && event.noPayout === settled.noPayout && event.redeemAfter === settled.redeemAfter) {
          return entry.signature;
        }
      }
    }
    return null;
  }

  /** Outcome of `settle_market` for a market that is settled already. */
  async function resolveSettled(marketAddress: Address, settled: Market, yesPayout: bigint, noPayout: bigint, cause?: unknown): Promise<string> {
    if (settled.yesPayout !== yesPayout || settled.noPayout !== noPayout) {
      throw new Error(
        `already settled: ${settled.symbol} pays (${settled.yesPayout}, ${settled.noPayout}), not (${yesPayout}, ${noPayout})`,
        { cause },
      );
    }
    const signature = await findSettlement(marketAddress, settled);
    if (signature === null) {
      throw new Error(`market settled: no settle_market of ${settled.symbol} (${marketAddress}) found in its recent transactions`, { cause });
    }
    log(`market ${settled.symbol}: settlement already landed in ${signature}`);
    return signature;
  }

  /** Outcome of a write to an order whose account no longer exists. */
  async function resolveClosed(orderAddress: Address, want: "fill" | "cancel", cause?: unknown): Promise<string> {
    orders.delete(orderAddress);
    const closure = await findClosure(orderAddress);
    if (closure === null) {
      throw new Error(`order gone: no fill or cancel of ${orderAddress} found in its recent transactions`, { cause });
    }
    const landed = closure.kind === "filled" ? "fill" : "cancel";
    if (landed === want) {
      log(`order ${orderAddress}: ${want} already landed in ${closure.signature}`);
      return closure.signature;
    }
    throw new Error(`order closed: ${closure.kind} in ${closure.signature}`, { cause });
  }

  /**
   * Sends a fill or a cancel exactly-once: the order account is checked before sending and again
   * after any failure, and when it is gone the transaction that closed it decides the result.
   */
  async function writeOrder(order: ChainOrder, want: "fill" | "cancel", build: (data: Order, orderAddress: Address) => Promise<Instruction[]>): Promise<string> {
    const orderAddress = address(order.address);
    if (!(await orderExists(orderAddress))) return resolveClosed(orderAddress, want);
    try {
      const data = await orderData(orderAddress);
      return await sender.send(relayer, await build(data, orderAddress));
    } catch (error) {
      let exists: boolean;
      try {
        exists = await orderExists(orderAddress);
      } catch {
        throw error;
      }
      if (exists) throw error;
      return resolveClosed(orderAddress, want, error);
    }
  }

  async function outcomeMintOf(data: Order): Promise<Address> {
    if (data.side !== Side.Yes && data.side !== Side.No) throw new Error(`unknown order side: ${data.side}`);
    const [mint] = await findMintPda({ market: data.market, side: data.side }, program);
    return mint;
  }

  /** Idempotent creation of `owner`'s associated token account, paid by the relayer. */
  async function associatedAccount(owner: Address, mint: Address, tokenProgram: Address): Promise<{ account: Address; create: Instruction }> {
    const [account] = await findAssociatedTokenPda({ owner, mint, tokenProgram });
    const create = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: relayer, owner, mint, tokenProgram });
    return { account, create };
  }

  /** Supplies of a market's two outcome mints in one request; a mint that is not created yet counts as zero. */
  async function suppliesOf(yesMint: Address, noMint: Address): Promise<{ yes: bigint; no: bigint }> {
    const created = [yesMint, noMint].filter((mint) => mint !== DEFAULT_ADDRESS);
    const accounts = created.length === 0 ? [] : await fetchAllMaybeOutcomeMint(rpc, created, { commitment });
    const supply = (mint: Address): bigint => {
      const account = accounts.find((candidate) => candidate.address === mint);
      return account !== undefined && account.exists ? account.data.supply : 0n;
    };
    return { yes: supply(yesMint), no: supply(noMint) };
  }

  async function market(symbol: string): Promise<ChainMarket | null> {
    const marketAddress = await marketPda(symbol);
    const account = await fetchMaybeMarket(rpc, marketAddress, { commitment });
    if (!account.exists) return null;
    symbols.set(marketAddress, account.data.symbol);
    return toChainMarket(marketAddress, account.data, await suppliesOf(account.data.yesMint, account.data.noMint));
  }

  async function config(): Promise<ChainConfig> {
    return toChainConfig((await fetchConfig(rpc, await configPda(), { commitment })).data);
  }

  return {
    async now() {
      return Number((await fetchSysvarClock(rpc, { commitment })).unixTimestamp);
    },

    async openOrders() {
      const accounts = await rpc
        .getProgramAccounts(programId, {
          commitment,
          encoding: "base64",
          filters: [
            { memcmp: { offset: 0n, bytes: getBase58Decoder().decode(ORDER_DISCRIMINATOR) as Base58EncodedBytes, encoding: "base58" } },
            { dataSize: BigInt(getOrderSize()) },
          ],
        })
        .send();
      const open: ChainOrder[] = [];
      orders.clear();
      for (const { pubkey, account } of accounts) {
        try {
          const data = getOrderDecoder().decode(getBase64Encoder().encode(account.data[0]));
          const symbol = await symbolOf(data.market);
          if (symbol === null) {
            log(`order ${pubkey} skipped: its market ${data.market} cannot be read`);
            continue;
          }
          open.push(toChainOrder(pubkey, data, symbol));
          orders.set(pubkey, data);
        } catch (error) {
          log(`order ${pubkey} skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return open;
    },

    orderExists,

    fillBuy(order, args) {
      return writeOrder(order, "fill", async (data, orderAddress) => {
        if (data.kind !== ORDER_KIND_BUY) throw new Error(`order ${orderAddress} is not a buy`);
        const outcomeMint = await outcomeMintOf(data);
        const userOutcome = await associatedAccount(data.user, outcomeMint, TOKEN_2022_PROGRAM_ADDRESS);
        const userStable = await associatedAccount(data.user, stableMint, TOKEN_PROGRAM_ADDRESS);
        const fill = await getFillBuyInstructionAsync(
          {
            relayer,
            market: data.market,
            order: orderAddress,
            outcomeMint,
            userOutcome: userOutcome.account,
            userStable: userStable.account,
            treasury,
            rentPayer: data.rentPayer,
            stableMint,
            fillQty: args.fillUnits,
            cost: args.costMicros,
            fee: args.feeMicros,
          },
          program,
        );
        return [userOutcome.create, userStable.create, fill];
      });
    },

    fillSell(order, args) {
      return writeOrder(order, "fill", async (data, orderAddress) => {
        if (data.kind !== ORDER_KIND_SELL) throw new Error(`order ${orderAddress} is not a sell`);
        const outcomeMint = await outcomeMintOf(data);
        const userOutcome = await associatedAccount(data.user, outcomeMint, TOKEN_2022_PROGRAM_ADDRESS);
        const userStable = await associatedAccount(data.user, stableMint, TOKEN_PROGRAM_ADDRESS);
        const fill = await getFillSellInstructionAsync(
          {
            relayer,
            market: data.market,
            order: orderAddress,
            outcomeMint,
            payoutSource: relayerFloat,
            userStable: userStable.account,
            userOutcome: userOutcome.account,
            rentPayer: data.rentPayer,
            stableMint,
            fillQty: args.fillUnits,
            proceeds: args.proceedsMicros,
            fee: args.feeMicros,
          },
          program,
        );
        return [userOutcome.create, userStable.create, fill];
      });
    },

    cancel(order) {
      return writeOrder(order, "cancel", async (data, orderAddress) => {
        if (data.kind !== ORDER_KIND_BUY && data.kind !== ORDER_KIND_SELL) throw new Error(`unknown order kind: ${data.kind}`);
        const sell = data.kind === ORDER_KIND_SELL;
        const escrowMint = sell ? await outcomeMintOf(data) : stableMint;
        const tokenProgram = sell ? TOKEN_2022_PROGRAM_ADDRESS : TOKEN_PROGRAM_ADDRESS;
        const userToken = await associatedAccount(data.user, escrowMint, tokenProgram);
        const cancel = await getCancelOrderInstructionAsync(
          {
            caller: relayer,
            market: data.market,
            order: orderAddress,
            escrowMint,
            userToken: userToken.account,
            rentPayer: data.rentPayer,
            tokenProgram,
          },
          program,
        );
        return [userToken.create, cancel];
      });
    },

    config,
    market,

    async ensureMarket(spec: NewChainMarket) {
      const existing = await market(spec.symbol);
      const marketAddress = await marketPda(spec.symbol);
      const instructions: Instruction[] = [];
      if (existing === null) {
        instructions.push(
          await getCreateMarketInstructionAsync(
            {
              relayer,
              payer: relayer,
              market: marketAddress,
              symbolHash: createHash("sha256").update(spec.symbol).digest(),
              symbol: spec.symbol,
              closeTs: BigInt(spec.closeTs),
              placeCutoffSecs: spec.placeCutoffSecs,
              tickPx: Number(spec.tickPx),
              maxSupplyUnits: spec.maxSupplyUnits,
            },
            program,
          ),
        );
      }
      for (const [side, names, mint] of [
        [Side.Yes, spec.yes, existing?.yesMint ?? null],
        [Side.No, spec.no, existing?.noMint ?? null],
      ] as const) {
        if (mint !== null) continue;
        instructions.push(
          await getCreateOutcomeMintInstructionAsync({ relayer, payer: relayer, market: marketAddress, side, ...names }, program),
        );
      }
      if (instructions.length === 0) return existing!;
      const signature = await sender.send(relayer, instructions);
      log(`market ${spec.symbol}: ${instructions.length} instruction(s) in ${signature}`);
      const fresh = await market(spec.symbol);
      if (fresh === null) throw new Error(`market ${spec.symbol} is missing after ${signature}`);
      return fresh;
    },

    async haltMarket(symbol) {
      // `status = Open` needs the admin, so the relayer only ever sends Halted.
      const instruction = await getSetMarketInstructionAsync(
        { authority: relayer, market: await marketPda(symbol), status: MarketStatus.Halted, closeTs: null },
        program,
      );
      return sender.send(relayer, [instruction]);
    },

    /**
     * Exactly-once like the order writes: the market is read before sending and again after any
     * failure, and when it is settled the transaction that settled it decides the result.
     */
    async settleMarket(symbol, yesPayout, noPayout) {
      const marketAddress = await marketPda(symbol);
      const account = await fetchMaybeMarket(rpc, marketAddress, { commitment });
      if (!account.exists) throw new Error(`market ${symbol} does not exist on-chain`);
      if (account.data.status === MarketStatus.Settled) return resolveSettled(marketAddress, account.data, yesPayout, noPayout);
      try {
        const instruction = await getSettleMarketInstructionAsync(
          {
            settler,
            payer: settler,
            market: marketAddress,
            yesMint: account.data.yesMint,
            noMint: account.data.noMint,
            funderStable: treasury,
            stableMint,
            yesPayout,
            noPayout,
          },
          program,
        );
        const signature = await sender.send(settler, [instruction]);
        log(`market ${symbol}: settled (${yesPayout}, ${noPayout}) in ${signature}`);
        return signature;
      } catch (error) {
        let after: Awaited<ReturnType<typeof fetchMaybeMarket>>;
        try {
          after = await fetchMaybeMarket(rpc, marketAddress, { commitment });
        } catch {
          throw error;
        }
        if (!after.exists || after.data.status !== MarketStatus.Settled) throw error;
        return resolveSettled(marketAddress, after.data, yesPayout, noPayout, error);
      }
    },

    async pause(flags) {
      const current = (await fetchConfig(rpc, await configPda(), { commitment })).data.pauseFlags;
      const wanted = current | (flags.place ? PAUSE_PLACE : 0) | (flags.fill ? PAUSE_FILL : 0);
      return sender.send(relayer, [await getSetPauseInstructionAsync({ authority: relayer, flags: wanted }, program)]);
    },

    async treasuryMicros() {
      return (await fetchToken(rpc, treasury, { commitment })).data.amount;
    },

    async relayerLamports() {
      return (await rpc.getBalance(relayer.address, { commitment }).send()).value;
    },

    close() {
      // HTTP only: there is no connection to close. Cached accounts are dropped.
      orders.clear();
      symbols.clear();
    },
  };
}
