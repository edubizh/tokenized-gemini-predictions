use anchor_lang::prelude::*;

// The position of a variant is its error number (6000 + index) and is part of the client
// interface: add new variants at the end.
#[error_code]
pub enum ErrorCode {
    #[msg("Signer is not allowed to do this")]
    Unauthorized,
    #[msg("Configuration value is out of range")]
    BadConfig,
    #[msg("This action is paused")]
    Paused,
    #[msg("Real stablecoin mints are not allowed in this build")]
    RealStablecoinNotAllowed,
    #[msg("Symbol must be 1 to 64 characters from A-Z, 0-9 and '-'")]
    BadSymbol,
    #[msg("Symbol hash does not equal sha256(symbol)")]
    BadSymbolHash,
    #[msg("The outcome mint for this side already exists")]
    MintAlreadyCreated,
    #[msg("Both outcome mints must exist first")]
    MintsNotReady,
    #[msg("Market is not open")]
    MarketNotOpen,
    #[msg("Market is already settled")]
    AlreadySettled,
    #[msg("Market is not settled")]
    NotSettled,
    #[msg("Too close to the market's close time")]
    TooCloseToClose,
    #[msg("Quantity is out of range")]
    BadQuantity,
    #[msg("Price is out of range")]
    BadPrice,
    #[msg("Price is not a multiple of the market tick")]
    OffTick,
    #[msg("Fee cap is too high")]
    FeeCapTooHigh,
    #[msg("Fill quantity must be positive and at most the order quantity")]
    FillExceedsOrder,
    #[msg("Cost is outside the range the order allows")]
    CostOutOfRange,
    #[msg("Proceeds are outside the range the order allows")]
    ProceedsOutOfRange,
    #[msg("Fee exceeds the order's fee cap")]
    FeeExceedsCap,
    #[msg("Fill would exceed the market's supply cap")]
    SupplyCapExceeded,
    #[msg("Order has expired")]
    OrderExpired,
    #[msg("Order has not expired yet")]
    OrderNotExpired,
    #[msg("Order is of the other kind")]
    WrongKind,
    #[msg("Order belongs to another market")]
    WrongMarket,
    #[msg("Mint is not the expected one")]
    WrongMint,
    #[msg("Token account is not owned by the expected wallet")]
    WrongOwner,
    #[msg("Payouts must add up to 10,000")]
    BadPayout,
    #[msg("Redemption is not open yet")]
    RedeemLocked,
    #[msg("Settlement can no longer be revoked")]
    RevokeWindowClosed,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
