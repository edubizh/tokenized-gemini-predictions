use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    constants::*, error::ErrorCode, events::Initialized, program::OutcomeTokens, state::Config,
};

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitializeArgs {
    pub relayer: Pubkey,
    pub settler: Pubkey,
    pub registrar: Pubkey,
    pub order_ttl_secs: u32,
    pub min_order_units: u64,
    pub max_order_units: u64,
    pub settle_delay_secs: u32,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// The program's upgrade authority. Becomes the admin.
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(
        mint::decimals = STABLE_DECIMALS,
        mint::token_program = token_program,
        constraint = !FORBIDDEN_STABLE_MINTS.contains(&stable_mint.key())
            @ ErrorCode::RealStablecoinNotAllowed
    )]
    pub stable_mint: Account<'info, Mint>,
    #[account(token::mint = stable_mint, token::token_program = token_program)]
    pub treasury: Account<'info, TokenAccount>,
    // Two links make the gate: this program names its ProgramData account, and that
    // account names the upgrade authority. Without the first, the ProgramData of any
    // program the caller controls would pass.
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ ErrorCode::Unauthorized
    )]
    pub program: Program<'info, OutcomeTokens>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ ErrorCode::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
    let config = Config {
        admin: ctx.accounts.authority.key(),
        relayer: args.relayer,
        settler: args.settler,
        registrar: args.registrar,
        stable_mint: ctx.accounts.stable_mint.key(),
        treasury: ctx.accounts.treasury.key(),
        order_ttl_secs: args.order_ttl_secs,
        min_order_units: args.min_order_units,
        max_order_units: args.max_order_units,
        settle_delay_secs: args.settle_delay_secs,
        pause_flags: 0,
        bump: ctx.bumps.config,
        reserved: [0; 64],
    };
    config.validate()?;
    ctx.accounts.config.set_inner(config);

    emit!(Initialized {});
    Ok(())
}
