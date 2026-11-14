//! `create_market`, `create_outcome_mint` and `set_market`.

mod common;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{program_option::COption, system_instruction},
        AccountSerialize, Space,
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
    outcome_tokens::{
        accounts,
        constants::{CUTOFF_MIN_SECS, MARKET_SEED, PX_MAX},
        error::ErrorCode,
        events::{MarketCreated, MarketStatusChanged, OutcomeMintCreated},
        instruction::{CreateMarket, CreateOutcomeMint},
        state::{Market, MarketStatus, Side},
    },
    solana_signer::Signer,
};

/// Sends `create_market` signed and paid for by the relayer.
fn create_market(env: &mut Env, args: CreateMarket) -> SendResult {
    let relayer = env.relayer.pubkey();
    let instruction = create_market_ix(env, &relayer, &relayer, args);
    send(&mut env.svm, &[instruction], &[&env.relayer])
}

/// An initialized program with the fixture's market, which has no mints yet.
fn env_with_market() -> (Env, Pubkey) {
    let mut env = initialize_default();
    let args = create_market_args(&env, MARKET_SYMBOL);
    let market = market_address(&args.symbol_hash);
    create_market(&mut env, args).unwrap();
    (env, market)
}

/// Sends `create_outcome_mint` signed and paid for by the relayer.
fn create_outcome_mint(env: &mut Env, market: &Pubkey, args: CreateOutcomeMint) -> SendResult {
    let relayer = env.relayer.pubkey();
    let instruction = create_outcome_mint_ix(env, &relayer, &relayer, market, args);
    send(&mut env.svm, &[instruction], &[&env.relayer])
}

fn set_market(
    env: &mut Env,
    authority: &solana_keypair::Keypair,
    market: &Pubkey,
    status: Option<MarketStatus>,
    close_ts: Option<i64>,
) -> SendResult {
    let instruction = set_market_ix(env, &authority.pubkey(), market, status, close_ts);
    send(&mut env.svm, &[instruction], &[authority])
}

fn market_status(env: &Env, market: &Pubkey) -> u8 {
    load::<Market>(&env.svm, market).status
}

// --- create_market ---------------------------------------------------------------------

#[test]
fn create_market_stores_every_field() {
    let mut env = initialize_default();
    // A separate payer shows that the relayer only has to sign.
    let payer = funded_keypair(&mut env.svm, 10);
    let symbol = "GEMI-BTC100K-31DEC26-YES";
    let close_ts = now(&env.svm) + 1;
    let args = CreateMarket {
        symbol_hash: symbol_hash(symbol),
        symbol: symbol.to_string(),
        close_ts,
        place_cutoff_secs: CUTOFF_MIN_SECS,
        tick_px: PX_MAX,
        max_supply_units: 1,
    };
    let market = market_address(&args.symbol_hash);
    let relayer_lamports = lamports(&env.svm, &env.relayer.pubkey());

    let instruction = create_market_ix(&env, &env.relayer.pubkey(), &payer.pubkey(), args);
    let meta = send_ok(&mut env.svm, &[instruction], &[&payer, &env.relayer]);
    println!(
        "compute units: create_market = {}",
        meta.compute_units_consumed
    );

    let stored: Market = load(&env.svm, &market);
    assert_eq!(stored.symbol_hash, symbol_hash(symbol));
    assert_eq!(stored.symbol, symbol);
    assert_eq!(stored.yes_mint, Pubkey::default());
    assert_eq!(stored.no_mint, Pubkey::default());
    assert_eq!(stored.status, MarketStatus::Open as u8);
    assert_eq!(stored.close_ts, close_ts);
    assert_eq!(stored.place_cutoff_secs, CUTOFF_MIN_SECS);
    assert_eq!(stored.tick_px, PX_MAX);
    assert_eq!(stored.max_supply_units, 1);
    assert_eq!(stored.yes_payout, 0);
    assert_eq!(stored.no_payout, 0);
    assert_eq!(stored.redeem_after, 0);
    let (address, bump) =
        Pubkey::find_program_address(&[MARKET_SEED, &symbol_hash(symbol)], &outcome_tokens::id());
    assert_eq!(market, address);
    assert_eq!(stored.bump, bump);
    assert_eq!(stored.reserved, [0; 64]);

    let account = env.svm.get_account(&market).unwrap();
    assert_eq!(account.owner, outcome_tokens::id());
    assert_eq!(account.data.len(), 8 + Market::INIT_SPACE);
    assert_eq!(
        account.lamports,
        env.svm
            .minimum_balance_for_rent_exemption(account.data.len())
    );
    // The payer funds the account and the fee, not the relayer.
    assert_eq!(lamports(&env.svm, &env.relayer.pubkey()), relayer_lamports);

    let logged = events::<MarketCreated>(&meta);
    assert_eq!(logged.len(), 1);
    assert_eq!(logged[0].market, market);
    assert_eq!(logged[0].symbol, symbol);
}

