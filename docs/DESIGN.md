---
name: Outcome Tokens
description: Forest, jade, peach and white. A calm, plain interface for a prediction market on Solana devnet.
colors:
  forest: "#173B2A"
  jade: "#0A7F56"
  peach: "#FEF3EB"
  white: "#FFFFFF"
  forest-soft: "#536E61"
  edge: "#788D83"
  line: "#E3E7E5"
  forest-hover: "#335344"
  jade-hover: "#0C754F"
  jade-tint: "#E2F0EB"
  jade-tint-hover: "#CEE5DD"
  clay: "#9C4A3C"
  clay-tint: "#F3E9E8"
typography:
  sans: "Reddit Sans, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
  scale:
    xs: "0.75rem / 1.35"
    sm: "0.875rem / 1.45"
    base: "1rem / 1.5"
    lg: "1.25rem / 1.3"
    xl: "1.5rem / 1.25"
    2xl: "2rem / 1.15"
  weights: [400, 500, 600]
rounded:
  sm: "8px"
  md: "12px"
  lg: "20px"
  full: "999px"
spacing:
  unit: "4px"
  steps: ["4px", "8px", "12px", "16px", "24px", "32px", "48px", "64px"]
components:
  - navbar
  - footer
  - button
  - field
  - segmented
  - panel
  - row-list
  - facts
  - badge
  - notice
  - timeline
  - countdown
  - external-link
  - skeleton
---

# Design

## Overview

Someone opens this on a laptop in daylight, or on a phone on the sofa, to look at a few markets without hurry. It is a demo with test money, so nothing on the screen should raise the pulse. The interface is light only: a peach-white page, white surfaces on it, forest-green text, and jade wherever there is a price, a Yes, or something live.

It still has to read as a prediction market at a glance. Every market shows its question, its price in cents, Yes and No, the time left and the volume. Calm does not mean vague: the numbers are exact and they are the largest things on the screen.

There is no motif and no decoration. No tickets, receipts or stamps, no illustrations, no gradients, no icons beyond the three small marks the components need (a check, a caret, an arrow). The whole product is built from twelve components and four colours.

Tokens are CSS custom properties on `:root` in `apps/web/src/app/globals.css`, named exactly as in the front matter (`--forest`, `--jade-tint`, `--text-sm`, `--space-4`, `--rounded-md`). Components use CSS Modules. There is no utility framework and no icon library. `/dev/gallery`, served by the development server only, shows every component in its states inside the real shell and is the visual reference for this file.

### Layout

