"use client";

import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ApiHealth, ApiMarket, SideName } from "@outcome/relayer/api-types";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { ReceiptLine } from "@/components/ui/Receipt";
import { SideToggle } from "@/components/ui/SideToggle";
import { askPx, availableAt, bidPx, wantedAt } from "@/features/markets/book";
import type { Balances } from "@/lib/chain/accounts";
import { formatCents, formatContracts, formatDollars, formatPrice } from "@/lib/format";
import type { ReconnectView } from "@/lib/privy/reconnect";
import { ReconnectWords } from "@/lib/privy/ReconnectWords";
import type { TicketAction } from "./intent";
import { orderLimits, parseContracts, parsePrice, quoteBuy, quoteSell, type QuoteError } from "./quote";
import styles from "./Ticket.module.css";

const QUANTITY_STEP = 100n;
const ACTIONS: readonly TicketAction[] = ["buy", "sell"];

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

/** Where a send is: waiting for the wallet, or on its way to the network. */
export type SendProgress = "wallet" | "sending";

export interface TicketProps {
  market: ApiMarket;
  /** Null while the relayer cannot be reached. */
  health: ApiHealth | null;
  /** Null until the wallet's balances have been read. */
  balances: Balances | null;
  /** The wallet's tokens of this market, in units. Null until they have been read. */
  held?: Record<SideName, bigint> | null;
  initialSide?: SideName;
  /** Opens on the sell tab. The tabs are shown whenever the wallet holds tokens of this market. */
  initialAction?: TicketAction;
  /** Overrides the default quantity: 1.00 for a buy, everything held for a sale. */
  initialQuantity?: string;
  /** Overrides the default price: the current ask of the chosen side for a buy, its bid for a sale. */
  initialPrice?: string;
  progress?: SendProgress | null;
  /** Why the last attempt did not place an order. */
  error?: string | null;
  onSubmit(draft: TicketDraft): void;
  onGetTestFunds?(): void;
  /** The faucet's answer, shown under the button. */
  fundsNote?: string | null;
  /** Set while the trading wallet is not connected in this tab: reconnecting takes the button's place. */
  reconnect?: ReconnectView | null;
  timeZone?: string;
}

function dollarsText(px: bigint): string {
  return formatPrice(px).slice(1);
}

function clamp(value: bigint, low: bigint, high: bigint | null): bigint {
  if (value < low) return low;
  return high !== null && value > high ? high : value;
}

const plain = (units: bigint) => formatContracts(units).replace(/,/g, "");

