# tokenized-gemini-predictions

> **Unofficial. Devnet and sandbox only. No real money.**
>
> An independent, experimental prototype. It is not affiliated with, endorsed by or sponsored by Gemini Space Station, Inc., Gemini Trust Company, LLC, Gemini Titan, LLC or any of their affiliates ("Gemini"). "Gemini" and "Gemini Predictions" are trademarks of their owners and appear here only to identify the API this software is tested against. (Gemini here is the crypto exchange, not Google's Gemini.)
>
> The software targets Solana devnet and the Gemini sandbox only. The tokens it creates are test tokens with no monetary value. They are not event contracts, they are not issued, backed or redeemable by Gemini, and nothing here is an offer or solicitation to buy or sell any financial product or to place a wager. See [docs/SCOPE.md](docs/SCOPE.md).

Prediction-market positions as SPL tokens on Solana. A user logs in, holds a test stablecoin, and buys YES or NO outcome tokens that are minted only after the matching order fills on the Gemini Predictions sandbox. After the market settles, winning tokens redeem for the test stablecoin.

## How it works

1. **Login.** Sign in with email (an embedded Solana wallet is created for you) or with your own wallet such as Phantom, including WalletConnect. Only wallets registered after a login can place orders; the program enforces it.
2. **Order.** The user signs one transaction that holds test dollars in an on-chain program, with a limit price and a 90-second deadline.
3. **Fill.** A relayer places the matching fill-or-kill order on the sandbox. If it fills, the program mints outcome tokens to the user and returns the unused part of the hold. If it does not, the whole hold is returned. After the deadline anyone, including the user, can trigger that refund without the relayer.
4. **Sell back.** Before the market closes, tokens can be sold back the same way: they are held on-chain, the relayer buys the opposite outcome at the venue, the tokens are burned and the proceeds are paid out.
5. **Settle.** When the sandbox market resolves, the relayer posts the outcome on-chain together with a fully funded redemption vault.
6. **Redeem.** Holders burn winning tokens for one test dollar each.

The bridge is custodial: the program limits what the relayer can do to any one order (price, quantity, fee cap, deadline), but that a fill happened and how a market resolved are reported by the relayer. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the accounts, the instructions, the invariants and the known limits.

## What is in the repository

| Path | What |
|---|---|
| `anchor/` | The Solana program `outcome_tokens` (Anchor, Token-2022): 15 instructions, 188 tests on LiteSVM |
| `clients/js/` | TypeScript client generated from the program's IDL |
| `apps/relayer/` | The relayer: order pipeline with a write-ahead journal, sandbox and mock venue adapters, market manager, settlement watcher, reconciliation, a local API, and scripts |
| `apps/web/` | The web app (Next.js, Privy): markets, a ticket for buying and selling with a live timeline, portfolio, activity, system status; browser checks in `apps/web/e2e/` |
| `docs/` | Architecture, scope, product and design notes |

## Status

Built, and verified end to end on Solana devnet against the Gemini Predictions sandbox on 14 November 2026:

- a buy placed on-chain was filled at the sandbox and the tokens were minted about five seconds after the order was placed;
- a sell-back filled, the tokens were burned and the proceeds paid;
- an order with no offer at its limit was refunded in full;
- with the relayer stopped, the user reclaimed an expired order's hold without it;
- markets were settled on-chain from the sandbox's resolution about forty seconds after expiry, and tokens were redeemed;
- the same flow was driven from the browser with an email login and with a wallet login: test funds, buys from the ticket with a live timeline, a sell-back, redemption after settlement, and an order after a page reload through Reconnect wallet;
- with the relayer stopped, the web app kept showing balances, positions and open orders from Solana, and expired orders were reclaimed from the browser.

Program id on devnet: `8TN1HWcEFTAcM7Vthmih1FKftTBrp3LDgTBkfhp1PRVn`. The addresses of that deployment are in [`deployments/devnet.json`](deployments/devnet.json).

The sandbox's market makers quote only part of the time. When a book is empty, orders are refunded; `pnpm dev:mock` runs the same system against a simulated venue instead.

## Run it

You need Node 24.6 or newer and pnpm 12. For the program tests and the local end-to-end run you also need Rust, the Solana CLI 4.1 and Anchor 1.2.2 ([`scripts/install-toolchain.sh`](scripts/install-toolchain.sh)).

```sh
pnpm install
cp .env.example .env      # then fill it in, see below
pnpm dev                  # relayer + web app; open http://localhost:3000
```

`.env` needs:

- a [Privy](https://www.privy.io) development app with email and Solana wallet login enabled: `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET`;
- a Gemini **sandbox** API key (account scope, trader role, time-based nonce): `GEMINI_ENV=sandbox`, `GEMINI_API_KEY`, `GEMINI_API_SECRET`. Not needed for `pnpm dev:mock`;
- `SOLANA_RPC_URL=https://api.devnet.solana.com`.

The role keys of the devnet deployment listed above are not in the repository. To run your own copy, deploy the program under your own program id (`anchor keys sync`, `anchor build`, `anchor program deploy`), then run `pnpm bootstrap`: it creates the role keys under `.keys/`, a test stablecoin, the treasury accounts and the program configuration, and writes `deployments/devnet.json`. The upgrade authority needs a few devnet SOL.

In the app: log in, press **Get test funds**, pick a market, place an order, and watch its timeline. Tokens can be sold back from the same ticket while the market is open. When the market's fifteen minutes are over, redeem from the portfolio. The app is a local one: nothing here is hosted.

Other commands:

| Command | What it does |
|---|---|
| `pnpm dev:mock` | The same with a simulated venue: rolling test markets that always have offers |
| `pnpm relayer`, `pnpm web` | The two processes separately |
| `pnpm demo setup`, `pnpm demo buy auto yes 1`, `pnpm demo sell <symbol> yes 1`, `pnpm demo redeem <symbol>`, `pnpm demo reclaim <order>` | A command-line test user trading through the running relayer |
| `pnpm e2e:local` | A full run on a local validator with the mock venue: buys, a refund, settlement, redemption (about three minutes; needs `anchor build` first) |
| `pnpm test` | Unit tests of the relayer and the web app |
| `cd anchor && anchor build && cargo test` | Program tests |

Both the relayer and the web app refuse to start against anything but Solana devnet (or a local validator) and the sandbox (or the mock venue).

## Documents

- Design and known limits: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Scope and constraints: [docs/SCOPE.md](docs/SCOPE.md)
- Product and interface design: [docs/PRODUCT.md](docs/PRODUCT.md), [docs/DESIGN.md](docs/DESIGN.md)
- Build plan and what was verified: [tasks/todo.md](tasks/todo.md)
