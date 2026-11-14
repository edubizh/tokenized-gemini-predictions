# Build plan

Goal: prediction-market positions from the Gemini Predictions sandbox as SPL tokens on Solana devnet, behind a login. Design: [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md). Scope: [docs/SCOPE.md](../docs/SCOPE.md).

The build runs in vertical slices. Each slice ends with something that runs, and has a stated exit test. Nothing in a later slice starts until the exit test of the one before it passes.

## Prerequisites (owner)

- [ ] Gemini sandbox account at https://exchange.sandbox.gemini.com/register, with the test USD balance showing and the Predictions page loading
- [ ] Sandbox API key: account scope (key starts with `account-`), Trader role only, "Uses a time-based nonce" on, "Requires Heartbeat" off, IP allowlist unrestricted. Values go in `.env` (see `.env.example`)
- [ ] Toolchain installed: Rust, Solana CLI 4.1.2, Anchor 1.2.2 (through AVM), pnpm 12
- [ ] About 5 devnet SOL on the deployer address (before the first devnet deploy)
- [ ] Privy development app: App ID, App Secret, email login on, test accounts on (before S2)

## S0a. Sandbox spike (go / no-go)

Needs only Node and the sandbox key. This is the one unknown that could stop the project, so it runs first.

- [ ] Capture harness: authenticated WebSocket with every raw frame written to a log, plus REST snapshots of balances and positions
- [ ] Accept the sandbox Prediction Markets terms; place a 1-contract BUY YES on a live 15-minute contract with a client order id
- [ ] Record the fill event fields (quantity, price, trade id, fee), partial-fill and full-fill sequences, a no-fill, and rejections
- [ ] Netting test: holding YES, buy NO; record position, cash movement and price space
- [ ] Duplicate client order id behaviour; order history lookup by client order id
- [ ] Hold a position through expiry; record the settlement and payout records
- [ ] Save scrubbed transcripts as fixtures

Exit: a fill with derivable quantity and cost, a settled payout record, and written answers to the open questions (netting, fee field, client order id in history). Stop and contact Gemini if a fresh sandbox account cannot trade.

## S0b. Toolchain spike

- [ ] `anchor init` in `anchor/`; one instruction that creates a Token-2022 mint (2 decimals, program-derived authority, metadata) and mints to an associated token account
- [ ] LiteSVM test for it, including a clock-based expiry check and a classic-token transfer into a program-owned escrow
- [ ] Pinned Codama generation into `clients/js/`; type-check against `@solana/kit` 8.6.0
- [ ] Deploy to devnet and call the instruction from Node through the generated client
- [ ] Write the installed versions into `docs/VERSIONS.md`

Exit: confirmed devnet signature. Fallback if not green within one session: build S1 without a custom program (backend-held mint authority) behind the same relayer core.

## S1. Headless slice: buy, mint, settle, redeem

One 15-minute market, YES side, no UI.

- [ ] Program: `initialize`, `register_trader`, `create_market`, `create_outcome_mint`, `place_buy`, `fill_buy`, `cancel_order`, `settle_market`, `redeem`, with account layouts frozen (including fields used by later slices)
- [ ] LiteSVM tests for every instruction and invariant, plus the adversarial cases listed in the architecture doc
- [ ] Relayer: order polling, SQLite journal, sandbox adapter, fill aggregation with second-source check, on-chain fill or cancel, settlement from the single-event endpoint
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

- [ ] Next.js 16 with Privy: email login with a test account creates an embedded Solana wallet
- [ ] A transaction built with `@solana/kit` is signed through Privy and confirms on devnet
- [ ] `next build` passes

Exit: explorer shows the signature. Fallback: Wallet Standard with Sign-In With Solana.

## S2. Web app

- [ ] Onboarding route: verify the login token, register the trader, send starter SOL and dUSD once
- [ ] Markets, Ticket, Activity (timeline, receipt, Reclaim), Portfolio, Redeem
- [ ] Devnet / sandbox banner and footer notice

Exit: a new email account completes test funds, buy, settle and redeem on two consecutive 15-minute contracts using only the browser.

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
- [ ] More login methods and external wallets, with one trading address per user
- [ ] Hosted demo on the mock venue (or sandbox mode behind an allow-list); Postgres if more than one process needs the ledger

## S6. Depends on Gemini

- [ ] Send the outreach questions (public display of sandbox data, naming, non-transferable receipts, OAuth review, partner route)
- [ ] Production own-account API smoke test with no tokens, to capture real fee and settlement records
- [ ] Per-user account-linking mode with non-transferable receipts, only with Gemini's written agreement

## Open decisions

- [ ] Repository name: keep, or move to a neutral name (see the Gemini Marks clause in docs/SCOPE.md)
- [ ] License for this repository
- [ ] Whether and when to contact Gemini

## Review

(Filled in as slices complete.)