#[test]
fn create_market_accepts_a_64_byte_symbol() {
    let mut env = initialize_default();
    let symbol = "A".repeat(64);
    let args = create_market_args(&env, &symbol);
    let market = market_address(&args.symbol_hash);

    create_market(&mut env, args).unwrap();

    assert_eq!(load::<Market>(&env.svm, &market).symbol, symbol);
}

#[test]
fn create_market_requires_the_relayer() {
    let mut env = initialize_default();
    let args = create_market_args(&env, MARKET_SYMBOL);
    let market = market_address(&args.symbol_hash);

    // The admin holds no market role.
    let admin = env.admin.pubkey();
    let instruction = create_market_ix(&env, &admin, &admin, args);
    let result = send(&mut env.svm, &[instruction], &[&env.admin]);

    assert_err(result, ErrorCode::Unauthorized);
    assert!(is_closed(&env.svm, &market));
}

#[test]
fn create_market_rejects_symbols_outside_the_alphabet_or_length() {
    let mut env = initialize_default();
    let too_long = "A".repeat(65);
    for symbol in [
        "btc-100k",
        "BTC 100K",
        "BTC_100K",
        "BTC-100K\n",
        "",
        &too_long,
    ] {
        let args = create_market_args(&env, symbol);
        let market = market_address(&args.symbol_hash);

        let result = create_market(&mut env, args);

        assert_err(result, ErrorCode::BadSymbol);
        assert!(is_closed(&env.svm, &market), "{symbol:?}");
    }
}

#[test]
fn create_market_rejects_a_hash_that_is_not_sha256_of_the_symbol() {
    let mut env = initialize_default();
    let args = CreateMarket {
        symbol_hash: symbol_hash("TEST-MARKET-2"),
        ..create_market_args(&env, MARKET_SYMBOL)
    };
    let market = market_address(&args.symbol_hash);

    let result = create_market(&mut env, args);

    assert_err(result, ErrorCode::BadSymbolHash);
    assert!(is_closed(&env.svm, &market));
}

#[test]
fn create_market_rejects_each_range_violation() {
    let mut env = initialize_default();
    let now = now(&env.svm);
    let valid = || create_market_args(&env, MARKET_SYMBOL);
    let cases = [
        CreateMarket {
            place_cutoff_secs: CUTOFF_MIN_SECS - 1,
            ..valid()
        },
        CreateMarket {
            tick_px: 0,
            ..valid()
        },
        CreateMarket {
            tick_px: PX_MAX + 1,
            ..valid()
        },
        CreateMarket {
            max_supply_units: 0,
            ..valid()
        },
        // The close time must be strictly in the future.
        CreateMarket {
            close_ts: now,
            ..valid()
        },
        CreateMarket {
            close_ts: now - 1,
            ..valid()
        },
    ];
    for args in cases {
        let result = create_market(&mut env, args);
        assert_err(result, ErrorCode::BadConfig);
    }
    assert!(is_closed(
        &env.svm,
        &market_address(&symbol_hash(MARKET_SYMBOL))
    ));
}

#[test]
fn create_market_fails_for_a_symbol_that_already_has_a_market() {
    let (mut env, market) = env_with_market();
    let before = env.svm.get_account(&market).unwrap();

    let args = CreateMarket {
        tick_px: 1,
        ..create_market_args(&env, MARKET_SYMBOL)
    };
    let result = create_market(&mut env, args);

    assert_already_in_use(result);
    assert_eq!(env.svm.get_account(&market).unwrap(), before);
}

// --- create_outcome_mint ---------------------------------------------------------------

