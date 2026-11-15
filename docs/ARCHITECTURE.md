# Architecture

A demonstration on **Solana devnet** and the **Gemini Predictions sandbox**. Scope and the reasons for it are in [SCOPE.md](SCOPE.md); the build order and what has been verified are in [../tasks/todo.md](../tasks/todo.md).

Status: built. The program is deployed and configured on devnet, the relayer has taken real orders through the sandbox from placement to redemption, and the web app drives the same flow from a browser.

## Overview

A user logs in, holds a test stablecoin on Solana, and buys YES or NO outcome tokens for one prediction-market contract. Tokens are minted only after the matching order has filled on the sandbox, and winning tokens redeem for the test stablecoin after the sandbox settles the contract.

```
 user wallet ──place_buy──▶ on-chain program (escrow, limit price, deadline)
                                   ▲                │ order account
              fill_buy / cancel ───┘                ▼
                              relayer ──fill-or-kill order──▶ exchange sandbox
                                   ◀──────── fill events ────────┘
 settle_market (outcome + funded vault) ◀── relayer ◀── sandbox resolution
 user wallet ──redeem (burn winners)──▶ test stablecoin
```

| Path | Purpose | Stack |
|---|---|---|
| `anchor/` | Program `outcome_tokens`: escrow, mint on fill, refund, sell-back, settle, redeem | Anchor 1.2.2, Token-2022, Rust tests on LiteSVM |
| `clients/js/` | Generated TypeScript client (committed) | Codama, for `@solana/kit` 8.x |
| `apps/relayer/` | Watches orders, trades on the sandbox, records fills, settles markets, serves a local API | Node 24 (runs the TypeScript sources directly), `ws`, SQLite through `node:sqlite` |
| `apps/web/` | Markets index, event pages with the trade panel, login, test funds, portfolio, redeem, activity, how it works | Next.js 16, React 19, Privy |

## Units

- Outcome tokens have **2 decimals**: one base unit is 0.01 contract, the sandbox's quantity increment. Contracts with another increment are refused when a market is created.
- On-chain prices are `px` = micro-dollars per unit, `1..=9_999`. One cent per contract is `px = 100`. Each market stores its tick (`100` today).
- The test stablecoin (**dUSD**, shown as "test dollars") is a classic SPL Token mint with 6 decimals. `cost = units * px`. A winning unit redeems for `10_000`.
- Venue taker fee: `fee = ceil(7 * units * px * (10_000 - px) / 10^10) * 10_000` (0.07 × contracts × P × (1 − P), rounded up to the cent). The fee the venue reports is passed through at cost, capped by the order's `max_fee`. The sandbox currently charges none.
- All money math is integer.

## On-chain program

Program id `8TN1HWcEFTAcM7Vthmih1FKftTBrp3LDgTBkfhp1PRVn` (devnet). Addresses of the configured deployment are in [`../deployments/devnet.json`](../deployments/devnet.json).

### Accounts

| Account | Seeds | Contents |
|---|---|---|
| Config | `"config"` | admin, relayer, settler, registrar, stable mint (immutable), treasury, order lifetime, order size limits, settlement delay, pause flags |
| Trader | `"trader", user` | user, `next_nonce`. Created only by the registrar after a verified login |
| Market | `"market", sha256(symbol)` | venue symbol, YES mint, NO mint, status (Open, Halted, Settled), close time, order cutoff, tick, per-side supply cap, payouts, `redeem_after` |
| Outcome mint | `"mint", market, side` | Token-2022, 2 decimals, name and symbol stored on the mint, no freeze authority. Mint authority is the Market account |
| Order | `"order", user, nonce` | user, market, side, kind (buy or sell), quantity, limit `px`, `max_fee`, `expires_at`, rent payer |
| Escrow | `"escrow", order` | Token account holding the order's dUSD (buy) or outcome tokens (sell) |
| Redemption vault | `"redeem", market` | dUSD, created and fully funded by `settle_market` |

### Instructions

