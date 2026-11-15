"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import type { ApiHealth, ApiMarket, SideName } from "@outcome/relayer/api-types";
import { Button } from "@/components/ui/Button";
import { Fact, Facts } from "@/components/ui/Facts";
import { Field } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { Panel } from "@/components/ui/Panel";
import { Segmented } from "@/components/ui/Segmented";
import { askPx, availableAt, bidPx, wantedAt } from "@/features/markets/book";
import { centsText } from "@/features/markets/derive";
import type { Balances } from "@/lib/chain/accounts";
import { formatCents, formatContracts, formatDollars } from "@/lib/format";
import type { ReconnectView } from "@/lib/privy/reconnect";
import { ReconnectWords } from "@/lib/privy/ReconnectWords";
import type { TicketAction } from "@/lib/routes";
import { orderLimits, parseCents, parseContracts, quoteBuy, quoteSell, type QuoteError } from "./quote";
import { fixPrice, movedReference, priceText as cents, quantityText as plain, ticketDefaults } from "./defaults";
import { closedReason } from "./reasons";
import styles from "./Ticket.module.css";

const QUANTITY_STEP = 100n;

/** An order ready to be placed. */
export interface TicketDraft {
  action: TicketAction;
  side: SideName;
  units: bigint;
  /** Buy: the most paid per unit. Sell: the least accepted per unit. */
  limitPx: bigint;
  maxFeeMicros: bigint;
  /** Buy: the test dollars held. Zero for a sale, which holds its tokens. */
  holdMicros: bigint;
}

/** Where a send is: the relayer is creating the market on Solana, the wallet is asked, or it is on its way to the network. */
export type SendProgress = "market" | "wallet" | "sending";

export interface TicketProps {
  market: ApiMarket;
  /** Null while the relayer cannot be reached. */
  health: ApiHealth | null;
  /** Null until the wallet's balances have been read, and for a visitor. */
  balances: Balances | null;
  /** The wallet's tokens of this market, in units. Null until they have been read. */
  held?: Record<SideName, bigint> | null;
  initialSide?: SideName;
  initialAction?: TicketAction;
  /** Overrides the default quantity: 1.00 for a buy, everything held for a sale. */
  initialQuantity?: string;
  /** Overrides the default price in cents: the current ask of the chosen side for a buy, its bid for a sale. */
  initialPrice?: string;
  progress?: SendProgress | null;
  /** Why the last attempt did not place an order. */
  error?: string | null;
  onSubmit(draft: TicketDraft): void;
  /** Called when a field is edited, so a failed attempt's error can be cleared. */
  onEdit?(): void;
  onGetTestFunds?(): void;
  /** The faucet's answer, shown under the button. */
  fundsNote?: string | null;
  /** Set while the trading wallet is not connected in this tab: reconnecting takes the button's place. */
  reconnect?: ReconnectView | null;
  /**
   * Stands where the order button would be for someone who cannot place an order yet: "Log in to
   * trade" for a visitor, the first-run step for a new wallet. Everything else still works.
   */
  gate?: ReactNode;
  timeZone?: string;
}

const word = (side: SideName) => (side === "YES" ? "Yes" : "No");

function clamp(value: bigint, low: bigint, high: bigint | null): bigint {
  if (value < low) return low;
  return high !== null && value > high ? high : value;
}

/**
 * The trade panel: buy or sell, which side at its price, how many, at what limit in cents, what
 * it costs and holds, and one button that names the order. There is no confirmation step; the
 * wallet prompt is the confirmation, and the shell's waiting block says what the wallet is asked.
 */
