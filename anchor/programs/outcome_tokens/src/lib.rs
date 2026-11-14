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

    pub fn place_buy(
        ctx: Context<PlaceBuy>,
        side: Side,
        qty_units: u64,
        limit_px: u16,
        max_fee: u64,
    ) -> Result<()> {
        handle_place_buy(ctx, side, qty_units, limit_px, max_fee)
    }

    pub fn fill_buy(ctx: Context<FillBuy>, fill_qty: u64, cost: u64, fee: u64) -> Result<()> {
        handle_fill_buy(ctx, fill_qty, cost, fee)
    }

    pub fn place_sell(
        ctx: Context<PlaceSell>,
        side: Side,
        qty_units: u64,
        min_px: u16,
        max_fee: u64,
    ) -> Result<()> {
        handle_place_sell(ctx, side, qty_units, min_px, max_fee)
    }

    pub fn fill_sell(ctx: Context<FillSell>, fill_qty: u64, proceeds: u64, fee: u64) -> Result<()> {
        handle_fill_sell(ctx, fill_qty, proceeds, fee)
    }

    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        handle_cancel_order(ctx)
    }

    pub fn settle_market(
        ctx: Context<SettleMarket>,
        yes_payout: u64,
        no_payout: u64,
    ) -> Result<()> {
        handle_settle_market(ctx, yes_payout, no_payout)
    }

    pub fn revoke_settlement(ctx: Context<RevokeSettlement>) -> Result<()> {
        handle_revoke_settlement(ctx)
    }

    pub fn redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
        handle_redeem(ctx, amount)
    }
}
