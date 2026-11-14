use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

use crate::{constants::*, error::ErrorCode, state::SpikeOrder};

#[derive(Accounts)]
pub struct SpikeRelease<'info> {
    /// Anyone may release an expired order.
    pub caller: Signer<'info>,
    /// CHECK: Pinned to `order.user` by `has_one`. Receives the rent of the closed accounts.
    #[account(mut)]
    pub user: UncheckedAccount<'info>,
    #[account(
        mut,
        close = user,
        has_one = user,
        seeds = [ORDER_SEED, order.user.as_ref(), &order.nonce.to_le_bytes()],
        bump = order.bump
    )]
    pub order: Account<'info, SpikeOrder>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, order.key().as_ref()],
        bump,
        token::mint = stable_mint,
        token::authority = order
    )]
    pub escrow: Account<'info, TokenAccount>,
    pub stable_mint: Account<'info, Mint>,
    /// Any token account of the escrowed mint that the order's user owns.
    #[account(mut, token::mint = stable_mint, token::authority = user)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_spike_release(ctx: Context<SpikeRelease>) -> Result<()> {
    let order = &ctx.accounts.order;
    require!(
        Clock::get()?.unix_timestamp > order.expires_at,
        ErrorCode::NotExpired
    );

    let nonce = order.nonce.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[ORDER_SEED, order.user.as_ref(), &nonce, &[order.bump]]];

    // Sweep what the escrow holds now, so a donated balance cannot block the close.
    let amount = ctx.accounts.escrow.amount;
    if amount > 0 {
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.escrow.to_account_info(),
                    mint: ctx.accounts.stable_mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: order.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.stable_mint.decimals,
        )?;
    }

    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.escrow.to_account_info(),
            destination: ctx.accounts.user.to_account_info(),
            authority: order.to_account_info(),
        },
        signer_seeds,
    ))
}
