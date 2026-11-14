//! The shared fixture itself: what `setup` and `initialize_default` provide, the clock
//! helpers, the stable token helpers and the assertion helpers.

mod common;

use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{program_option::COption, program_pack::Pack, system_instruction},
    },
    anchor_spl::token::spl_token,
    common::*,
    outcome_tokens::{constants::STABLE_DECIMALS, error::ErrorCode, state::Config},
    solana_signer::Signer,
};

#[test]
fn setup_deploys_the_program_with_the_admin_as_upgrade_authority() {
    let env = setup();

    let program_data = env.svm.get_account(&program_data_address()).unwrap();
    assert_eq!(program_data.data[12], 1);
    assert_eq!(program_data.data[13..45], env.admin.pubkey().to_bytes());
    assert_eq!(env.config, config_address());
    assert!(is_closed(&env.svm, &env.config));
}

#[test]
fn setup_creates_a_classic_six_decimal_stable_mint_and_a_treasury() {
    let env = setup();

    let account = env.svm.get_account(&env.stable_mint).unwrap();
    assert_eq!(account.owner, spl_token::ID);
    let mint = spl_token::state::Mint::unpack(&account.data).unwrap();
    assert_eq!(mint.decimals, STABLE_DECIMALS);
    assert_eq!(mint.mint_authority, COption::Some(env.issuer.pubkey()));
    assert_eq!(mint.freeze_authority, COption::None);
    assert_eq!(mint.supply, 0);

    assert_eq!(
        env.svm.get_account(&env.treasury).unwrap().owner,
        spl_token::ID
    );
    let treasury = token_account(&env.svm, &env.treasury);
    assert_eq!(treasury.mint, env.stable_mint);
    assert_eq!(treasury.owner, env.admin.pubkey());
    assert_eq!(treasury.amount, 0);

    // Fixed keys: every run sees the same role wallets and the same stable mint.
    let again = setup();
    assert_eq!(again.stable_mint, env.stable_mint);
    assert_eq!(again.admin.pubkey(), env.admin.pubkey());
    assert_eq!(again.relayer.pubkey(), env.relayer.pubkey());
    assert_eq!(again.settler.pubkey(), env.settler.pubkey());
    assert_eq!(again.registrar.pubkey(), env.registrar.pubkey());
    assert_eq!(again.issuer.pubkey(), env.issuer.pubkey());
}

#[test]
fn the_clock_starts_at_a_realistic_time_and_moves_only_when_told() {
    let mut env = setup();
    assert_eq!(now(&env.svm), START_TIME);

    advance_time(&mut env.svm, 90);
    assert_eq!(now(&env.svm), START_TIME + 90);

    set_time(&mut env.svm, START_TIME + 5);
    assert_eq!(now(&env.svm), START_TIME + 5);

    // Moving the slot leaves the timestamp alone, which is why the helpers exist.
    let slot = env.svm.get_sysvar::<Clock>().slot;
    env.svm.warp_to_slot(slot + 1_000_000);
    assert_eq!(now(&env.svm), START_TIME + 5);

    // Transactions do not move it either.
    let transfer = system_instruction::transfer(&env.admin.pubkey(), &env.relayer.pubkey(), 1);
    send_ok(&mut env.svm, &[transfer], &[&env.admin]);
    assert_eq!(now(&env.svm), START_TIME + 5);
}

#[test]
fn funded_keypairs_are_deterministic_and_funded() {
    let mut env = setup();

    let first = funded_keypair(&mut env.svm, 10);
    let second = funded_keypair(&mut setup().svm, 10);
    let other = funded_keypair(&mut env.svm, 11);

    assert_eq!(first.pubkey(), second.pubkey());
    assert_ne!(first.pubkey(), other.pubkey());
    assert_eq!(lamports(&env.svm, &other.pubkey()), 10 * LAMPORTS_PER_SOL);
    assert_eq!(lamports(&env.svm, &Pubkey::new_from_array([99; 32])), 0);
}

#[test]
fn stable_tokens_can_be_minted_to_a_user() {
    let mut env = setup();
    let user = Pubkey::new_from_array([10; 32]);

    let account = create_stable_account(&mut env, &user, 250_000_000);

    assert_eq!(env.svm.get_account(&account).unwrap().owner, spl_token::ID);
    let state = token_account(&env.svm, &account);
    assert_eq!(state.mint, env.stable_mint);
    assert_eq!(state.owner, user);
    assert_eq!(token_balance(&env.svm, &account), 250_000_000);

    mint_stable(&mut env, &account, 50_000_000);
    assert_eq!(token_balance(&env.svm, &account), 300_000_000);

    // Each call makes a new account; the user may hold several.
    let second = create_stable_account(&mut env, &user, 0);
    assert_ne!(second, account);
    assert_eq!(token_balance(&env.svm, &second), 0);
}

#[test]
fn initialize_default_writes_the_fixture_configuration() {
    let env = initialize_default();

    let config: Config = load(&env.svm, &env.config);
    assert_eq!(config.admin, env.admin.pubkey());
    assert_eq!(config.relayer, env.relayer.pubkey());
    assert_eq!(config.settler, env.settler.pubkey());
    assert_eq!(config.registrar, env.registrar.pubkey());
    assert_eq!(config.stable_mint, env.stable_mint);
    assert_eq!(config.treasury, env.treasury);
    assert_eq!(config.order_ttl_secs, ORDER_TTL_SECS);
    assert_eq!(config.min_order_units, MIN_ORDER_UNITS);
    assert_eq!(config.max_order_units, MAX_ORDER_UNITS);
    assert_eq!(config.settle_delay_secs, SETTLE_DELAY_SECS);
    assert_eq!(config.pause_flags, 0);
}

#[test]
fn send_reports_compute_units_on_success() {
    let mut env = initialize_default();
    let admin = env.admin.pubkey();
    let instruction = set_pause_ix(&env, &admin, 0);

    let units = send(&mut env.svm, &[instruction], &[&env.admin]).unwrap();

    assert!(units > 0);
}

#[test]
fn a_repeated_instruction_reaches_the_program_again() {
    let mut env = initialize_default();
    let stranger = funded_keypair(&mut env.svm, 10);

    // Identical bytes each time: without a fresh blockhash the second send would be
    // dropped as a duplicate before the program saw it.
    for _ in 0..2 {
        let instruction = set_pause_ix(&env, &stranger.pubkey(), 0);
        let result = send(&mut env.svm, &[instruction], &[&stranger]);
        assert_err(result, ErrorCode::Unauthorized);
    }
}

#[test]
#[should_panic(expected = "transaction succeeded")]
fn assert_err_fails_when_the_transaction_succeeds() {
    let mut env = initialize_default();
    let admin = env.admin.pubkey();
    let instruction = set_pause_ix(&env, &admin, 0);

    let result = send(&mut env.svm, &[instruction], &[&env.admin]);

    assert_err(result, ErrorCode::Unauthorized);
}

#[test]
#[should_panic(expected = "left: 6000")]
fn assert_err_fails_on_a_different_error() {
    let mut env = initialize_default();
    let stranger = funded_keypair(&mut env.svm, 10);
    let instruction = set_pause_ix(&env, &stranger.pubkey(), 0);

    // The program answers `Unauthorized` (6000); expecting anything else must fail.
    let result = send(&mut env.svm, &[instruction], &[&stranger]);

    assert_err(result, ErrorCode::BadConfig);
}
