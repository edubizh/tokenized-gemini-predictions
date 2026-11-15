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

# Phase 2

Requested on 2026-11-14, after the prototype. Three goals, each with an exit test:

1. **Redesign.** The whole site becomes very simple, clean and calm: few components, four theme colours (forest green, jade green, a peach that is almost white, white), a see-through navbar, and the feel of entering an on-chain prediction-market platform.
2. **Every market.** Everything the sandbox lists is shown to everyone and tradable after login, not only the 15-minute contracts, with event and market pages as complete as on other prediction-market platforms. A Vaults tab is added as a placeholder.
3. **Wallet login with real wallets.** Phantom waits on "Sign to verify" with no window, and MetaMask does not connect. Login is tested with real extensions and fixed.

The order below is the build order. P0 is read-only; P1, P2 and P3 are independent of each other; P4 needs P2 and the API types of P3.

## P0. Groundwork

- [x] How Polymarket, Kalshi, Gemini Predictions, Robinhood and two or three on-chain platforms lay out the markets index, the event page, the market page and the trade panel, ending in the list of parts these pages get here
- [x] The venue's full market model, measured on the live sandbox API: listing and pagination, binary and categorical events, price and quantity steps, market data (book, trades, price history), how strike ladders and long-dated events settle, review and invalid states, rate limits
- [x] The two wallet failures reproduced with real extensions in a test browser, with the cause of each

Findings (2026-11-14):

- The sandbox lists two kinds of event: an up-or-down contract over 5 or 15 minutes, and a ladder of five to eight "$X or above" contracts (hourly, daily, weekly, monthly; six crypto assets and six commodities). About 100 events and 320 contracts are listed at a time.
- The contracts of a ladder are independent: each has its own book and settles by itself, so several can pay. Settlement arrives 5 to 53 seconds after expiry, per contract.
- Every listed contract trades in one-cent price steps and 0.01-contract quantity steps, symbols are at most 28 characters, and a naming scheme fits every token name into 32 bytes and every ticker into 10. The program needs no change.
- The sandbox's market makers quote only BTC, ETH, SOL and XRP contracts, and only late in a contract's life (15-minute contracts a few minutes into their window, hourly ladders from about a quarter past the hour, daily ladders in their last hour). Commodity, HYPE, ZEC, weekly and monthly contracts have never had an offer or a trade, and one account cannot trade with itself, so those can be listed but not bought on the sandbox.
- Both wallet failures have one cause: current Phantom and MetaMask show a site's request in their browser side panel instead of opening a window, and the login window then waits for ever with a hint that points elsewhere. Phantom never answers the request if that panel is closed.
- Other platforms' pages reduce to a short list of parts: an index with category and duration filters, one event page that holds the contracts, the price history, the book, the rules and the trade panel, a portfolio and an activity list.

## P1. Wallet login with real wallets (goal 3)

- [x] Test harness: Chromium with the unpacked Phantom and MetaMask extensions (Solflare and Backpack if they load the same way), each with a wallet created by the test
- [x] Cause found for "Phantom waits on Sign to verify and no window opens" and for "MetaMask does not connect"
- [x] Fix with the smallest correct change
- [x] Every step that waits for a wallet says what it is waiting for and offers retry and cancel
- [x] A wallet that cannot sign for Solana gets a clear message instead of a dead end; the supported wallets are stated plainly
- [x] Matrix below filled in for each wallet

Matrix (one row per case, one column per wallet): first login (connect, then sign); the user rejects the connection; the user rejects or closes the signature; wallet locked; wallet on another network or Testnet Mode off; two wallets installed; log out and in again; switch account inside the wallet; reload, then Reconnect; first-run test funds; place an order and reach FILLED or REFUNDED; redeem; Reclaim. Email login keeps passing its checks.

Result (2026-11-15), real extensions (Phantom 26.38.1, MetaMask 13.56) in a test browser with wallets made by the test, on devnet with the simulated venue. Each case is `node e2e/real-wallets/matrix.mjs <wallet> <case>` from `apps/web`.