export function Ticket({
  market,
  health,
  balances,
  held = null,
  initialSide = "YES",
  initialAction = "buy",
  initialQuantity,
  initialPrice,
  progress = null,
  error = null,
  onSubmit,
  onEdit,
  onGetTestFunds,
  fundsNote,
  reconnect = null,
  gate,
  timeZone,
}: TicketProps) {
  const [action, setAction] = useState<TicketAction>(initialAction);
  const [side, setSide] = useState<SideName>(initialSide);
  // Until they are edited, the quantity and the price follow the chosen action and side. The price
  // follows the market only until the panel is first touched; then it is fixed as if typed.
  const [typedQuantity, setTypedQuantity] = useState<string | null>(initialQuantity ?? null);
  const [typedPrice, setTypedPrice] = useState<string | null>(initialPrice ?? null);
  const [fixedPrice, setFixedPrice] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const selling = action === "sell";
  const heldUnits = held ? held[side] : null;
  const limits = orderLimits(market, health);
  // A buy is priced off the offer of its side, a sale off the bid.
  const reference = selling ? bidPx(market, side) : askPx(market, side);
  const price = typedPrice ?? (reference === null ? "" : cents(reference));
  const { quantity: defaultQuantity, leastUnits, mostUnits } = ticketDefaults({ selling, heldUnits, limits });
  const quantity = typedQuantity ?? defaultQuantity;
  const moved = movedReference({ typed: typedPrice, fixed: fixedPrice }, reference);
  const units = parseContracts(quantity);
  const limitPx = parseCents(price);
  const buy = quoteBuy({ side, units, limitPx, market, health, balances, timeZone });
  const sell = quoteSell({ side, units, minPx: limitPx, market, health, balances, heldUnits, timeZone });
  const errors = selling ? sell.errors : buy.errors;

  const errorFor = (field: QuoteError["field"]) => errors.find((entry) => entry.field === field);
  const reason = closedReason(market, health, { timeZone, now: Date.now() });
  // The chosen side has nobody on the other end: an order could only be refunded.
  const noOffer = reason === null && reference === null;
  const blocker = errorFor("fee") ?? errorFor("funds") ?? errorFor("sol");
  const fieldsValid = !errorFor("quantity") && !errorFor("price");
  const busy = progress !== null;
  const off = busy || reason !== null;

  const reachable = limitPx !== null && !errorFor("price") && !off ? (selling ? wantedAt(market, side, limitPx) : availableAt(market, side, limitPx)) : null;
  let priceHelper = selling ? "The least you accept per contract." : "The most you pay per contract.";
  let priceWarning: string | undefined;
  if (reachable !== null && reference !== null) {
    if (reachable === 0n) {
      // When the price was fixed from a reference that has since moved, the line under the field says so instead.
      if (moved === null) {
        priceWarning = selling ? `Nobody bids this much. The highest bid is ${formatCents(reference)}.` : `Nothing is offered at this price. The best offer is ${formatCents(reference)}.`;
      }
    } else if (units !== null && units > reachable) {
      priceWarning = `Only ${formatContracts(reachable)} ${selling ? "wanted" : "available"} at this price. The order fills in full or not at all.`;
    } else {
      priceHelper = `${formatContracts(reachable)} contracts ${selling ? "wanted" : "available"} at this price.`;
    }
  }

  const stepQuantity = (direction: 1n | -1n) => setTypedQuantity(plain(clamp((units ?? 0n) + direction * QUANTITY_STEP, leastUnits, mostUnits)));
  const highestPx = ((10_000n - 1n) / limits.tickPx) * limits.tickPx;
  const stepPrice = (direction: 1n | -1n) => {
    const current = limitPx ?? reference ?? limits.tickPx;
    const onTick = direction > 0n ? (current / limits.tickPx) * limits.tickPx : ((current + limits.tickPx - 1n) / limits.tickPx) * limits.tickPx;
    setTypedPrice(cents(clamp(onTick + direction * limits.tickPx, limits.tickPx, highestPx)));
  };

  const fix = (next: string | null) => {
    setTypedPrice(next);
    setFixedPrice(next);
  };
  const touch = () => {
    if (touched) return;
    setTouched(true);
    if (typedPrice === null) fix(fixPrice(null, reference));
  };
  const choose = (next: TicketAction) => {
    setAction(next);
    onEdit?.();
    setTypedQuantity(null);
    fix(fixPrice(null, next === "sell" ? bidPx(market, side) : askPx(market, side)));
  };

  const blocked = errors.length > 0 || noOffer || reason !== null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (gate || busy || reconnect || blocked || units === null || limitPx === null) return;
    onSubmit({ action, side, units, limitPx, maxFeeMicros: selling ? sell.maxFeeMicros : buy.maxFeeMicros, holdMicros: selling ? 0n : buy.holdMicros });
  };

  const amount = (micros: bigint) => (fieldsValid ? formatDollars(micros) : "–");
  // An unchosen side is a plain outline; only the chosen one is filled, Yes in jade and No in forest.
  const sideOption = (which: SideName) => ({
    value: which,
    label: word(which),
    detail: centsText(selling ? bidPx(market, which) : askPx(market, which)),
    tone: which !== side ? undefined : which === "YES" ? ("yes" as const) : ("no" as const),
  });
  const ready = fieldsValid && !blocked;
  const label = `${selling ? "Sell" : "Buy"} ${word(side)}${ready && units !== null ? (selling ? ` · ${formatContracts(units)} contracts` : ` · hold ${formatDollars(buy.holdMicros)}`) : ""}`;

  return (
    <Panel>
      <form className={styles.ticket} onSubmit={submit} onFocus={touch} onPointerDown={touch} onChange={onEdit} noValidate aria-label="Trade" data-testid="ticket" data-action={action}>
        <div className={styles.head}>
          <h2 className={styles.contract}>{market.label}</h2>
          {selling ? (
            heldUnits !== null && <p className={styles.balance}>{`${formatContracts(heldUnits)} ${word(side)} held`}</p>
          ) : (
            balances && <p className={styles.balance}>{`${formatDollars(balances.stableMicros)} test dollars`}</p>
          )}
        </div>

        <div data-testid="ticket-action">
          <Segmented
            label="Buy or sell"
            size="row"
            stretch
            value={action}
            onChange={choose}
            disabled={busy}
            options={[
              { value: "buy", label: "Buy" },
              { value: "sell", label: "Sell" },
            ]}
          />
        </div>

        <div data-testid="ticket-side">
          <Segmented
            label={selling ? "Side to sell" : "Side to buy"}
            stretch
            value={side}
            onChange={(next) => {
              setSide(next);
              onEdit?.();
              fix(fixPrice(null, selling ? bidPx(market, next) : askPx(market, next)));
              if (selling) setTypedQuantity(null);
            }}
            disabled={busy}
            options={[sideOption("YES"), sideOption("NO")]}
          />
        </div>

        <Field
          label="Quantity"
          numeric
          suffix="contracts"
          value={quantity}
          onChange={setTypedQuantity}
          onBlur={() => units !== null && setTypedQuantity(plain(units))}
          error={reason ? undefined : errorFor("quantity")?.message}
          disabled={off}
          data-testid="ticket-quantity"
          stepper={{
            onDecrement: () => stepQuantity(-1n),
            onIncrement: () => stepQuantity(1n),
            canDecrement: units === null || units > leastUnits,
            canIncrement: units === null || mostUnits === null || units < mostUnits,
          }}
        />

        <Field
          label={selling ? "Minimum price" : "Limit price"}
          numeric
          suffix="¢"
          value={price}
          placeholder={reference === null ? "–" : cents(reference)}
          onChange={setTypedPrice}
          error={reason || noOffer ? undefined : errorFor("price")?.message}
          warning={priceWarning}
          helper={priceHelper}
          disabled={off}
          data-testid="ticket-price"
          stepper={{
            onDecrement: () => stepPrice(-1n),
            onIncrement: () => stepPrice(1n),
            canDecrement: limitPx === null || limitPx > limits.tickPx,
            canIncrement: limitPx === null || limitPx < highestPx,
          }}
        />
        {moved !== null && !off && (
          <p className={styles.moved} data-testid="ticket-moved">
            {`Best ${selling ? "bid" : "offer"} is now ${formatCents(moved)}.`}
            <Button variant="quiet" size="row" onClick={() => fix(cents(moved))}>
              {`Use ${formatCents(moved)}`}
            </Button>
          </p>
        )}

        <h3 className="sr-only">Order summary</h3>
        {selling ? (
          <Facts>
            <Fact label="Proceeds at minimum">{amount(sell.proceedsMicros)}</Fact>
            <Fact label="Fee at most">{amount(sell.maxFeeMicros)}</Fact>
            <Fact label="You receive at least" total>
              {errorFor("fee") ? "–" : amount(sell.receiveMicros)}
            </Fact>
          </Facts>
        ) : (
          <Facts>
            <Fact label="Cost at limit">{amount(buy.costMicros)}</Fact>
            <Fact label="Fee at most">{amount(buy.maxFeeMicros)}</Fact>
            <Fact label={`Pays if ${word(side)} wins`}>{amount(buy.payoutMicros)}</Fact>
            <Fact label="Held until filled" total>
              {amount(buy.holdMicros)}
            </Fact>
          </Facts>
        )}

        {reason ? (
          <Notice title={reason.title}>{reason.text}</Notice>
        ) : noOffer ? (
          <Notice title={selling ? `Nobody bids on ${word(side)}` : `No offer on ${word(side)}`}>
            {selling ? "A sale would not fill right now. Try again when someone bids." : `Nobody sells ${word(side)} right now, so a buy would not fill.`}
          </Notice>
        ) : (
          !gate &&
          blocker && (
            <Notice
              title={blocker.field === "fee" ? "The fee is not covered" : "Not enough funds"}
              action={
                (blocker.field === "funds" || blocker.field === "sol") &&
                onGetTestFunds && (
                  <Button size="row" onClick={onGetTestFunds}>
                    Get test funds
                  </Button>
                )
              }
            >
              {blocker.message}
            </Notice>
          )
        )}
        {fundsNote && <p className={styles.note}>{fundsNote}</p>}
        {error && (
          <Notice tone="negative" title="The order was not placed">
            {error}
          </Notice>
        )}

        {/* Separate buttons with keys of their own: a wallet can reconnect within the click that
            asked it to, and that click must not go on to submit the order through a reused button. */}
        {gate ? (
          gate
        ) : reconnect ? (
          <>
            <Button key="reconnect" variant="primary" block onClick={reconnect.onReconnect} data-testid="reconnect">
              Reconnect wallet
            </Button>
            <p className={styles.note} role="status">
              <ReconnectWords reconnect={reconnect} />
            </p>
          </>
        ) : (
          <Button
            key="place"
            type="submit"
            variant="primary"
            block
            disabled={blocked}
            data-testid="place"
            busy={progress === "market" ? "Preparing the market" : progress === "wallet" ? "Check your wallet" : progress === "sending" ? "Sending" : false}
          >
            {label}
          </Button>
        )}

        <p className={styles.note}>Every order fills at once at your limit or better, or is refunded in full. Test dollars with no value.</p>
      </form>
    </Panel>
  );
}
