//! Token-2022 mint at a PDA with on-mint metadata, and PDA-signed minting.

mod common;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            instruction::Instruction, program_option::COption, program_pack::Pack,
            system_instruction, system_program,
        },
        InstructionData, ToAccountMetas,
    },
    anchor_spl::{
        token::spl_token,
        token_2022::spl_token_2022::{
            self,
            extension::{
                metadata_pointer::MetadataPointer, BaseStateWithExtensions, ExtensionType,
                StateWithExtensions,
            },
        },
        token_interface::spl_token_metadata_interface::state::TokenMetadata,
    },
    common::*,
    litesvm::LiteSVM,
    outcome_tokens::{error::ErrorCode, state::SpikeMarket},
    solana_keypair::Keypair,
    solana_signer::Signer,
};

const SYMBOL: &str = "SPIKE-TEST-1";
/// sha256("SPIKE-TEST-1"), computed outside the program (`shasum -a 256`).
const SYMBOL_HASH_HEX: &str = "87008a8e9fdd6d1ab31d8a5cea197c6404b177e243d18de200f1cf0aff6706c3";

const TOKEN_NAME: &str = "Spike Test 1 YES";
const TOKEN_SYMBOL: &str = "SPK1-YES";
const TOKEN_URI: &str = "https://example.invalid/spike-test-1-yes.json";

const YES: u8 = 0;
const NO: u8 = 1;

fn symbol_hash() -> [u8; 32] {
    hex32(SYMBOL_HASH_HEX)
}

