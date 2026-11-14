use anchor_lang::prelude::*;
use anchor_spl::{
    token::Token,
    token_interface::{self, Mint, Token2022, TokenAccount, TransferChecked},
};

use super::escrow::{burn_from_escrow, refund_and_close_escrow};
use crate::{
    constants::*,
    error::ErrorCode,
    events::OrderFilled,
    state::{Config, Market, MarketStatus, Order, OrderKind},
};

#[derive(Accounts)]
pub struct FillSell<'info> {
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
    // The kind is checked here, ahead of the escrow: a buy order's escrow holds another
    // mint under another token program and would otherwise fail with an unrelated error.
    #[account(
        mut,
        close = rent_payer,
        seeds = [ORDER_SEED, order.user.as_ref(), &order.nonce.to_le_bytes()],
        bump = order.bump,
        has_one = rent_payer,
        constraint = order.kind == OrderKind::Sell as u8 @ ErrorCode::WrongKind,
        constraint = order.market == market.key() @ ErrorCode::WrongMarket
    )]
    pub order: Box<Account<'info, Order>>,
    // Ahead of the escrow, so that the other side's mint is reported as the wrong mint
    // and not as an escrow that does not match it.
    #[account(
        mut,
        address = market.mint(order.side()) @ ErrorCode::WrongMint,
        mint::token_program = outcome_token_program
    )]
    pub outcome_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, order.key().as_ref()],
        bump,
        token::mint = outcome_mint,
        token::authority = order,
        token::token_program = outcome_token_program
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    /// A stable token account of the relayer, which received the venue's payment for the
    /// sale. Pays the user.
    #[account(
        mut,
        token::mint = stable_mint,
        token::token_program = stable_token_program,
        constraint = payout_source.owner == relayer.key() @ ErrorCode::WrongOwner
    )]
    pub payout_source: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Any stable token account of the order's user. Receives the proceeds less the fee.
    #[account(
        mut,
        token::mint = stable_mint,
        token::token_program = stable_token_program,
        constraint = user_stable.owner == order.user @ ErrorCode::WrongOwner
    )]
    pub user_stable: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Any token account of the order's user for the outcome mint; it need not be the
    /// associated one. Receives what the fill did not sell.
    #[account(
        mut,
        token::mint = outcome_mint,
        token::token_program = outcome_token_program,
        constraint = user_outcome.owner == order.user @ ErrorCode::WrongOwner
    )]
    pub user_outcome: Box<InterfaceAccount<'info, TokenAccount>>,
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

pub fn handle_fill_sell(
    ctx: Context<FillSell>,
    fill_qty: u64,
    proceeds: u64,
    fee: u64,
) -> Result<()> {
    let accounts = ctx.accounts;
    let order = &accounts.order;

    require!(
        Clock::get()?.unix_timestamp <= order.expires_at,
        ErrorCode::OrderExpired
    );
    require!(
        fill_qty > 0 && fill_qty <= order.qty_units,
        ErrorCode::FillExceedsOrder
    );
    // At least the user's minimum price and at most the highest price a unit trades at.
    let min_proceeds = fill_qty
        .checked_mul(u64::from(order.limit_px))
        .ok_or(ErrorCode::MathOverflow)?;
    let max_proceeds = fill_qty
        .checked_mul(u64::from(PX_MAX))
        .ok_or(ErrorCode::MathOverflow)?;
    require!(
        (min_proceeds..=max_proceeds).contains(&proceeds),
        ErrorCode::ProceedsOutOfRange
    );
    require!(
        fee <= order.max_fee && fee <= proceeds,
        ErrorCode::FeeExceedsCap
    );
    let payout = proceeds.checked_sub(fee).ok_or(ErrorCode::MathOverflow)?;

    let outcome_token_program = accounts.outcome_token_program.key();
    burn_from_escrow(
        order,
        &accounts.escrow,
        &accounts.outcome_mint,
        outcome_token_program,
        fill_qty,
    )?;
    token_interface::transfer_checked(
        CpiContext::new(
            accounts.stable_token_program.key(),
            TransferChecked {
                from: accounts.payout_source.to_account_info(),
                mint: accounts.stable_mint.to_account_info(),
                to: accounts.user_stable.to_account_info(),
                authority: accounts.relayer.to_account_info(),
            },
        ),
        payout,
        accounts.stable_mint.decimals,
    )?;
    // Whatever is left: the unfilled quantity and anything sent to the escrow since.
    refund_and_close_escrow(
        order,
        &mut accounts.escrow,
        &accounts.outcome_mint,
        &accounts.user_outcome,
        &accounts.rent_payer,
        outcome_token_program,
    )?;

    emit!(OrderFilled {
        order: order.key(),
        user: order.user,
        market: order.market,
        side: order.side,
        kind: order.kind,
        fill_qty,
        amount: proceeds,
        fee,
    });
    Ok(())
}
