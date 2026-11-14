use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount};

use super::vault::transfer_from_vault;
use crate::{
    constants::*,
    error::ErrorCode,
    events::SettlementRevoked,
    state::{Config, Market, MarketStatus},
};

#[derive(Accounts)]
pub struct RevokeSettlement<'info> {
    /// The admin or the settler. Receives the vault's rent.
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = authority.key() == config.admin || authority.key() == config.settler
            @ ErrorCode::Unauthorized
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [MARKET_SEED, market.symbol_hash.as_ref()],
        bump = market.bump,
        constraint = market.status == MarketStatus::Settled as u8 @ ErrorCode::NotSettled
    )]
    pub market: Box<Account<'info, Market>>,
    /// CHECK: The address is fixed by the seeds, where only `settle_market` creates an
    /// account: a stable token account whose authority is the market. Left untyped so
    /// that an unsettled market is reported as such, not as a vault that does not exist.
    #[account(
        mut,
        seeds = [REDEEM_SEED, market.key().as_ref()],
        bump
    )]
    pub vault: UncheckedAccount<'info>,
    #[account(
        mut,
        address = config.treasury,
        token::token_program = token_program
    )]
    pub treasury: Box<Account<'info, TokenAccount>>,
    #[account(
        address = config.stable_mint,
        mint::token_program = token_program
    )]
    pub stable_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_revoke_settlement(ctx: Context<RevokeSettlement>) -> Result<()> {
    let accounts = &ctx.accounts;
    let market = &accounts.market;
    // Once redemption is open, holders may already have been paid at these payouts.
    require!(
        Clock::get()?.unix_timestamp < market.redeem_after,
        ErrorCode::RevokeWindowClosed
    );

    // The balance as it is now: tokens that anyone sent to the vault leave with the
    // funding and cannot block the close.
    let balance = {
        let data = accounts.vault.try_borrow_data()?;
        TokenAccount::try_deserialize(&mut &data[..])?.amount
    };
    let token_program = accounts.token_program.key();
    if balance > 0 {
        transfer_from_vault(
            market,
            &accounts.vault,
            &accounts.stable_mint,
            &accounts.treasury,
            token_program,
            balance,
        )?;
    }
    let market_seeds: &[&[&[u8]]] = &[&[MARKET_SEED, market.symbol_hash.as_ref(), &[market.bump]]];
    token::close_account(CpiContext::new_with_signer(
        token_program,
        CloseAccount {
            account: accounts.vault.to_account_info(),
            destination: accounts.authority.to_account_info(),
            authority: market.to_account_info(),
        },
        market_seeds,
    ))?;

    // Halted, not open: resuming trading after a mistaken settlement is the admin's call.
    let market = &mut ctx.accounts.market;
    market.status = MarketStatus::Halted as u8;
    market.yes_payout = 0;
    market.no_payout = 0;
    market.redeem_after = 0;

    emit!(SettlementRevoked {
        market: market.key(),
    });
    Ok(())
}
