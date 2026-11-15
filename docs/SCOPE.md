# Scope and constraints

Not legal advice. This page records what the project is, what it deliberately is not, and the published rules that shape it. Quotes were read from the primary sources on 2026-11-13 and 2026-11-14; terms change, so re-check before relying on any of it.

## What this project is

- A simulation on **Solana devnet** and the **Gemini sandbox** (Gemini's demo environment). No production Gemini account, API key or market data. No real money. No mainnet.
- One demo operator sandbox account holds the sandbox positions. Logged-in testers pay a test stablecoin and receive transferable test YES/NO tokens after the matching sandbox fill, and receive a test payout after the sandbox market settles.
- Every event the sandbox lists is shown, with its contracts. Contracts the sandbox's market makers never quote are listed with "No offers"; they trade only on the simulated venue.
- The tokens are test tokens with no value. They mirror positions in a sandbox account. They are not event contracts.

## What it is not

Mainnet. Real funds. Production keys or production market data. Fees or revenue. KYC. Listing on any exchange or AMM. A hosted public site that shows Gemini market data.

## Why the pooled model stays on the sandbox

This shape (one account holds the positions, other people hold transferable tokens on them) is not something an ordinary member may run on the live exchange.

Gemini Titan Rulebook v1.14, effective 2026-08-07 (these rules are unchanged from v1.13):

- Rule 3.1(b)(6)(iii): a member certifies that it "will trade only for itself in its Self-Clearing Member Account and will not serve as an intermediary for any other Person".
- Rule 5.17(f): "No Person shall enter into or agree to transfer, or transfer the benefit of any position in, any Contract to another Person other than through a Transaction executed through the Platform."
- Rule 5.17(g): "No Member shall trade for a Person other than itself."

The limit is not only about other people's money: any other person holding or benefiting from a token is a transfer of the benefit of a position.

Related Gemini terms:

- Market Data Agreement: market data may not be used to "develop, create, register, issue, price, list, modify, or cause to bring to market ... any new or existing investment product, financial product ... or financial contract of any kind", nor redistributed.
- User Agreement: "you may not use any of the Gemini Marks in connection with the creation, issuance, sale, offer for sale, trading, distribution, solicitation, marketing, or promotion of any investment products ... without a separate written agreement with us."
- Accounts and API access can be ended by Gemini at any time.

Separately from Gemini's own rules, accepting other people's orders and money for exchange-traded event contracts is regulated activity in the United States and can require registration. This project does not do that.

## What a real-user version would need

A different architecture, not a configuration change:

- Each user trades in their own Gemini account, connected through Gemini's OAuth, and Gemini approves the application for production.
- Tokens are non-transferable receipts of that user's own position.
- CFTC Staff Letter 26-25 (2026-09-17) sets out when a "passive software provider" front end need not register as an introducing broker. Among its conditions: users are direct members of the exchange, orders are entered from the user's own device, the provider never holds user assets, the provider and the exchange sign a joint-and-several-liability undertaking, and the provider files a notice with the CFTC's Market Participants Division. The letter does not mention tokens.

This project's escrow, fill and redemption program does not carry over to that design. The web shell, login, venue read adapter and settlement watcher do.

## Guardrails

Requirements of the build:

- Services refuse to start unless the Solana cluster is devnet (or a local validator) and the venue is the sandbox, on the sandbox hosts only, or the simulated venue.
- The program build rejects real stablecoin mints.
- Token names, token symbols and the app title do not use the Gemini name. Gemini is named only descriptively, to identify the API the software is tested against.
- Sandbox market data is shown in local runs. Any hosted demo runs on the mock venue or behind an allow-list.
- Gemini's specifications, documentation and recorded API payloads are not committed. Test fixtures are synthetic or scrubbed.
- Secrets live in git-ignored files only.

## Sources

| Document | Where |
|---|---|
| Gemini Titan Rulebook v1.14 (2026-08-07) | https://www.cftc.gov/filings/orgrules/rules07242611652.docx |
| Gemini Titan Rulebook v1.13 (2026-07-29) | https://www.cftc.gov/filings/orgrules/rules07142610110.pdf |
| Self-Clearing Member Agreement | https://www.gemini.com/titan/self-clearing-member-agreement |
| User Agreement | https://www.gemini.com/legal/gemini-moonbase-user-agreement |
| API Agreement | https://www.gemini.com/legal/api-agreement |
| Market Data Agreement | https://www.gemini.com/legal/market-data-agreement |
| CFTC Staff Letter 26-25 | https://www.cftc.gov/csl/26-25/download |
| Gemini developer documentation | https://developer.gemini.com |

## Staying in scope

This is a personal project and it stays on devnet and the sandbox. Anything beyond that is out of plan. It would first need a fresh read of the current rulebook (Rules 3.1, 5.17 and 11.1), the member agreement, the User Agreement, the API Agreement and the Market Data Agreement, then the exchange's written agreement and legal advice.
