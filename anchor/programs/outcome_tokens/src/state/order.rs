use anchor_lang::prelude::*;

/// Direction of an order. Accounts and events store it as its number.
// Borsh writes the variant index, which the explicit numbers must keep matching; Anchor's
// IDL builder accepts no other encoding.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[borsh(use_discriminant = false)]
pub enum OrderKind {
    Buy = 0,
    Sell = 1,
}

/// One escrowed order. PDA `["order", user, nonce]`, and the authority of its escrow token
/// account. Closed by the instruction that fills or cancels it.
#[account]
#[derive(InitSpace)]
pub struct Order {
    pub user: Pubkey,
    pub market: Pubkey,
    /// A `Side`.
    pub side: u8,
    /// An `OrderKind`.
    pub kind: u8,
    pub qty_units: u64,
    /// Highest price of a buy, lowest price of a sell.
    pub limit_px: u16,
    /// Micro-dollars.
    pub max_fee: u64,
    pub expires_at: i64,
    /// Receives the rent of the order and its escrow when they close.
    pub rent_payer: Pubkey,
    /// The trader's `next_nonce` at placement.
    pub nonce: u64,
    pub bump: u8,
    pub reserved: [u8; 16],
}
