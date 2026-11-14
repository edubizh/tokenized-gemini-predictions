"use client";

import { useState, type FormEvent } from "react";
import type { ApiHealth, ApiMarket, SideName } from "@outcome/relayer/api-types";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { ReceiptLine } from "@/components/ui/Receipt";
import { SideToggle } from "@/components/ui/SideToggle";
import { askPx, availableAt } from "@/features/markets/book";
import type { Balances } from "@/lib/chain/accounts";
import { formatCents, formatContracts, formatDollars, formatPrice } from "@/lib/format";
import { orderLimits, parseContracts, parsePrice, quoteBuy, type QuoteError } from "./quote";
import styles from "./Ticket.module.css";

const QUANTITY_STEP = 100n;

/** A buy order ready to be placed. */
export interface TicketDraft {
  side: SideName;
  units: bigint;
  limitPx: bigint;
  maxFeeMicros: bigint;
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
  initialSide?: SideName;
  initialQuantity?: string;
  /** Overrides the default limit, which is the current ask of the chosen side. */
  initialPrice?: string;
  progress?: SendProgress | null;
  /** Why the last attempt did not place an order. */
  error?: string | null;
  onSubmit(draft: TicketDraft): void;
  onGetTestFunds?(): void;
  /** The faucet's answer, shown under the button. */
  fundsNote?: string | null;
  timeZone?: string;
}

function dollarsText(px: bigint): string {
  return formatPrice(px).slice(1);
}

function clamp(value: bigint, low: bigint, high: bigint | null): bigint {
  if (value < low) return low;
  return high !== null && value > high ? high : value;
}

/**
 * The order form: which side, how many, at what price, then what will be held. There is no
 * confirmation step; the wallet prompt is the confirmation.
 */