#[test]
fn create_outcome_mint_builds_a_token_2022_mint_with_metadata_for_both_sides() {
    let (mut env, market) = env_with_market();

    for side in [Side::Yes, Side::No] {
        let args = outcome_mint_args(side);
        let (name, ticker, uri) = (args.name.clone(), args.ticker.clone(), args.uri.clone());
        let mint = mint_address(&market, side);

        let relayer = env.relayer.pubkey();
        let instruction = create_outcome_mint_ix(&env, &relayer, &relayer, &market, args);
        let meta = send_ok(&mut env.svm, &[instruction], &[&env.relayer]);
        println!(
            "compute units: create_outcome_mint({side:?}) = {}",
            meta.compute_units_consumed
        );

        let account = env.svm.get_account(&mint).expect("mint exists");
        assert_eq!(account.owner, spl_token_2022::ID);
        let state =
            StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&account.data).unwrap();
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
        assert_eq!(metadata.name, name);
        assert_eq!(metadata.symbol, ticker);
        assert_eq!(metadata.uri, uri);
        assert_eq!(metadata.mint, mint);
        assert_eq!(
            Option::<Pubkey>::from(metadata.update_authority),
            Some(market)
        );
        assert!(metadata.additional_metadata.is_empty());

        assert_eq!(
            account.lamports,
            env.svm
                .minimum_balance_for_rent_exemption(account.data.len())
        );

        let stored: Market = load(&env.svm, &market);
        match side {
            Side::Yes => {
                assert_eq!(stored.yes_mint, mint);
                assert_eq!(stored.no_mint, Pubkey::default());
            }
            Side::No => {
                assert_eq!(stored.yes_mint, mint_address(&market, Side::Yes));
                assert_eq!(stored.no_mint, mint);
            }
        }

        let logged = events::<OutcomeMintCreated>(&meta);
        assert_eq!(logged.len(), 1);
        assert_eq!(logged[0].market, market);
        assert_eq!(logged[0].side, side as u8);
        assert_eq!(logged[0].mint, mint);
    }
    assert_ne!(
        mint_address(&market, Side::Yes),
        mint_address(&market, Side::No)
    );
}

#[test]
fn create_outcome_mint_fails_when_the_side_already_has_a_mint() {
    let mut env = initialize_default();
    let keys = create_market_with_mints(&mut env, MARKET_SYMBOL);

    for side in [Side::Yes, Side::No] {
        let mint = keys.mint(side);
        assert_eq!(mint, mint_address(&keys.market, side));
        let before = env.svm.get_account(&mint).unwrap();

        let args = CreateOutcomeMint {
            name: "Another name".to_string(),
            ..outcome_mint_args(side)
        };
        let result = create_outcome_mint(&mut env, &keys.market, args);

        assert_err(result, ErrorCode::MintAlreadyCreated);
        assert_eq!(env.svm.get_account(&mint).unwrap(), before);
    }
    let stored: Market = load(&env.svm, &keys.market);
    assert_eq!(stored.yes_mint, keys.yes_mint);
    assert_eq!(stored.no_mint, keys.no_mint);
    assert_eq!(stored.close_ts, keys.close_ts);
}

#[test]
fn create_outcome_mint_requires_the_relayer() {
    let (mut env, market) = env_with_market();

    let admin = env.admin.pubkey();
    let instruction =
        create_outcome_mint_ix(&env, &admin, &admin, &market, outcome_mint_args(Side::Yes));
    let result = send(&mut env.svm, &[instruction], &[&env.admin]);

    assert_err(result, ErrorCode::Unauthorized);
    assert!(is_closed(&env.svm, &mint_address(&market, Side::Yes)));
    assert_eq!(
        load::<Market>(&env.svm, &market).yes_mint,
        Pubkey::default()
    );
}

#[test]
fn create_outcome_mint_rejects_metadata_outside_the_length_limits() {
    let (mut env, market) = env_with_market();
    let valid = || outcome_mint_args(Side::Yes);
    let cases = [
        CreateOutcomeMint {
            name: String::new(),
            ..valid()
        },
        CreateOutcomeMint {
            name: "N".repeat(33),
            ..valid()
        },
        CreateOutcomeMint {
            ticker: String::new(),
            ..valid()
        },
        CreateOutcomeMint {
            ticker: "T".repeat(11),
            ..valid()
        },
        CreateOutcomeMint {
            uri: "u".repeat(201),
            ..valid()
        },
    ];
    for args in cases {
        let result = create_outcome_mint(&mut env, &market, args);
        assert_err(result, ErrorCode::BadConfig);
    }
    assert!(is_closed(&env.svm, &mint_address(&market, Side::Yes)));
}

