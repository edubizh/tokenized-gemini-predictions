// Decoded program accounts to the plain shapes of `chain.ts`.

import { getAddressEncoder, type Address } from "@solana/kit";
import { PAUSE_FILL, PAUSE_PLACE, type Config, type Market, type Order } from "@outcome/program-client";
import type { ChainConfig, ChainMarket, ChainOrder } from "./chain.ts";

/** `Pubkey::default()`: what a market stores for a mint that has not been created. */
const DEFAULT_ADDRESS = "11111111111111111111111111111111";

const SIDES = ["YES", "NO"] as const;
const KINDS = ["buy", "sell"] as const;
const STATUSES = ["open", "halted", "settled"] as const;

export function toChainOrder(address: Address, order: Order, symbol: string): ChainOrder {
  const side = SIDES[order.side];
  if (side === undefined) throw new Error(`unknown order side: ${order.side}`);
  const kind = KINDS[order.kind];
  if (kind === undefined) throw new Error(`unknown order kind: ${order.kind}`);
  return {
    address,
    addressBytes: new Uint8Array(getAddressEncoder().encode(address)),
    user: order.user,
    symbol,
    side,
    kind,
    units: order.qtyUnits,
    limitPx: BigInt(order.limitPx),
    maxFeeMicros: order.maxFee,
    expiresAt: Number(order.expiresAt),
  };
}

/** `supplies` are the current supplies of the two outcome mints (zero for a missing mint). */
export function toChainMarket(address: Address, market: Market, supplies: { yes: bigint; no: bigint }): ChainMarket {
  const status = STATUSES[market.status];
  if (status === undefined) throw new Error(`unknown market status: ${market.status}`);
  const settled = status === "settled";
  return {
    address,
    symbol: market.symbol,
    yesMint: market.yesMint === DEFAULT_ADDRESS ? null : market.yesMint,
    noMint: market.noMint === DEFAULT_ADDRESS ? null : market.noMint,
    status,
    closeTs: Number(market.closeTs),
    placeCutoffSecs: market.placeCutoffSecs,
    tickPx: BigInt(market.tickPx),
    maxSupplyUnits: market.maxSupplyUnits,
    yesSupply: supplies.yes,
    noSupply: supplies.no,
    yesPayout: settled ? market.yesPayout : null,
    noPayout: settled ? market.noPayout : null,
    redeemAfter: market.redeemAfter === 0n ? null : Number(market.redeemAfter),
  };
}

export function toChainConfig(config: Config): ChainConfig {
  return {
    admin: config.admin,
    relayer: config.relayer,
    settler: config.settler,
    registrar: config.registrar,
    stableMint: config.stableMint,
    treasury: config.treasury,
    orderTtlSecs: config.orderTtlSecs,
    minOrderUnits: config.minOrderUnits,
    maxOrderUnits: config.maxOrderUnits,
    settleDelaySecs: config.settleDelaySecs,
    pausePlace: (config.pauseFlags & PAUSE_PLACE) !== 0,
    pauseFill: (config.pauseFlags & PAUSE_FILL) !== 0,
  };
}
