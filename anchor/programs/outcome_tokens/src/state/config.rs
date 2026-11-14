use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode};

/// Program-wide settings and roles. PDA `["config"]`.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// The program's upgrade authority at `initialize`. Cannot be changed.
    pub admin: Pubkey,
    /// Fills and cancels orders, creates markets.
    pub relayer: Pubkey,
    /// Settles markets.
    pub settler: Pubkey,
    /// Registers traders after login.
    pub registrar: Pubkey,
    /// Cannot be changed after `initialize`.
    pub stable_mint: Pubkey,
    /// Stable token account that receives `cost + fee` on buys and revoked settlement
    /// funds.
    pub treasury: Pubkey,
    pub order_ttl_secs: u32,
    /// Applies to buys.
    pub min_order_units: u64,
    /// Applies to buys and sells.
    pub max_order_units: u64,
    /// Redemption opens this long after `settle_market`.
    pub settle_delay_secs: u32,
    /// Bits `PAUSE_PLACE` and `PAUSE_FILL`.
    pub pause_flags: u8,
    pub bump: u8,
    pub reserved: [u8; 64],
}

impl Config {
    /// Range rules of the settings, checked whenever they are written.
    pub fn validate(&self) -> Result<()> {
        require!(
            (TTL_MIN_SECS..=TTL_MAX_SECS).contains(&self.order_ttl_secs),
            ErrorCode::BadConfig
        );
        require!(self.min_order_units >= 1, ErrorCode::BadConfig);
        require!(
            self.max_order_units >= self.min_order_units,
            ErrorCode::BadConfig
        );
        Ok(())
    }
}
