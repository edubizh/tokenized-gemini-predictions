use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, Token2022, TokenAccount, TransferChecked};

use super::placement::{check_placement, record_order};
use crate::{
    constants::*,
    error::ErrorCode,
    state::{Config, Market, Order, OrderKind, Side, Trader},
};

#[derive(Accounts)]
#[instruction(side: Side)]
pub struct PlaceSell<'info> {
    pub user: Signer<'info>,
    /// Funds the order and its escrow, and gets that rent back when they close.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// Exists only for a wallet the registrar has registered.
    #[account(
        mut,
        seeds = [TRADER_SEED, user.key().as_ref()],
        bump = trader.bump
    )]
    pub trader: Account<'info, Trader>,
    #[account(
        seeds = [MARKET_SEED, market.symbol_hash.as_ref()],
        bump = market.bump
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(
        init,
        payer = payer,
        space = 8 + Order::INIT_SPACE,
        seeds = [ORDER_SEED, user.key().as_ref(), &trader.next_nonce.to_le_bytes()],
        bump
    )]
    pub order: Box<Account<'info, Order>>,
    #[account(
        init,
        payer = payer,
        seeds = [ESCROW_SEED, order.key().as_ref()],
        bump,
        token::mint = outcome_mint,
        token::authority = order,
        token::token_program = token_program
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Any token account of the user for the outcome mint; it need not be the associated
    /// one.
    #[account(
        mut,
        token::mint = outcome_mint,
        token::token_program = token_program,
        constraint = user_outcome.owner == user.key() @ ErrorCode::WrongOwner
    )]
    pub user_outcome: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        address = market.mint(side) @ ErrorCode::WrongMint,
        mint::token_program = token_program
    )]
    pub outcome_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handle_place_sell(
    ctx: Context<PlaceSell>,
    side: Side,
    qty_units: u64,
    min_px: u16,
    max_fee: u64,
) -> Result<()> {
    let accounts = ctx.accounts;
    // No minimum size: a holder must be able to sell whatever is left of a position.
    let expires_at = check_placement(
        &accounts.config,
        &accounts.market,
        1,
        qty_units,
        min_px,
        max_fee,
    )?;
    // The fee comes out of the proceeds, which are at least this much for a full fill.
    let min_proceeds = qty_units
        .checked_mul(u64::from(min_px))
        .ok_or(ErrorCode::MathOverflow)?;
    require!(max_fee <= min_proceeds, ErrorCode::FeeCapTooHigh);

    token_interface::transfer_checked(
        CpiContext::new(
            accounts.token_program.key(),
            TransferChecked {
                from: accounts.user_outcome.to_account_info(),
                mint: accounts.outcome_mint.to_account_info(),
                to: accounts.escrow.to_account_info(),
                authority: accounts.user.to_account_info(),
            },
        ),
        qty_units,
        accounts.outcome_mint.decimals,
    )?;

    let order = Order {
        user: accounts.user.key(),
        market: accounts.market.key(),
        side: side as u8,
        kind: OrderKind::Sell as u8,
        qty_units,
        limit_px: min_px,
        max_fee,
        expires_at,
        rent_payer: accounts.payer.key(),
        nonce: accounts.trader.next_nonce,
        bump: ctx.bumps.order,
        reserved: [0; 16],
    };
    record_order(&mut accounts.order, &mut accounts.trader, order)
}
