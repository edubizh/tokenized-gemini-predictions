use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use super::escrow::refund_and_close_escrow;
use crate::{
    constants::*,
    error::ErrorCode,
    events::OrderCancelled,
    state::{Config, Market, MarketStatus, Order},
};

/// Serves buy orders (stable escrow, classic Token program) and sell orders (outcome
/// escrow, Token-2022 program) alike: the escrow decides the mint and the token program.
#[derive(Accounts)]
pub struct CancelOrder<'info> {
    /// Anyone. What the caller may cancel depends on who it is and on the time.
    pub caller: Signer<'info>,
    // Pause flags never block a cancel: funds must always be able to leave an escrow.
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [MARKET_SEED, market.symbol_hash.as_ref()],
        bump = market.bump
    )]
    pub market: Box<Account<'info, Market>>,
    // The permission rule reads the market's status, so it has to be the order's market.
    #[account(
        mut,
        close = rent_payer,
        seeds = [ORDER_SEED, order.user.as_ref(), &order.nonce.to_le_bytes()],
        bump = order.bump,
        has_one = rent_payer,
        constraint = order.market == market.key() @ ErrorCode::WrongMarket
    )]
    pub order: Box<Account<'info, Order>>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, order.key().as_ref()],
        bump,
        token::mint = escrow_mint,
        token::authority = order,
        token::token_program = token_program
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = token_program)]
    pub escrow_mint: Box<InterfaceAccount<'info, Mint>>,
    /// Any token account of the order's user for the escrowed mint; it need not be the
    /// associated one.
    #[account(
        mut,
        token::mint = escrow_mint,
        token::token_program = token_program,
        constraint = user_token.owner == order.user @ ErrorCode::WrongOwner
    )]
    pub user_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Pinned to `order.rent_payer` by `has_one`. Receives the rent of the order and
    /// its escrow.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    /// The program that owns the escrow.
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
    let accounts = ctx.accounts;
    let order = &accounts.order;
    let caller = accounts.caller.key();

    // The relayer cancels once the venue order is dead. After the expiry no fill can
    // happen, so anyone may send the funds back. Before it the user may leave only while
    // fills are impossible anyway; otherwise a cancel could race a fill the venue has
    // already executed.
    let fills_stopped = accounts.market.status == MarketStatus::Settled as u8
        || accounts.config.pause_flags & PAUSE_FILL != 0;
    require!(
        caller == accounts.config.relayer
            || Clock::get()?.unix_timestamp > order.expires_at
            || (caller == order.user && fills_stopped),
        ErrorCode::OrderNotExpired
    );

    refund_and_close_escrow(
        order,
        &mut accounts.escrow,
        &accounts.escrow_mint,
        &accounts.user_token,
        &accounts.rent_payer,
        accounts.token_program.key(),
    )?;

    emit!(OrderCancelled {
        order: order.key(),
        user: order.user,
        market: order.market,
        by: caller,
    });
    Ok(())
}
