use anchor_lang::prelude::*;

/// A wallet that may place orders. PDA `["trader", user]`, created by the registrar.
#[account]
#[derive(InitSpace)]
pub struct Trader {
    pub user: Pubkey,
    /// Nonce of the user's next order. It only increases, so order addresses never repeat.
    pub next_nonce: u64,
    pub bump: u8,
    pub reserved: [u8; 32],
}
