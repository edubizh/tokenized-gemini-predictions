pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("8TN1HWcEFTAcM7Vthmih1FKftTBrp3LDgTBkfhp1PRVn");

#[program]
pub mod outcome_tokens {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        handle_initialize(ctx, args)
    }

    pub fn set_config(ctx: Context<SetConfig>, args: SetConfigArgs) -> Result<()> {
        handle_set_config(ctx, args)
    }

    pub fn set_pause(ctx: Context<SetPause>, flags: u8) -> Result<()> {
        handle_set_pause(ctx, flags)
    }

    pub fn register_trader(ctx: Context<RegisterTrader>) -> Result<()> {
        handle_register_trader(ctx)
    }

    pub fn create_market(
        ctx: Context<CreateMarket>,
        symbol_hash: [u8; 32],
        symbol: String,
        close_ts: i64,
        place_cutoff_secs: u32,
        tick_px: u16,
        max_supply_units: u64,
    ) -> Result<()> {
        handle_create_market(
            ctx,
            symbol_hash,
            symbol,
            close_ts,
            place_cutoff_secs,
            tick_px,
            max_supply_units,
        )
    }

    pub fn create_outcome_mint(
        ctx: Context<CreateOutcomeMint>,
        side: Side,
        name: String,
        ticker: String,
        uri: String,
    ) -> Result<()> {
        handle_create_outcome_mint(ctx, side, name, ticker, uri)
    }

    pub fn set_market(
        ctx: Context<SetMarket>,
        status: Option<MarketStatus>,
        close_ts: Option<i64>,
    ) -> Result<()> {
        handle_set_market(ctx, status, close_ts)
    }
}
