use anchor_lang::prelude::*;

// Items marked `#[constant]` are written to the IDL, so the generated client carries the
// same values. The `usize` limits and the mint list have no IDL representation.

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

#[constant]
pub const TRADER_SEED: &[u8] = b"trader";

#[constant]
pub const MARKET_SEED: &[u8] = b"market";

#[constant]
pub const MINT_SEED: &[u8] = b"mint";

#[constant]
pub const ORDER_SEED: &[u8] = b"order";

#[constant]
pub const ESCROW_SEED: &[u8] = b"escrow";

#[constant]
pub const REDEEM_SEED: &[u8] = b"redeem";

/// Outcome tokens have two decimals: one unit is 0.01 contract.
#[constant]
pub const OUTCOME_DECIMALS: u8 = 2;

/// The stablecoin is a classic SPL Token mint with six decimals: one base unit is one
/// micro-dollar.
#[constant]
pub const STABLE_DECIMALS: u8 = 6;

/// Prices are micro-dollars per unit, from 1 to this value.
#[constant]
pub const PX_MAX: u16 = 9_999;

/// `yes_payout + no_payout` of a settled market, in micro-dollars per unit.
#[constant]
pub const PAYOUT_TOTAL: u64 = 10_000;

/// Venue instrument symbol, characters `A-Z`, `0-9` and `-`.
pub const MAX_SYMBOL_LEN: usize = 64;

/// Token metadata name.
pub const MAX_NAME_LEN: usize = 32;

/// Token metadata symbol.
pub const MAX_TICKER_LEN: usize = 10;

/// Token metadata uri, which may be empty.
pub const MAX_URI_LEN: usize = 200;

#[constant]
pub const TTL_MIN_SECS: u32 = 30;

#[constant]
pub const TTL_MAX_SECS: u32 = 900;

/// Shortest allowed gap between the last order placement and a market's close time.
#[constant]
pub const CUTOFF_MIN_SECS: u32 = 30;

/// Pause bit: no new orders.
#[constant]
pub const PAUSE_PLACE: u8 = 1;

/// Pause bit: no fills.
#[constant]
pub const PAUSE_FILL: u8 = 2;

/// An order's fee cap may not exceed `qty_units * MAX_FEE_PER_UNIT + MAX_FEE_BASE`.
#[constant]
pub const MAX_FEE_PER_UNIT: u64 = 200;

#[constant]
pub const MAX_FEE_BASE: u64 = 50_000;

/// Mainnet USDC, USDT and PYUSD. This build handles test funds only, so it refuses to be
/// configured with a real stablecoin.
pub const FORBIDDEN_STABLE_MINTS: [Pubkey; 3] = [
    pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    pubkey!("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
    pubkey!("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"),
];
