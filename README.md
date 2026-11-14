# tokenized-gemini-predictions

> **Unofficial. Devnet and sandbox only. No real money.**
>
> An independent, experimental prototype. It is not affiliated with, endorsed by or sponsored by Gemini Space Station, Inc., Gemini Trust Company, LLC, Gemini Titan, LLC or any of their affiliates ("Gemini"). "Gemini" and "Gemini Predictions" are trademarks of their owners and appear here only to identify the API this software is tested against. (Gemini here is the crypto exchange, not Google's Gemini.)
>
> The software targets Solana devnet and the Gemini sandbox only. The tokens it creates are test tokens with no monetary value. They are not event contracts, they are not issued, backed or redeemable by Gemini, and nothing here is an offer or solicitation to buy or sell any financial product or to place a wager. See [docs/SCOPE.md](docs/SCOPE.md).

Prediction-market positions as SPL tokens on Solana. A user logs in, pays a test stablecoin, and receives YES or NO outcome tokens that are minted only after the matching order fills on the Gemini Predictions sandbox. After the market settles, winning tokens redeem for the test stablecoin.

## Design in brief

1. **Login.** Email login creates an embedded Solana wallet. Only logged-in wallets can place orders.
2. **Order.** The user signs one transaction that escrows test dollars in an on-chain program, with a limit price and a short deadline.
3. **Fill.** A relayer places the matching order on the sandbox. If it fills, the program mints outcome tokens to the user and refunds unused escrow. If it does not, the escrow is refunded; after the deadline anyone can trigger that refund.
4. **Settle.** When the sandbox market resolves, the outcome is posted on-chain together with a fully funded redemption vault.
5. **Redeem.** Holders burn winning tokens for test dollars.

## Status

Research and design are complete. The build proceeds in vertical slices, each with an exit test.

- Plan: [tasks/todo.md](tasks/todo.md)
- Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Scope and constraints: [docs/SCOPE.md](docs/SCOPE.md)
