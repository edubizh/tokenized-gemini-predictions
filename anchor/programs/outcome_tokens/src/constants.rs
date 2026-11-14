use anchor_lang::prelude::*;

#[constant]
pub const MARKET_SEED: &[u8] = b"market";

#[constant]
pub const MINT_SEED: &[u8] = b"mint";

#[constant]
pub const ORDER_SEED: &[u8] = b"order";

#[constant]
pub const ESCROW_SEED: &[u8] = b"escrow";

/// Outcome tokens have two decimals: one base unit is 0.01 contract.
#[constant]
pub const OUTCOME_DECIMALS: u8 = 2;
