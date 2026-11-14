pub mod constants;
pub mod error;
pub mod events;
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

    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        handle_initialize(ctx, args)
    }

    pub fn set_config(ctx: Context<SetConfig>, args: SetConfigArgs) -> Result<()> {
        handle_set_config(ctx, args)
    }

    pub fn set_pause(ctx: Context<SetPause>, flags: u8) -> Result<()> {
        handle_set_pause(ctx, flags)
    }

    pub fn register_trader(ctx: Context<RegisterTrader>) -> Result<()> {
        handle_register_trader(ctx)
    }
}
