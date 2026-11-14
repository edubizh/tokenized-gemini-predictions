use anchor_lang::prelude::*;
use anchor_spl::{
    token::{self, Token},
    token_interface::{self, Burn, Token2022},
};

use super::vault::transfer_from_vault;
use crate::{
    constants::*,
    error::ErrorCode,
    events::Redeemed,
    state::{Market, MarketStatus, Side},
};

// No Config account: redemption depends on the market alone, so neither a pause flag nor
// a change of roles can stand between a holder and a settled payout.
#[derive(Accounts)]
pub struct Redeem<'info> {
    /// Anyone who holds outcome tokens; no trader registration is needed.
    pub holder: Signer<'info>,
    #[account(
        seeds = [MARKET_SEED, market.symbol_hash.as_ref()],
        bump = market.bump,
        constraint = market.status == MarketStatus::Settled as u8 @ ErrorCode::NotSettled
    )]
    pub market: Box<Account<'info, Market>>,
    /// Either of the market's two mints. It decides which payout applies.
    #[account(
        mut,
        constraint = outcome_mint.key() == market.yes_mint
            || outcome_mint.key() == market.no_mint @ ErrorCode::WrongMint,
        mint::token_program = outcome_token_program
    )]
    pub outcome_mint: Box<InterfaceAccount<'info, token_interface::Mint>>,
    /// Any token account of the holder for the outcome mint; it need not be the
    /// associated one.
    #[account(
        mut,
        token::mint = outcome_mint,
        token::token_program = outcome_token_program,
        constraint = holder_outcome.owner == holder.key() @ ErrorCode::WrongOwner
    )]
    pub holder_outcome: Box<InterfaceAccount<'info, token_interface::TokenAccount>>,
    /// CHECK: The address is fixed by the seeds, where only `settle_market` creates an
    /// account: a stable token account whose authority is the market. Left untyped so
    /// that an unsettled market is reported as such, not as a vault that does not exist.
    #[account(
        mut,
        seeds = [REDEEM_SEED, market.key().as_ref()],
        bump
    )]
    pub vault: UncheckedAccount<'info>,
    /// Any stable token account of the holder.
    #[account(
        mut,
        token::mint = stable_mint,
        token::token_program = stable_token_program,
        constraint = holder_stable.owner == holder.key() @ ErrorCode::WrongOwner
    )]
    pub holder_stable: Box<Account<'info, token::TokenAccount>>,
    /// The vault's mint: the token program refuses the payout for any other.
    #[account(mint::token_program = stable_token_program)]
    pub stable_mint: Box<Account<'info, token::Mint>>,
    pub stable_token_program: Program<'info, Token>,
    pub outcome_token_program: Program<'info, Token2022>,
}

pub fn handle_redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
    let accounts = ctx.accounts;
    let market = &accounts.market;
    require!(
        Clock::get()?.unix_timestamp >= market.redeem_after,
        ErrorCode::RedeemLocked
    );
    require!(amount > 0, ErrorCode::BadQuantity);

    let (side, payout_per_unit) = if accounts.outcome_mint.key() == market.yes_mint {
        (Side::Yes, market.yes_payout)
    } else {
        (Side::No, market.no_payout)
    };
    let payout = amount
        .checked_mul(payout_per_unit)
        .ok_or(ErrorCode::MathOverflow)?;

    token_interface::burn(
        CpiContext::new(
            accounts.outcome_token_program.key(),
            Burn {
                mint: accounts.outcome_mint.to_account_info(),
                from: accounts.holder_outcome.to_account_info(),
                authority: accounts.holder.to_account_info(),
            },
        ),
        amount,
    )?;
    // Tokens of a side that settled at zero are burned for nothing.
    if payout > 0 {
        transfer_from_vault(
            market,
            &accounts.vault,
            &accounts.stable_mint,
            &accounts.holder_stable,
            accounts.stable_token_program.key(),
            payout,
        )?;
    }

    emit!(Redeemed {
        market: market.key(),
        holder: accounts.holder.key(),
        side: side as u8,
        amount,
        payout,
    });
    Ok(())
}
