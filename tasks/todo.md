# Build plan

Goal: prediction-market positions from the Gemini Predictions sandbox as SPL tokens on Solana devnet, behind a login. Design: [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md). Scope: [docs/SCOPE.md](../docs/SCOPE.md).

The build runs in vertical slices. Each slice ends with something that runs, and has a stated exit test. S0a, S0b and S0c are independent spikes and can run in any order; every other slice starts only after the exit tests it depends on have passed.

## Prerequisites (owner)

- [ ] Gemini sandbox account at https://exchange.sandbox.gemini.com/register, with the test USD balance showing and the Predictions page loading
- [ ] Sandbox API key: account scope (key starts with `account-`), Trader role only, "Uses a time-based nonce" on, "Requires Heartbeat" off, IP allowlist unrestricted. Values go in `.env` (see `.env.example`)
- [ ] Toolchain installed: Rust, Solana CLI 4.1.2, Anchor 1.2.2 (through AVM), pnpm 12
- [ ] About 5 devnet SOL on the deployer address (before the first devnet deploy)
- [ ] Privy development app: App ID, App Secret, email and wallet login on, test accounts on (before S2)
- [ ] Phantom browser extension with a throwaway wallet in Testnet Mode, for trying wallet login by hand (optional)

## S0a. Sandbox spike (go / no-go)

Needs only Node and the sandbox key. This is the one unknown that could stop the project, so it runs first.

- [x] Capture harness: authenticated WebSocket with every raw frame written to a log, plus REST snapshots of balances and positions
- [x] Terms already accepted on the account; placed a 1-contract BUY YES on a live 15-minute contract with a client order id
- [x] Recorded the fill event fields (quantity, price, trade id, fee), partial-fill and full-fill sequences, a no-fill, and rejections
- [x] Netting test: holding YES, buy NO; recorded position, cash movement and price space
- [x] Duplicate client order id behaviour; order history lookup by client order id
- [x] Held a position through expiry; recorded the settlement and payout records
- [x] Fixtures: tests use synthetic frames shaped like the recorded ones (recorded payloads are not committed)

Exit: passed (2026-11-14). A fresh sandbox account trades through the API. Answers:
- Fills are keyed by trade id. On a fill event the executed quantity is that execution; on the closing cancel event it is cumulative, so summing double-counts.
- A fill-or-kill order ends with a single filled or cancelled event; an immediate-or-cancel order that fills completely still ends with a cancel event.
- Netting holds: buying the opposite outcome reduces the position and releases a dollar per netted pair at once. A fully netted market gets no settlement record and no payout.
- The sandbox charges no fee (the fee field is present and zero).
- A client order id can be reused after its order closed, so the journal is the only guard against a second order. Order history returns the client order id.
- Signed REST calls must be at least a second apart (the nonce is in seconds and must increase).
- Settlement arrived 9 seconds after expiry; the settled-positions record carries the payout.

## S0b. Toolchain spike

- [x] `anchor init` in `anchor/`; one instruction that creates a Token-2022 mint (2 decimals, program-derived authority, metadata) and mints to an associated token account
- [x] LiteSVM test for it, including a clock-based expiry check and a classic-token transfer into a program-owned escrow
- [x] Pinned Codama generation into `clients/js/`; type-check against `@solana/kit` 8.6.0
- [x] Deploy to devnet and call the instruction from Node through the generated client
- [x] Write the installed versions into `docs/VERSIONS.md`

Exit: passed (2026-11-14). Program id `8TN1HWcEFTAcM7Vthmih1FKftTBrp3LDgTBkfhp1PRVn` on devnet; 12 spike tests green; a spike mint with metadata created and 100 units minted on devnet through the generated client. The spike instructions are throwaway and are replaced by the real program in S1.

## S1. Headless slice: buy, mint, settle, redeem

One 15-minute market, YES side, no UI.

