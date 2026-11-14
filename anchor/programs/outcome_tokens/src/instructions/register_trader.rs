use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ErrorCode,
    events::TraderRegistered,
    state::{Config, Trader},
};

#[derive(Accounts)]
pub struct RegisterTrader<'info> {
    pub registrar: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = registrar @ ErrorCode::Unauthorized
    )]
    pub config: Account<'info, Config>,
    /// CHECK: Any address. Only the key is used, as a seed and as the stored user.
    pub user: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Trader::INIT_SPACE,
        seeds = [TRADER_SEED, user.key().as_ref()],
        bump
    )]
    pub trader: Account<'info, Trader>,
    pub system_program: Program<'info, System>,
}

pub fn handle_register_trader(ctx: Context<RegisterTrader>) -> Result<()> {
    let user = ctx.accounts.user.key();
    ctx.accounts.trader.set_inner(Trader {
        user,
        next_nonce: 0,
        bump: ctx.bumps.trader,
        reserved: [0; 32],
    });

    emit!(TraderRegistered { user });
    Ok(())
}
