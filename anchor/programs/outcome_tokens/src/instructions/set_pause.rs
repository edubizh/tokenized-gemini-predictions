use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, events::ConfigChanged, state::Config};

#[derive(Accounts)]
pub struct SetPause<'info> {
    /// The admin or the relayer.
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = authority.key() == config.admin || authority.key() == config.relayer
            @ ErrorCode::Unauthorized
    )]
    pub config: Account<'info, Config>,
}

pub fn handle_set_pause(ctx: Context<SetPause>, flags: u8) -> Result<()> {
    require!(
        flags & !(PAUSE_PLACE | PAUSE_FILL) == 0,
        ErrorCode::BadConfig
    );
    let config = &mut ctx.accounts.config;
    // The relayer can stop activity but only the admin can resume it.
    let is_admin = ctx.accounts.authority.key() == config.admin;
    require!(
        is_admin || flags & config.pause_flags == config.pause_flags,
        ErrorCode::Unauthorized
    );
    config.pause_flags = flags;

    emit!(ConfigChanged {});
    Ok(())
}
