use anchor_lang::{
    prelude::*,
    system_program::{self, Allocate, Assign, Transfer},
};
use anchor_spl::{
    token::{self, InitializeAccount3, Mint, Token, TokenAccount, TransferChecked},
    token_interface,
};

use crate::{
    constants::*,
    error::ErrorCode,
    events::MarketSettled,
    state::{Config, Market, MarketStatus},
};

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    pub settler: Signer<'info>,
    /// Funds the vault's rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = settler @ ErrorCode::Unauthorized
    )]
    pub config: Account<'info, Config>,
    // Nothing ties a settlement to `close_ts`: some markets resolve early.
    #[account(
        mut,
        seeds = [MARKET_SEED, market.symbol_hash.as_ref()],
        bump = market.bump,
        constraint = market.status != MarketStatus::Settled as u8 @ ErrorCode::AlreadySettled,
        constraint = market.yes_mint != Pubkey::default() && market.no_mint != Pubkey::default()
            @ ErrorCode::MintsNotReady
    )]
    pub market: Box<Account<'info, Market>>,
    /// CHECK: Pinned to the address the market stores, which only ever names the mint this
    /// program created. Left untyped so that a market without its mints is reported as
    /// such, not as an account that does not exist.
    #[account(address = market.yes_mint @ ErrorCode::WrongMint)]
    pub yes_mint: UncheckedAccount<'info>,
    /// CHECK: As `yes_mint`.
    #[account(address = market.no_mint @ ErrorCode::WrongMint)]
    pub no_mint: UncheckedAccount<'info>,
    /// CHECK: The address is fixed by the seeds. The handler creates the stable token
    /// account here; an `init` constraint would run before the checks on `market` and
    /// report a settled market as a System program error.
    #[account(
        mut,
        seeds = [REDEEM_SEED, market.key().as_ref()],
        bump
    )]
    pub vault: UncheckedAccount<'info>,
    #[account(
        mut,
        token::mint = stable_mint,
        token::token_program = token_program,
        constraint = funder_stable.owner == settler.key() @ ErrorCode::WrongOwner
    )]
    pub funder_stable: Box<Account<'info, TokenAccount>>,
    #[account(
        address = config.stable_mint,
        mint::token_program = token_program
    )]
    pub stable_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> SettleMarket<'info> {
    /// Creates the vault: a stable token account whose authority is the market.
    fn create_vault(&self, bump: u8) -> Result<()> {
        let market_key = self.market.key();
        let vault_seeds: &[&[&[u8]]] = &[&[REDEEM_SEED, market_key.as_ref(), &[bump]]];
        let system_program = self.system_program.key();
        let token_program = self.token_program.key();

        // Fund, allocate and assign instead of `create_account`, which refuses an address
        // that already holds lamports: anyone could block a settlement by sending it some.
        let shortfall = Rent::get()?
            .minimum_balance(TokenAccount::LEN)
            .saturating_sub(self.vault.lamports());
        if shortfall > 0 {
            system_program::transfer(
                CpiContext::new(
                    system_program,
                    Transfer {
                        from: self.payer.to_account_info(),
                        to: self.vault.to_account_info(),
                    },
                ),
                shortfall,
            )?;
        }
        system_program::allocate(
            CpiContext::new_with_signer(
                system_program,
                Allocate {
                    account_to_allocate: self.vault.to_account_info(),
                },
                vault_seeds,
            ),
            TokenAccount::LEN as u64,
        )?;
        system_program::assign(
            CpiContext::new_with_signer(
                system_program,
                Assign {
                    account_to_assign: self.vault.to_account_info(),
                },
                vault_seeds,
            ),
            &token_program,
        )?;
        token::initialize_account3(CpiContext::new(
            token_program,
            InitializeAccount3 {
                account: self.vault.to_account_info(),
                mint: self.stable_mint.to_account_info(),
                authority: self.market.to_account_info(),
            },
        ))
    }
}

/// Supply of an outcome mint whose address the accounts struct has pinned.
fn supply(mint: &UncheckedAccount) -> Result<u64> {
    let data = mint.try_borrow_data()?;
    Ok(token_interface::Mint::try_deserialize(&mut &data[..])?.supply)
}

/// What `units` tokens are owed at `payout` micro-dollars each.
fn owed(units: u64, payout: u64) -> Result<u128> {
    u128::from(units)
        .checked_mul(u128::from(payout))
        .ok_or_else(|| ErrorCode::MathOverflow.into())
}

pub fn handle_settle_market(
    ctx: Context<SettleMarket>,
    yes_payout: u64,
    no_payout: u64,
) -> Result<()> {
    require!(
        yes_payout.checked_add(no_payout) == Some(PAYOUT_TOTAL),
        ErrorCode::BadPayout
    );
    let accounts = &ctx.accounts;

    // The vault receives exactly what every outstanding token can claim.
    let funding = owed(supply(&accounts.yes_mint)?, yes_payout)?
        .checked_add(owed(supply(&accounts.no_mint)?, no_payout)?)
        .and_then(|total| u64::try_from(total).ok())
        .ok_or(ErrorCode::MathOverflow)?;
    let redeem_after = Clock::get()?
        .unix_timestamp
        .checked_add(i64::from(accounts.config.settle_delay_secs))
        .ok_or(ErrorCode::MathOverflow)?;

    accounts.create_vault(ctx.bumps.vault)?;
    token::transfer_checked(
        CpiContext::new(
            accounts.token_program.key(),
            TransferChecked {
                from: accounts.funder_stable.to_account_info(),
                mint: accounts.stable_mint.to_account_info(),
                to: accounts.vault.to_account_info(),
                authority: accounts.settler.to_account_info(),
            },
        ),
        funding,
        accounts.stable_mint.decimals,
    )?;

    let market = &mut ctx.accounts.market;
    market.yes_payout = yes_payout;
    market.no_payout = no_payout;
    market.status = MarketStatus::Settled as u8;
    market.redeem_after = redeem_after;

    emit!(MarketSettled {
        market: market.key(),
        yes_payout,
        no_payout,
        funding,
        redeem_after,
    });
    Ok(())
}
