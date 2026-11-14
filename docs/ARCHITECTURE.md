# Architecture

A demonstration on **Solana devnet** and the **Gemini Predictions sandbox**. Scope and the reasons for it are in [SCOPE.md](SCOPE.md); the build order and what has been verified are in [../tasks/todo.md](../tasks/todo.md).

Status: built. The program is deployed and configured on devnet, the relayer has taken real orders through the sandbox from placement to redemption, and the web app drives the same flow from a browser.

## Overview

A user logs in, holds a test stablecoin on Solana, and buys YES or NO outcome tokens for one prediction-market contract. Tokens are minted only after the matching order has filled on the sandbox, and winning tokens redeem for the test stablecoin after the sandbox market settles.

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
| `apps/web/` | Login, test funds, markets, order ticket, activity, portfolio, redeem | Next.js 16, React 19, Privy |

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
3. Pre-trade checks; an order that fails one is cancelled on-chain and refunded: enough time left, the contract is tradable now, the book has offers on the needed side, the fee cap covers the worst-case fee (for a sale, also that the minimum proceeds exceed that fee cap).
4. Send one fill-or-kill order over the authenticated WebSocket. Fills are counted per trade id and must agree with the venue's cumulative quantity.
5. Filled: `fill_buy` or `fill_sell` with the exact cost or proceeds and the fee. Not filled: `cancel_order`.
6. Outcome unknown (timeout, disconnect, malformed data): never resend. Look the order up by its client order id through the order history, then continue at step 5. On-chain writes are idempotent: a retry finds the transaction that already closed the order.
7. A venue fill that can no longer be recorded on-chain (the order was refunded first) is booked as operator inventory and raised as an alert.

A restart resumes every unfinished order from the journal; it never places a second venue order for an address that was ever submitted.

**Markets.** The relayer lists the short-dated series it is configured for (by default the four 15-minute crypto series) and creates a market on-chain the first time someone opens it. Token names are built from the underlying, the outcome and the expiry.

**Settlement.** After a contract expires, the relayer polls its single-event endpoint. A clean YES or NO result that stays unchanged for twenty seconds, and whose venue payout matches the on-chain supply (the payout record can lag, so a shortfall is rechecked for three minutes), is settled automatically as `(10_000, 0)` or `(0, 10_000)`. A market nobody holds is not settled at all. Anything else is marked for review and settled by hand with the relayer's `settle` command.

**Reconciliation.** Every thirty seconds, per unsettled market: the venue's net position must equal YES supply minus NO supply, plus orders in flight, plus operator inventory. The treasury must cover the largest amount any open market could require at settlement. A market that stays out of balance for three checks, or a treasury shortfall, pauses new orders.

**Venue adapters.** `GeminiSandboxVenue` (signed REST with one call per second, authenticated WebSocket with a liveness watchdog, sandbox hosts only) and `MockVenue` implement one interface. The mock drives the tests; with `VENUE=mock` the relayer runs rolling simulated contracts, which is the fallback when the sandbox's market makers are not quoting.

**Local API.** `127.0.0.1:8787`, read-only except for creating a market: health, markets, orders by user, reconciliation status. The web app reaches it through its own server.

**Guards.** The relayer refuses to start unless the cluster is devnet (checked by genesis hash) or a local validator, the venue is the sandbox or the mock, and the deployment file matches the on-chain configuration and the loaded keys.

## Web app

- Login through Privy, two ways. With email: an embedded Solana wallet is created on first login. With an existing Solana wallet: Phantom, Solflare, Backpack, any other detected wallet, or WalletConnect by QR code. Each account has one trading wallet: the embedded wallet for email logins, the connected wallet for wallet logins.
- External wallets on devnet: Phantom needs its Testnet Mode switched on. The wallet only signs; the app broadcasts through its own devnet connection.
- A server route verifies the login token, registers the wallet as a Trader and sends starter funds (devnet SOL and test dollars) in one transaction, once per wallet.
- Pages: Markets (the live contracts with countdowns and prices), Market (the order ticket, which turns into the order's timeline once placed), Portfolio (positions, sell, redeem), Activity (every order with its receipt, and Reclaim for an expired one), System (how it works, relayer status, reconciliation).
- Balances, positions and open orders are read from Solana in the browser. The relayer's API adds the venue's side: titles, prices, and what happened to each order.
- Transactions are built with `@solana/kit` and the generated client, use a blockhash fetched at click time, are simulated first, signed through Privy, and broadcast unchanged.
- Without the relayer the app keeps working from Solana alone. A token is matched to its market through its mint (the mint's authority is the Market account, and the mint's metadata carries the name), so positions, Redeem, open orders and Reclaim stay available; listing markets and placing new orders wait for the relayer. On-chain deadlines are counted on the cluster clock, taken from the relayer's health answer or, while the relayer is away, from the cluster's Clock account.
- After a page reload a wallet login is still signed in, but the wallet is no longer connected in the tab. Wherever a signature is needed the app offers Reconnect wallet in place of the action.
- A fixed notice marks every page as devnet and names the venue in use (the sandbox or the simulated one).

The design direction and component rules are in [PRODUCT.md](PRODUCT.md) and [DESIGN.md](DESIGN.md).

## Testing

- Program: LiteSVM tests for every instruction and invariant, with the adversarial cases: account substitution, donated escrow balances, expiry boundaries, wrong token programs, role separation, a two-user lifecycle from first order to an empty vault.
- Relayer: unit tests against synthetic sandbox frames; the pipeline against the mock venue and a fake chain, including crash and restart around every external call and a randomized fault loop asserting that minted units never exceed venue-filled units.
- End to end: `pnpm e2e:local` runs buys, a refund, settlement, redemption and the automatic settlement watcher on a local validator with the mock venue. `pnpm demo` drives a test user through a running relayer on devnet.

## Known limits

- The bridge is custodial by design (see the trust model).
- After redemption opens, nothing sweeps a vault: tokens that are never redeemed leave their funding, and the vault's rent, locked.
- `settle_market` funds whatever the supply is at that moment; there is no caller-supplied ceiling.
- A sale whose minimum proceeds do not exceed the worst-case fee is refused by the relayer, which rules out very small sales of very cheap tokens.
- Reconciliation checks positions and treasury cover. It does not tie out the venue's cash balance trade by trade.
- A market the relayer marked for review is settled by hand.
- The sandbox's market makers quote only part of the time. With an empty book every order is refunded.

## Not in this build

Mainnet, real funds, production venue hosts, KYC, AMM listing, a hosted public demo with venue data, per-user account linking. See [SCOPE.md](SCOPE.md).

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
