use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::{constants::*, error::ErrorCode, events::ConfigChanged, state::Config};

/// Every field is optional: `None` keeps the current value.
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SetConfigArgs {
    pub relayer: Option<Pubkey>,
    pub settler: Option<Pubkey>,
    pub registrar: Option<Pubkey>,
    pub order_ttl_secs: Option<u32>,
    pub min_order_units: Option<u64>,
    pub max_order_units: Option<u64>,
    pub settle_delay_secs: Option<u32>,
}

#[derive(Accounts)]
pub struct SetConfig<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ErrorCode::Unauthorized
    )]
    pub config: Account<'info, Config>,
    /// When present, replaces `config.treasury`.
    #[account(
        token::mint = config.stable_mint,
        token::token_program = token_program
    )]
    pub new_treasury: Option<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_set_config(ctx: Context<SetConfig>, args: SetConfigArgs) -> Result<()> {
    let config = &mut ctx.accounts.config;
    if let Some(relayer) = args.relayer {
        config.relayer = relayer;
    }
    if let Some(settler) = args.settler {
        config.settler = settler;
    }
    if let Some(registrar) = args.registrar {
        config.registrar = registrar;
    }
    if let Some(order_ttl_secs) = args.order_ttl_secs {
        config.order_ttl_secs = order_ttl_secs;
    }
    if let Some(min_order_units) = args.min_order_units {
        config.min_order_units = min_order_units;
    }
    if let Some(max_order_units) = args.max_order_units {
        config.max_order_units = max_order_units;
    }
    if let Some(settle_delay_secs) = args.settle_delay_secs {
        config.settle_delay_secs = settle_delay_secs;
    }
    if let Some(new_treasury) = &ctx.accounts.new_treasury {
        config.treasury = new_treasury.key();
    }
    // The limits are checked together, so two of them can move in one call.
    config.validate()?;

    emit!(ConfigChanged {});
    Ok(())
}
