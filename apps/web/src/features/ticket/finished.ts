// Tells when an order of the wallet has just finished, which is when its balances and tokens
// have changed and are worth reading again at once. Pure.

export interface OrdersInProgress {
  /** Addresses of the order accounts that exist on Solana. */
  open: readonly string[];
  /** Addresses of the orders the relayer is still working on. */
  working: readonly string[];
}

/** The orders that were open or in progress at the previous look and no longer are. */
export function finishedOrders(previous: OrdersInProgress | null, next: OrdersInProgress): string[] {
  if (previous === null) return [];
  const open = new Set(next.open);
  const working = new Set(next.working);
  return [...new Set([...previous.open.filter((address) => !open.has(address)), ...previous.working.filter((address) => !working.has(address))])];
}
