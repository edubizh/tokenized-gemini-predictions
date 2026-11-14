use anchor_lang::prelude::*;

use crate::constants::MAX_SYMBOL_LEN;

/// Outcome of a market. Accounts and events store it as its number.
// Borsh writes the variant index, which the explicit numbers must keep matching; Anchor's
// IDL builder accepts no other encoding.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[borsh(use_discriminant = false)]
pub enum Side {
    Yes = 0,
    No = 1,
}

/// Lifecycle of a market. Accounts and events store it as its number.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[borsh(use_discriminant = false)]
pub enum MarketStatus {
    Open = 0,
    /// No new orders; fills and cancels continue.
    Halted = 1,
    Settled = 2,
}

/// One venue instrument. PDA `["market", symbol_hash]`.
///
/// The market account is the mint authority of both outcome mints, the authority over
/// their metadata, and the authority of the redemption vault.
#[account]
#[derive(InitSpace)]
pub struct Market {
    /// sha256 of the `symbol` bytes.
    pub symbol_hash: [u8; 32],
    #[max_len(MAX_SYMBOL_LEN)]
    pub symbol: String,
    /// `Pubkey::default()` until created.
    pub yes_mint: Pubkey,
    /// `Pubkey::default()` until created.
    pub no_mint: Pubkey,
    /// A `MarketStatus`.
    pub status: u8,
    /// Venue expiry. Advisory: the relayer may update it.
    pub close_ts: i64,
    /// No new orders within this many seconds of `close_ts`.
    pub place_cutoff_secs: u32,
    /// Order prices must be multiples of this.
    pub tick_px: u16,
    /// Supply cap of each outcome mint.
    pub max_supply_units: u64,
    /// Micro-dollars per unit, set at settlement.
    pub yes_payout: u64,
    /// Micro-dollars per unit, set at settlement.
    pub no_payout: u64,
    /// Redemption opens at this time. Zero until settled.
    pub redeem_after: i64,
    pub bump: u8,
    pub reserved: [u8; 64],
}