| Instruction | Signer | Rule |
|---|---|---|
| `initialize` | program upgrade authority | Sets the roles and the stablecoin mint, once. Well-known real stablecoin mints are rejected in this build |
| `set_config` | admin | Changes roles, limits and the treasury. The admin and the stablecoin mint cannot change |
| `set_pause` | admin; relayer | Two flags: no new orders, no fills. The relayer can only add flags; only the admin clears them |
| `register_trader` | registrar | Creates the Trader account for a wallet. This is how the login is enforced on-chain |
| `create_market`, `create_outcome_mint` | relayer | Market keyed by the hash of the venue symbol; both mints must exist before any order |
| `set_market` | relayer; admin | The relayer can halt a market and update its close time; only the admin reopens one |
| `place_buy` | user | Needs a Trader account, an open market, a price on the tick and a quantity within limits. Escrows `qty * limit_px + max_fee`. `expires_at = min(now + lifetime, close)` |
| `fill_buy` | relayer | Only up to `expires_at` and never after settlement. `0 < fill_qty <= qty`, `fill_qty <= cost <= fill_qty * limit_px`, `fee <= max_fee`, supply cap respected. Mints to the user, sends `cost + fee` to the treasury, refunds the rest from the live escrow balance, closes order and escrow |
| `place_sell` | user | Escrows outcome tokens with a minimum price |
| `fill_sell` | relayer | Burns the filled tokens, pays `proceeds - fee` to the user from the relayer's float (never from the treasury), returns the rest, closes order and escrow. `proceeds >= fill_qty * min_px` |
| `cancel_order` | relayer at any time; anyone after `expires_at`; the user early if the market is settled or fills are paused | Returns the whole escrow to the user and closes the order. Never blocked by a pause or by the market's status |
| `settle_market` | settler | Once. `yes_payout + no_payout == 10_000`. Funds the vault with `supply_yes * yes_payout + supply_no * no_payout`. Redemption opens after a delay |
| `revoke_settlement` | admin; settler | Only before redemption opens. Returns the vault to the treasury and halts the market, so it can be settled again |
| `redeem` | holder | Burns tokens and pays `amount * payout`. Cannot be paused |

### Invariants

1. Outcome tokens are minted only by `fill_buy`, and never above the per-side supply cap.
2. An order is filled or cancelled exactly once; its escrow is swept using the live balance and closed in the same instruction.
3. The relayer's fill window (`now <= expires_at`) and the public refund window (`now > expires_at`) never overlap.
4. Order addresses never repeat (per-trader nonce), so an order address identifies one order forever.
5. After settlement the vault holds what every outstanding token can claim, and only burns happen.
6. No role can move escrowed funds anywhere except to the order's user, to the treasury on a buy fill, or into a burn on a sell fill.
7. Nothing the relayer must land before a deadline can be made to fail by the order's user or a third party: destinations are checked by owner and mint, not by address, and the relayer creates missing token accounts in the same transaction.
8. Each role can do only its own job: the relayer cannot change the configuration, lift a pause, reopen a market, settle, or move treasury or vault funds; the settler cannot fill.

### Trust model

The program cannot observe the venue. It bounds what the relayer and settler can do to any one order (price limit, quantity, fee cap, deadline, supply cap), but that a fill happened and how a market resolved are attested by the relayer and settler. This is a custodial bridge, stated as such. A user's protection against a relayer that disappears is the deadline: after it, anyone can send the refund.

## Relayer

One process, one order in flight at a time.

**Order mapping.** Each sandbox contract is a single order book quoted in YES prices; buying NO at `q` is the same order as selling YES at `1 - q`. The relayer only ever buys:

| User action | Sandbox order (limit, fill-or-kill) |
|---|---|
| buy YES at up to `L` | BUY YES at `L` |
| buy NO at up to `L` | BUY NO at `L` |
| sell YES at no less than `M` | BUY NO at `1 - M` |
| sell NO at no less than `M` | BUY YES at `1 - M` |

The sandbox nets positions: buying the opposite outcome reduces the account's position and releases a dollar per netted pair at once. So the account's net position in a contract always equals YES supply minus NO supply on-chain.

**Pipeline.**

1. Read the open Order accounts every two seconds.
2. Write the order to a journal (SQLite, write-ahead) before anything is sent, with a client order id derived from the order address.
3. Pre-trade checks; an order that fails one is cancelled on-chain and refunded: enough time left, the contract is tradable now, the book has offers on the needed side, the fee cap covers the worst-case fee (for a sale, also that the minimum proceeds exceed that fee cap), and enough time is still left once those venue reads are done.
4. Send one fill-or-kill order over the authenticated WebSocket. Fills are counted per trade id and must agree with the venue's cumulative quantity.
5. Filled: `fill_buy` or `fill_sell` with the exact cost or proceeds and the fee. Not filled: `cancel_order`.
6. Outcome unknown (timeout, disconnect, malformed data): never resend. Look the order up by its client order id through the order history, then continue at step 5. On-chain writes are idempotent: a retry finds the transaction that already closed the order.
7. A venue fill that can no longer be recorded on-chain (the order was refunded first) is booked as operator inventory and raised as an alert.

