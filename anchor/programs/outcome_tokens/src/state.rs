use anchor_lang::prelude::*;

/// Mint authority for one market's outcome mints. Stores its own seeds so it can sign.
#[account]
#[derive(InitSpace)]
pub struct SpikeMarket {
    pub symbol_hash: [u8; 32],
    pub bump: u8,
}

/// One escrowed order. Token authority of its escrow account.
#[account]
#[derive(InitSpace)]
pub struct SpikeOrder {
    pub user: Pubkey,
    pub nonce: u64,
    pub expires_at: i64,
    pub bump: u8,
}
