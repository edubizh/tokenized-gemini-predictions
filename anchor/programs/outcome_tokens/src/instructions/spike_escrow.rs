use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{constants::*, error::ErrorCode, state::SpikeOrder};

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct SpikeEscrow<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init,
        payer = user,
        space = 8 + SpikeOrder::INIT_SPACE,
        seeds = [ORDER_SEED, user.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub order: Account<'info, SpikeOrder>,
    /// Classic SPL Token account owned by the order.
    #[account(
        init,
        payer = user,
        seeds = [ESCROW_SEED, order.key().as_ref()],
        bump,
        token::mint = stable_mint,
        token::authority = order,
        token::token_program = token_program
    )]
    pub escrow: Account<'info, TokenAccount>,
    pub stable_mint: Account<'info, Mint>,
    #[account(mut, token::mint = stable_mint, token::authority = user)]
    pub user_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_spike_escrow(
    ctx: Context<SpikeEscrow>,
    nonce: u64,
    amount: u64,
    ttl_secs: i64,
) -> Result<()> {
    require!(amount > 0, ErrorCode::ZeroAmount);
    require!(ttl_secs > 0, ErrorCode::InvalidTtl);

    let now = Clock::get()?.unix_timestamp;
    let order = &mut ctx.accounts.order;
    order.user = ctx.accounts.user.key();
    order.nonce = nonce;
    order.expires_at = now.checked_add(ttl_secs).ok_or(ErrorCode::Overflow)?;
    order.bump = ctx.bumps.order;

    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.user_token.to_account_info(),
                mint: ctx.accounts.stable_mint.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.stable_mint.decimals,
    )
}