#[test]
fn create_outcome_mint_accepts_an_empty_uri_and_the_longest_metadata() {
    let (mut env, market) = env_with_market();
    let yes = CreateOutcomeMint {
        side: Side::Yes,
        name: "N".repeat(32),
        ticker: "T".repeat(10),
        uri: String::new(),
    };
    let no = CreateOutcomeMint {
        uri: "u".repeat(200),
        ..outcome_mint_args(Side::No)
    };

    create_outcome_mint(&mut env, &market, yes).unwrap();
    create_outcome_mint(&mut env, &market, no).unwrap();

    for (side, name_len, uri_len) in [(Side::Yes, 32, 0), (Side::No, 16, 200)] {
        let account = env.svm.get_account(&mint_address(&market, side)).unwrap();
        let state =
            StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&account.data).unwrap();
        let metadata = state.get_variable_len_extension::<TokenMetadata>().unwrap();
        assert_eq!(metadata.name.len(), name_len);
        assert_eq!(metadata.uri.len(), uri_len);
        assert_eq!(
            account.lamports,
            env.svm
                .minimum_balance_for_rent_exemption(account.data.len())
        );
    }
}

#[test]
fn create_outcome_mint_works_when_the_mint_address_already_holds_lamports() {
    let (mut env, market) = env_with_market();
    let mint = mint_address(&market, Side::Yes);
    // Anyone can send lamports to the address before the mint exists.
    let stranger = funded_keypair(&mut env.svm, 10);
    let lamports = env.svm.minimum_balance_for_rent_exemption(0);
    let donation = system_instruction::transfer(&stranger.pubkey(), &mint, lamports);
    send_ok(&mut env.svm, &[donation], &[&stranger]);

    create_outcome_mint(&mut env, &market, outcome_mint_args(Side::Yes)).unwrap();

    let account = env.svm.get_account(&mint).unwrap();
    assert_eq!(account.owner, spl_token_2022::ID);
    assert_eq!(
        account.lamports,
        env.svm
            .minimum_balance_for_rent_exemption(account.data.len())
    );
    assert_eq!(load::<Market>(&env.svm, &market).yes_mint, mint);
}

#[test]
fn create_outcome_mint_rejects_the_other_sides_address_and_the_classic_token_program() {
    let (mut env, market) = env_with_market();
    let relayer = env.relayer.pubkey();
    let valid = accounts::CreateOutcomeMint {
        relayer,
        payer: relayer,
        config: env.config,
        market,
        mint: mint_address(&market, Side::Yes),
        token_program: spl_token_2022::ID,
        system_program: anchor_lang::solana_program::system_program::ID,
    };

    let other_side = accounts::CreateOutcomeMint {
        mint: mint_address(&market, Side::No),
        ..valid
    };
    let result = send(
        &mut env.svm,
        &[instruction(other_side, outcome_mint_args(Side::Yes))],
        &[&env.relayer],
    );
    assert_anchor_err(result, anchor_lang::error::ErrorCode::ConstraintSeeds);

    let classic_program = accounts::CreateOutcomeMint {
        relayer,
        payer: relayer,
        config: env.config,
        market,
        mint: mint_address(&market, Side::Yes),
        token_program: spl_token::ID,
        system_program: anchor_lang::solana_program::system_program::ID,
    };
    let result = send(
        &mut env.svm,
        &[instruction(classic_program, outcome_mint_args(Side::Yes))],
        &[&env.relayer],
    );
    assert_anchor_err(result, anchor_lang::error::ErrorCode::InvalidProgramId);
}

// --- set_market ------------------------------------------------------------------------