fn create_market_ix(authority: &Pubkey, symbol: &str, symbol_hash: [u8; 32]) -> Instruction {
    Instruction::new_with_bytes(
        outcome_tokens::id(),
        &outcome_tokens::instruction::SpikeCreateMarket {
            symbol: symbol.to_string(),
            symbol_hash,
        }
        .data(),
        outcome_tokens::accounts::SpikeCreateMarket {
            authority: *authority,
            market: market_address(&symbol_hash),
            program: outcome_tokens::id(),
            program_data: program_data_address(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn create_mint_ix(payer: &Pubkey, market: &Pubkey, side: u8) -> Instruction {
    Instruction::new_with_bytes(
        outcome_tokens::id(),
        &outcome_tokens::instruction::SpikeCreateMint {
            side,
            name: TOKEN_NAME.to_string(),
            symbol: TOKEN_SYMBOL.to_string(),
            uri: TOKEN_URI.to_string(),
        }
        .data(),
        outcome_tokens::accounts::SpikeCreateMint {
            payer: *payer,
            market: *market,
            mint: mint_address(market, side),
            token_program: spl_token_2022::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn mint_ix(
    user: &Pubkey,
    market: &Pubkey,
    mint: &Pubkey,
    user_token: &Pubkey,
    amount: u64,
) -> Instruction {
    Instruction::new_with_bytes(
        outcome_tokens::id(),
        &outcome_tokens::instruction::SpikeMint { amount }.data(),
        outcome_tokens::accounts::SpikeMint {
            user: *user,
            market: *market,
            mint: *mint,
            user_token: *user_token,
            token_program: spl_token_2022::ID,
        }
        .to_account_metas(None),
    )
}

/// Market created by the upgrade authority plus its YES mint, paid for by `admin`.
fn market_with_yes_mint(svm: &mut LiteSVM, admin: &Keypair) -> (Pubkey, Pubkey) {
    let market = market_address(&symbol_hash());
    send_ok(
        svm,
        &[create_market_ix(&admin.pubkey(), SYMBOL, symbol_hash())],
        &[admin],
    );
    send_ok(
        svm,
        &[create_mint_ix(&admin.pubkey(), &market, YES)],
        &[admin],
    );
    (market, mint_address(&market, YES))
}

fn mint_supply(svm: &LiteSVM, mint: &Pubkey) -> u64 {
    let account = svm.get_account(mint).expect("mint exists");
    StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&account.data)
        .unwrap()
        .base
        .supply
}

#[test]
fn create_market_is_gated_on_the_upgrade_authority() {
    let Fixture { mut svm, admin } = setup();
    let stranger = funded_keypair(&mut svm, 2);
    let market = market_address(&symbol_hash());

    let result = send(
        &mut svm,
        &[create_market_ix(&stranger.pubkey(), SYMBOL, symbol_hash())],
        &[&stranger],
    );
    assert_custom_error(result, program_error(ErrorCode::NotUpgradeAuthority));
    assert!(is_closed(&svm, &market));

    let units = send_ok(
        &mut svm,
        &[create_market_ix(&admin.pubkey(), SYMBOL, symbol_hash())],
        &[&admin],
    );
    println!("compute units: spike_create_market = {units}");
    assert!(units < 200_000);

    // The program hashed the symbol on-chain and accepted the reference digest.
    let state: SpikeMarket = load(&svm, &market);
    assert_eq!(state.symbol_hash, symbol_hash());
    let (_, bump) = Pubkey::find_program_address(
        &[outcome_tokens::MARKET_SEED, &symbol_hash()],
        &outcome_tokens::id(),
    );
    assert_eq!(state.bump, bump);
    assert_eq!(
        svm.get_account(&market).unwrap().owner,
        outcome_tokens::id()
    );
}

#[test]
fn create_market_rejects_a_hash_that_is_not_sha256_of_the_symbol() {
    let Fixture { mut svm, admin } = setup();
    let mut wrong_hash = symbol_hash();
    wrong_hash[0] ^= 1;

    let result = send(
        &mut svm,
        &[create_market_ix(&admin.pubkey(), SYMBOL, wrong_hash)],
        &[&admin],
    );
    assert_custom_error(result, program_error(ErrorCode::SymbolHashMismatch));
    assert!(is_closed(&svm, &market_address(&wrong_hash)));
}

#[test]
fn create_mint_builds_a_token_2022_mint_with_metadata_at_a_pda() {
    let Fixture { mut svm, admin } = setup();
    let payer = funded_keypair(&mut svm, 3);
    let market = market_address(&symbol_hash());
    send_ok(
        &mut svm,
        &[create_market_ix(&admin.pubkey(), SYMBOL, symbol_hash())],
        &[&admin],
    );

    let units = send_ok(
        &mut svm,
        &[create_mint_ix(&payer.pubkey(), &market, YES)],
        &[&payer],
    );
    println!("compute units: spike_create_mint = {units}");
    assert!(units < 200_000);

    let mint = mint_address(&market, YES);
    let account = svm.get_account(&mint).expect("mint exists");
    assert_eq!(account.owner, spl_token_2022::ID);
    assert_ne!(account.owner, spl_token::ID);

    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&account.data).unwrap();
    assert!(state.base.is_initialized);
    assert_eq!(state.base.decimals, 2);
    assert_eq!(state.base.supply, 0);
    assert_eq!(state.base.mint_authority, COption::Some(market));
    assert_eq!(state.base.freeze_authority, COption::None);
    assert_eq!(
        state.get_extension_types().unwrap(),
        vec![ExtensionType::MetadataPointer, ExtensionType::TokenMetadata]
    );

    let pointer = state.get_extension::<MetadataPointer>().unwrap();
    assert_eq!(Option::<Pubkey>::from(pointer.authority), Some(market));
    assert_eq!(Option::<Pubkey>::from(pointer.metadata_address), Some(mint));

    let metadata = state.get_variable_len_extension::<TokenMetadata>().unwrap();
    assert_eq!(metadata.name, TOKEN_NAME);
    assert_eq!(metadata.symbol, TOKEN_SYMBOL);
    assert_eq!(metadata.uri, TOKEN_URI);
    assert_eq!(metadata.mint, mint);
    assert_eq!(
        Option::<Pubkey>::from(metadata.update_authority),
        Some(market)
    );
    assert!(metadata.additional_metadata.is_empty());

    // The top-up after the metadata CPI leaves exactly the rent-exempt minimum.
    assert_eq!(
        account.lamports,
        svm.minimum_balance_for_rent_exemption(account.data.len())
    );

    // The other side gets its own mint; anything else is refused.
    send_ok(
        &mut svm,
        &[create_mint_ix(&payer.pubkey(), &market, NO)],
        &[&payer],
    );
    assert_ne!(mint_address(&market, NO), mint);
    assert_eq!(
        svm.get_account(&mint_address(&market, NO)).unwrap().owner,
        spl_token_2022::ID
    );
    let result = send(
        &mut svm,
        &[create_mint_ix(&payer.pubkey(), &market, 2)],
        &[&payer],
    );
    assert_custom_error(result, program_error(ErrorCode::InvalidSide));
}

#[test]
fn create_mint_succeeds_when_the_mint_address_was_prefunded() {
    let Fixture { mut svm, admin } = setup();
    let market = market_address(&symbol_hash());
    let mint = mint_address(&market, YES);
    // Anyone can send lamports to the future mint address before it is created.
    let prefund = svm.minimum_balance_for_rent_exemption(0);
    send_ok(
        &mut svm,
        &[
            create_market_ix(&admin.pubkey(), SYMBOL, symbol_hash()),
            system_instruction::transfer(&admin.pubkey(), &mint, prefund),
        ],
        &[&admin],
    );
    assert_eq!(lamports(&svm, &mint), prefund);

    send_ok(
        &mut svm,
        &[create_mint_ix(&admin.pubkey(), &market, YES)],
        &[&admin],
    );

    let account = svm.get_account(&mint).unwrap();
    assert_eq!(account.owner, spl_token_2022::ID);
    assert!(account.lamports >= svm.minimum_balance_for_rent_exemption(account.data.len()));
}

#[test]
fn mint_to_the_users_token_2022_ata_is_signed_by_the_market_pda() {
    let Fixture { mut svm, admin } = setup();
    let (market, mint) = market_with_yes_mint(&mut svm, &admin);
    let user = funded_keypair(&mut svm, 4);
    let user_token = ata_address(&user.pubkey(), &mint, &spl_token_2022::ID);
    assert_ne!(
        user_token,
        ata_address(&user.pubkey(), &mint, &spl_token::ID)
    );

    send_ok(
        &mut svm,
        &[create_ata_idempotent_ix(
            &user.pubkey(),
            &user.pubkey(),
            &mint,
            &spl_token_2022::ID,
        )],
        &[&user],
    );
    let units = send_ok(
        &mut svm,
        &[mint_ix(&user.pubkey(), &market, &mint, &user_token, 100)],
        &[&user],
    );
    println!("compute units: spike_mint = {units}");
    assert!(units < 200_000);

    assert_eq!(mint_supply(&svm, &mint), 100);

    let account = svm.get_account(&user_token).expect("token account exists");
    assert_eq!(account.owner, spl_token_2022::ID);
    let token =
        StateWithExtensions::<spl_token_2022::state::Account>::unpack(&account.data).unwrap();
    assert_eq!(token.base.amount, 100);
    assert_eq!(token.base.owner, user.pubkey());
    assert_eq!(token.base.mint, mint);
}

#[test]
fn mint_rejects_zero_and_a_token_account_that_is_not_the_users_ata() {
    let Fixture { mut svm, admin } = setup();
    let (market, mint) = market_with_yes_mint(&mut svm, &admin);
    let user = funded_keypair(&mut svm, 4);
    let user_token = ata_address(&user.pubkey(), &mint, &spl_token_2022::ID);
    send_ok(
        &mut svm,
        &[create_ata_idempotent_ix(
            &user.pubkey(),
            &user.pubkey(),
            &mint,
            &spl_token_2022::ID,
        )],
        &[&user],
    );

    let result = send(
        &mut svm,
        &[mint_ix(&user.pubkey(), &market, &mint, &user_token, 0)],
        &[&user],
    );
    assert_custom_error(result, program_error(ErrorCode::ZeroAmount));

    // A Token-2022 account of the right mint and owner, but at a keypair address.
    let other = Keypair::new();
    let space = spl_token_2022::state::Account::LEN;
    let rent = svm.minimum_balance_for_rent_exemption(space);
    send_ok(
        &mut svm,
        &[
            system_instruction::create_account(
                &user.pubkey(),
                &other.pubkey(),
                rent,
                space as u64,
                &spl_token_2022::ID,
            ),
            spl_token_2022::instruction::initialize_account3(
                &spl_token_2022::ID,
                &other.pubkey(),
                &mint,
                &user.pubkey(),
            )
            .unwrap(),
        ],
        &[&user, &other],
    );
    let result = send(
        &mut svm,
        &[mint_ix(
            &user.pubkey(),
            &market,
            &mint,
            &other.pubkey(),
            100,
        )],
        &[&user],
    );
    assert_custom_error(
        result,
        anchor_error(anchor_lang::error::ErrorCode::ConstraintAssociated),
    );
    assert_eq!(mint_supply(&svm, &mint), 0);
}
