// Reads the program's Anchor events back out of transaction logs.

import { getBase64Encoder, type Address } from "@solana/kit";
import {
  getOrderCancelledEventDecoder,
  getOrderFilledEventDecoder,
  identifyOutcomeTokensEvent,
  OutcomeTokensEvent,
  type OrderCancelledEvent,
  type OrderFilledEvent,
} from "@outcome/program-client";

/** One event of the program: its name in the generated client and its raw bytes. */
export interface ProgramEvent {
  name: string;
  bytes: Uint8Array;
}

/** What closed an order account. */
export type OrderClosure = { kind: "filled"; event: OrderFilledEvent } | { kind: "cancelled"; event: OrderCancelledEvent };

// The runtime's own call lines name a program by address. Program output is always prefixed
// ("Program log: ", "Program data: "), which is not an address, so it cannot imitate them.
const PROGRAM_ADDRESS = "[1-9A-HJ-NP-Za-km-z]{32,44}";
const INVOKE = new RegExp(`^Program (${PROGRAM_ADDRESS}) invoke \\[\\d+\\]$`);
const RETURN = new RegExp(`^Program ${PROGRAM_ADDRESS} (?:success|failed: .*)$`);
const DATA_PREFIX = "Program data: ";

/**
 * Events the program emitted, in log order. The call stack is rebuilt from the `invoke` and
 * `success`/`failed` lines, and a `Program data:` line counts only while the program itself is
 * executing: any other program can log identical bytes, in its own transaction or in a nested
 * call. Data that is not one of the program's events is skipped.
 */
export function programEvents(logs: readonly string[], programId: Address): ProgramEvent[] {
  const events: ProgramEvent[] = [];
  const stack: string[] = [];
  for (const line of logs) {
    const invoked = INVOKE.exec(line);
    if (invoked !== null) {
      stack.push(invoked[1]!);
      continue;
    }
    if (RETURN.test(line)) {
      stack.pop();
      continue;
    }
    if (!line.startsWith(DATA_PREFIX) || stack.at(-1) !== programId) continue;
    try {
      const bytes = new Uint8Array(getBase64Encoder().encode(line.slice(DATA_PREFIX.length)));
      events.push({ name: OutcomeTokensEvent[identifyOutcomeTokensEvent(bytes)], bytes });
    } catch {
      // Not base64, or not an event of this program.
    }
  }
  return events;
}

/** The fill or cancel of `order` in the logs of one transaction, or null when there is none. */
export function orderClosure(logs: readonly string[], programId: Address, order: Address): OrderClosure | null {
  for (const { name, bytes } of programEvents(logs, programId)) {
    try {
      if (name === "OrderFilled") {
        const event = getOrderFilledEventDecoder().decode(bytes);
        if (event.order === order) return { kind: "filled", event };
      } else if (name === "OrderCancelled") {
        const event = getOrderCancelledEventDecoder().decode(bytes);
        if (event.order === order) return { kind: "cancelled", event };
      }
    } catch {
      // Truncated event data: not a usable record.
    }
  }
  return null;
}
