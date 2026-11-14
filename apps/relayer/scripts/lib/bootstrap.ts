// The bootstrap steps behind `scripts/bootstrap.ts`: role keys, SOL, the dUSD test stablecoin, the
// stable token accounts, the program's Config, and the deployment file.
//
// Idempotent: every step first checks whether it is already done. Only Solana devnet or a local
// validator is accepted. Key material is never printed.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  address,
  fetchEncodedAccount,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  lamports,
  unwrapOption,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { fetchMaybeConfig, findConfigPda, getInitializeInstructionAsync, OUTCOME_TOKENS_PROGRAM_ADDRESS } from "@outcome/program-client";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import {
  fetchMaybeMint,
  fetchMaybeToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { createRetryingRpc } from "../../src/chain/rpc.ts";
import { ensureKeypairFile, loadKeypairSigner } from "../../src/chain/keys.ts";
import { createSender, waitForSignature, type ChainRpc } from "../../src/chain/send.ts";

export type Cluster = "devnet" | "localnet";

/** Content of `deployments/<cluster>.json`. */
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

export interface BootstrapOptions {
  cluster: Cluster;
  rpcUrl: string;
  repoRoot: string;
  log?: (line: string) => void;
}

export interface BootstrapResult {
  deployment: Deployment;
  deploymentPath: string;
  /** Differences between an existing Config and the expected values. Empty when it matches. */
  configDifferences: string[];
}

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const LOCALNET_RPC_URL = "http://127.0.0.1:8899";
const UPGRADEABLE_LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");

const LAMPORTS_PER_SOL = 1_000_000_000n;
const DUSD = 1_000_000n;
const STABLE_DECIMALS = 6;
const COMMITMENT = "confirmed";

/** SOL of each role: topped up to `target` when below `floor`. */
const SOL_TARGETS = {
  relayer: { target: 3n * LAMPORTS_PER_SOL, floor: 1n * LAMPORTS_PER_SOL },
  registrar: { target: 2n * LAMPORTS_PER_SOL, floor: LAMPORTS_PER_SOL / 2n },
  settler: { target: LAMPORTS_PER_SOL / 2n, floor: LAMPORTS_PER_SOL / 10n },
} as const;
/** What the deployer keeps for its own fees and rent on top of the top-ups. */
const DEPLOYER_RESERVE = LAMPORTS_PER_SOL / 2n;
const LOCAL_AIRDROP = 100n * LAMPORTS_PER_SOL;

/** dUSD of each stable account: minted up to the target when below half of it. */
const STABLE_TARGETS = { treasury: 1_000_000n * DUSD, relayerFloat: 100_000n * DUSD, faucet: 1_000_000n * DUSD } as const;

const CONFIG_VALUES = { orderTtlSecs: 90, minOrderUnits: 1n, maxOrderUnits: 10_000n, settleDelaySecs: 30 } as const;

/** Throws unless the cluster behind `rpcUrl` may be used: devnet, or a validator on this machine. */
export function assertClusterAllowed(cluster: Cluster, rpcUrl: string, genesisHash: string): void {
  if (genesisHash === MAINNET_GENESIS_HASH) throw new Error("refusing to run: the RPC endpoint is Solana mainnet");
  if (genesisHash === DEVNET_GENESIS_HASH) return;
  const host = new URL(rpcUrl).hostname;
  if (cluster === "localnet" && (host === "127.0.0.1" || host === "localhost")) return;
  throw new Error(`refusing to run: the RPC endpoint is neither Solana devnet nor a local validator (cluster argument: ${cluster})`);
}

export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const { cluster, rpcUrl, repoRoot } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const rpc = createRetryingRpc(rpcUrl);
  assertClusterAllowed(cluster, rpcUrl, await rpc.getGenesisHash().send());

  const programId = OUTCOME_TOKENS_PROGRAM_ADDRESS;
  const sender = createSender({ rpc, programId, commitment: COMMITMENT, computeUnitLimit: 200_000, confirmTimeoutMs: 60_000 });

  // 1. Keys.
  const keysDir = path.join(repoRoot, ".keys");
  const deployer = await loadKeypairSigner(path.join(keysDir, "deployer-keypair.json"));
  const load = async (name: string): Promise<KeyPairSigner> => {
    const file = path.join(keysDir, `${name}-keypair.json`);
    if (await ensureKeypairFile(file)) log(`created .keys/${name}-keypair.json`);
    return loadKeypairSigner(file);
  };
  const relayer = await load("relayer");
  const settler = await load("settler");
  const registrar = await load("registrar");
  const stableMint = await load("dusd-mint");

  // 2. SOL.
  const balance = async (owner: Address): Promise<bigint> => (await rpc.getBalance(owner, { commitment: COMMITMENT }).send()).value;
  const topUps: Array<{ name: string; to: Address; amount: bigint }> = [];
  for (const [name, signer] of [["relayer", relayer], ["registrar", registrar], ["settler", settler]] as const) {
    const have = await balance(signer.address);
    if (have < SOL_TARGETS[name].floor) topUps.push({ name, to: signer.address, amount: SOL_TARGETS[name].target - have });
  }
  const needed = topUps.reduce((sum, topUp) => sum + topUp.amount, 0n) + DEPLOYER_RESERVE;
  if ((await balance(deployer.address)) < needed) {
    if (cluster !== "localnet") {
      throw new Error(`the deployer ${deployer.address} needs at least ${formatSol(needed)} SOL on devnet`);
    }
    log(`airdropping ${formatSol(LOCAL_AIRDROP)} SOL to the deployer`);
    const signature = await rpc.requestAirdrop(deployer.address, lamports(LOCAL_AIRDROP), { commitment: COMMITMENT }).send();
    await waitForSignature(rpc, signature, COMMITMENT, 30_000);
  }
  if (topUps.length > 0) {
    await sender.send(
      deployer,
      topUps.map(({ to, amount }) => getTransferSolInstruction({ source: deployer, destination: to, amount })),
    );
    for (const { name, amount } of topUps) log(`sent ${formatSol(amount)} SOL to the ${name}`);
  }

  // 3. The dUSD mint: classic SPL Token, 6 decimals, mint authority = deployer, no freeze authority.
  const mintAccount = await fetchMaybeMint(rpc, stableMint.address, { commitment: COMMITMENT });
  if (!mintAccount.exists) {
    const space = BigInt(getMintSize());
    const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
    await sender.send(deployer, [
      getCreateAccountInstruction({ payer: deployer, newAccount: stableMint, lamports: rent, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
      getInitializeMint2Instruction({ mint: stableMint.address, decimals: STABLE_DECIMALS, mintAuthority: deployer.address, freezeAuthority: null }),
    ]);
    log(`created the dUSD mint ${stableMint.address}`);
  } else {
    const authority = unwrapOption(mintAccount.data.mintAuthority);
    if (mintAccount.programAddress !== TOKEN_PROGRAM_ADDRESS || mintAccount.data.decimals !== STABLE_DECIMALS || authority !== deployer.address) {
      throw new Error(`the account at ${stableMint.address} is not the expected dUSD mint (classic token program, 6 decimals, deployer authority)`);
    }
  }

  // 4. Stable token accounts.
  const stableAccounts = {
    treasury: { owner: settler.address, target: STABLE_TARGETS.treasury },
    relayerFloat: { owner: relayer.address, target: STABLE_TARGETS.relayerFloat },
    faucet: { owner: registrar.address, target: STABLE_TARGETS.faucet },
  } as const;
  const tokenAddresses = {} as Record<keyof typeof stableAccounts, Address>;
  for (const name of ["treasury", "relayerFloat", "faucet"] as const) {
    const { owner, target } = stableAccounts[name];
    const [account] = await findAssociatedTokenPda({ owner, mint: stableMint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    tokenAddresses[name] = account;
    const existing = await fetchMaybeToken(rpc, account, { commitment: COMMITMENT });
    const have = existing.exists ? existing.data.amount : 0n;
    const instructions: Instruction[] = [];
    if (!existing.exists) {
      instructions.push(
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: deployer, owner, mint: stableMint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
      );
    }
    if (have < target / 2n) {
      instructions.push(getMintToInstruction({ mint: stableMint.address, token: account, mintAuthority: deployer, amount: target - have }));
    }
    if (instructions.length > 0) {
      await sender.send(deployer, instructions);
      log(`${name}: ${existing.exists ? "" : "created, "}balance ${formatDusd(have < target / 2n ? target : have)} dUSD`);
    }
  }

  // 5. Config.
  const [configAddress] = await findConfigPda({ programAddress: programId });
  const expected = {
    admin: deployer.address,
    relayer: relayer.address,
    settler: settler.address,
    registrar: registrar.address,
    stableMint: stableMint.address,
    treasury: tokenAddresses.treasury,
    ...CONFIG_VALUES,
  };
  const configDifferences: string[] = [];
  const configAccount = await fetchMaybeConfig(rpc, configAddress, { commitment: COMMITMENT });
  if (!configAccount.exists) {
    const [programData] = await getProgramDerivedAddress({ programAddress: UPGRADEABLE_LOADER, seeds: [getAddressEncoder().encode(programId)] });
    const authority = await upgradeAuthority(rpc, programData);
    if (authority !== deployer.address) {
      throw new Error(`the upgrade authority of ${programId} is ${authority ?? "none"}, not the deployer ${deployer.address}`);
    }
    const mint = await fetchMaybeMint(rpc, stableMint.address, { commitment: COMMITMENT });
    if (!mint.exists || mint.data.decimals !== STABLE_DECIMALS) throw new Error("the stable mint does not have 6 decimals");
    const treasuryAccount = await fetchMaybeToken(rpc, tokenAddresses.treasury, { commitment: COMMITMENT });
    if (!treasuryAccount.exists || treasuryAccount.data.owner !== settler.address || treasuryAccount.data.mint !== stableMint.address) {
      throw new Error("the treasury is not a stable token account owned by the settler");
    }
    await sender.send(deployer, [
      await getInitializeInstructionAsync(
        {
          authority: deployer,
          payer: deployer,
          stableMint: stableMint.address,
          treasury: tokenAddresses.treasury,
          program: programId,
          programData,
          relayer: relayer.address,
          settler: settler.address,
          registrar: registrar.address,
          ...CONFIG_VALUES,
        },
        { programAddress: programId },
      ),
    ]);
    log(`initialized the program config ${configAddress}`);
  } else {
    const actual = configAccount.data;
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      if (actual[key] !== expected[key]) configDifferences.push(`config.${key}: on-chain ${String(actual[key])}, expected ${String(expected[key])}`);
    }
    if (configDifferences.length === 0) log(`the program config ${configAddress} exists and matches`);
    else for (const difference of configDifferences) log(`DIFFERENCE ${difference}`);
  }

  // 6. Deployment file and summary.
  const deployment: Deployment = {
    cluster,
    programId,
    config: configAddress,
    stableMint: stableMint.address,
    treasury: tokenAddresses.treasury,
    admin: deployer.address,
    relayer: relayer.address,
    settler: settler.address,
    registrar: registrar.address,
    relayerFloat: tokenAddresses.relayerFloat,
    faucet: tokenAddresses.faucet,
  };
  const deploymentPath = path.join(repoRoot, "deployments", `${cluster}.json`);
  await mkdir(path.dirname(deploymentPath), { recursive: true });
  await writeFile(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`);

  const stableBalance = async (account: Address): Promise<string> => {
    const token = await fetchMaybeToken(rpc, account, { commitment: COMMITMENT });
    return token.exists ? formatDusd(token.data.amount) : "missing";
  };
  log(`cluster      ${cluster}`);
  log(`program      ${programId}`);
  log(`config       ${configAddress}`);
  log(`dUSD mint    ${stableMint.address}`);
  log(`admin        ${deployer.address}  ${formatSol(await balance(deployer.address))} SOL`);
  log(`relayer      ${relayer.address}  ${formatSol(await balance(relayer.address))} SOL`);
  log(`settler      ${settler.address}  ${formatSol(await balance(settler.address))} SOL`);
  log(`registrar    ${registrar.address}  ${formatSol(await balance(registrar.address))} SOL`);
  log(`treasury     ${tokenAddresses.treasury}  ${await stableBalance(tokenAddresses.treasury)} dUSD`);
  log(`float        ${tokenAddresses.relayerFloat}  ${await stableBalance(tokenAddresses.relayerFloat)} dUSD`);
  log(`faucet       ${tokenAddresses.faucet}  ${await stableBalance(tokenAddresses.faucet)} dUSD`);
  log(`written      ${path.relative(repoRoot, deploymentPath)}`);
  return { deployment, deploymentPath, configDifferences };
}

/** Upgrade authority stored in a ProgramData account of the upgradeable loader, or null. */
async function upgradeAuthority(rpc: ChainRpc, programData: Address): Promise<Address | null> {
  const account = await fetchEncodedAccount(rpc, programData, { commitment: COMMITMENT });
  if (!account.exists || account.programAddress !== UPGRADEABLE_LOADER) throw new Error(`the program data account ${programData} does not exist`);
  // Layout: u32 variant (3 = ProgramData), u64 slot, Option<Pubkey>.
  const data = account.data;
  const variant = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
  if (variant !== 3 || data.length < 45) throw new Error(`${programData} is not a program data account`);
  if (data[12] !== 1) return null;
  return getAddressDecoder().decode(data.subarray(13, 45));
}

function formatSol(amount: bigint): string {
  return formatFixed(amount, 9, 3);
}

function formatDusd(amount: bigint): string {
  return formatFixed(amount, STABLE_DECIMALS, 2);
}

/** `amount` scaled down by 10^decimals, cut (not rounded) to `shown` decimals. */
function formatFixed(amount: bigint, decimals: number, shown: number): string {
  const digits = amount.toString().padStart(decimals + 1, "0");
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals, digits.length - decimals + shown)}`;
}

/** The command line: `[devnet|localnet]`, default devnet. Exit code 2 when an existing Config differs. */
export async function runCli(argv: readonly string[], env: Record<string, string | undefined>): Promise<number> {
  const argument = argv[0] ?? "devnet";
  if (argument !== "devnet" && argument !== "localnet") throw new Error(`unknown cluster ${JSON.stringify(argument)}: use devnet or localnet`);
  let rpcUrl = LOCALNET_RPC_URL;
  if (argument === "devnet") {
    const fromEnv = env["SOLANA_RPC_URL"];
    if (!fromEnv) throw new Error("SOLANA_RPC_URL must be set for devnet");
    rpcUrl = fromEnv;
  }
  const repoRoot = path.resolve(import.meta.dirname, "../../../..");
  const { configDifferences } = await bootstrap({ cluster: argument, rpcUrl, repoRoot });
  return configDifferences.length > 0 ? 2 : 0;
}
