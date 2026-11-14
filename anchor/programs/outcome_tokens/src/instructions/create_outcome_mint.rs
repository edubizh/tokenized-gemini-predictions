use anchor_lang::{
    prelude::*,
    system_program::{self, Allocate, Assign, Transfer},
};
use anchor_spl::{
    token_2022::spl_token_2022::extension::ExtensionType,
    token_interface::{
        find_mint_account_size, initialize_mint2, metadata_pointer_initialize,
        token_metadata_initialize, InitializeMint2, MetadataPointerInitialize, Token2022,
        TokenMetadataInitialize,
    },
};

use crate::{
    constants::*,
    error::ErrorCode,
    events::OutcomeMintCreated,
    state::{Config, Market, Side},
};

#[derive(Accounts)]
#[instruction(side: Side)]
pub struct CreateOutcomeMint<'info> {
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
        mut,
        seeds = [MARKET_SEED, market.symbol_hash.as_ref()],
        bump = market.bump,
        constraint = market.mint(side) == Pubkey::default() @ ErrorCode::MintAlreadyCreated
    )]
    pub market: Box<Account<'info, Market>>,
    /// CHECK: The address is fixed by the seeds. The handler creates the Token-2022 mint
    /// here; an `init` constraint would run before the check on `market` and report an
    /// existing mint as a System program error.
    #[account(
        mut,
        seeds = [MINT_SEED, market.key().as_ref(), &side.to_le_bytes()],
        bump
    )]
    pub mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

impl<'info> CreateOutcomeMint<'info> {
    /// Tops the mint account up to the rent-exempt minimum for `space` bytes.
    fn fund_mint(&self, space: usize) -> Result<()> {
        let shortfall = Rent::get()?
            .minimum_balance(space)
            .saturating_sub(self.mint.lamports());
        if shortfall > 0 {
            system_program::transfer(
                CpiContext::new(
                    self.system_program.key(),
                    Transfer {
                        from: self.payer.to_account_info(),
                        to: self.mint.to_account_info(),
                    },
                ),
                shortfall,
            )?;
        }
        Ok(())
    }
}

pub fn handle_create_outcome_mint(
    ctx: Context<CreateOutcomeMint>,
    side: Side,
    name: String,
    ticker: String,
    uri: String,
) -> Result<()> {
    require!(
        (1..=MAX_NAME_LEN).contains(&name.len()),
        ErrorCode::BadConfig
    );
    require!(
        (1..=MAX_TICKER_LEN).contains(&ticker.len()),
        ErrorCode::BadConfig
    );
    require!(uri.len() <= MAX_URI_LEN, ErrorCode::BadConfig);

    let accounts = &ctx.accounts;
    let market_key = accounts.market.key();
    let mint_key = accounts.mint.key();
    let token_program = accounts.token_program.key();
    let system_program = accounts.system_program.key();
    let side_seed = side.to_le_bytes();
    let mint_seeds: &[&[&[u8]]] = &[&[
        MINT_SEED,
        market_key.as_ref(),
        &side_seed,
        &[ctx.bumps.mint],
    ]];
    let market_seeds: &[&[&[u8]]] = &[&[
        MARKET_SEED,
        accounts.market.symbol_hash.as_ref(),
        &[accounts.market.bump],
    ]];

    // Fund, allocate and assign instead of `create_account`, which refuses an address
    // that already holds lamports: anyone could block a mint by sending it some.
    let space = find_mint_account_size(Some(&vec![ExtensionType::MetadataPointer]))?;
    accounts.fund_mint(space)?;
    system_program::allocate(
        CpiContext::new_with_signer(
            system_program,
            Allocate {
                account_to_allocate: accounts.mint.to_account_info(),
            },
            mint_seeds,
        ),
        space as u64,
    )?;
    system_program::assign(
        CpiContext::new_with_signer(
            system_program,
            Assign {
                account_to_assign: accounts.mint.to_account_info(),
            },
            mint_seeds,
        ),
        &token_program,
    )?;

    // The metadata lives on the mint account itself. No freeze authority.
    metadata_pointer_initialize(
        CpiContext::new(
            token_program,
            MetadataPointerInitialize {
                token_program_id: accounts.token_program.to_account_info(),
                mint: accounts.mint.to_account_info(),
            },
        ),
        Some(market_key),
        Some(mint_key),
    )?;
    initialize_mint2(
        CpiContext::new(
            token_program,
            InitializeMint2 {
                mint: accounts.mint.to_account_info(),
            },
        ),
        OUTCOME_DECIMALS,
        &market_key,
        None,
    )?;
    token_metadata_initialize(
        CpiContext::new_with_signer(
            token_program,
            TokenMetadataInitialize {
                program_id: accounts.token_program.to_account_info(),
                mint: accounts.mint.to_account_info(),
                metadata: accounts.mint.to_account_info(),
                mint_authority: accounts.market.to_account_info(),
                update_authority: accounts.market.to_account_info(),
            },
            market_seeds,
        ),
        name,
        ticker,
        uri,
    )?;
    // The token program appended the metadata without charging rent for it.
    accounts.fund_mint(accounts.mint.data_len())?;

    let market = &mut ctx.accounts.market;
    match side {
        Side::Yes => market.yes_mint = mint_key,
        Side::No => market.no_mint = mint_key,
    }

    emit!(OutcomeMintCreated {
        market: market_key,
        side: side as u8,
        mint: mint_key,
    });
    Ok(())
}