/**
 * The order form: buy or sell, which side, how many, at what price, then what will be held.
 * There is no confirmation step; the wallet prompt is the confirmation.
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
  onGetTestFunds,
  fundsNote,
  reconnect = null,
  timeZone,
}: TicketProps) {
  const tabsId = useId();
  const [action, setAction] = useState<TicketAction>(initialAction);
  const [side, setSide] = useState<SideName>(initialSide);
  // Until they are edited, the quantity and the price follow the chosen tab and side.
  const [typedQuantity, setTypedQuantity] = useState<string | null>(initialQuantity ?? null);
  const [typedPrice, setTypedPrice] = useState<string | null>(initialPrice ?? null);

  const selling = action === "sell";
  const tabbed = selling || (held !== null && (held.YES > 0n || held.NO > 0n));
  const heldUnits = held ? held[side] : null;
  const limits = orderLimits(market, health);
  // A buy is priced off the offer of its side, a sale off the bid.
  const reference = selling ? bidPx(market, side) : askPx(market, side);
  const price = typedPrice ?? (reference === null ? "" : dollarsText(reference));
  const sellAll = heldUnits !== null && heldUnits > 0n ? plain(clamp(heldUnits, 1n, limits.maxUnits)) : "1.00";
  const quantity = typedQuantity ?? (selling ? sellAll : "1.00");
  const units = parseContracts(quantity);
  const limitPx = parsePrice(price);
  const buy = quoteBuy({ side, units, limitPx, market, health, balances, timeZone });
  const sell = quoteSell({ side, units, minPx: limitPx, market, health, balances, heldUnits, timeZone });
  const errors = selling ? sell.errors : buy.errors;

  const errorFor = (field: QuoteError["field"]) => errors.find((entry) => entry.field === field);
  const blocker = errorFor("market") ?? errorFor("fee") ?? errorFor("funds") ?? errorFor("sol");
  const fieldsValid = !errorFor("quantity") && !errorFor("price");
  const closed = errorFor("market") !== undefined;
  const busy = progress !== null;
  // A ticket that cannot be used is shown, switched off, with the reason under its button.
  const off = busy || closed;

  const reachable = limitPx !== null && !errorFor("price") ? (selling ? wantedAt(market, side, limitPx) : availableAt(market, side, limitPx)) : null;
  let priceHelper: string | undefined;
  let priceWarning: string | undefined;
  if (reachable !== null && !closed) {
    if (reachable === 0n && selling) {
      priceWarning = reference === null ? "Nobody is bidding on this side right now, so the order would not fill." : `Nobody bids this much. The highest bid is ${formatPrice(reference)}.`;
    } else if (reachable === 0n) {
      priceWarning = reference === null ? "Nothing is offered on this side right now, so the order would not fill." : `Nothing is offered at this price. The lowest offer is ${formatPrice(reference)}.`;
    } else if (units !== null && units > reachable) {
      priceWarning = `Only ${formatContracts(reachable)} ${selling ? "wanted" : "available"} at this price. The order fills in full or not at all.`;
    } else {
      priceHelper = `${formatContracts(reachable)} ${selling ? "wanted" : "available"} at this price`;
    }
  }

  const mostUnits = selling && heldUnits !== null && (limits.maxUnits === null || heldUnits < limits.maxUnits) ? heldUnits : limits.maxUnits;
  const leastUnits = selling ? 1n : limits.minUnits;
  const stepQuantity = (direction: 1n | -1n) => {
    const current = units ?? 0n;
    setTypedQuantity(plain(clamp(current + direction * QUANTITY_STEP, leastUnits, mostUnits)));
  };
  const highestPx = ((10_000n - 1n) / limits.tickPx) * limits.tickPx;
  const stepPrice = (direction: 1n | -1n) => {
    const current = limitPx ?? reference ?? limits.tickPx;
    const onTick = direction > 0n ? (current / limits.tickPx) * limits.tickPx : ((current + limits.tickPx - 1n) / limits.tickPx) * limits.tickPx;
    setTypedPrice(dollarsText(clamp(onTick + direction * limits.tickPx, limits.tickPx, highestPx)));
  };

  const choose = (next: TicketAction) => {
    if (next === action) return;
    setAction(next);
    setTypedQuantity(null);
    setTypedPrice(null);
  };
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = action === "buy" ? "sell" : "buy";
    choose(next);
    document.getElementById(`${tabsId}-${next}`)?.focus();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || reconnect || errors.length > 0 || units === null || limitPx === null) return;
    onSubmit({ action, side, units, limitPx, maxFeeMicros: selling ? sell.maxFeeMicros : buy.maxFeeMicros, holdMicros: selling ? 0n : buy.holdMicros });
  };

  const amount = (micros: bigint) => (fieldsValid ? formatDollars(micros) : "–");
  const tokens = fieldsValid && units !== null ? `${formatContracts(units)} ${side}` : "–";
  const detail = (which: SideName) => {
    const px = selling ? bidPx(market, which) : askPx(market, which);
    return px === null ? "–" : formatCents(px);
  };
  const holdWords = selling ? tokens : formatDollars(buy.holdMicros);

  return (
    <form className={styles.ticket} onSubmit={submit} noValidate aria-label="Order ticket" data-testid="ticket" data-action={action}>
      <div className={styles.head}>
        {tabbed ? (
          <div className={styles.tabs} role="tablist" aria-label="Buy or sell">
            {ACTIONS.map((name) => (
              <button
                key={name}
                id={`${tabsId}-${name}`}
                type="button"
                role="tab"
                className={styles.tab}
                aria-selected={action === name}
                aria-controls={`${tabsId}-panel`}
                tabIndex={action === name ? 0 : -1}
                disabled={busy}
                onClick={() => choose(name)}
                onKeyDown={onTabKey}
              >
                {name === "buy" ? "Buy" : "Sell"}
              </button>
            ))}
          </div>
        ) : (
          <h2 className={styles.heading}>Buy</h2>
        )}
        <p className={styles.balance}>
          {selling ? (
            heldUnits === null ? (
              "reading your tokens"
            ) : (
              <>
                <span className={styles.balanceValue}>{`${formatContracts(heldUnits)} ${side}`}</span> in your wallet
              </>
            )
          ) : balances ? (
            <>
              <span className={styles.balanceValue}>{formatDollars(balances.stableMicros)}</span> test dollars
            </>
          ) : (
            "test dollars"
          )}
        </p>
      </div>

      <div className={styles.fields} id={`${tabsId}-panel`} role={tabbed ? "tabpanel" : undefined} aria-labelledby={tabbed ? `${tabsId}-${action}` : undefined}>
        <SideToggle
          value={side}
          onChange={(next) => {
            setSide(next);
            setTypedPrice(null);
            if (selling) setTypedQuantity(null);
          }}
          label={selling ? "Outcome to sell" : "Outcome to buy"}
          detail={{ YES: detail("YES"), NO: detail("NO") }}
          disabled={off}
        />

        <Field
          label="Quantity"
          numeric
          suffix="contracts"
          value={quantity}
          onChange={setTypedQuantity}
          onBlur={() => units !== null && setTypedQuantity(plain(units))}
          error={closed ? undefined : errorFor("quantity")?.message}
          disabled={off}
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
          prefix="$"
          value={price}
          placeholder="0.00"
          onChange={setTypedPrice}
          error={closed ? undefined : errorFor("price")?.message}
          warning={priceWarning}
          helper={priceHelper ?? (selling ? "The least you accept per contract." : "The most you pay per contract.")}
          disabled={off}
          stepper={{
            onDecrement: () => stepPrice(-1n),
            onIncrement: () => stepPrice(1n),
            canDecrement: limitPx === null || limitPx > limits.tickPx,
            canIncrement: limitPx === null || limitPx < highestPx,
          }}
        />
      </div>

      <div className={styles.summary}>
        {selling ? (
          <>
            <dl className={styles.lines}>
              <ReceiptLine label="Tokens held">{tokens}</ReceiptLine>
              <ReceiptLine label="Proceeds at minimum">{amount(sell.proceedsMicros)}</ReceiptLine>
              <ReceiptLine label="Fee cap">{amount(sell.maxFeeMicros)}</ReceiptLine>
              <ReceiptLine label="You receive at least" total>
                {errorFor("fee") ? "–" : amount(sell.receiveMicros)}
              </ReceiptLine>
            </dl>
            <p className={styles.note}>A fill burns the tokens and pays test dollars. Without a fill the tokens come back.</p>
          </>
        ) : (
          <>
            <dl className={styles.lines}>
              <ReceiptLine label="Cost at limit">{amount(buy.costMicros)}</ReceiptLine>
              <ReceiptLine label="Fee cap">{amount(buy.maxFeeMicros)}</ReceiptLine>
              <ReceiptLine label="Total hold" total>
                {amount(buy.holdMicros)}
              </ReceiptLine>
              <ReceiptLine label={`Pays if ${side}`}>{amount(buy.payoutMicros)}</ReceiptLine>
            </dl>
            <p className={styles.note}>Unused hold is refunded when the order fills.</p>
          </>
        )}
      </div>

      {error && (
        <Notice tone="negative" title="The order was not placed">
          {error}
        </Notice>
      )}

      {/* Two buttons with keys of their own: a wallet can reconnect within the click that asked it
          to, and that click must not go on to submit the form through a reused button. */}
      {reconnect ? (
        <Button key="reconnect" variant="primary" block onClick={reconnect.onReconnect} data-testid="reconnect">
          Reconnect wallet
        </Button>
      ) : (
        <Button key="place" type="submit" variant="primary" block disabled={errors.length > 0} busy={progress === "wallet" ? "Check your wallet" : progress === "sending" ? "Sending" : false}>
          {fieldsValid && !closed && !errorFor("fee") ? `Place order · hold ${holdWords}` : "Place order"}
        </Button>
      )}

      {reconnect ? (
        <p className={styles.reason} role="status">
          <ReconnectWords reconnect={reconnect} />
        </p>
      ) : (
        blocker && (
          <p className={styles.reason} role="status">
            {blocker.message}
            {(blocker.field === "funds" || blocker.field === "sol") && onGetTestFunds && (
              <>
                {" "}
                <button type="button" className={styles.link} onClick={onGetTestFunds}>
                  Get test funds
                </button>
              </>
            )}
          </p>
        )
      )}
      {fundsNote && (
        <p className={styles.reason} role="status">
          {fundsNote}
        </p>
      )}
    </form>
  );
}
