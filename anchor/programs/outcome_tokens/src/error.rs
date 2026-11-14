use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("Symbol hash does not equal sha256(symbol)")]
    SymbolHashMismatch,
    #[msg("Side must be 0 or 1")]
    InvalidSide,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Time to live must be greater than zero")]
    InvalidTtl,
    #[msg("Order has not expired yet")]
    NotExpired,
    #[msg("Arithmetic overflow")]
    Overflow,
}
