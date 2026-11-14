---
name: Outcome Tokens
description: Paper and ink. A calm, light interface for a devnet demo, built around the order ticket and its receipt.
colors:
  paper: "oklch(0.982 0.007 85)"
  paper-raised: "oklch(0.995 0.004 85)"
  paper-sunken: "oklch(0.958 0.009 85)"
  rule: "oklch(0.885 0.012 85)"
  rule-strong: "oklch(0.62 0.015 85)"
  ink: "oklch(0.24 0.02 265)"
  ink-2: "oklch(0.42 0.018 265)"
  ink-3: "oklch(0.52 0.014 265)"
  yes: "oklch(0.50 0.14 255)"
  yes-strong: "oklch(0.44 0.14 255)"
  yes-tint: "oklch(0.955 0.02 255)"
  no: "oklch(0.53 0.14 48)"
  no-strong: "oklch(0.47 0.125 48)"
  no-tint: "oklch(0.955 0.026 60)"
  positive: "oklch(0.47 0.11 155)"
  positive-tint: "oklch(0.955 0.03 155)"
  caution: "oklch(0.50 0.10 75)"
  caution-tint: "oklch(0.955 0.04 90)"
  negative: "oklch(0.50 0.17 27)"
  negative-tint: "oklch(0.955 0.02 27)"
  focus: "oklch(0.55 0.17 255)"
typography:
  sans: "IBM Plex Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
  mono: "IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
  scale:
    xs: "0.75rem / 1.4"
    sm: "0.875rem / 1.45"
    base: "1rem / 1.5"
    lg: "1.25rem / 1.35"
    xl: "1.5625rem / 1.25"
    2xl: "1.9531rem / 1.2"
  weights: [400, 500, 600]
rounded:
  none: "0"
  sm: "2px"
  md: "4px"
  full: "999px"
spacing:
  unit: "4px"
  steps: ["4px", "8px", "12px", "16px", "24px", "32px", "48px", "64px"]
components:
  - network-strip
  - top-bar
  - button
  - side-toggle
  - price-button
  - field
  - stamp
  - countdown
  - ticket
  - order-timeline
  - receipt
  - row-list
  - notice
  - empty-state
  - skeleton
---

# Design

## Overview

Someone opens this on a laptop in a lit room, often while sharing their screen, and has fifteen minutes before the market they are looking at closes. The interface is a sheet of warm paper with dark ink on it: light theme only, high contrast, nothing that glows.

The visual idea is the order ticket and its receipt. An order is filled in on a ticket; once placed, the ticket becomes a timeline that is stamped step by step; when it is over it reads as a receipt with dotted leaders and a transaction reference on each line. Lists are ruled rows, like a ledger, not cards.

Layout: one centred column, 72rem at most, with 24px gutters (16px on narrow screens). A market page splits into a main column and a 22rem ticket column at 60rem and wider, and stacks below that. Spacing follows the 4px steps; sections are separated by 48px, related groups by 24px, items in a group by 8 or 12px. Do not use the same padding everywhere.

Tokens are CSS custom properties on `:root`, named exactly as in the front matter (`--paper`, `--ink`, `--yes`, `--text-sm`, `--space-4` and so on). Components use CSS Modules. There is no utility framework.

## Colors

Restrained. Tinted neutrals carry almost everything, ink is the action colour, and two data colours mark the two outcomes.

- **Paper** (`paper`, `paper-raised`, `paper-sunken`): warm off-whites. `paper` is the page, `paper-raised` is for inputs and the ticket, `paper-sunken` for hovered rows and inset areas. Never pure white.
- **Ink** (`ink`, `ink-2`, `ink-3`): a blue-black. `ink` for primary text and primary buttons, `ink-2` for secondary text, `ink-3` for captions and placeholders. Never pure black. All three pass 4.5:1 on every paper tone.
- **Rules** (`rule`, `rule-strong`): hairlines between rows use `rule`; borders of form controls use `rule-strong`, which keeps 3:1 against paper.
- **YES is blue, NO is orange** (`yes`, `no`, each with `-strong` for hover and pressed and `-tint` for backgrounds). The pair stays distinct for the common forms of colour blindness, and neither reads as good or bad. Each is always accompanied by the word YES or NO.
- **Status** (`positive`, `caution`, `negative`, each with a `-tint`): filled or redeemed, needs attention (expired, reclaim available, closing soon), and errors. A refund is not an error: it uses ink, not `negative`.
- **Focus** (`focus`): a 2px ring with a 2px offset on every focusable element.

Colour use stays under roughly a tenth of any screen. If a screen looks colourful, something is wrong.

## Typography

IBM Plex Sans for text and IBM Plex Mono for anything a user might compare or copy: prices, quantities, balances, countdowns, addresses, signatures, order ids. Both load through `next/font` with system fallbacks.

- Scale (ratio 1.25): `xs` 12px for captions and stamps, `sm` 14px for dense rows and helper text, `base` 16px for body, `lg` 20px for section titles, `xl` 25px for page titles, `2xl` 31px for the single most important number on a screen (a countdown or a price).
- Weights: 400 for text, 500 for labels and numbers, 600 for titles. No light weights, no italics for emphasis.
- Numbers always use `font-variant-numeric: tabular-nums`. Prices are written in dollars with two decimals (`$0.57`); a cents shorthand (`57¢`) is allowed only inside price buttons. Quantities are in contracts with up to two decimals.
- Uppercase is reserved for stamps and for small column headers, set in mono `xs` with 0.06em letter spacing.
- Body text lines stay under 70 characters.

