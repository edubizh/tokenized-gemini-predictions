// One-time setup of a cluster for the relayer: role keys, SOL, the dUSD test stablecoin, the
// stable token accounts, the program's Config, and the deployment file. Run from apps/relayer:
//
//   node --env-file=../../.env scripts/bootstrap.ts [devnet|localnet]
//
// Idempotent, and only for Solana devnet or a local validator. The steps are in
// `lib/bootstrap.ts`; it is loaded after the resolver for the program client is registered.

import "../src/chain/client-loader.ts";

try {
  const { runCli } = await import("./lib/bootstrap.ts");
  process.exitCode = await runCli(process.argv.slice(2), process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
