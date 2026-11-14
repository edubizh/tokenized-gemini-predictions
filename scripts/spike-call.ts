/**
 * Calls the deployed spike instructions on Solana devnet through the generated client.
 *
 * Transaction 1 creates a market and its side-0 Token-2022 mint. Transaction 2 creates the
 * caller's associated token account and mints 100 units to it. The mint is then read back.
 *
 *   pnpm exec tsx scripts/spike-call.ts
 *
 * Environment (all optional):
 *   SOLANA_RPC_URL   default https://api.devnet.solana.com
 *   SOLANA_WS_URL    default wss://api.devnet.solana.com
 *   SOLANA_KEYPAIR   default .keys/deployer-keypair.json (must be the program's upgrade authority)
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  address,
  appendTransactionMessageInstructions,
  assertIsSendableTransaction,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  devnet,
  estimateResourceLimitsFactory,
  getAddressEncoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  unwrapOption,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Signature,
} from '@solana/kit';
import {
  fetchMint,
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';

import {
  fetchSpikeMarket,
  findMarketPda,
  findMintPda,
  getSpikeCreateMarketInstructionAsync,
  getSpikeCreateMintInstructionAsync,
  getSpikeMintInstructionAsync,
  OUTCOME_TOKENS_PROGRAM_ADDRESS,
} from '@outcome/program-client';

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const BPF_LOADER_UPGRADEABLE_PROGRAM_ADDRESS = address(
  'BPFLoaderUpgradeab1e11111111111111111111111',
);

const SIDE_YES = 0;
const MINT_AMOUNT = 100n;
/** Headroom added to the simulated compute units before the limit is set explicitly. */
const COMPUTE_UNIT_MARGIN = 1.1;

const repoRoot = path.resolve(import.meta.dirname, '..');
const rpcUrl = process.env['SOLANA_RPC_URL'] ?? 'https://api.devnet.solana.com';
const wsUrl = process.env['SOLANA_WS_URL'] ?? 'wss://api.devnet.solana.com';
const keypairPath = path.resolve(
  repoRoot,
  process.env['SOLANA_KEYPAIR'] ?? '.keys/deployer-keypair.json',
);

const rpc = createSolanaRpc(devnet(rpcUrl));
const rpcSubscriptions = createSolanaRpcSubscriptions(devnet(wsUrl));
const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
const estimateResourceLimits = estimateResourceLimitsFactory({ rpc });

async function loadSigner(file: string): Promise<KeyPairSigner> {
  const bytes: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error(`${file} is not a 64-byte keypair file`);
  }
  return await createKeyPairSignerFromBytes(Uint8Array.from(bytes as number[]));
}

async function findProgramDataAddress(program: Address): Promise<Address> {
  const [programData] = await getProgramDerivedAddress({
    programAddress: BPF_LOADER_UPGRADEABLE_PROGRAM_ADDRESS,
    seeds: [getAddressEncoder().encode(program)],
  });
  return programData;
}

/**
 * Sends one version-0 transaction. The compute-unit limit comes from a simulation and is set
 * explicitly; the blockhash is fetched immediately before signing.
 */
async function send(
  label: string,
  payer: KeyPairSigner,
  instructions: Instruction[],
): Promise<Signature> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const { computeUnitLimit: simulatedUnits } = await estimateResourceLimits(message, {
    commitment: 'confirmed',
  });
  const unitLimit = Math.ceil(simulatedUnits * COMPUTE_UNIT_MARGIN);

  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const transaction = await signTransactionMessageWithSigners(
    pipe(
      message,
      (m) => setTransactionMessageComputeUnitLimit(unitLimit, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    ),
  );
  assertIsSendableTransaction(transaction);
  assertIsTransactionWithBlockhashLifetime(transaction);

  const signature = getSignatureFromTransaction(transaction);
  await sendAndConfirmTransaction(transaction, { commitment: 'confirmed' });

  const consumed = await fetchComputeUnitsConsumed(signature);
  console.log(`${label}`);
  console.log(`  signature              ${signature}`);
  console.log(`  compute unit limit     ${unitLimit} (simulated ${simulatedUnits})`);
  console.log(`  compute units consumed ${consumed ?? 'unavailable'}`);
  return signature;
}

async function fetchComputeUnitsConsumed(signature: Signature): Promise<bigint | undefined> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const transaction = await rpc
      .getTransaction(signature, {
        commitment: 'confirmed',
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
      })
      .send();
    if (transaction?.meta) {
      return transaction.meta.computeUnitsConsumed;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return undefined;
}

async function main(): Promise<void> {
  const genesisHash = await rpc.getGenesisHash().send();
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error(`Refusing to run: ${rpcUrl} is not Solana devnet`);
  }

  const user = await loadSigner(keypairPath);
  const symbol = `SPIKE-${Math.floor(Date.now() / 1_000)}`;
  const symbolHash = createHash('sha256').update(symbol).digest();

  const [market] = await findMarketPda({ symbolHash });
  const [mint] = await findMintPda({ market, side: SIDE_YES });
  const [userToken] = await findAssociatedTokenPda({
    owner: user.address,
    mint,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });

  console.log(`program    ${OUTCOME_TOKENS_PROGRAM_ADDRESS}`);
  console.log(`user       ${user.address}`);
  console.log(`symbol     ${symbol}`);
  console.log(`market     ${market}`);
  console.log(`mint       ${mint}`);
  console.log(`user token ${userToken}`);

  await send('create market and mint', user, [
    await getSpikeCreateMarketInstructionAsync({
      authority: user,
      programData: await findProgramDataAddress(OUTCOME_TOKENS_PROGRAM_ADDRESS),
      symbol,
      symbolHash,
    }),
    await getSpikeCreateMintInstructionAsync({
      payer: user,
      market,
      side: SIDE_YES,
      name: `Spike ${symbol} YES`,
      symbol: 'SPIKE-YES',
      uri: '',
    }),
  ]);

  await send('create token account and mint', user, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: user,
      owner: user.address,
      mint,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    await getSpikeMintInstructionAsync({ user, market, mint, amount: MINT_AMOUNT }),
  ]);

  const [marketAccount, mintAccount, tokenAccount] = await Promise.all([
    fetchSpikeMarket(rpc, market),
    fetchMint(rpc, mint),
    fetchToken(rpc, userToken),
  ]);
  const metadata = unwrapOption(mintAccount.data.extensions)?.find(
    (extension) => extension.__kind === 'TokenMetadata',
  );

  console.log('read back');
  console.log(`  market bump       ${marketAccount.data.bump}`);
  console.log(`  mint owner        ${mintAccount.programAddress}`);
  console.log(`  supply            ${mintAccount.data.supply}`);
  console.log(`  decimals          ${mintAccount.data.decimals}`);
  console.log(`  mint authority    ${unwrapOption(mintAccount.data.mintAuthority)}`);
  console.log(`  freeze authority  ${unwrapOption(mintAccount.data.freezeAuthority)}`);
  console.log(`  metadata name     ${metadata?.name}`);
  console.log(`  metadata symbol   ${metadata?.symbol}`);
  console.log(`  user balance      ${tokenAccount.data.amount}`);

  if (mintAccount.data.supply !== MINT_AMOUNT || tokenAccount.data.amount !== MINT_AMOUNT) {
    throw new Error('Supply or balance does not equal the minted amount');
  }
}

await main();
