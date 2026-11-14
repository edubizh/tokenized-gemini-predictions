# Architecture

Design for v1: a demonstration on **Solana devnet** and the **Gemini sandbox**. Scope and the reasons for it are in [SCOPE.md](SCOPE.md); the build order is in [../tasks/todo.md](../tasks/todo.md).

Status: design. Nothing here has been built yet. Items marked *(to confirm in S0a)* depend on the first authenticated sandbox session.

## Overview

A user logs in, pays a test stablecoin on Solana, and receives YES or NO outcome tokens for one prediction-market contract. Tokens are minted only after the matching order has filled on the Gemini Predictions sandbox, and redeem for the test stablecoin after the sandbox market settles.

```
 user wallet ──place_buy──▶ on-chain program (escrow, limit price, deadline)
                                   ▲                │ order account
              fill_buy / cancel ───┘                ▼
                              relayer ──order.place (FOK)──▶ Gemini sandbox
                                   ◀──────── fill events ────────┘
 settle_market (outcome + funded vault) ◀── relayer ◀── sandbox settlement
 user wallet ──redeem (burn winners)──▶ test stablecoin
```

Three parts:

| Path | Purpose | Stack |
|---|---|---|
| `anchor/` | Program `outcome_tokens`: escrow, mint on fill, refund, settle, redeem | Anchor 1.2.2, Token-2022, Rust tests on LiteSVM |
| `clients/js/` | Generated TypeScript client (committed) | Codama, for `@solana/kit` 8.x |
| `apps/relayer/` | Watches orders, trades on the sandbox, records fills, settles markets | Node 24, TypeScript, `@gemini-markets/sdk`, SQLite journal |
| `apps/web/` | Login, test funds, markets, order ticket, activity, portfolio, redeem | Next.js 16, React 19, Privy |

## Units

- Outcome tokens have **2 decimals**: one base unit is 0.01 contract, the sandbox's quantity increment. Instruments with another increment are refused at market creation.
- On-chain prices are `px` = micro-dollars per unit, `1..=9_999`. One cent per contract is `px = 100`. Each market stores its tick (`100` today).
- The test stablecoin (**dUSD**, "Test USD") is a classic SPL Token mint with 6 decimals. `cost = units * px`. A winning unit redeems for `10_000`.
- Venue taker fee: `fee = ceil(7 * units * px * (10_000 - px) / 10^10) * 10_000` (that is 0.07 × contracts × P × (1 − P), rounded up to the cent). The actual fee is passed through at cost and capped by the order's `max_fee`.
- All money math is integer. Buys charge the exact `sum(units_i * px_i)`; the venue debits that amount rounded down to the cent, so the operator is never short.

## On-chain program

### Accounts

| Account | Seeds | Contents |
|---|---|---|
| Config | `"config"` | admin, relayer, settler, registrar, `usdc_mint` (immutable), `treasury`, order TTL, min/max order size, settle delay, pause flags |
| Trader | `"trader", user` | user, `next_nonce`. Created only by the registrar after a verified login |
| Market | `"market", sha256(symbol)` | venue symbol, YES mint, NO mint, status (Open, Halted, Settled), close time, tick, per-side supply cap, payouts, `redeem_after` |
| Outcome mint | `"mint", market, side` | Token-2022, 2 decimals, metadata on the mint, no freeze authority. Mint authority is the Market account |
| Order | `"order", user, nonce` | user, market, side, kind, quantity, limit `px`, `max_fee`, `expires_at`, rent payer |
| Escrow | `"escrow", order` | Token account holding the order's dUSD (buy) or outcome tokens (sell) |
| Redemption vault | `"redeem", market` | dUSD, created and fully funded by `settle_market` |

### Instructions

| Instruction | Signer | Rule |
|---|---|---|
| `initialize` | program upgrade authority | Sets roles and the stablecoin mint; rejects real stablecoin mints in this build |
| `register_trader` | registrar | Creates the Trader account for a wallet. This is how login is enforced on-chain |
| `create_market`, `create_outcome_mint` | relayer | Market keyed by the hash of the venue symbol; both mints must exist before any order |
| `place_buy` | user | Requires a Trader account, an open market and `nonce == next_nonce`. Escrows `qty * limit_px + max_fee`. `expires_at = min(now + ttl, close - buffer)` |
| `fill_buy` | relayer | Only before `expires_at` and before settlement. `0 < fill_qty <= qty`, `fill_qty <= cost <= fill_qty * limit_px`, `fee <= max_fee`, supply cap respected. Mints to the user, sends `cost + fee` to the treasury, refunds the rest, closes order and escrow |
| `cancel_order` | relayer any time; anyone after `expires_at` | Refunds the whole escrow to the user and closes the order. Never blocked by pause or market state |
| `settle_market` | settler | Once. `yes_payout + no_payout == 10_000`. Funds the vault with `supply_yes * yes_payout + supply_no * no_payout`. Redemption opens after a short delay |
| `redeem` | holder | Burns tokens and pays `amount * payout`. Never pausable |
| `set_config`, `set_pause`, `set_market`, `revoke_settlement` | admin / relayer | Operational controls, added in S3. A settlement can be revoked only before redemption opens |
| `place_sell`, `fill_sell` | user / relayer | Sell-back before expiry, added in S4. Tokens are escrowed and burned on fill; the user is paid from the treasury |

### Invariants

