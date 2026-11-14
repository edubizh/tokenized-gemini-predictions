//! Paying out of a market's redemption vault. The market account is the vault's authority,
//! so the transfer is signed with the market's seeds.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, TokenAccount, TransferChecked};

use crate::{constants::MARKET_SEED, state::Market};

/// Transfers `amount` from the vault to `to`.
pub fn transfer_from_vault<'info>(
    market: &Account<'info, Market>,
    vault: &UncheckedAccount<'info>,
    stable_mint: &Account<'info, Mint>,
    to: &Account<'info, TokenAccount>,
    token_program: Pubkey,
    amount: u64,
) -> Result<()> {
    let signer_seeds: &[&[&[u8]]] = &[&[MARKET_SEED, market.symbol_hash.as_ref(), &[market.bump]]];
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program,
            TransferChecked {
                from: vault.to_account_info(),
                mint: stable_mint.to_account_info(),
                to: to.to_account_info(),
                authority: market.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        stable_mint.decimals,
    )
}
