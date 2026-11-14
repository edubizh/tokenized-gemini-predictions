pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("8TN1HWcEFTAcM7Vthmih1FKftTBrp3LDgTBkfhp1PRVn");

#[program]
pub mod outcome_tokens {
    use super::*;

    pub fn spike_create_market(
        ctx: Context<SpikeCreateMarket>,
        symbol_hash: [u8; 32],
        symbol: String,
    ) -> Result<()> {
        crate::instructions::spike_create_market::handle_spike_create_market(
            ctx,
            symbol_hash,
            symbol,
        )
    }

    pub fn spike_create_mint(
        ctx: Context<SpikeCreateMint>,
        side: u8,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        crate::instructions::spike_create_mint::handle_spike_create_mint(
            ctx, side, name, symbol, uri,
        )
    }

    pub fn spike_mint(ctx: Context<SpikeMint>, amount: u64) -> Result<()> {
        crate::instructions::spike_mint::handle_spike_mint(ctx, amount)
    }

    pub fn spike_escrow(
        ctx: Context<SpikeEscrow>,
        nonce: u64,
        amount: u64,
        ttl_secs: i64,
    ) -> Result<()> {
        crate::instructions::spike_escrow::handle_spike_escrow(ctx, nonce, amount, ttl_secs)
    }

    pub fn spike_release(ctx: Context<SpikeRelease>) -> Result<()> {
        crate::instructions::spike_release::handle_spike_release(ctx)
    }
}