- [x] Program, part 1: `initialize`, `set_config`, `set_pause`, `register_trader`, `create_market`, `create_outcome_mint`, `set_market`, `place_buy`, `fill_buy`, `cancel_order`, with account layouts frozen (124 tests; deployed to devnet)
- [x] Program, part 2: `settle_market`, `revoke_settlement`, `redeem`, and the later-slice instructions `place_sell`, `fill_sell` (182 tests in all; the complete program is deployed to devnet and configured there)
- [x] LiteSVM tests for every instruction and invariant, plus the adversarial cases listed in the architecture doc (substitution, donation, expiry boundaries, role separation, two-user lifecycle)
- [x] Relayer, part 1: SQLite journal, fill aggregation, order pipeline with crash recovery, mock venue, sandbox adapter (522 tests; live sandbox order placed and filled through the adapter)
- [x] Relayer, part 2: Solana adapter, market manager, settlement watcher, reconciliation, daemon and local API (698 tests)
- [x] Devnet and sandbox start-up guards
- [x] Scripts: `bootstrap` (role keys, dUSD mint, treasury float, initialize), `demo` (a test user: setup, buy, sell, redeem, reclaim), `local-e2e` (a full run on a local validator with the mock venue)

Exit: passed on devnet with the sandbox (2026-11-14), except item 4, which is covered by the pipeline's crash tests and has not been forced on live infrastructure.
1. The user's YES balance equals the sandbox filled quantity times 100.
2. An unfillable limit is cancelled with a full refund.
3. With the relayer stopped, anyone can refund the order after its deadline.
4. Killing the relayer between the sandbox order and the on-chain fill, then restarting, yields exactly one sandbox order and one mint.
5. The market settles from the sandbox outcome.
6. Redeem pays units times payout and supply returns to zero.

## S0c. Login spike

- [x] Next.js 16 with Privy: email login with a test account creates an embedded Solana wallet
- [x] Wallet login: the login window lists Phantom, Solflare, Backpack and WalletConnect (signing in with a real wallet extension is a manual check; an injected test wallet covers it in the browser tests later)
- [x] A transaction built with `@solana/kit` is signed through Privy with the embedded wallet and confirms on devnet
- [x] The server verifies the login token and reads the user's Solana wallet
- [x] `next build` passes

Exit: passed (2026-11-14). Email login, embedded wallet, server-side token verification and a signed devnet transaction all work on Next.js 16.4.6, React 19.3.1, Privy 3.51.4 and Solana Kit 8.6.0.

## S2. Web app

- [x] Onboarding route: verify the login token, register the trader, send starter SOL and dUSD once
- [x] Markets, Ticket, Activity (timeline, receipt, Reclaim), Portfolio, Redeem
- [x] Devnet / sandbox banner and footer notice

Exit: passed on devnet with the sandbox (2026-11-14), using only the browser. The email test account took test funds, bought on the 20:00 and 20:15 UTC contracts, saw both settled from the sandbox's result, redeemed a winning position for $1.00 and cleared the losing ones. A wallet login ran the same loop (test funds, a buy signed by the wallet, a winning redemption) and placed a further order after a page reload through Reconnect wallet. The wallet in these runs is a Wallet Standard test wallet injected into the page the way an extension registers itself; signing in with a real extension such as Phantom, or through WalletConnect, is a manual check that has not been done.

## S3. Breadth: the v1 demo

- [x] NO side; curated market rotation with the tradable-now check; token metadata
- [x] Fee pass-through from the venue's fill data; minimum order rules
- [x] `set_config`, `set_pause`, `set_market`, `revoke_settlement`; supply and order caps exercised (program tests)
- [x] Reconciliation of the venue position against token supply, a treasury cover check, and a reconciliation table on the system page; admin commands `status`, `pause`, `cancel-expired`, `settle`
- [ ] Not built: a trade-by-trade tie-out of the venue's cash balance, and a `void-market` command (a market held for review is settled by hand)
- [x] Mock venue; a deterministic end-to-end run on a local validator (`pnpm e2e:local`); CI for the type-check and unit tests of the TypeScript packages
- [ ] Not in CI: the program tests (they need the Solana toolchain) and a linter