A restart resumes every unfinished order from the journal; it never places a second venue order for an address that was ever submitted.

**Markets.** The relayer lists every event the venue lists, with its contracts: an up-or-down contract over 5 or 15 minutes, or a ladder of "$X or above" contracts that runs for an hour, a day, a week or a month, in two categories (Crypto, Commodities); about 100 events and 370 contracts at a time. The list is read again every twenty seconds; a contract the venue drops from an event is no longer offered once two list reads in a row show the event without it. The live top of book comes from the venue's public WebSocket; depth, recent trades and price history are read when a page asks for them. A market is created on-chain only when a logged-in trader (a wallet with a Trader account) places the first order on it. Token names (at most 32 bytes) and tickers (at most 10) are built from the underlying, the strike or direction, the outcome and the expiry.

**Settlement.** Each contract is settled by itself, the contracts of a ladder included; an event is settled once all its contracts are. A contract can resolve early, so an unsettled market is looked at once a minute before its expiry and on every tick after it, through the venue's single-event endpoint. A clean YES or NO result that stays unchanged for twenty seconds, and whose venue payout matches the on-chain supply (the payout record can lag, so a shortfall is rechecked for three minutes), is settled automatically as `(10_000, 0)` or `(0, 10_000)`. A market nobody holds is not settled at all. A contract with no result ten minutes after expiry, or anything else unexpected, is marked for review and settled by hand with the relayer's `settle` command.

**Reconciliation.** Every thirty seconds, per unsettled market: the venue's net position must equal YES supply minus NO supply, plus orders in flight, plus operator inventory. The treasury must cover the largest amount any open market could require at settlement. A market that stays out of balance for three checks, or a treasury shortfall, pauses new orders.

**Venue adapters.** `GeminiSandboxVenue` (signed REST at most one call every 1.1 seconds, public REST reads in one queue of one call a second, orders over an authenticated WebSocket with a liveness watchdog, the top of book over the public WebSocket, sandbox hosts only) and `MockVenue` implement one interface. The mock drives the tests; with `VENUE=mock` (`pnpm dev:mock`) the relayer runs a simulated venue that lists the same variety of events in both categories, quotes some of them and resolves each contract a few seconds after expiry. It is where the contracts the sandbox never quotes can be traded.

**Local API.** `127.0.0.1:8787` (`RELAYER_PORT`), read-only except for creating a market: health, events and one event with its contracts, markets and one market with its depth, trades and price history, orders by user and one order, reconciliation status. The shapes are in `apps/relayer/src/api/types.ts`. Requests that carry an `Origin` header are refused; the web app reaches the API through its own server.

**Guards.** The relayer refuses to start unless the cluster is devnet (checked by genesis hash) or a local validator, the venue is the sandbox or the mock, and the deployment file matches the on-chain configuration and the loaded keys.

## Web app

- The app's own login entry, on Privy: email, one button per Solana wallet detected in the browser, and WalletConnect. With email, an embedded Solana wallet is created on first login. Every wallet request shows one waiting block that names the wallet, says where it asks (a window or its side panel) and offers Cancel and Try again. Each account has one trading wallet: the embedded wallet for email logins, the connected wallet for wallet logins.
- Wallets: Phantom logs in and trades; it needs its Testnet Mode switched on to preview a devnet transaction. MetaMask logs in only: it confirms Solana mainnet transactions only and has no test network, and the login entry and the trade panel say so. Solflare and Backpack are listed when installed. The wallet only signs; the app broadcasts through its own devnet connection.
- There is no login gate: every page is open to everyone, login starts from the navbar, and what belongs to an account asks for a login in place.
- First-run test funds are a step in the trade panel and on the portfolio: a server route verifies the login token, registers the wallet as a Trader and sends starter funds (devnet SOL and test dollars) in one transaction, once per wallet. A second route tops up a registered wallet whose balance is low.
- Pages: Markets at `/` (search, sort, category and timeframe filters, a card per event), one page per event at `/markets/<event>` (its contracts, price chart, order book, recent trades, the rule with the price to beat for up-or-down contracts, dates, on-chain accounts, the user's position and orders, and the trade panel, which shows the order's timeline once placed), Portfolio (positions, sell, redeem, Reclaim), Activity (every order with its steps, and Reclaim for an expired one), How it works at `/system` (the mechanism, relayer status, addresses, reconciliation), and Vaults (a placeholder).
- Balances, positions and open orders are read from Solana in the browser. The relayer's API adds the venue's side: titles, prices, and what happened to each order.
- Transactions are built with `@solana/kit` and the generated client, use a blockhash fetched at click time, are simulated first, signed through Privy, and broadcast unchanged.
- Without the relayer the app keeps working from Solana alone. A token is matched to its market through its mint (the mint's authority is the Market account, and the mint's metadata carries the name), so positions, Redeem, open orders and Reclaim stay available; listing markets and placing new orders wait for the relayer. On-chain deadlines are counted on the cluster clock, taken from the relayer's health answer or, while the relayer is away, from the cluster's Clock account.
- After a page reload a wallet login is still signed in, but the wallet is no longer connected in the tab. Wherever a signature is needed the app offers Reconnect wallet in place of the action.
- A fixed notice marks every page as devnet and names the venue in use (the sandbox or the simulated one).

