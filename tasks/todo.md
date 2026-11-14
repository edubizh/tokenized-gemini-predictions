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
- [ ] Program, part 2: `settle_market`, `revoke_settlement`, `redeem`
- [ ] LiteSVM tests for every instruction and invariant, plus the adversarial cases listed in the architecture doc
- [x] Relayer, part 1: SQLite journal, fill aggregation, order pipeline with crash recovery, mock venue, sandbox adapter (522 tests; live sandbox order placed and filled through the adapter)
- [ ] Relayer, part 2: Solana adapter, market manager, settlement watcher, reconciliation, daemon and local API
- [ ] Devnet and sandbox start-up guards
- [ ] Scripts: bootstrap (deploy, initialize, dUSD mint, treasury float), `demo-buy`, `demo-redeem`

Exit:
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

- [ ] Onboarding route: verify the login token, register the trader, send starter SOL and dUSD once
- [ ] Markets, Ticket, Activity (timeline, receipt, Reclaim), Portfolio, Redeem
- [ ] Devnet / sandbox banner and footer notice

Exit: a new email account completes test funds, buy, settle and redeem on two consecutive 15-minute contracts using only the browser, and a wallet login (Phantom) completes the same flow once.

## S3. Breadth: the v1 demo

- [ ] NO side; curated market rotation with the tradable-now check; token metadata
- [ ] Fee pass-through from the venue's fill data; minimum order rules
- [ ] `set_config`, `set_pause`, `set_market`, `revoke_settlement`; supply and order caps exercised
- [ ] Reconciliation checks I1 to I3 and a reconciliation page; admin commands (status, pause, cancel-expired, void-market)
- [ ] Mock venue; deterministic end-to-end suite; CI (program tests, type-check, lint)

Exit: a one-hour run with at least 10 orders on at least 4 markets and both sides; reconciliation shows venue net position equal to (YES supply minus NO supply) per market; no order accounts left open; every settled market redeemable.

## S4. Sell-back

- [ ] `place_sell`, `fill_sell`, the buy-opposite order mapping, sell ticket with estimated proceeds

Exit: buy, sell part, settle, redeem the rest on one market, with reconciliation clean throughout.

## S5. Hardening and optional hosting

- [ ] Browser end-to-end test with a login test account; failure-injection runs
- [ ] More login methods (Google, passkey)
- [ ] Hosted demo on the mock venue (or sandbox mode behind an allow-list); Postgres if more than one process needs the ledger

## Out of plan

This is a personal project. It stays on devnet and the sandbox, and nothing here involves contacting anyone. What a version with real users would take is described in docs/SCOPE.md for context only.

## Open decisions

- [ ] License for this repository

## Review

(Filled in as slices complete.)
