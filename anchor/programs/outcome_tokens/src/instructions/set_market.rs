use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ErrorCode,
    events::MarketStatusChanged,
    state::{Config, Market, MarketStatus},
};

#[derive(Accounts)]
pub struct SetMarket<'info> {
    /// The relayer or the admin.
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = authority.key() == config.admin || authority.key() == config.relayer
            @ ErrorCode::Unauthorized
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [MARKET_SEED, market.symbol_hash.as_ref()],
        bump = market.bump
    )]
    pub market: Box<Account<'info, Market>>,
}

pub fn handle_set_market(
    ctx: Context<SetMarket>,
    status: Option<MarketStatus>,
    close_ts: Option<i64>,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    require!(
        market.status != MarketStatus::Settled as u8,
        ErrorCode::AlreadySettled
    );
    if let Some(status) = status {
        match status {
            // The relayer can stop a market but only the admin can resume it.
            MarketStatus::Open => require_keys_eq!(
                ctx.accounts.authority.key(),
                ctx.accounts.config.admin,
                ErrorCode::Unauthorized
            ),
            MarketStatus::Halted => {}
            // Settlement has its own instruction, which funds the redemption vault.
            MarketStatus::Settled => return err!(ErrorCode::BadConfig),
        }
        market.status = status as u8;
    }
    if let Some(close_ts) = close_ts {
        market.close_ts = close_ts;
    }

    emit!(MarketStatusChanged {
        market: market.key(),
        status: market.status,
        close_ts: market.close_ts,
    });
    Ok(())
}
