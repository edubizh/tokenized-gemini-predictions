use anchor_lang::prelude::*;

// `side`, `kind` and `status` carry the same numbers the accounts store (`Side`,
// `OrderKind`, `MarketStatus`).

#[event]
pub struct Initialized {}

/// Emitted by `set_config` and `set_pause`; the new values are read from the Config account.
#[event]
pub struct ConfigChanged {}

#[event]
pub struct TraderRegistered {
    pub user: Pubkey,
}

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub symbol: String,
}

#[event]
pub struct OutcomeMintCreated {
    pub market: Pubkey,
    pub side: u8,
    pub mint: Pubkey,
}

#[event]
pub struct OrderPlaced {
    pub order: Pubkey,
    pub user: Pubkey,
    pub market: Pubkey,
    pub side: u8,
    pub kind: u8,
    pub qty_units: u64,
    pub limit_px: u16,
    pub max_fee: u64,
    pub expires_at: i64,
    pub nonce: u64,
}

#[event]
pub struct OrderFilled {
    pub order: Pubkey,
    pub user: Pubkey,
    pub market: Pubkey,
    pub side: u8,
    pub kind: u8,
    pub fill_qty: u64,
    /// Cost of a buy, proceeds of a sell.
    pub amount: u64,
    pub fee: u64,
}

#[event]
pub struct OrderCancelled {
    pub order: Pubkey,
    pub user: Pubkey,
    pub market: Pubkey,
    /// The signer that cancelled the order.
    pub by: Pubkey,
}

#[event]
pub struct MarketStatusChanged {
    pub market: Pubkey,
    pub status: u8,
    pub close_ts: i64,
}

#[event]
pub struct MarketSettled {
    pub market: Pubkey,
    pub yes_payout: u64,
    pub no_payout: u64,
    pub funding: u64,
    pub redeem_after: i64,
}

#[event]
pub struct SettlementRevoked {
    pub market: Pubkey,
}

#[event]
pub struct Redeemed {
    pub market: Pubkey,
    pub holder: Pubkey,
    pub side: u8,
    pub amount: u64,
    pub payout: u64,
}
