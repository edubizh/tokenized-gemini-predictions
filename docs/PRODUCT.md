# Product

## Users

Three kinds of people, on a laptop or a phone:

- A visitor who has not logged in. They can see every market, its price and its rules, and decide whether to try it.
- The owner, showing a personal project to someone else. They narrate while they click, so every screen has to explain itself at a glance.
- Developers who are curious about Solana or prediction markets and try the demo for a few minutes. They know what a wallet is. They may not know how a prediction market settles.

Their job is one full loop without help: look at the markets, log in, get test funds, buy an outcome, watch the order fill, wait for the market to settle, redeem. Along the way they should be able to tell which part happened on Solana and which part happened at the venue.

## Product Purpose

Outcome Tokens is a prediction-market platform on Solana devnet. It lists the markets of an exchange sandbox and turns a position in any of them into a token. A user holds a test stablecoin on-chain with a limit price. A relayer places the matching order at the venue. Tokens are minted only after that order fills, and winning tokens redeem for the test stablecoin once the market settles.

Everything is test money. The app exists to show the mechanism working end to end, honestly, including the parts that depend on trusting the relayer.

Success is a first-time visitor finishing the loop and being able to say what happened to their order at each step.

## Brand Personality

Calm, plain, exact.

- It feels like entering an on-chain platform: the network, the wallet and the balance are always in view, and every on-chain step links to its transaction.
- It reads as a prediction market: a question, a price in cents, Yes and No, the time left, the volume.
- It is quiet about it. A small fixed palette from nature (forest, jade, peach, white), a lot of space, few parts.

## Voice

- Plain sentences, in the present tense, in sentence case. Say what happened and what happens next.
- Numbers first. A price is `57¢`, money is `$2.85`, time left is `12:41`. Words are labels around them.
- Honest about test status, without shouting. Money is "test dollars" or "test funds", tokens have "no value", the network is "Solana devnet". The network mark and the footer say so on every page.
- Honest about limits: this is an unofficial demo, the bridge is custodial, the relayer is trusted.
- No hype. Nothing is "hot", "trending" or "winning". An order that does not fill is "not filled" and "refunded", not "failed".
- A wait always says what it waits for ("Waiting for your wallet") and offers Retry and Cancel.
- Buttons name the action and what it holds: "Buy Yes · hold $2.92", "Get test funds", "Redeem $5.00".
- The exchange is named only descriptively ("the exchange sandbox"), never in a product name.

## Anti-references

- Neon-on-black crypto casino.
- Gamified betting: confetti, flashing odds, WIN banners, streaks.
- DeFi dashboards made of gradient glass cards and oversized hero metrics.
- Cramped exchange terminals with twelve panels.
- A themed interface: tickets, receipts, stamps or any other borrowed object.
- Anything that looks affiliated with, or styled after, the exchange whose sandbox is used.

## Design Principles

1. **Few parts.** Start from the fewest components that do the job. Add one only when a screen cannot work without it.
2. **The market is the content.** Question, price, Yes and No, time left, volume. Nothing on a screen is larger than the number that matters.
3. **Show the mechanism.** Every order shows where it is: held on Solana, sent to the venue, filled or not, minted or refunded, each with its time and its transaction.
4. **Open to look, log in to trade.** Every market is visible to everyone. Only the trade panel asks for a login.
5. **Honest and quiet about test money.** The notice is always present and never loud.
6. **Failure is a normal state.** An order that does not fill is refunded, and the screen says so calmly, in the same visual language as a fill.
7. **Never a silent wait.** Anything that waits on a wallet, the chain or the relayer says so and can be retried or cancelled.

## Pages

The details of each page are specified separately. This is the inventory.

| Page | Route | Who | What it is for |
| --- | --- | --- | --- |
| Markets | `/` and `/markets` | Everyone | The entry. Every event the venue lists, by category, with prices, time left and volume. No marketing page in front. |
| Event | under `/markets` | Everyone | One event and all of its contracts, each with its Yes and No prices. |
| Market | under `/markets` | Everyone | One contract: question and rules, price, time left, volume, the user's position and orders, and the trade panel. Logged out, the trade panel asks for a login; nothing else is hidden. |
| Portfolio | `/portfolio` | Logged in | Balances, positions, what can be sold, redeemed or cleared. |
| Activity | `/activity` | Logged in | Every order with each step it took and its transactions. |
| Vaults | `/vaults` | Everyone | A placeholder: vaults come later. |
| System | `/system` | Everyone | How it works: the program, the relayer, the venue, the addresses, and whether everything balances. |
| Welcome | `/welcome` | Logged in, first run | Get test funds. |

Not found and error pages use the same shell, one sentence and one way back.

## Accessibility & Inclusion

- WCAG 2.1 AA for contrast, checked numerically for every pairing the design system allows; WCAG 2.2 AA for focus visibility and target size.
- Fully keyboard operable, with a visible focus ring on every interactive element and a skip link before the navigation.
- Colour is never the only signal: Yes and No always carry their word, statuses always carry text.
- `prefers-reduced-motion` removes all motion; `prefers-reduced-transparency` makes the navbar solid.
- Touch targets are at least 44 by 44 CSS pixels on narrow and touch screens.
- Figures are tabular so columns and countdowns do not shift.
- Times are shown in the viewer's local time zone with the zone named; durations are spelled in minutes and seconds for screen readers.
