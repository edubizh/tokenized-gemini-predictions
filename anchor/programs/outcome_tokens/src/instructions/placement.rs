//! What `place_buy` and `place_sell` share: the checks on a new order and the bookkeeping
//! that records it.

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ErrorCode,
    events::OrderPlaced,
    state::{Config, Market, MarketStatus, Order, Trader},
};

/// Runs the checks every placement shares and returns the time at which the order
/// expires. `min_units` is the smallest quantity this kind of order may have.
pub fn check_placement(
    config: &Config,
    market: &Market,
    min_units: u64,
    qty_units: u64,
    limit_px: u16,
    max_fee: u64,
) -> Result<i64> {
    let now = Clock::get()?.unix_timestamp;

    require!(config.pause_flags & PAUSE_PLACE == 0, ErrorCode::Paused);
    require!(
        market.status == MarketStatus::Open as u8,
        ErrorCode::MarketNotOpen
    );
    require!(
        market.yes_mint != Pubkey::default() && market.no_mint != Pubkey::default(),
        ErrorCode::MintsNotReady
    );
    let cutoff = market
        .close_ts
        .checked_sub(i64::from(market.place_cutoff_secs))
        .ok_or(ErrorCode::MathOverflow)?;
    require!(now < cutoff, ErrorCode::TooCloseToClose);
    require!(
        (min_units..=config.max_order_units).contains(&qty_units),
        ErrorCode::BadQuantity
    );
    require!((1..=PX_MAX).contains(&limit_px), ErrorCode::BadPrice);
    require!(limit_px % market.tick_px == 0, ErrorCode::OffTick);
    // Without a bound a careless client could commit to far more than any real fee.
    let fee_limit = qty_units
        .checked_mul(MAX_FEE_PER_UNIT)
        .and_then(|fees| fees.checked_add(MAX_FEE_BASE))
        .ok_or(ErrorCode::MathOverflow)?;
    require!(max_fee <= fee_limit, ErrorCode::FeeCapTooHigh);

    // An order never outlives its market.
    let expires_at = now
        .checked_add(i64::from(config.order_ttl_secs))
        .ok_or(ErrorCode::MathOverflow)?
        .min(market.close_ts);
    Ok(expires_at)
}

/// Writes the order, announces it and moves the trader on to the next nonce.
pub fn record_order<'info>(
    account: &mut Account<'info, Order>,
    trader: &mut Account<'info, Trader>,
    order: Order,
) -> Result<()> {
    emit!(OrderPlaced {
        order: account.key(),
        user: order.user,
        market: order.market,
        side: order.side,
        kind: order.kind,
        qty_units: order.qty_units,
        limit_px: order.limit_px,
        max_fee: order.max_fee,
        expires_at: order.expires_at,
        nonce: order.nonce,
    });
    // The nonce only increases, so a closed order's address is never used again.
    trader.next_nonce = order.nonce.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
    account.set_inner(order);
    Ok(())
}