Exit: met across the live runs of 2026-11-14 rather than in one timed hour. Between 18:47 and 20:17 UTC the relayer handled 16 orders from three test wallets on 8 sandbox contracts: buys on both sides and sells, 13 filled and 3 refunded. After every step reconciliation showed the venue's net position equal to YES supply minus NO supply, with no alerts; no order account was left open; every settled market paid on redemption.

## S4. Sell-back

- [x] `place_sell`, `fill_sell`, the buy-opposite order mapping, sell ticket with estimated proceeds

Exit: passed on devnet with the sandbox (2026-11-14), from the browser. Bought 2.00 YES, sold 1.00 of it back (the relayer bought NO at the venue, the tokens were burned and $0.48 was paid), the market settled, and the rest was redeemed (it had lost, so it paid nothing). Reconciliation stayed balanced throughout. A first sale, with its minimum above a bid that had just moved, was not filled and the tokens came back.

## S5. Hardening and optional hosting

- [x] Browser checks with a login test account: `apps/web/e2e/live-*.mjs` drive a live stack, `screens.mjs` drives every page and state against fixtures
- [x] Failure injection: crash recovery in the pipeline's tests; with the relayer stopped, the app kept showing balances, positions and open orders from Solana, a position was cleared, and expired orders were reclaimed from the browser and from the command line
- [ ] More login methods (Google, passkey): not planned
- [ ] Hosted demo: not planned; this is a local app

## Out of plan

This is a personal project. It stays on devnet and the sandbox, and nothing here involves contacting anyone. What a version with real users would take is described in docs/SCOPE.md for context only.

## Open decisions

- [ ] License for this repository

## Review

Finished on 2026-11-14.

What was built:

- **Program** `outcome_tokens` (Anchor 1.2.2, Token-2022): 15 instructions, 188 tests on LiteSVM, deployed and configured on devnet.
- **Relayer**: order pipeline with a write-ahead journal and crash recovery, sandbox and mock venue adapters, market manager, settlement watcher, reconciliation, a local API and command-line tools; 699 unit tests.
- **Web app** (Next.js, Privy): login with email or a Solana wallet, test funds, markets, an order ticket for buying and selling that turns into a live timeline, portfolio with redemption, activity with receipts and Reclaim, and a system page; 228 unit tests, and screenshots of every page and state from a fixtures mode.

What was verified live on devnet against the sandbox, all on 2026-11-14 and all from the browser unless noted:

| What | Result |
|---|---|
| Buy, email login | filled at the sandbox and minted 6 to 9 seconds after the click |
| Buy with no offer at the limit (command line) | refunded in full |
| Sell | filled: tokens burned and the proceeds paid in 8 seconds; with a minimum above the bid: tokens returned |
| Settlement | recorded on-chain about 40 seconds after expiry, from the sandbox's result |
| Redeem | $1.00 per winning token, confirmed in under 2 seconds; losing tokens cleared |
| Wallet login | a buy signed by the wallet, a winning redemption, and an order after a page reload through Reconnect wallet |
| Relayer stopped | pages kept working from Solana; a position was cleared; three expired orders were reclaimed, the newest on the first click the moment it expired |
| Reconciliation | balanced after every step; no alerts |

One defect was found by the live runs and fixed: with the relayer stopped, an order's expiry was counted on the local clock, so Reclaim was offered a few seconds before the program allowed it. The app now reads the cluster's clock itself while the relayer is away.

Not done, and why:

- A real extension wallet (Phantom) and WalletConnect have not been tried by hand. The login window lists them, and an injected Wallet Standard wallet covers the same code path in the browser checks.
- Killing the relayer between the venue order and the on-chain fill has not been forced on live infrastructure; the pipeline's crash tests cover it.
- The sandbox's market makers quote only part of the time. When a book is empty every order is refunded; `pnpm dev:mock` runs the same system against a simulated venue.
- The known limits of the design are listed in [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).
