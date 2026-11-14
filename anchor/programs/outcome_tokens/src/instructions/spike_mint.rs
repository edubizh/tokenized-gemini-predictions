use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, MintTo, Token2022, TokenAccount};

use crate::{constants::*, error::ErrorCode, state::SpikeMarket};

#[derive(Accounts)]
pub struct SpikeMint<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [MARKET_SEED, market.symbol_hash.as_ref()], bump = market.bump)]
    pub market: Account<'info, SpikeMarket>,
    #[account(mut, mint::authority = market, mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// The user's associated token account under the Token-2022 program.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = user,
        associated_token::token_program = token_program
    )]
    pub user_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token2022>,
}

pub fn handle_spike_mint(ctx: Context<SpikeMint>, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::ZeroAmount);

    let market = &ctx.accounts.market;
    let signer_seeds: &[&[&[u8]]] = &[&[MARKET_SEED, market.symbol_hash.as_ref(), &[market.bump]]];

    token_interface::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.user_token.to_account_info(),
                authority: market.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )
}
