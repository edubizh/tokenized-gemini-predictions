use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ErrorCode,
    events::MarketCreated,
    state::{Config, Market, MarketStatus},
};

// `symbol_hash` comes first among the arguments because it is the only one the account
// constraints read.
#[derive(Accounts)]
#[instruction(symbol_hash: [u8; 32])]
pub struct CreateMarket<'info> {
    pub relayer: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = relayer @ ErrorCode::Unauthorized
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = payer,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, symbol_hash.as_ref()],
        bump
    )]
    pub market: Box<Account<'info, Market>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_market(
    ctx: Context<CreateMarket>,
    symbol_hash: [u8; 32],
    symbol: String,
    close_ts: i64,
    place_cutoff_secs: u32,
    tick_px: u16,
    max_supply_units: u64,
) -> Result<()> {
    require!(
        (1..=MAX_SYMBOL_LEN).contains(&symbol.len())
            && symbol
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-'),
        ErrorCode::BadSymbol
    );
    // The address is derived from the hash, so the hash must commit to this symbol.
    require!(
        solana_sha256_hasher::hash(symbol.as_bytes()).to_bytes() == symbol_hash,
        ErrorCode::BadSymbolHash
    );
    require!(place_cutoff_secs >= CUTOFF_MIN_SECS, ErrorCode::BadConfig);
    require!((1..=PX_MAX).contains(&tick_px), ErrorCode::BadConfig);
    require!(max_supply_units >= 1, ErrorCode::BadConfig);
    require!(
        close_ts > Clock::get()?.unix_timestamp,
        ErrorCode::BadConfig
    );

    let market = ctx.accounts.market.key();
    ctx.accounts.market.set_inner(Market {
        symbol_hash,
        symbol: symbol.clone(),
        yes_mint: Pubkey::default(),
        no_mint: Pubkey::default(),
        status: MarketStatus::Open as u8,
        close_ts,
        place_cutoff_secs,
        tick_px,
        max_supply_units,
        yes_payout: 0,
        no_payout: 0,
        redeem_after: 0,
        bump: ctx.bumps.market,
        reserved: [0; 64],
    });

    emit!(MarketCreated { market, symbol });
    Ok(())
}