| Case | Phantom | MetaMask |
|---|---|---|
| First login (connect, then sign), in a window and in the side panel | pass | pass |
| The user rejects the connection | pass | pass |
| The user rejects the signature; closes the window; closes the side panel | pass | pass (it has no window) |
| Wallet locked | pass | pass |
| Other network | pass: the app names Testnet Mode; with it on the order fills | pass: the app says plainly that it cannot sign |
| Two wallets installed | pass | pass |
| Log out and in again | pass | pass |
| Switch account inside the wallet | app side passes with the injected wallet; not run in the extension | pass |
| Reload, then Reconnect | pass | pass |
| First-run test funds | pass | pass |
| Place an order | pass, filled | does not apply |
| Redeem | pass | does not apply |
| Reclaim | pass | does not apply |

What is supported:

- **Phantom**: login and trading. It asks in a window of its own or in its side panel; the app says so while it waits.
- **MetaMask**: login only. MetaMask 13.56 confirms Solana mainnet transactions only (asked for devnet it still previews on mainnet and keeps its Confirm button off, and it offers no Solana test network), so it cannot sign an order here. The login entry and the trade panel say so.
- **Solflare, Backpack**: listed when installed; not run with the real extensions.
- **WalletConnect**: offered through the login library's own window; needs a phone wallet and was not run.

