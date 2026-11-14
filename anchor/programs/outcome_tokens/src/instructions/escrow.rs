//! Moving tokens out of an order's escrow. The order account is the escrow's authority,
//! so everything here is signed with the order's seeds. Works for both token programs.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Burn, CloseAccount, Mint, TokenAccount, TransferChecked};

use crate::{constants::ORDER_SEED, state::Order};

/// Transfers `amount` from the escrow to `to`.
pub fn transfer_from_escrow<'info>(
    order: &Account<'info, Order>,
    escrow: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    token_program: Pubkey,
    amount: u64,
) -> Result<()> {
    let nonce = order.nonce.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[ORDER_SEED, order.user.as_ref(), &nonce, &[order.bump]]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program,
            TransferChecked {
                from: escrow.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: order.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        mint.decimals,
    )
}

/// Burns `amount` of the escrowed tokens.
pub fn burn_from_escrow<'info>(
    order: &Account<'info, Order>,
    escrow: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    token_program: Pubkey,
    amount: u64,
) -> Result<()> {
    let nonce = order.nonce.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[ORDER_SEED, order.user.as_ref(), &nonce, &[order.bump]]];
    token_interface::burn(
        CpiContext::new_with_signer(
            token_program,
            Burn {
                mint: mint.to_account_info(),
                from: escrow.to_account_info(),
                authority: order.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )
}

/// Sends everything the escrow holds to `to`, then closes the escrow with its rent going
/// to `rent_payer`.
///
/// The balance is read from the account as it is now, not from what the order recorded:
/// tokens that anyone sent to the escrow go to the user and cannot block the close.
pub fn refund_and_close_escrow<'info>(
    order: &Account<'info, Order>,
    escrow: &mut InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    rent_payer: &AccountInfo<'info>,
    token_program: Pubkey,
) -> Result<()> {
    escrow.reload()?;
    if escrow.amount > 0 {
        transfer_from_escrow(order, escrow, mint, to, token_program, escrow.amount)?;
    }

    let nonce = order.nonce.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[ORDER_SEED, order.user.as_ref(), &nonce, &[order.bump]]];
    token_interface::close_account(CpiContext::new_with_signer(
        token_program,
        CloseAccount {
            account: escrow.to_account_info(),
            destination: rent_payer.clone(),
            authority: order.to_account_info(),
        },
        signer_seeds,
    ))
}