The design direction and component rules are in [PRODUCT.md](PRODUCT.md) and [DESIGN.md](DESIGN.md).

## Testing

- Program: LiteSVM tests for every instruction and invariant, with the adversarial cases: account substitution, donated escrow balances, expiry boundaries, wrong token programs, role separation, a two-user lifecycle from first order to an empty vault.
- Relayer: unit tests against synthetic sandbox frames; the pipeline against the mock venue and a fake chain, including crash and restart around every external call and a randomized fault loop asserting that minted units never exceed venue-filled units.
- Web app: unit tests for the money, quotes, filters, order steps, wallet login and the contrast of every colour pairing in use.
- CI type-checks the generated client and the relayer and runs the unit tests of the relayer and the web app twice, the second time with the clock a year ahead.
- End to end: `pnpm e2e:local` takes an up-or-down contract and a ladder contract through buys, a refund, the automatic settlement watcher and redemption on a local validator with the simulated venue. `pnpm demo` drives a test user through a running relayer on devnet.
- Browser checks in `apps/web/e2e/`: `screens.mjs` and `responsive.mjs` drive every page and state against simulated data at 1280, 390 and 360 wide; the `live-*.mjs` checks and `live-screens.mjs` run against a live stack; `real-wallets/matrix.mjs` logs in and signs with the real Phantom and MetaMask extensions.

## Known limits

- The bridge is custodial by design (see the trust model).
- After redemption opens, nothing sweeps a vault: tokens that are never redeemed leave their funding, and the vault's rent, locked.
- `settle_market` funds whatever the supply is at that moment; there is no caller-supplied ceiling.
- A sale whose minimum proceeds do not exceed the worst-case fee is refused by the relayer, which rules out very small sales of very cheap tokens.
- Reconciliation checks positions and treasury cover. It does not tie out the venue's cash balance trade by trade.
- A market the relayer marked for review is settled by hand.
- The registry never moves a contract's venue status backwards (a read can be older than an earlier one). The same rule also blocks a genuine correction by the venue.
- Reads of the venue's event list share one public request queue (one call a second) with the reads settlement and the order checks make, so those can wait behind list reads. Only the page reads of depth, trades and history give way: they answer empty while the queue is backed up.
- A slow venue order is not bounded by the order window. The window is checked again right before the order goes out, but an order the venue answers late is not cut off: if it fills after the on-chain deadline, the user is refunded and the fill is booked as operator inventory.
- The sandbox's market makers quote only BTC, ETH, SOL and XRP contracts, and only part of the time. Commodity, HYPE, ZEC, weekly and monthly contracts never have an offer there and one account cannot trade with itself, so they are listed with "No offers" and trade only on the simulated venue. With an empty book every order is refunded.
- MetaMask cannot sign an order here: it confirms Solana mainnet transactions only and has no test network. Solflare, Backpack and WalletConnect were not run with the real wallets.
- Killing the relayer between the venue order and the on-chain fill was never forced on live infrastructure; the pipeline's crash and restart tests cover it.

## Not in this build

Mainnet, real funds, production venue hosts, KYC, AMM listing, a hosted public demo with venue data, per-user account linking, vaults (the Vaults page is a placeholder). See [SCOPE.md](SCOPE.md).

## Pinned stack

| Component | Version |
|---|---|
| Anchor | 1.2.2 |
| Solana CLI | 4.1.2 |
| `@solana/kit` | 8.6.0 |
| `@solana-program/token`, `token-2022`, `system`, `memo` | 0.18.0, 0.20.1, 0.16.0, 0.16.0 |
| `codama`, `@codama/renderers-js`, `@codama/nodes-from-anchor` | 1.11.0, 2.9.0, 1.5.6 |
| Next.js, React | 16.4.6, 19.3.1 |
| `@privy-io/react-auth`, `@privy-io/node` | 3.51.4, 0.39.0 |
| Node, TypeScript, pnpm | 24, ~5.9, 12.18 |