export function Ticket({ market, health, balances, initialSide = "YES", initialQuantity = "1.00", initialPrice, progress = null, error = null, onSubmit, onGetTestFunds, fundsNote, timeZone }: TicketProps) {
  const [side, setSide] = useState<SideName>(initialSide);
  const [quantity, setQuantity] = useState(initialQuantity);
  // Until the price is edited it follows the ask of the chosen side.
  const [typedPrice, setTypedPrice] = useState<string | null>(initialPrice ?? null);

  const limits = orderLimits(market, health);
  const ask = askPx(market, side);
  const price = typedPrice ?? (ask === null ? "" : dollarsText(ask));
  const units = parseContracts(quantity);
  const limitPx = parsePrice(price);
  const quote = quoteBuy({ side, units, limitPx, market, health, balances, timeZone });

  const errorFor = (field: QuoteError["field"]) => quote.errors.find((entry) => entry.field === field);
  const blocker = errorFor("market") ?? errorFor("funds") ?? errorFor("sol");
  const fieldsValid = !errorFor("quantity") && !errorFor("price");
  const closed = errorFor("market") !== undefined;
  const busy = progress !== null;
  // A ticket that cannot be used is shown, switched off, with the reason under its button.
  const off = busy || closed;

  const available = limitPx !== null && !errorFor("price") ? availableAt(market, side, limitPx) : null;
  let priceHelper: string | undefined;
  let priceWarning: string | undefined;
  if (available !== null && !closed) {
    if (available === 0n) {
      priceWarning = ask === null ? "Nothing is offered on this side right now, so the order would not fill." : `Nothing is offered at this price. The lowest offer is ${formatPrice(ask)}.`;
    } else if (units !== null && units > available) {
      priceWarning = `Only ${formatContracts(available)} available at this price. The order fills in full or not at all.`;
    } else {
      priceHelper = `${formatContracts(available)} available at this price`;
    }
  }

  const stepQuantity = (direction: 1n | -1n) => {
    const current = units ?? 0n;
    setQuantity(formatContracts(clamp(current + direction * QUANTITY_STEP, limits.minUnits, limits.maxUnits)).replace(/,/g, ""));
  };
  const highestPx = ((10_000n - 1n) / limits.tickPx) * limits.tickPx;
  const stepPrice = (direction: 1n | -1n) => {
    const current = limitPx ?? ask ?? limits.tickPx;
    const onTick = direction > 0n ? (current / limits.tickPx) * limits.tickPx : ((current + limits.tickPx - 1n) / limits.tickPx) * limits.tickPx;
    setTypedPrice(dollarsText(clamp(onTick + direction * limits.tickPx, limits.tickPx, highestPx)));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || quote.errors.length > 0 || units === null || limitPx === null) return;
    onSubmit({ side, units, limitPx, maxFeeMicros: quote.maxFeeMicros, holdMicros: quote.holdMicros });
  };

  const amount = (micros: bigint) => (fieldsValid ? formatDollars(micros) : "–");
  const detail = (which: SideName) => {
    const px = askPx(market, which);
    return px === null ? "–" : formatCents(px);
  };

  return (
    <form className={styles.ticket} onSubmit={submit} noValidate aria-label="Order ticket" data-testid="ticket">
      <div className={styles.head}>
        <h2 className={styles.heading}>Buy</h2>
        <p className={styles.balance}>
          {balances ? (
            <>
              <span className={styles.balanceValue}>{formatDollars(balances.stableMicros)}</span> test dollars
            </>
          ) : (
            "test dollars"
          )}
        </p>
      </div>

      <SideToggle
        value={side}
        onChange={(next) => {
          setSide(next);
          setTypedPrice(null);
        }}
        label="Outcome to buy"
        detail={{ YES: detail("YES"), NO: detail("NO") }}
        disabled={off}
      />

      <Field
        label="Quantity"
        numeric
        suffix="contracts"
        value={quantity}
        onChange={setQuantity}
        onBlur={() => units !== null && setQuantity(formatContracts(units).replace(/,/g, ""))}
        error={closed ? undefined : errorFor("quantity")?.message}
        disabled={off}
        stepper={{
          onDecrement: () => stepQuantity(-1n),
          onIncrement: () => stepQuantity(1n),
          canDecrement: units === null || units > limits.minUnits,
          canIncrement: units === null || limits.maxUnits === null || units < limits.maxUnits,
        }}
      />

      <Field
        label="Limit price"
        numeric
        prefix="$"
        value={price}
        placeholder="0.00"
        onChange={setTypedPrice}
        error={closed ? undefined : errorFor("price")?.message}
        warning={priceWarning}
        helper={priceHelper ?? "The most you pay per contract."}
        disabled={off}
        stepper={{
          onDecrement: () => stepPrice(-1n),
          onIncrement: () => stepPrice(1n),
          canDecrement: limitPx === null || limitPx > limits.tickPx,
          canIncrement: limitPx === null || limitPx < highestPx,
        }}
      />

      <div className={styles.summary}>
        <dl className={styles.lines}>
          <ReceiptLine label="Cost at limit">{amount(quote.costMicros)}</ReceiptLine>
          <ReceiptLine label="Fee cap">{amount(quote.maxFeeMicros)}</ReceiptLine>
          <ReceiptLine label="Total hold" total>
            {amount(quote.holdMicros)}
          </ReceiptLine>
          <ReceiptLine label={`Pays if ${side}`}>{amount(quote.payoutMicros)}</ReceiptLine>
        </dl>
        <p className={styles.note}>Unused hold is refunded when the order fills.</p>
      </div>

      {error && (
        <Notice tone="negative" title="The order was not placed">
          {error}
        </Notice>
      )}

      <Button type="submit" variant="primary" block disabled={quote.errors.length > 0} busy={progress === "wallet" ? "Check your wallet" : progress === "sending" ? "Sending" : false}>
        {fieldsValid && !closed ? `Place order · hold ${formatDollars(quote.holdMicros)}` : "Place order"}
      </Button>

      {blocker && (
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
      )}
      {fundsNote && (
        <p className={styles.reason} role="status">
          {fundsNote}
        </p>
      )}
    </form>
  );
}
