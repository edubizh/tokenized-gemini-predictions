use anchor_lang::{
    prelude::*,
    system_program::{self, Transfer},
};
use anchor_spl::token_interface::{
    token_metadata_initialize, Mint, Token2022, TokenMetadataInitialize,
};

use crate::{constants::*, error::ErrorCode, state::SpikeMarket};

#[derive(Accounts)]
#[instruction(side: u8)]
pub struct SpikeCreateMint<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [MARKET_SEED, market.symbol_hash.as_ref()], bump = market.bump)]
    pub market: Account<'info, SpikeMarket>,
    /// Token-2022 mint whose metadata lives on the mint account itself. No freeze authority.
    #[account(
        init,
        payer = payer,
        seeds = [MINT_SEED, market.key().as_ref(), &side.to_le_bytes()],
        bump,
        mint::decimals = OUTCOME_DECIMALS,
        mint::authority = market,
        mint::token_program = token_program,
        extensions::metadata_pointer::authority = market,
        extensions::metadata_pointer::metadata_address = mint
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handle_spike_create_mint(
    ctx: Context<SpikeCreateMint>,
    side: u8,
    name: String,
    symbol: String,
    uri: String,
) -> Result<()> {
    require!(side <= 1, ErrorCode::InvalidSide);

    let market = &ctx.accounts.market;
    let signer_seeds: &[&[&[u8]]] = &[&[MARKET_SEED, market.symbol_hash.as_ref(), &[market.bump]]];

    // The mint authority must sign; the token program appends the metadata to the mint.
    token_metadata_initialize(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TokenMetadataInitialize {
                program_id: ctx.accounts.token_program.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                metadata: ctx.accounts.mint.to_account_info(),
                mint_authority: market.to_account_info(),
                update_authority: market.to_account_info(),
            },
            signer_seeds,
        ),
        name,
        symbol,
        uri,
    )?;

    // The mint grew during the call above. Pay only the rent that is now missing.
    let mint = ctx.accounts.mint.to_account_info();
    let shortfall = Rent::get()?
        .minimum_balance(mint.data_len())
        .saturating_sub(mint.lamports());
    if shortfall > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: mint,
                },
            ),
            shortfall,
        )?;
    }
    Ok(())
}
