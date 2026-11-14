// Deterministic end-to-end run on a local validator with the mock venue. Run from apps/relayer:
//
//   node scripts/local-e2e.ts
//
// Prints `LOCAL E2E OK` and exits 0; any failed assertion exits 1 with the reason. The validator
// it starts is stopped again in every case. Ports 8899, 8900 and 9900 must be free.
//
// Environment (optional):
//   PROGRAM_SO   program binary to load, default <repo>/.data/outcome_tokens.p4.so
//
// The run is in `lib/local-e2e.ts`; it is loaded after the resolver for the program client is
// registered.

import "../src/chain/client-loader.ts";

await import("./lib/local-e2e.ts");