#[test]
fn set_market_lets_the_relayer_halt_but_only_the_admin_reopen() {
    let (mut env, market) = env_with_market();
    let close_ts = load::<Market>(&env.svm, &market).close_ts;
    let (relayer, admin) = (env.relayer.insecure_clone(), env.admin.insecure_clone());

    let instruction = set_market_ix(
        &env,
        &relayer.pubkey(),
        &market,
        Some(MarketStatus::Halted),
        None,
    );
    let meta = send_ok(&mut env.svm, &[instruction], &[&relayer]);
    println!(
        "compute units: set_market = {}",
        meta.compute_units_consumed
    );
    assert_eq!(market_status(&env, &market), MarketStatus::Halted as u8);
    let logged = events::<MarketStatusChanged>(&meta);
    assert_eq!(logged.len(), 1);
    assert_eq!(logged[0].market, market);
    assert_eq!(logged[0].status, MarketStatus::Halted as u8);
    assert_eq!(logged[0].close_ts, close_ts);

    let result = set_market(&mut env, &relayer, &market, Some(MarketStatus::Open), None);
    assert_err(result, ErrorCode::Unauthorized);
    assert_eq!(market_status(&env, &market), MarketStatus::Halted as u8);

    set_market(&mut env, &admin, &market, Some(MarketStatus::Open), None).unwrap();
    assert_eq!(market_status(&env, &market), MarketStatus::Open as u8);

    // The admin can halt as well.
    set_market(&mut env, &admin, &market, Some(MarketStatus::Halted), None).unwrap();
    assert_eq!(market_status(&env, &market), MarketStatus::Halted as u8);
}

#[test]
fn set_market_rejects_settled_as_a_target() {
    let (mut env, market) = env_with_market();
    let (relayer, admin) = (env.relayer.insecure_clone(), env.admin.insecure_clone());

    for authority in [&relayer, &admin] {
        let result = set_market(
            &mut env,
            authority,
            &market,
            Some(MarketStatus::Settled),
            None,
        );
        assert_err(result, ErrorCode::BadConfig);
    }
    assert_eq!(market_status(&env, &market), MarketStatus::Open as u8);
}

#[test]
fn set_market_lets_the_relayer_update_the_close_time() {
    let (mut env, market) = env_with_market();
    let relayer = env.relayer.insecure_clone();
    let close_ts = load::<Market>(&env.svm, &market).close_ts + 3_600;

    let instruction = set_market_ix(&env, &relayer.pubkey(), &market, None, Some(close_ts));
    let meta = send_ok(&mut env.svm, &[instruction], &[&relayer]);

    let stored: Market = load(&env.svm, &market);
    assert_eq!(stored.close_ts, close_ts);
    assert_eq!(stored.status, MarketStatus::Open as u8);
    let logged = events::<MarketStatusChanged>(&meta);
    assert_eq!(logged[0].status, MarketStatus::Open as u8);
    assert_eq!(logged[0].close_ts, close_ts);

    // Both fields can change in one call.
    set_market(
        &mut env,
        &relayer,
        &market,
        Some(MarketStatus::Halted),
        Some(close_ts + 1),
    )
    .unwrap();
    let stored: Market = load(&env.svm, &market);
    assert_eq!(stored.close_ts, close_ts + 1);
    assert_eq!(stored.status, MarketStatus::Halted as u8);
}

#[test]
fn set_market_rejects_a_stranger_and_the_other_roles() {
    let (mut env, market) = env_with_market();
    let before = env.svm.get_account(&market).unwrap();
    let stranger = funded_keypair(&mut env.svm, 10);
    let (settler, registrar) = (env.settler.insecure_clone(), env.registrar.insecure_clone());

    for authority in [&stranger, &settler, &registrar] {
        let result = set_market(
            &mut env,
            authority,
            &market,
            Some(MarketStatus::Halted),
            Some(1),
        );
        assert_err(result, ErrorCode::Unauthorized);
    }
    assert_eq!(env.svm.get_account(&market).unwrap(), before);
}

#[test]
fn set_market_cannot_change_a_settled_market() {
    let (mut env, market) = env_with_market();
    // Settlement arrives with a later instruction; write the status directly.
    let mut account = env.svm.get_account(&market).unwrap();
    let mut stored: Market = load(&env.svm, &market);
    stored.status = MarketStatus::Settled as u8;
    let mut data = Vec::new();
    stored.try_serialize(&mut data).unwrap();
    account.data[..data.len()].copy_from_slice(&data);
    env.svm.set_account(market, account.clone()).unwrap();
    let (relayer, admin) = (env.relayer.insecure_clone(), env.admin.insecure_clone());

    for (authority, status, close_ts) in [
        (&relayer, Some(MarketStatus::Halted), None),
        (&relayer, None, Some(stored.close_ts + 1)),
        (&admin, Some(MarketStatus::Open), None),
        (&admin, Some(MarketStatus::Settled), None),
    ] {
        let result = set_market(&mut env, authority, &market, status, close_ts);
        assert_err(result, ErrorCode::AlreadySettled);
    }
    assert_eq!(env.svm.get_account(&market).unwrap(), account);
}
