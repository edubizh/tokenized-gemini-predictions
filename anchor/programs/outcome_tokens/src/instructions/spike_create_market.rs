use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, program::OutcomeTokens, state::SpikeMarket};

#[derive(Accounts)]
#[instruction(symbol_hash: [u8; 32])]
pub struct SpikeCreateMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + SpikeMarket::INIT_SPACE,
        seeds = [MARKET_SEED, symbol_hash.as_ref()],
        bump
    )]
    pub market: Account<'info, SpikeMarket>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ ErrorCode::NotUpgradeAuthority
    )]
    pub program: Program<'info, OutcomeTokens>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ ErrorCode::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn handle_spike_create_market(
    ctx: Context<SpikeCreateMarket>,
    symbol_hash: [u8; 32],
    symbol: String,
) -> Result<()> {
    require!(
        solana_sha256_hasher::hash(symbol.as_bytes()).to_bytes() == symbol_hash,
        ErrorCode::SymbolHashMismatch
    );

    let market = &mut ctx.accounts.market;
    market.symbol_hash = symbol_hash;
    market.bump = ctx.bumps.market;
    Ok(())
}