## Elevation

Flat. Depth comes from rules and paper tones, not shadows.

- Surfaces are separated by 1px `rule` lines. Rows in a list share one line between them.
- The ticket and receipts sit on `paper-raised` with a 1px `rule-strong` border and a perforated top or bottom edge (a dashed rule).
- The only shadow belongs to floating menus (account menu): `0 8px 24px -12px` of ink at 25% opacity, plus a 1px `rule-strong` border.
- No blur, no glass, no gradients.

Motion is for state changes only: a timeline step completing, a row whose value just changed, a notice appearing. 150 to 250ms, `cubic-bezier(0.22, 1, 0.36, 1)`, opacity and transform only. Under `prefers-reduced-motion` everything is instant.

## Components

- **Network strip.** Full-width, 28px, `caution-tint` background, ink mono `xs` text: "Devnet and sandbox demo. Test tokens with no value." Fixed at the top of every page. Not dismissible.
- **Top bar.** Wordmark "Outcome Tokens" on the left; Markets, Portfolio, Activity; on the right the test-dollar balance in mono and the account menu (short address, copy, get test funds, how it works, log out). A 1px rule below it. The current page is marked with a 2px ink underline and `aria-current`.
- **Button.** Primary: ink background, paper text. Secondary: paper background, 1px `rule-strong` border, ink text. Quiet: text only, underlined on hover. Heights 40px (default) and 32px (in rows). Radius `md`. Disabled lowers opacity to 0.5 and keeps the label; a busy button keeps its width and shows a short status ("Signing", "Sending") instead of a spinner alone.
- **Side toggle.** Two segments, YES and NO. The selected segment fills with its colour (`yes` or `no`) and paper text; the other stays outlined. Arrow keys move between them (radio group semantics).
- **Price button.** In market rows: label (YES or NO) above the ask price in mono, tinted background of its side, side-coloured text and border. Disabled, with a dash for the price, when that side has no offer.
- **Field.** Label above, control on `paper-raised` with a `rule-strong` border, helper or error text below in `sm`. Numeric fields are mono, right aligned, with the unit inside the control (`$`, `contracts`). Steppers are plain minus and plus buttons beside the control. Errors state what is wrong and what is allowed ("Minimum is 0.01 contracts").
- **Stamp.** A status label: mono `xs`, uppercase, 1px border in the status colour, radius `sm`, no fill. Values: OPEN, FILLED, REFUNDED, EXPIRED, SETTLED, REDEEMABLE, REDEEMED, LOST, HALTED. Each has a fixed colour: ink for OPEN and REFUNDED, `positive` for FILLED, REDEEMABLE and REDEEMED, `caution` for EXPIRED and HALTED, `ink-3` for LOST and SETTLED.
- **Countdown.** Mono, tabular, `m:ss` (or `h:mm:ss` above an hour), with a short label before it ("closes in"). In the last two minutes it switches to `caution` and adds the text "closing"; at zero it reads "closed". It ticks once per second from the server-aligned clock and is announced to screen readers only when its state changes, not every second.
- **Ticket.** The order form: side toggle, quantity, limit price, then a summary block in receipt style (cost at limit, fee cap, total held, "anything unused is refunded"). One primary button, labelled with the action and the amount ("Place order · hold $5.83"). No modal confirmation: the wallet prompt is the confirmation.
- **Order timeline.** Replaces the ticket in place after an order is sent. Four steps in a vertical list with a status mark, a one-line description, a time and a transaction link: Held on Solana, Sent to the venue, Filled (or Not filled), Tokens minted (or Refunded). The current step shows a quiet progress indicator; finished steps get a check mark; a step that did not happen is described in words, not struck out. Under it, the order expiry countdown, then "Place another order".
- **Receipt.** Key and value lines joined by a dotted leader, values in mono, totals separated by a dashed rule. Used for a finished order and for a redemption.
- **Row list.** The ledger pattern for markets, positions and activity: a header row of mono uppercase labels, then rows of 56px minimum height separated by `rule`, the primary text left, numbers right aligned in fixed columns, actions at the far right. Rows highlight with `paper-sunken` on hover and focus-within. On narrow screens a row stacks into two lines; columns are never hidden without their label.
- **Notice.** Inline block with a tinted background, a 1px border in the status colour, a short title and one sentence. Used for relayer offline, wallet on the wrong network, paused trading and errors. Appears where the problem is, not as a floating toast.
- **Empty state.** One sentence saying what will appear here and one action that leads to it ("No positions yet. Pick a market to buy your first outcome tokens."). No illustration.
- **Skeleton.** `paper-sunken` blocks with the final layout's dimensions; no shimmer.

## Do's and Don'ts

Do:

- Show the exact number, with its unit, in mono.
- Put the deadline next to anything that has one.
- Describe what happened to an order in a full sentence when it did not fill.
- Link every on-chain step to its transaction.
- Keep one primary button per view.
- Say "test dollars" and "no value" wherever money is shown for the first time on a page.

Don't:

- No dark theme, no neon, no gradients, no glass, no glow.
- No cards in grids; lists are ruled rows.
- No modals for confirmation or for results.
- No green for YES or red for NO, and no red for an order that simply did not fill.
- No coloured side stripes on rows or notices.
- No celebratory effects, badges, streaks or leaderboards.
- No exchange logos, names in the wordmark, or styling borrowed from the venue.
- No em dashes in interface copy.