- **Page.** One centred column, `--page-max` 72rem (1152px) wide including the gutters. Gutters are `--gutter`: 24px, and 16px at 40rem and narrower.
- **Two surfaces.** The page is `peach`. Content sits on `white` surfaces with a 20px radius and no border. A surface never sits inside another surface.
- **Section titles sit on the page**, above the surface they name, not inside it.
- **At 1280** the content column is 1104px. A list page is one column. A market page is a main column plus an aside of `--aside` 22.5rem (360px) for the trade panel, 32px apart; the aside stays in view while the main column scrolls (`position: sticky`, 24px under the navbar).
- **At 390** the content column is 358px and everything is one column. On a market page the trade panel comes straight after the title and price, before the chart and the details. Rows of a list stack: the main text on the first line, the values under it with their labels.
- **Three breakpoints, by the window.** At 40rem and narrower: 16px gutters, 20px inside a surface, compact controls at full touch size. Under 60rem: the aside leaves the side and stacks into the column. Under 64rem: the navbar takes two rows. There are no others.
- **Two components answer to their own width instead**, so that they behave the same in the page column, beside the aside and on a phone: a RowList stacks its rows when the list is 40rem wide or less, and a Notice puts its actions under its text when the notice is 30rem wide or less.
- **Rhythm.** 48px between sections, 24px between a section title and its surface, 24px padding inside a surface (20px at 40rem and narrower), 12 or 16px between related items, 4 or 8px inside a control. The page starts 32px under the navbar and the footer starts 64px after the last section. Do not use one padding everywhere.
- **Spacing** follows the 4px steps `--space-1` to `--space-8`: 4, 8, 12, 16, 24, 32, 48, 64.
- **Radius.** `--rounded-md` 12px for every control, `--rounded-lg` 20px for surfaces, `--rounded-sm` 8px for small marks and skeletons, `--rounded-full` for dots and badges.
- **Touch.** Controls are 44px tall (`--control`). The compact size for controls inside rows and notices (`--control-row`, 36px) grows to 44px at 40rem and narrower and on touch screens. A link that stands alone (a row's main text, a transaction) is padded to the same target there.
- **Measure.** Running text stays under 65 characters per line.

## Colors

Four theme colours. Everything else is one of them mixed toward another, written down as a solid value so it can be checked.

| Token | Value | Derived from | Role |
| --- | --- | --- | --- |
| `forest` | `#173B2A` | theme | All text. The primary action. A selected neutral choice. |
| `jade` | `#0A7F56` | theme | Prices, Yes, live, selected, done, the focus ring. |
| `peach` | `#FEF3EB` | theme | The page. The hovered row on a surface. |
| `white` | `#FFFFFF` | theme | Surfaces and fields. Text on forest and on jade. |
| `forest-soft` | `#536E61` | forest 74% in white | Secondary text: labels, captions, helper text, placeholders. |
| `edge` | `#788D83` | forest 58% in white | The 1px boundary of a control: fields, outlined buttons, unselected choices. |
| `line` | `#E3E7E5` | forest 12% in white | Hairlines between rows. Skeletons. The neutral badge. |
| `forest-hover` | `#335344` | forest 88% in white | A forest fill under the pointer. |
| `jade-hover` | `#0C754F` | jade 85% in forest | A jade fill under the pointer. |
| `jade-tint` | `#E2F0EB` | jade 12% in white | Yes at rest. The positive notice and badge. |
| `jade-tint-hover` | `#CEE5DD` | jade 20% in white | Yes under the pointer. |
| `clay` | `#9C4A3C` | exception | Errors only: the message, the field boundary, the mark. |
| `clay-tint` | `#F3E9E8` | clay 12% in white | The fill of an error notice. |

Mixes are in sRGB, as `color-mix(in srgb, ...)` computes them. A unit test (`apps/web/src/app/theme.test.ts`) recomputes every mix and every ratio below from `globals.css` and fails if this file, the stylesheet and the figures disagree.

### Why these four

Each was chosen against neighbours, side by side in the browser, and then by the numbers.

- **Forest `#173B2A`.** The starting candidate `#1F3B2D` reads as charcoal in small text. This one is as dark (12.39:1 on white against 12.20) with more green in it, so a button filled with it is plainly forest green. Lighter greens such as `#234534` look greener still but push secondary text under 4.5:1 on the page.
- **Jade `#0A7F56`.** Classic jade (`#00A86B`) and the starting candidate `#17A673` reach only 3.1:1 on white and 2.8:1 on the page, and neither white nor forest text reaches 4.5:1 on top of them, so they could not carry a price or a label. This is the same hue taken down to the lightest value that does three jobs at AA: text on white (5.02), text on the page (4.60) and white text on a jade fill (5.02). It is also calmer than the bright version.
- **Peach `#FEF3EB`.** Seashell (`#FFF5EE`) is so close to white that surfaces stop separating from the page (1.07:1). `#FDF1E8` and `#FBEEE4` separate well but read as peach or sand. This sits between: a skin-like tint, close to white, on which white surfaces are still visible without borders or shadows (1.09:1).
- **White `#FFFFFF`.** Pure white, so the peach is felt by comparison.

### The clay exception

There is no fifth hue, with one exception: `clay`, a muted terracotta from the same warm family as the page, for errors. It marks a failed action and an invalid field, and nothing else. It is never decoration, never a "No", and never an order that simply did not fill. There is no warning colour: something that needs attention is said in forest, in words.

### Contrast

WCAG 2.1 AA: 4.5:1 for text, 3:1 for large text, for the boundary of a control and for a mark that carries meaning. These are all the pairings the system uses. Any other pairing is not allowed until it is added here and passes.

| Text or mark | On | Ratio | Needs | Used for |
| --- | --- | --- | --- | --- |
| `forest` | `white` | 12.39 | 4.5 | Text on surfaces |
| `forest` | `peach` | 11.34 | 4.5 | Text on the page and in a hovered row |
| `forest-soft` | `white` | 5.57 | 4.5 | Secondary text on surfaces |
| `forest-soft` | `peach` | 5.10 | 4.5 | Secondary text on the page and in a hovered row |
| `white` | `forest` | 12.39 | 4.5 | Primary button, selected choice |
| `white` | `forest-hover` | 8.53 | 4.5 | The same under the pointer |
| `white` | `jade` | 5.02 | 4.5 | Selected Yes, the done mark of a step |
| `white` | `jade-hover` | 5.72 | 4.5 | Selected Yes under the pointer |
| `jade` | `white` | 5.02 | 4.5 | Prices, the Yes boundary, the focus ring, the mark of a step |
| `jade` | `peach` | 4.60 | 4.5 | Prices, the Yes boundary and the focus ring on the page, the live dot |
| `jade` | `jade-tint` | 4.28 | 3 | The Yes boundary against its own fill, marks and the focus ring in a positive notice |
| `jade` | `jade-tint-hover` | 3.80 | 3 | The Yes boundary under the pointer |
| `jade` | `clay-tint` | 4.22 | 3 | The focus ring in an error notice |
| `forest` | `jade-tint` | 10.56 | 4.5 | Yes at rest, positive notice and badge, the boundary of a control in a positive notice |
| `forest` | `jade-tint-hover` | 9.36 | 4.5 | Yes under the pointer, selected text |
| `forest` | `line` | 9.93 | 4.5 | Neutral badge |
| `clay` | `white` | 6.07 | 4.5 | Error text and the boundary of an invalid field on surfaces |
| `clay` | `peach` | 5.56 | 4.5 | The same on the page |
| `clay` | `clay-tint` | 5.10 | 4.5 | Title and mark of an error notice, the negative badge |
| `forest` | `clay-tint` | 10.40 | 4.5 | Body of an error notice, the boundary of a control in it |
| `edge` | `white` | 3.54 | 3 | Control boundaries on surfaces |
| `edge` | `peach` | 3.24 | 3 | Control boundaries on the page and in a hovered row |
| `forest` | `nav-worst` | 7.85 | 4.5 | Navbar text, and the boundary of the wallet control, over the darkest content |
| `jade` | `nav-worst` | 3.18 | 3 | Navbar marks and the focus ring over the darkest content |

`nav-worst` is not a token. It is the navbar's fill (peach at `--nav-alpha`, 80%) composited over a forest area, the darkest thing that can scroll beneath it.

These pairings look available and are not. The components avoid them:

| Text or mark | On | Ratio | Instead |
| --- | --- | --- | --- |
| `forest` | `jade` | 2.47 | White is the only text on jade |
| `edge` | `jade-tint` | 3.01 | Inside a positive notice a boundary is forest |
| `edge` | `clay-tint` | 2.97 | Inside an error notice a boundary is forest |

### Rules

- **Text is forest.** Secondary text is `forest-soft`, on `white` and `peach` only. The other text colours are the ones in the table and nothing more: white on a forest or jade fill, jade for a price standing on its own, clay for an error. On a tint, text is `forest`.
- **Jade is never body text.** It is for a price or a probability standing on its own (`57¢`), for fills, boundaries and marks. Jade text never sits on `jade-tint`.
- **Nothing sits on jade but white.**
- **`edge` is for boundaries, `line` is for hairlines.** A boundary says "this is a control" and keeps 3:1 on `white` and on `peach`. It does not on a tint, so inside a tinted notice the boundary of a control and the underline of a link are `forest`; the Notice sets that by itself. A hairline only separates: rows on a surface, and the edge of a neutral notice. Nothing should depend on seeing it.
- **In the navbar everything is forest or jade**, text and boundaries alike, because anything may scroll beneath it.
- **Colour is never the only signal.** Yes and No carry their words, a status carries its word, an error carries a sentence.

## Typography

One typeface: Reddit Sans, loaded and self-hosted through `next/font`, with a system sans as fallback. It is a quiet humanist sans with open shapes, drawn for interfaces, and it has true tabular figures. There is no monospace and no second family.

| Token | Size / line | Weight | Used for |
| --- | --- | --- | --- |
| `2xl` | 32px / 1.15 | 600 | The one number that matters on a screen: a price or a countdown |
| `xl` | 24px / 1.25 | 600 | Page titles and the question of a market |
| `lg` | 20px / 1.3 | 600 | Section titles |
| `base` | 16px / 1.5 | 400 | Body text, fields, default buttons, the main line of a row |
| `sm` | 14px / 1.45 | 400 | Secondary lines, helper text, compact buttons, navigation |
| `xs` | 12px / 1.35 | 500 | Column headers, captions, badges, the network mark; at 400 for small print (the footer, the time of a step) |

- Weights: 400 for text, 500 for labels (a badge is a label) and for numbers in running rows, 600 for titles, buttons, the wordmark and the number that matters. No light weights, no italics, no uppercase, no letter-spaced labels.
- Text at `xl` and `2xl` is tracked in by 0.01em and 0.02em. Nothing else is tracked, the wordmark included.
- **Figures are tabular everywhere** (`font-variant-numeric: tabular-nums` on `body`), so prices, balances and countdowns never shift as they change.
- **Prices are written in cents**: `57¢`, `3.5¢`. **Money is written in dollars** with two decimals: `$2.85`. Quantities are in contracts with two decimals.
- **Time left has three forms**, and the longer the wait the less often it changes: `12:41` under an hour (minutes and seconds, every second), `19h 6m` from an hour up (every minute), `3d 4h` from a day up (every hour). A market that closes in three days does not need its seconds.
- Addresses and signatures are shortened to four characters, an ellipsis and four more (`8rj8…DK8p`) and set in the same typeface at weight 500 (at 600 in the wallet control, which is a button).
- Sizes are fixed `rem` values. Nothing scales with the viewport.

## Elevation

Flat. There are two levels, page and surface, and they differ by colour alone: white on peach, no border, no shadow.

- **The one shadow** (`--shadow`: a 1px forest ring at 6% and `0 12px 32px -8px` of forest at 16%) belongs to things that float over surfaces: the panel of the wallet control, and any later popover. Nothing else has a shadow.
- **The navbar is the only translucent thing.** See Components. Blur is not used anywhere else.
- **No gradients**, no glows, no inner shadows, no overlapping layers.

### Motion

Motion is for state changes only: a fill or boundary changing under the pointer, a notice appearing, the wallet panel opening. 160ms, `cubic-bezier(0.22, 1, 0.36, 1)`, opacity, transform and colour only. Two things loop: the spinner of a busy control and the mark of the step in progress. Under `prefers-reduced-motion` both stand still and every transition is instant. Nothing moves on page load and nothing moves to decorate.

## Components

Twelve components in `apps/web/src/components/ui/`, plus the shell. Add one only when a screen cannot be built from these.

| Component | Use it for | Rule |
| --- | --- | --- |
| **Button** (and `ButtonLink`, `PriceButton`) | Every action and every link that looks like one | One `primary` per view. `secondary` for the rest, `quiet` for the least important action in a row or a notice. |
| **Field** | Every typed value | Always a visible label above. The unit sits inside the field. Errors say what is allowed. |
| **Segmented** | A choice among a few: Yes or No, Buy or Sell, a category, a cadence | Up to eight short options. `stretch` is for two or three; more than that stay at their own width and wrap onto a second line. |
| **Panel** | A white surface for anything that is not a list | Never inside another Panel or a RowList. |
| **RowList** | Every list: markets, contracts of an event, positions, orders, activity | It is its own surface. Numbers right aligned. One line of main text per row. It stacks by its own width. |
| **Facts** | Label and value lines: a cost summary, the details of a market or an order | Labels left in `forest-soft`, values right. The total is the last line. A heading before it names it. |
| **Badge** | The status of one thing in a word | The word carries the meaning. Three tones: neutral, positive, negative. |
| **Notice** | A message placed where it applies: waiting, done, went wrong, nothing here yet | A title, one sentence, at most two actions. Never a floating toast, never a modal. |
| **Timeline** | The steps of an order, each with its time and transaction | Every on-chain step carries its transaction link. A step that did not happen is said in words. |
| **Countdown** | Time left until a deadline | Sits next to anything that has a deadline. Read by a screen reader, never announced, except the one per page that is given `announce`. |
| **ExternalLink** | A transaction or an address on the explorer | Opens in a new tab and says so. |
| **Skeleton** | The shape of what is loading | Still blocks with the final dimensions. No shimmer, no spinner in the middle of a page. |

### States

Every control has all of these, and they look the same on every control.

- **Hover**: a fill moves one step (`forest` to `forest-hover`, `jade` to `jade-hover`, `jade-tint` to `jade-tint-hover`); an outlined control's boundary goes from `edge` to `forest`; a row on a surface turns `peach`. Hover styles apply only where there is a pointer that hovers.
- **Focus-visible**: a 2px `jade` ring, 2px away from the control, on every focusable element. Never removed. Where there is no room around the control (the navbar's two rows on a phone, the items of the wallet panel) the ring is drawn just inside it.
- **Pressed**: the control moves down 1px.
- **Selected**: filled. A neutral choice fills with `forest`, Yes fills with `jade`; the text turns `white`.
- **Disabled**: 45% opacity, the label stays, the cursor says not allowed. A disabled primary button is accompanied by the reason, in a field error or a notice.
- **Busy**: the control keeps its width, shows a small spinner and names what it is doing ("Check your wallet", "Sending"). It does not take a second press.
- **Invalid**: the boundary and the message turn `clay`; the message says what is allowed ("Minimum is 0.01 contracts").

### Yes and No

Yes and No use no hue of their own. They differ by fill and always carry their word.

| | At rest | Selected |
| --- | --- | --- |
| **Yes** | `jade-tint` fill, 1px `jade` boundary, forest text | `jade` fill, white text |
| **No** | no fill, 1px `edge` boundary, forest text | `forest` fill, white text |

- In lists, `PriceButton` shows both at rest: the word, then the price in cents (`Yes 57¢`, `No 44¢`). A side without an offer is disabled and shows a dash. Its name for a screen reader begins with the same words ("Yes 57 cents, buy Bitcoin above $66,000").
- In the trade panel, a `Segmented` with the two options shows which side is chosen. The chosen side is filled; the other stays at rest.
- The words are "Yes" and "No", in sentence case, never colour alone and never an icon alone.
- Buy and Sell, and every other choice, use the neutral treatment: outlined at rest, `forest` when selected.

### Button

44px tall (`default`) or 36px (`row`), 12px radius, the label at weight 600. `primary` is forest with white text. `secondary` is outlined with `edge`. `quiet` is text with the hairline underline of a link. `block` stretches to the width of its container. A button's label is a verb and its object ("Buy Yes · hold $2.92", "Get test funds"), never "OK" or "Submit".

### Segmented

Options side by side, 8px apart, each with its own boundary; the chosen one is filled. A radio group: Tab reaches it, the arrow keys move within it. `stretch` shares the full width equally and is for two or three options (Yes and No, Buy and Sell). With more, as in a filter of up to eight (All, 5 min, 15 min, Hourly, Daily, Weekly, Monthly), the options keep their own width and wrap onto a second line where the row runs out; nothing scrolls sideways and nothing is hidden. The compact size (`row`) is for filters above a list.

### Field

Label above at `sm` and weight 500. The control is white, 44px tall, with a 1px `edge` boundary and a 12px radius, on a surface and on the page alike. Numeric fields are right aligned with the unit inside (`¢`, `contracts`), and may have minus and plus buttons beside them. Helper text below in `forest-soft`; an error replaces it in `clay`. The unit is described to a screen reader ("In contracts.") whether or not there is helper text.

### Panel, RowList and Facts

A Panel is white, 20px radius, 24px padding. A RowList is the same surface with rows: a header line of `xs` labels in `forest-soft`, then rows at least 64px tall, separated by `line` hairlines, the main text left and the numbers right in fixed columns. A row turns `peach` under the pointer. Where the list is 40rem wide or less (on a phone, and in the main column beside the aside on a smaller laptop) a row stacks: the main text, then each value under its label, then the actions on a line of their own at the right. A list whose columns cannot fit scrolls sideways; it is never cut off. What hangs under a row (the details of an order) is a row of its own across every column. Facts is a plain list inside a Panel: label left, value right at weight 500, the total separated by a hairline and set at weight 600. It takes its name from a heading placed before it, hidden with `sr-only` where the lines explain themselves.

### Notice

A rounded block with a small round mark, a title at weight 600, one sentence, and up to two actions on the right (under the text where the notice is 30rem wide or less: on a phone, and in the trade panel). Neutral: white with a `line` boundary and a forest mark, so it reads as a small surface on the page and as an outlined note on a surface. Positive: `jade-tint` fill, jade mark. Negative: `clay-tint` fill, clay mark and title. An action in a notice is `secondary` or `quiet`; on the two tints its boundary is forest. With `busy` the mark is a spinner and the title is what a screen reader announces: this is the pattern for every wait on a wallet ("Waiting for your wallet", with Retry and Cancel), so that no step can hang without saying what it waits for. An empty list is a neutral notice that says what will appear and offers the one action that leads there.

### Countdown

The words before it in `forest-soft` ("closes in"), then the figure at weight 500, in one of the three forms of time left. In the last two minutes the figure goes to weight 600 and the word "closing" follows it; at zero the words for the end take its place ("closed", "awaiting result"). There is no warning colour. As the one number that matters (`display`) the figure is `2xl`.

A screen reader finds a sentence that is kept current ("closes in about 13 minutes", "closes in 19 hours 6 minutes") but nothing is announced: a list of twenty markets must stay silent. The one countdown a page is about takes `announce`, and then says when the last two minutes begin and when time is up, and nothing as the page loads.

### Navbar

One bar, on every page, for everyone.

- **Position.** `position: sticky; top: 0`, full width, above the page (`z-index: 20`). Content scrolls beneath it.
- **See-through.** Its fill is `peach` at 80% (`--nav-alpha`) with `backdrop-filter: saturate(1.6) blur(16px)`, and a 1px line of forest at 8% under it. Where `backdrop-filter` or `color-mix` is not supported, and under `prefers-reduced-transparency: reduce`, the fill is solid `peach` and there is no blur.
- **Left.** The wordmark "Outcome Tokens" (`base`, 600), which leads to the start. Then the four links: Markets, Portfolio, Activity, Vaults (`sm`, 500, forest). They are shown logged out as well. The current page is at weight 600 with a 2px jade line under it, on the bar's lower edge, and `aria-current="page"`.
- **Right.** The network mark: a 6px jade dot and "Solana devnet · test funds" (`xs`, 500). The test-dollar balance (`sm`, 600), present once logged in. Then the wallet control, or a compact primary "Log in" button, the one way in.
- **The wallet control** is the short address with a caret, outlined in forest; under the pointer, and while its panel is open, it fills with white. It shows and hides a panel under it: the full address, Copy address, Get test funds, How it works, Log out. It is a disclosure, not a menu: the panel is ordinary content reached with Tab, Escape closes it and returns to the button, and so does a press or focus anywhere else. The panel is the one floating surface: white, 20px radius, the one shadow.
- **Everything in the bar is forest or jade**, never `forest-soft` or `edge`, so it stays readable whatever scrolls beneath. A link under the pointer gets the line of the current page in forest.
- **Height.** `--nav-height` holds it (64px, and 100px under 64rem), for anything that sticks below the bar or scrolls to an anchor.
- **At 1280** it is one row, 64px tall, inside the page column.
- **At 390** (and anywhere under 64rem) it is two rows. First, 56px: the wordmark with the network mark under it ("Devnet · test funds"), and on the right the balance and the wallet control. Second, 44px: the four links, spread across the width, each a 44px target. Four short words fit on one line, so nothing is hidden behind a menu button, no icons have to be invented, and there is no second bar fixed to the bottom that would cover the page or the trade panel's action.
- A "Skip to content" link is the first focusable element.

### Footer and the test-money notice

The notice is quiet and it is always there. The network mark in the navbar says "Devnet · test funds" on every page and cannot be dismissed. The footer, on the page in `xs` `forest-soft`, says: "Unofficial demo. Not affiliated with any exchange. Test tokens with no value." followed by where orders go ("Orders are placed on the exchange sandbox." or "Orders are placed on a simulated venue.") and a link to How it works. There is no banner.

## Do's and Don'ts

Do:

- Show the price in cents, the time left and the volume wherever a market appears.
- Put the deadline next to anything that has one.
- Link every on-chain step to its transaction.
- Keep one primary button per view (the navbar's Log in aside), and name what it does and what it holds.
- Say what is being waited for at every wait, with a way to retry and a way to cancel.
- Write "test dollars" and "no value" where money first appears on a page.
- Leave space. If a screen feels full, remove something before shrinking anything.

Don't:

- No fifth colour. No blue, no orange, no red for No, no yellow for warnings. `clay` is for errors only.
- No dark theme, no neon, no gradients, no glow, no glass apart from the navbar.
- No tickets, receipts, stamps, perforations, dotted leaders or any other motif.
- No monospace type, no uppercase labels, no letter-spaced captions.
- No borders around surfaces and no surface inside a surface. (A neutral notice keeps its hairline: it is a note, not a surface.) No coloured side stripes.
- No shadows except under a floating panel.
- No modals for confirmation or for results: the wallet prompt is the confirmation, and results appear in place.
- No celebratory effects, badges of honour, streaks, leaderboards or "hot" markets.
- No exchange logos, no exchange name in the wordmark, nothing styled after the venue.
- No new component while one of the twelve can do the job.
- No em dashes in interface copy.