Still to check by hand: Phantom with Testnet Mode on in an ordinary browser profile (in the test browser Phantom's own service refuses to preview a transaction, so the test confirms without a preview); switching between two accounts inside Phantom (its service refuses to add an account in the test browser); WalletConnect with a phone.

Exit: every row passes for Phantom and for MetaMask (through its Solana account) with real extensions on a live stack; no path hangs without a message; unit tests and browser checks pass.

## P2. Design system (goal 1, first half)

- [x] The four colours chosen and every text and control pairing checked numerically against WCAG AA
- [x] `docs/DESIGN.md` and `docs/PRODUCT.md` rewritten for the new direction
- [x] Tokens, one typeface with tabular numerals, and the few primitives
- [x] Shell: see-through navbar (Markets, Portfolio, Activity, Vaults, the network, the wallet and its balance), a quiet devnet mark, the footer line
- [x] Looked at in a browser at 1280 and 390 wide before any page is built on it

Exit: the reference page shows every primitive and state at both widths; contrast figures are in DESIGN.md; nothing uses a fifth hue (one muted error tone is the single written exception).

## P3. Every market: relayer and API (goal 2, back end)

- [x] API types first: event grouping, category, description and rules, resolution source, dates, volume, per-contract label and strike (the venue's images are not loaded); price history, depth and recent trades for one market
- [x] Discovery of every active event and contract in place of the curated series list, inside the venue's rate limits
- [x] A market is created on-chain only when a logged-in user places the first order on it
- [x] Token names and tickers for strike contracts (32 and 10 bytes)
- [x] Settlement and reconciliation for strike ladders and long-dated events: early resolution, review, invalid
- [x] The simulated venue offers the same variety, so the demo and the tests are deterministic
- [x] Program: tick, minimum quantity, close and cutoff times confirmed against the wider set of contracts: everything fits, so it is unchanged

Exit: with the stack running, every active sandbox event and contract appears within a poll or two; a contract with offers can be bought and sold and then settles and redeems; a contract without offers says so; tests cover discovery, grouping and the new settlement cases.

## P4. Web app rebuilt (goals 1 and 2, front end)

- [x] Markets index for everyone: categories, search, sort, live and upcoming, quoted first
- [x] Event page: every contract of the event with its prices
- [x] Market page (one page per event, with the selected contract's parts): question and rules, resolution source and terms, close and settlement times with a countdown, price chart, order book or best bid and ask, recent trades, volume, the user's position and orders, the trade panel
- [x] Logged out, the trade panel asks for a login and nothing else is hidden; the login gate no longer covers the market pages
- [x] Portfolio, Activity, Vaults (placeholder), System, not-found, error and offline states on the new design; the welcome page is gone and first-run test funds are a step inside the trade panel and the portfolio
- [x] Old components and tokens deleted; fixtures and the reference page updated or cut down

Exit: every route is rebuilt and reviewed in screenshots at 1280 and 390; no component or token of the old theme is left; tests, the build and the browser checks pass on the new markup.

## P5. Verification

- [x] Unit tests, type-checks and builds of every package
- [x] Screenshots of every route and state at both widths, checked against DESIGN.md
- [x] Live on devnet with the sandbox, from the command line: a 15-minute contract and a strike-ladder contract bought, settled and redeemed, with reconciliation balanced (a commodity contract cannot be bought there: none has ever had an offer)
- [ ] The same from the browser, with a sale
- [ ] The wallet matrix with real extensions on the live stack
- [ ] A run with the relayer stopped
- [x] An independent review of each track

## P6. Documentation

- [ ] README, ARCHITECTURE and SCOPE brought up to date
- [ ] Phase 2 review below: what changed, what was verified, what is not done
- [ ] Lessons

## Phase 2 review

Not finished. State on 2026-11-15:

Done and verified:

- **Wallet login** is the app's own: a login entry with email, one button per detected Solana wallet and WalletConnect, and one waiting block for every wallet request that names the wallet, says where it asks (a window or its side panel), and offers Cancel and Try again. Verified with the real Phantom and MetaMask extensions (table under P1).
- **Design**: four colours (forest `#173B2A`, jade `#0A7F56`, peach `#FEF3EB`, white), one typeface, twelve primitives, a see-through navbar; every pairing in use is checked for contrast by a unit test. Every page is rebuilt on it and nothing of the old theme is left.
- **Every market**: the relayer lists every event of the venue with its contracts (both shapes, six durations, two categories), serves depth, trades and price history, takes the live top of book from the venue's public feed, creates a market on-chain only at a logged-in trader's first order, and settles each contract by itself. The simulated venue offers the same variety. The local end-to-end run takes a ladder contract and an up-or-down contract from buy to redemption.
- **Pages**: markets index (filters, search, sort, cards), event page (contracts, price chart, order book, recent trades, rule, dates, on-chain accounts, position and orders), trade panel (every state, prices in cents), portfolio, activity, system, vaults placeholder.
- **Checks**: 445 unit tests in the web app and 927 in the relayer, type-checks and the production build; two browser checks in fixtures mode drive every route and state at 1280, 390 and 360 (no page error, no overflow, no target under 44 px) and follow an order to filled; an independent review of the relayer and one of the web app, with their must-fix items fixed.

- **First live run** of the new relayer on devnet with the sandbox, from the command line (2026-11-15, 01:10 to 02:01 UTC): it served all 110 events and 370 contracts the venue listed, and the twelve markets of the first release were still there after the database was brought to the new tables. On an hourly ladder (XRP at $0.84 or above) one Yes contract was bought at 97 cents and half of it sold back at 88; on a 15-minute contract one No was bought and a Yes order below the offer was refunded in full. Fills landed 1 to 3 seconds after placement. Both markets settled on-chain 31 and 38 seconds after expiry from the venue's results and the winning tokens redeemed for a dollar each. Reconciliation stayed balanced throughout.

Not done yet:

- The same live run from the browser, the wallet matrix on the sandbox stack, and a run with the relayer stopped. The live checks under `apps/web/e2e/live-*.mjs` follow the new pages but have not been run.
- Found by the live run, not fixed: token supplies shown for a market stop updating once it is settled; an event keeps the status "active" after its contracts have settled; the first listing after a start can be incomplete for under a minute; an alert that says "fetch failed" without saying what was being fetched.
- A commodity contract cannot be bought on the sandbox: no commodity, HYPE, ZEC, weekly or monthly contract has ever had an offer there, and one account cannot trade with itself. Those markets are listed with "No offers"; the commodity ladder trades, settles and redeems on the simulated venue.
- README, ARCHITECTURE and SCOPE still describe the first release in places.
- From the reviews, not yet done: contracts the venue drops from a ladder stay listed until they expire; the status rule that never moves backwards can also block a real correction; list reads share one queue with settlement reads.
