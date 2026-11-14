# Product

## Register

product

## Users

Two kinds of people, both on a laptop, in daylight or on a screen share:

- The owner, demonstrating a personal project to someone else. They narrate while they click, so every screen has to explain itself at a glance.
- Developers who are curious about Solana or prediction markets and try the demo for a few minutes. They know what a wallet is. They may not know how a prediction market settles.

Their job is one full loop without help: get test funds, buy an outcome, watch the order fill, wait for the 15-minute window to end, redeem. Along the way they should be able to tell which part happened on Solana and which part happened at the venue.

## Product Purpose

Outcome Tokens turns a position in a short prediction market into a token on Solana devnet. A user escrows a test stablecoin with a limit price. A relayer places the matching order on an exchange sandbox. Tokens are minted only after that order fills, and winning tokens redeem for the test stablecoin once the market settles.

Everything is test money. The app exists to show the mechanism working end to end, honestly, including the parts that depend on trusting the relayer.

Success is a first-time visitor finishing the loop and being able to say what happened to their order at each step.

## Brand Personality

Precise, calm, candid.

- Numbers first. Prices, quantities, countdowns and addresses are the content; words are labels.
- No hype. Nothing is "winning" or "hot". Amounts are "test dollars" and tokens have "no value".
- Plain statements about limits: this is a demo, the bridge is custodial, the relayer is trusted.

## Anti-references

- Neon-on-black crypto casino.
- Gamified betting: confetti, flashing odds, WIN banners, streaks.
- DeFi dashboards made of gradient glass cards and oversized hero metrics.
- Cramped exchange terminals with twelve panels.
- Anything that looks affiliated with, or styled after, the exchange whose sandbox is used.

## Design Principles

1. **Show the mechanism.** Every order shows where it is: escrowed on-chain, sent to the venue, filled or not, minted or refunded, each with a link to the transaction.
2. **Time is the main character.** Markets last fifteen minutes. Exact countdowns appear wherever a deadline matters: market close, order expiry, redemption opening.
3. **Honest about test status.** A fixed notice says devnet, sandbox, no value. It cannot be dismissed.
4. **One decision per screen.** A market page asks one question: which side, how many, at what price.
5. **Failure is a normal state.** An order that does not fill is refunded, and the screen says so calmly, in the same visual language as a fill.

## Accessibility & Inclusion

- WCAG 2.2 AA for contrast, focus visibility and target size.
- Fully keyboard operable, with a visible focus ring on every interactive element.
- Colour is never the only signal: YES and NO always carry their label, statuses always carry text.
- `prefers-reduced-motion` removes all non-essential motion.
- Numbers use tabular figures so columns and countdowns do not shift.
- Times are shown in the viewer's local time zone with the zone named; durations are spelled in minutes and seconds.
