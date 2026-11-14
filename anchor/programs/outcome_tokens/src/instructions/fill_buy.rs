use anchor_lang::prelude::*;
use anchor_spl::{
    token::Token,
    token_interface::{self, Mint, MintTo, Token2022, TokenAccount},
};

use super::escrow::{refund_and_close_escrow, transfer_from_escrow};
use crate::{
    constants::*,
    error::ErrorCode,
    events::OrderFilled,
    state::{Config, Market, MarketStatus, Order, OrderKind},
};

#[derive(Accounts)]
pub struct FillBuy<'info> {
    pub relayer: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = relayer @ ErrorCode::Unauthorized,
        constraint = config.pause_flags & PAUSE_FILL == 0 @ ErrorCode::Paused
    )]
    pub config: Account<'info, Config>,
    // Fills continue on a halted market: the venue may still report fills of orders that
    // were placed before the halt.
    #[account(
        seeds = [MARKET_SEED, market.symbol_hash.as_ref()],
        bump = market.bump,
        constraint = market.status != MarketStatus::Settled as u8 @ ErrorCode::AlreadySettled
    )]
    pub market: Box<Account<'info, Market>>,
    // The kind is checked here, ahead of the escrow: a sell order's escrow holds another
    // mint under another token program and would otherwise fail with an unrelated error.
    #[account(
        mut,
        close = rent_payer,
        seeds = [ORDER_SEED, order.user.as_ref(), &order.nonce.to_le_bytes()],
        bump = order.bump,
        has_one = rent_payer,
        constraint = order.kind == OrderKind::Buy as u8 @ ErrorCode::WrongKind,
        constraint = order.market == market.key() @ ErrorCode::WrongMarket
    )]
    pub order: Box<Account<'info, Order>>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, order.key().as_ref()],
        bump,
        token::mint = stable_mint,
        token::authority = order,
        token::token_program = stable_token_program
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        address = market.mint(order.side()) @ ErrorCode::WrongMint,
        mint::token_program = outcome_token_program
    )]
    pub outcome_mint: Box<InterfaceAccount<'info, Mint>>,
    /// Any token account of the order's user for the outcome mint; it need not be the
    /// associated one.
    #[account(
        mut,
        token::mint = outcome_mint,
        token::token_program = outcome_token_program,
        constraint = user_outcome.owner == order.user @ ErrorCode::WrongOwner
    )]
    pub user_outcome: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Any stable token account of the order's user. Receives what the fill did not use.
    #[account(
        mut,
        token::mint = stable_mint,
        token::token_program = stable_token_program,
        constraint = user_stable.owner == order.user @ ErrorCode::WrongOwner
    )]
    pub user_stable: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        address = config.treasury,
        token::token_program = stable_token_program
    )]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Pinned to `order.rent_payer` by `has_one`. Receives the rent of the order and
    /// its escrow.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    #[account(
        address = config.stable_mint,
        mint::token_program = stable_token_program
    )]
    pub stable_mint: Box<InterfaceAccount<'info, Mint>>,
    pub stable_token_program: Program<'info, Token>,
    pub outcome_token_program: Program<'info, Token2022>,
}

pub fn handle_fill_buy(ctx: Context<FillBuy>, fill_qty: u64, cost: u64, fee: u64) -> Result<()> {
    let accounts = ctx.accounts;
    let order = &accounts.order;
    let market = &accounts.market;

    require!(
        Clock::get()?.unix_timestamp <= order.expires_at,
        ErrorCode::OrderExpired
    );
    require!(
        fill_qty > 0 && fill_qty <= order.qty_units,
        ErrorCode::FillExceedsOrder
    );
    // At least one micro-dollar per unit and at most the limit price.
    let max_cost = fill_qty
        .checked_mul(u64::from(order.limit_px))
        .ok_or(ErrorCode::MathOverflow)?;
    require!(
        (fill_qty..=max_cost).contains(&cost),
        ErrorCode::CostOutOfRange
    );
    require!(fee <= order.max_fee, ErrorCode::FeeExceedsCap);
    let supply = accounts
        .outcome_mint
        .supply
        .checked_add(fill_qty)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(
        supply <= market.max_supply_units,
        ErrorCode::SupplyCapExceeded
    );
    let payment = cost.checked_add(fee).ok_or(ErrorCode::MathOverflow)?;

    let market_seeds: &[&[&[u8]]] = &[&[MARKET_SEED, market.symbol_hash.as_ref(), &[market.bump]]];
    token_interface::mint_to(
        CpiContext::new_with_signer(
            accounts.outcome_token_program.key(),
            MintTo {
                mint: accounts.outcome_mint.to_account_info(),
                to: accounts.user_outcome.to_account_info(),
                authority: market.to_account_info(),
            },
            market_seeds,
        ),
        fill_qty,
    )?;

    let stable_token_program = accounts.stable_token_program.key();
    transfer_from_escrow(
        order,
        &accounts.escrow,
        &accounts.stable_mint,
        &accounts.treasury,
        stable_token_program,
        payment,
    )?;
    // Whatever is left: the unfilled quantity, the price improvement and the unused part
    // of the fee cap.
    refund_and_close_escrow(
        order,
        &mut accounts.escrow,
        &accounts.stable_mint,
        &accounts.user_stable,
        &accounts.rent_payer,
        stable_token_program,
    )?;

    emit!(OrderFilled {
        order: order.key(),
        user: order.user,
        market: order.market,
        side: order.side,
        kind: order.kind,
        fill_qty,
        amount: cost,
        fee,
    });
    Ok(())
}