1. Outcome tokens are minted only by `fill_buy`, and never above the per-side supply cap.
2. An order is filled or cancelled exactly once; its escrow is swept using the live balance and closed in the same instruction.
3. The relayer's fill window and the public refund window never overlap.
4. Order addresses never repeat (per-trader nonce), so an order address identifies one order forever.
5. After settlement the vault holds at least `sum(supply * payout)`, and only burns happen.
6. No role can move escrowed funds anywhere except to the order's user, to the treasury on a fill, or to redeemers.
7. Nothing the relayer must land before a deadline can be made to fail by the order's user or a third party: destinations are checked by owner and mint, not by address, and the relayer creates missing token accounts in the same transaction.

### Trust model

The program cannot observe the venue. It bounds what the relayer and settler can do to any one order (price limit, quantity, fee cap, deadline, supply cap), but that a fill happened and how a market resolved are attested by the relayer and settler. This is a custodial bridge, stated as such.

## Relayer

One process, one order in flight at a time.

**Order mapping.** Each sandbox contract is a single order book quoted in YES prices; buying NO at `q` is the same order as selling YES at `1 - q`. The relayer only ever buys:

| User action | Sandbox order (limit, fill-or-kill) |
|---|---|
| buy YES at up to `L` | BUY YES at `L` |
| buy NO at up to `L` | BUY NO at `L` |
| sell YES at no less than `M` (S4) | BUY NO at `1 - M` |
| sell NO at no less than `M` (S4) | BUY YES at `1 - M` |

Buying the opposite outcome reduces the account's net position and releases collateral *(to confirm in S0a; if the sandbox keeps gross positions instead, reconciliation switches to gross mode and nothing else changes)*.

**Pipeline.**

1. Poll for open Order accounts every few seconds.
2. Write the order to the journal, with a client order id derived from the order address, before anything is sent.
3. Re-check that the contract is tradable now (status active, market open, enough time to expiry, book side non-empty), then send `order.place` over the authenticated WebSocket.
4. Aggregate fills by trade id. On the terminal event the per-trade quantities must equal the venue's cumulative quantity, and a second source (the position change on the account stream, or REST) must agree, before anything is minted.
5. Filled: `fill_buy` with exact cost and fee. Not filled: `cancel_order`.
6. Outcome unknown (timeout, disconnect, malformed frame): never resend. Reconcile through order history by client order id, then continue at step 5. A venue fill that can no longer be recorded on-chain is booked as operator inventory and alerted.

**Settlement.** For every market with supply, watch the contract status and poll the single-event endpoint (list endpoints are cached and unreliable). A clean binary outcome seen consistently over at least a minute, and matching the account's payout record when it held a net position, is settled automatically as `(10_000, 0)` or `(0, 10_000)`. Anything else (fractional or unspecified outcome, payout mismatch, long review) waits for manual entry.

**Reconciliation.** With on-chain supplies `Y` and `N` per market:

- I1, exact: venue net position equals `Y - N` plus in-flight orders plus operator inventory.
- I2, solvency: venue cash plus treasury is at least the sum of `min(Y, N)` dollars over open markets plus unredeemed settled obligations.
- I3, tie-out: actual venue cash equals the ledger's expectation within a cent per fill.

A persistent I1 breach or any I2 failure pauses new orders.

**Venue adapters.** `GeminiSandboxVenue` and `MockVenue` implement one interface. The mock drives deterministic tests and any hosted demo.

**Guards.** The relayer and web app refuse to start unless the Solana cluster is devnet and the venue hosts are the sandbox hosts.

## Web app

- Login through Privy, two ways. With email: an embedded Solana wallet is created on first login. With an existing Solana wallet: Phantom, Solflare, Backpack, any other detected wallet, or WalletConnect by QR code, using Sign-In With Solana. Each account has one trading wallet: the embedded wallet for email logins, the connected wallet for wallet logins.
- External wallets on devnet: Phantom needs its Testnet Mode switched on. The wallet only signs; the app broadcasts through its own devnet connection.
- An onboarding route verifies the login token server-side, registers the wallet as a Trader, and sends starter funds (devnet SOL and dUSD) once per account.
- Pages: Markets (a curated set of contracts that are tradable now), Ticket (bid, ask, limit, fee cap), Activity (per-order timeline, receipt, and a Reclaim button once an order has expired), Portfolio and Redeem. The in-app portfolio is the canonical view of balances.
- Transactions are built with `@solana/kit` and the generated client, use a blockhash fetched at click time, are simulated first, signed through Privy, and broadcast unchanged.
- A fixed banner marks every page as devnet and sandbox.

## Testing

- Program: LiteSVM tests for every instruction, every invariant, and adversarial cases (account substitution, replayed fills, donated escrow balances, expiry boundaries, wrong settlement).
- Relayer: recorded sandbox frames as fixtures; a property test that minted quantity never exceeds venue-filled quantity under reordered, duplicated or dropped events; crash-and-restart tests around every external call.
- End to end: scripted runs on devnet plus sandbox; deterministic runs on a local validator plus the mock venue.

## Not in v1

Mainnet, real funds, production venue hosts, KYC, AMM listing, hosted public demo with venue data, per-user account linking. See [SCOPE.md](SCOPE.md).

## Pinned stack (checked 2026-11-14)

| Component | Version |
|---|---|
| Anchor | 1.2.2 |
| Solana CLI | 4.1.2 |
| `@solana/kit` | 8.6.0 |
| `@solana-program/token`, `token-2022`, `system`, `memo` | 0.18.0, 0.20.1, 0.16.0, 0.16.0 |
| `codama`, `@codama/renderers-js`, `@codama/nodes-from-anchor` | 1.11.0, 2.9.0, 1.5.6 |
| `@gemini-markets/sdk` | 0.1.1 |
| Next.js, React | 16.4.6, 19.3.1 |
| `@privy-io/react-auth`, `@privy-io/node` | 3.51.4, 0.39.0 |
| Node, TypeScript, pnpm | 24, ~5.9, 12.18 |
