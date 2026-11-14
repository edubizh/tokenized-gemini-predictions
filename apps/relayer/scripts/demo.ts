// A test user trading through a running relayer, from the command line. Run from apps/relayer:
//
//   node --env-file=../../.env scripts/demo.ts setup
//   node --env-file=../../.env scripts/demo.ts markets
//   node --env-file=../../.env scripts/demo.ts buy  <symbol|auto> <yes|no> <contracts> [limit]
//   node --env-file=../../.env scripts/demo.ts sell <symbol> <yes|no> <contracts> [minimum]
//   node --env-file=../../.env scripts/demo.ts redeem <symbol>
//   node --env-file=../../.env scripts/demo.ts status
//
// Devnet or a local validator only, with test tokens. The steps are in `lib/demo.ts`; it is
// loaded after the resolver for the program client is registered.

import "../src/chain/client-loader.ts";

try {
  const { runCli } = await import("./lib/demo.ts");
  process.exitCode = await runCli(process.argv.slice(2), process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
