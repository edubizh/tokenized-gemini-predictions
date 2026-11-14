//! `initialize`, `set_config`, `set_pause` and `register_trader`.

mod common;

use {
    anchor_lang::{prelude::Pubkey, solana_program::system_instruction, Space},
    anchor_spl::{token::spl_token, token_2022::spl_token_2022},
    common::*,
    outcome_tokens::{
        accounts,
        constants::{
            CONFIG_SEED, PAUSE_FILL, PAUSE_PLACE, STABLE_DECIMALS, TRADER_SEED, TTL_MAX_SECS,
            TTL_MIN_SECS,
        },
        error::ErrorCode,
        events::{ConfigChanged, Initialized, TraderRegistered},
        instructions::{InitializeArgs, SetConfigArgs},
        state::{Config, Trader},
    },
    solana_keypair::Keypair,
    solana_signer::Signer,
};

// --- initialize ------------------------------------------------------------------------

#[test]
fn initialize_writes_every_config_field() {
    let mut env = setup();
    // A separate payer shows that the authority only has to sign.
    let payer = funded_keypair(&mut env.svm, 10);
    let relayer = Pubkey::new_from_array([21; 32]);
    let settler = Pubkey::new_from_array([22; 32]);
    let registrar = Pubkey::new_from_array([23; 32]);
    let args = InitializeArgs {
        relayer,
        settler,
        registrar,
        order_ttl_secs: 45,
        min_order_units: 7,
        max_order_units: 9_000,
        settle_delay_secs: 3_600,
    };
    let accounts = accounts::Initialize {
        payer: payer.pubkey(),
        ..initialize_accounts(&env)
    };
    let payer_lamports = lamports(&env.svm, &payer.pubkey());
    let admin_lamports = lamports(&env.svm, &env.admin.pubkey());

    let meta = send_ok(
        &mut env.svm,
        &[initialize_ix(accounts, args)],
        &[&payer, &env.admin],
    );
    println!(
        "compute units: initialize = {}",
        meta.compute_units_consumed
    );

    let config: Config = load(&env.svm, &env.config);
    assert_eq!(config.admin, env.admin.pubkey());
    assert_eq!(config.relayer, relayer);
    assert_eq!(config.settler, settler);
    assert_eq!(config.registrar, registrar);
    assert_eq!(config.stable_mint, env.stable_mint);
    assert_eq!(config.treasury, env.treasury);
    assert_eq!(config.order_ttl_secs, 45);
    assert_eq!(config.min_order_units, 7);
    assert_eq!(config.max_order_units, 9_000);
    assert_eq!(config.settle_delay_secs, 3_600);
    assert_eq!(config.pause_flags, 0);
    let (address, bump) = Pubkey::find_program_address(&[CONFIG_SEED], &outcome_tokens::id());
    assert_eq!(env.config, address);
    assert_eq!(config.bump, bump);
    assert_eq!(config.reserved, [0; 64]);

    let account = env.svm.get_account(&env.config).unwrap();
    assert_eq!(account.owner, outcome_tokens::id());
    assert_eq!(account.data.len(), 8 + Config::INIT_SPACE);
    let rent = env
        .svm
        .minimum_balance_for_rent_exemption(account.data.len());
    assert_eq!(account.lamports, rent);
    assert_eq!(
        lamports(&env.svm, &payer.pubkey()),
        payer_lamports - rent - meta.fee
    );
    assert_eq!(lamports(&env.svm, &env.admin.pubkey()), admin_lamports);

    assert_eq!(events::<Initialized>(&meta).len(), 1);
}

#[test]
fn initialize_rejects_a_signer_that_is_not_the_upgrade_authority() {
    let mut env = setup();
    let stranger = funded_keypair(&mut env.svm, 10);
    let accounts = accounts::Initialize {
        authority: stranger.pubkey(),
        payer: stranger.pubkey(),
        ..initialize_accounts(&env)
    };
    let instruction = initialize_ix(accounts, initialize_args(&env));

    let result = send(&mut env.svm, &[instruction], &[&stranger]);

    assert_err(result, ErrorCode::Unauthorized);
    assert!(is_closed(&env.svm, &env.config));
}

#[test]
fn initialize_rejects_the_program_data_account_of_another_program() {
    let mut env = setup();
    let attacker = funded_keypair(&mut env.svm, 10);
    // What deploying a program of their own gives an attacker: a ProgramData account,
    // owned by the loader, that names the attacker as upgrade authority.
    let other_program_data = Pubkey::new_from_array([11; 32]);
    let mut account = env.svm.get_account(&program_data_address()).unwrap();
    account.data[13..45].copy_from_slice(attacker.pubkey().as_ref());
    env.svm.set_account(other_program_data, account).unwrap();
    let accounts = accounts::Initialize {
        authority: attacker.pubkey(),
        payer: attacker.pubkey(),
        program_data: other_program_data,
        ..initialize_accounts(&env)
    };
    let instruction = initialize_ix(accounts, initialize_args(&env));

    let result = send(&mut env.svm, &[instruction], &[&attacker]);

    assert_err(result, ErrorCode::Unauthorized);
    assert!(is_closed(&env.svm, &env.config));
}

#[test]
fn initialize_rejects_a_program_data_account_that_the_loader_does_not_own() {
    let mut env = setup();
    let attacker = funded_keypair(&mut env.svm, 10);
    let accounts = accounts::Initialize {
        authority: attacker.pubkey(),
        payer: attacker.pubkey(),
        program_data: attacker.pubkey(),
        ..initialize_accounts(&env)
    };
    let instruction = initialize_ix(accounts, initialize_args(&env));

    let result = send(&mut env.svm, &[instruction], &[&attacker]);

    assert_anchor_err(
        result,
        anchor_lang::error::ErrorCode::AccountOwnedByWrongProgram,
    );
}

#[test]
fn initialize_rejects_another_program_with_its_own_program_data() {
    let mut env = setup();
    let attacker = funded_keypair(&mut env.svm, 10);
    // Token-2022 stands in for a program the attacker deployed: the program account and
    // its ProgramData belong together, and the attacker is the upgrade authority.
    set_upgrade_authority(&mut env.svm, &spl_token_2022::ID, &attacker.pubkey());
    let accounts = accounts::Initialize {
        authority: attacker.pubkey(),
        payer: attacker.pubkey(),
        program: spl_token_2022::ID,
        program_data: program_data_address_of(&spl_token_2022::ID),
        ..initialize_accounts(&env)
    };
    let instruction = initialize_ix(accounts, initialize_args(&env));

    let result = send(&mut env.svm, &[instruction], &[&attacker]);

    assert_anchor_err(result, anchor_lang::error::ErrorCode::InvalidProgramId);
    assert!(is_closed(&env.svm, &env.config));
}

#[test]
fn initialize_runs_only_once() {
    let mut env = initialize_default();
    let instruction = initialize_ix(
        initialize_accounts(&env),
        InitializeArgs {
            order_ttl_secs: 90,
            ..initialize_args(&env)
        },
    );

    let result = send(&mut env.svm, &[instruction], &[&env.admin]);

    assert_already_in_use(result);
    let config: Config = load(&env.svm, &env.config);
    assert_eq!(config.order_ttl_secs, ORDER_TTL_SECS);
}

#[test]
fn initialize_rejects_real_stablecoin_mints() {
    for address in [
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
    ] {
        let mut env = setup();
        let real_mint: Pubkey = address.parse().unwrap();
        // A well-formed classic mint with six decimals at the real address, and a treasury
        // for it: the address is the only thing wrong.
        let mint_account = env.svm.get_account(&env.stable_mint).unwrap();
        env.svm.set_account(real_mint, mint_account).unwrap();
        let treasury = create_token_account(
            &mut env.svm,
            &spl_token::ID,
            &env.admin,
            &real_mint,
            &env.admin.pubkey(),
        );
        let accounts = accounts::Initialize {
            stable_mint: real_mint,
            treasury,
            ..initialize_accounts(&env)
        };
        let instruction = initialize_ix(accounts, initialize_args(&env));

        let result = send(&mut env.svm, &[instruction], &[&env.admin]);

        assert_err(result, ErrorCode::RealStablecoinNotAllowed);
    }
}

#[test]
fn initialize_rejects_a_token_2022_stable_mint() {
    let mut env = setup();
    // A matching mint and treasury under Token-2022: the token program is the only thing
    // wrong.
    let mint = create_mint(
        &mut env.svm,
        &spl_token_2022::ID,
        &env.issuer,
        &Keypair::new(),
        STABLE_DECIMALS,
    );
    let treasury = create_token_account(
        &mut env.svm,
        &spl_token_2022::ID,
        &env.admin,
        &mint,
        &env.admin.pubkey(),
    );
    let accounts = accounts::Initialize {
        stable_mint: mint,
        treasury,
        ..initialize_accounts(&env)
    };
    let instruction = initialize_ix(accounts, initialize_args(&env));

    let result = send(&mut env.svm, &[instruction], &[&env.admin]);

    assert_anchor_err(
        result,
        anchor_lang::error::ErrorCode::AccountOwnedByWrongProgram,
    );
}

#[test]
fn initialize_rejects_a_stable_mint_without_six_decimals() {
    for decimals in [STABLE_DECIMALS - 1, STABLE_DECIMALS + 1] {
        let mut env = setup();
        let mint = create_mint(
            &mut env.svm,
            &spl_token::ID,
            &env.issuer,
            &Keypair::new(),
            decimals,
        );
        let treasury = create_token_account(
            &mut env.svm,
            &spl_token::ID,
            &env.admin,
            &mint,
            &env.admin.pubkey(),
        );
        let accounts = accounts::Initialize {
            stable_mint: mint,
            treasury,
            ..initialize_accounts(&env)
        };
        let instruction = initialize_ix(accounts, initialize_args(&env));

        let result = send(&mut env.svm, &[instruction], &[&env.admin]);

        assert_anchor_err(
            result,
            anchor_lang::error::ErrorCode::ConstraintMintDecimals,
        );
    }
}

#[test]
fn initialize_rejects_a_treasury_of_another_mint() {
    let mut env = setup();
    let other_mint = create_mint(
        &mut env.svm,
        &spl_token::ID,
        &env.issuer,
        &Keypair::new(),
        STABLE_DECIMALS,
    );
    let treasury = create_token_account(
        &mut env.svm,
        &spl_token::ID,
        &env.admin,
        &other_mint,
        &env.admin.pubkey(),
    );
    let accounts = accounts::Initialize {
        treasury,
        ..initialize_accounts(&env)
    };
    let instruction = initialize_ix(accounts, initialize_args(&env));

    let result = send(&mut env.svm, &[instruction], &[&env.admin]);

    assert_anchor_err(result, anchor_lang::error::ErrorCode::ConstraintTokenMint);
}

#[test]
fn initialize_rejects_a_treasury_that_is_not_a_token_account() {
    let mut env = setup();
    let accounts = accounts::Initialize {
        treasury: env.admin.pubkey(),
        ..initialize_accounts(&env)
    };
    let instruction = initialize_ix(accounts, initialize_args(&env));

    let result = send(&mut env.svm, &[instruction], &[&env.admin]);

    assert_anchor_err(
        result,
        anchor_lang::error::ErrorCode::AccountOwnedByWrongProgram,
    );
}

#[test]
fn initialize_rejects_another_token_program() {
    let mut env = setup();
    let accounts = accounts::Initialize {
        token_program: spl_token_2022::ID,
        ..initialize_accounts(&env)
    };
    let instruction = initialize_ix(accounts, initialize_args(&env));

    let result = send(&mut env.svm, &[instruction], &[&env.admin]);

    assert_anchor_err(result, anchor_lang::error::ErrorCode::InvalidProgramId);
}

#[test]
fn initialize_accepts_the_edges_of_every_range() {
    for order_ttl_secs in [TTL_MIN_SECS, TTL_MAX_SECS] {
        let mut env = setup();
        let instruction = initialize_ix(
            initialize_accounts(&env),
            InitializeArgs {
                order_ttl_secs,
                // The smallest minimum, and a maximum equal to it.
                min_order_units: 1,
                max_order_units: 1,
                // The settle delay has no range.
                settle_delay_secs: 0,
                ..initialize_args(&env)
            },
        );

        send_ok(&mut env.svm, &[instruction], &[&env.admin]);

        let config: Config = load(&env.svm, &env.config);
        assert_eq!(config.order_ttl_secs, order_ttl_secs);
        assert_eq!(config.min_order_units, 1);
        assert_eq!(config.max_order_units, 1);
        assert_eq!(config.settle_delay_secs, 0);
    }
}

#[test]
fn initialize_rejects_an_order_ttl_outside_the_range() {
    for order_ttl_secs in [0, TTL_MIN_SECS - 1, TTL_MAX_SECS + 1, u32::MAX] {
        let mut env = setup();
        let instruction = initialize_ix(
            initialize_accounts(&env),
            InitializeArgs {
                order_ttl_secs,
                ..initialize_args(&env)
            },
        );

        let result = send(&mut env.svm, &[instruction], &[&env.admin]);

        assert_err(result, ErrorCode::BadConfig);
    }
}

#[test]
fn initialize_rejects_a_zero_minimum_order() {
    let mut env = setup();
    let instruction = initialize_ix(
        initialize_accounts(&env),
        InitializeArgs {
            min_order_units: 0,
            ..initialize_args(&env)
        },
    );

    let result = send(&mut env.svm, &[instruction], &[&env.admin]);

    assert_err(result, ErrorCode::BadConfig);
}

#[test]
fn initialize_rejects_a_maximum_order_below_the_minimum() {
    let mut env = setup();
    let instruction = initialize_ix(
        initialize_accounts(&env),
        InitializeArgs {
            min_order_units: MIN_ORDER_UNITS,
            max_order_units: MIN_ORDER_UNITS - 1,
            ..initialize_args(&env)
        },
    );

    let result = send(&mut env.svm, &[instruction], &[&env.admin]);

    assert_err(result, ErrorCode::BadConfig);
}

#[test]
fn initialize_succeeds_when_the_config_address_was_prefunded() {
    let mut env = setup();
    // Anyone can send lamports to the config address before it exists.
    let prefund = env.svm.minimum_balance_for_rent_exemption(0);
    let transfer = system_instruction::transfer(&env.relayer.pubkey(), &env.config, prefund);
    send_ok(&mut env.svm, &[transfer], &[&env.relayer]);
    assert_eq!(lamports(&env.svm, &env.config), prefund);
    let instruction = initialize_ix(initialize_accounts(&env), initialize_args(&env));

    send_ok(&mut env.svm, &[instruction], &[&env.admin]);

    let config: Config = load(&env.svm, &env.config);
    assert_eq!(config.admin, env.admin.pubkey());
    let account = env.svm.get_account(&env.config).unwrap();
    assert_eq!(account.owner, outcome_tokens::id());
    assert_eq!(
        account.lamports,
        env.svm
            .minimum_balance_for_rent_exemption(account.data.len())
    );
}

// --- set_config ------------------------------------------------------------------------

/// Every argument spelled out, so a new one cannot be added without touching the tests.
fn no_changes() -> SetConfigArgs {
    SetConfigArgs {
        relayer: None,
        settler: None,
        registrar: None,
        order_ttl_secs: None,
        min_order_units: None,
        max_order_units: None,
        settle_delay_secs: None,
    }
}

type Settings = (
    Pubkey,
    Pubkey,
    Pubkey,
    Pubkey,
    Pubkey,
    Pubkey,
    u32,
    u64,
    u64,
    u32,
    u8,
);

/// All settings of the Config account, in field order, for whole-account comparisons.
fn settings(env: &Env) -> Settings {
    let config: Config = load(&env.svm, &env.config);
    (
        config.admin,
        config.relayer,
        config.settler,
        config.registrar,
        config.stable_mint,
        config.treasury,
        config.order_ttl_secs,
        config.min_order_units,
        config.max_order_units,
        config.settle_delay_secs,
        config.pause_flags,
    )
}

fn set_config_as_admin(
    env: &mut Env,
    args: SetConfigArgs,
    new_treasury: Option<Pubkey>,
) -> SendResult {
    let admin = env.admin.pubkey();
    let instruction = set_config_ix(env, &admin, args, new_treasury);
    send(&mut env.svm, &[instruction], &[&env.admin])
}

#[test]
fn set_config_changes_each_role_and_nothing_else() {
    let relayer = Pubkey::new_from_array([31; 32]);
    let settler = Pubkey::new_from_array([32; 32]);
    let registrar = Pubkey::new_from_array([33; 32]);

    let mut env = initialize_default();
    let mut expected = settings(&env);
    let args = SetConfigArgs {
        relayer: Some(relayer),
        ..no_changes()
    };
    set_config_as_admin(&mut env, args, None).unwrap();
    expected.1 = relayer;
    assert_eq!(settings(&env), expected);

    let args = SetConfigArgs {
        settler: Some(settler),
        ..no_changes()
    };
    set_config_as_admin(&mut env, args, None).unwrap();
    expected.2 = settler;
    assert_eq!(settings(&env), expected);

    let args = SetConfigArgs {
        registrar: Some(registrar),
        ..no_changes()
    };
    set_config_as_admin(&mut env, args, None).unwrap();
    expected.3 = registrar;
    assert_eq!(settings(&env), expected);
}

#[test]
fn set_config_changes_each_limit_and_nothing_else() {
    let mut env = initialize_default();
    let mut expected = settings(&env);

    let args = SetConfigArgs {
        order_ttl_secs: Some(ORDER_TTL_SECS + 30),
        ..no_changes()
    };
    set_config_as_admin(&mut env, args, None).unwrap();
    expected.6 = ORDER_TTL_SECS + 30;
    assert_eq!(settings(&env), expected);

    let args = SetConfigArgs {
        min_order_units: Some(MIN_ORDER_UNITS / 2),
        ..no_changes()
    };
    set_config_as_admin(&mut env, args, None).unwrap();
    expected.7 = MIN_ORDER_UNITS / 2;
    assert_eq!(settings(&env), expected);

    let args = SetConfigArgs {
        max_order_units: Some(MAX_ORDER_UNITS * 2),
        ..no_changes()
    };
    set_config_as_admin(&mut env, args, None).unwrap();
    expected.8 = MAX_ORDER_UNITS * 2;
    assert_eq!(settings(&env), expected);

    let args = SetConfigArgs {
        settle_delay_secs: Some(SETTLE_DELAY_SECS + 7),
        ..no_changes()
    };
    set_config_as_admin(&mut env, args, None).unwrap();
    expected.9 = SETTLE_DELAY_SECS + 7;
    assert_eq!(settings(&env), expected);
}

#[test]
fn set_config_replaces_the_treasury_and_nothing_else() {
    let mut env = initialize_default();
    let mut expected = settings(&env);
    let owner = Pubkey::new_from_array([34; 32]);
    let new_treasury = create_stable_account(&mut env, &owner, 0);

    set_config_as_admin(&mut env, no_changes(), Some(new_treasury)).unwrap();

    expected.5 = new_treasury;
    assert_eq!(settings(&env), expected);
}

#[test]
fn set_config_emits_config_changed() {
    let mut env = initialize_default();
    let admin = env.admin.pubkey();
    let instruction = set_config_ix(&env, &admin, no_changes(), None);

    let meta = send_ok(&mut env.svm, &[instruction], &[&env.admin]);

    println!(
        "compute units: set_config = {}",
        meta.compute_units_consumed
    );
    assert_eq!(events::<ConfigChanged>(&meta).len(), 1);
}

#[test]
fn set_config_rejects_every_signer_but_the_admin() {
    let mut env = initialize_default();
    let stranger = funded_keypair(&mut env.svm, 10);
    let before = settings(&env);

    for signer in [&env.relayer, &env.settler, &env.registrar, &stranger] {
        let args = SetConfigArgs {
            relayer: Some(signer.pubkey()),
            ..no_changes()
        };
        let instruction = set_config_ix(&env, &signer.pubkey(), args, None);

        let result = send(&mut env.svm, &[instruction], &[signer]);

        assert_err(result, ErrorCode::Unauthorized);
    }
    assert_eq!(settings(&env), before);
}

#[test]
fn set_config_rejects_values_outside_the_ranges() {
    let mut env = initialize_default();
    let before = settings(&env);
    let violations = [
        SetConfigArgs {
            order_ttl_secs: Some(TTL_MIN_SECS - 1),
            ..no_changes()
        },
        SetConfigArgs {
            order_ttl_secs: Some(TTL_MAX_SECS + 1),
            ..no_changes()
        },
        SetConfigArgs {
            min_order_units: Some(0),
            ..no_changes()
        },
        // Each of these is in range by itself and only conflicts with the stored value of
        // the other limit.
        SetConfigArgs {
            min_order_units: Some(MAX_ORDER_UNITS + 1),
            ..no_changes()
        },
        SetConfigArgs {
            max_order_units: Some(MIN_ORDER_UNITS - 1),
            ..no_changes()
        },
        SetConfigArgs {
            min_order_units: Some(5),
            max_order_units: Some(4),
            ..no_changes()
        },
    ];

    for args in violations {
        let result = set_config_as_admin(&mut env, args, None);

        assert_err(result, ErrorCode::BadConfig);
    }
    assert_eq!(settings(&env), before);
}

#[test]
fn set_config_accepts_limits_that_are_consistent_together() {
    let mut env = initialize_default();
    let mut expected = settings(&env);
    // The new minimum is above the stored maximum; the pair is valid as a whole.
    let args = SetConfigArgs {
        order_ttl_secs: Some(TTL_MAX_SECS),
        min_order_units: Some(MAX_ORDER_UNITS + 1),
        max_order_units: Some(MAX_ORDER_UNITS + 1),
        ..no_changes()
    };

    set_config_as_admin(&mut env, args, None).unwrap();

    expected.6 = TTL_MAX_SECS;
    expected.7 = MAX_ORDER_UNITS + 1;
    expected.8 = MAX_ORDER_UNITS + 1;
    assert_eq!(settings(&env), expected);
}

#[test]
fn set_config_rejects_a_new_treasury_of_another_mint() {
    let mut env = initialize_default();
    let before = settings(&env);
    let other_mint = create_mint(
        &mut env.svm,
        &spl_token::ID,
        &env.issuer,
        &Keypair::new(),
        STABLE_DECIMALS,
    );
    let new_treasury = create_token_account(
        &mut env.svm,
        &spl_token::ID,
        &env.admin,
        &other_mint,
        &env.admin.pubkey(),
    );

    let result = set_config_as_admin(&mut env, no_changes(), Some(new_treasury));

    assert_anchor_err(result, anchor_lang::error::ErrorCode::ConstraintTokenMint);
    assert_eq!(settings(&env), before);
}

#[test]
fn set_config_rejects_a_new_treasury_that_is_not_a_token_account() {
    let mut env = initialize_default();
    let before = settings(&env);
    let wallet = env.admin.pubkey();

    let result = set_config_as_admin(&mut env, no_changes(), Some(wallet));

    assert_anchor_err(
        result,
        anchor_lang::error::ErrorCode::AccountOwnedByWrongProgram,
    );
    assert_eq!(settings(&env), before);
}

#[test]
fn set_config_rejects_another_token_program() {
    let mut env = initialize_default();
    let instruction = instruction(
        accounts::SetConfig {
            admin: env.admin.pubkey(),
            config: env.config,
            new_treasury: None,
            token_program: spl_token_2022::ID,
        },
        outcome_tokens::instruction::SetConfig { args: no_changes() },
    );

    let result = send(&mut env.svm, &[instruction], &[&env.admin]);

    assert_anchor_err(result, anchor_lang::error::ErrorCode::InvalidProgramId);
}

#[test]
fn set_config_cannot_change_the_admin_or_the_stable_mint() {
    let mut env = initialize_default();
    let before = settings(&env);
    let owner = Pubkey::new_from_array([34; 32]);
    let new_treasury = create_stable_account(&mut env, &owner, 0);
    // Every argument the instruction has, all at once.
    let args = SetConfigArgs {
        relayer: Some(Pubkey::new_from_array([31; 32])),
        settler: Some(Pubkey::new_from_array([32; 32])),
        registrar: Some(Pubkey::new_from_array([33; 32])),
        order_ttl_secs: Some(TTL_MIN_SECS),
        min_order_units: Some(2),
        max_order_units: Some(3),
        settle_delay_secs: Some(4),
    };

    set_config_as_admin(&mut env, args, Some(new_treasury)).unwrap();

    let after = settings(&env);
    assert_eq!(after.0, env.admin.pubkey());
    assert_eq!(after.4, env.stable_mint);
    assert_eq!(
        after,
        (
            before.0,
            Pubkey::new_from_array([31; 32]),
            Pubkey::new_from_array([32; 32]),
            Pubkey::new_from_array([33; 32]),
            before.4,
            new_treasury,
            TTL_MIN_SECS,
            2,
            3,
            4,
            before.10,
        )
    );
}

// --- set_pause -------------------------------------------------------------------------

fn set_pause(env: &mut Env, signer: &Keypair, flags: u8) -> SendResult {
    let instruction = set_pause_ix(env, &signer.pubkey(), flags);
    send(&mut env.svm, &[instruction], &[signer])
}

#[test]
fn set_pause_lets_the_admin_set_and_clear_any_valid_value() {
    let mut env = initialize_default();
    let admin = env.admin.insecure_clone();
    let mut expected = settings(&env);

    // Up, across and back down: every transition between the four valid values.
    for flags in [
        PAUSE_PLACE,
        PAUSE_PLACE | PAUSE_FILL,
        PAUSE_FILL,
        0,
        PAUSE_PLACE | PAUSE_FILL,
        0,
    ] {
        set_pause(&mut env, &admin, flags).unwrap();

        expected.10 = flags;
        assert_eq!(settings(&env), expected);
    }
}

#[test]
fn set_pause_emits_config_changed() {
    let mut env = initialize_default();
    let admin = env.admin.pubkey();
    let instruction = set_pause_ix(&env, &admin, PAUSE_PLACE);

    let meta = send_ok(&mut env.svm, &[instruction], &[&env.admin]);

    println!("compute units: set_pause = {}", meta.compute_units_consumed);
    assert_eq!(events::<ConfigChanged>(&meta).len(), 1);
}

#[test]
fn set_pause_rejects_signers_other_than_the_admin_and_the_relayer() {
    let mut env = initialize_default();
    let stranger = funded_keypair(&mut env.svm, 10);
    let settler = env.settler.insecure_clone();
    let registrar = env.registrar.insecure_clone();

    for signer in [&stranger, &settler, &registrar] {
        let result = set_pause(&mut env, signer, PAUSE_PLACE);

        assert_err(result, ErrorCode::Unauthorized);
    }
    assert_eq!(settings(&env).10, 0);
}

#[test]
fn set_pause_rejects_unknown_bits() {
    let mut env = initialize_default();
    let admin = env.admin.insecure_clone();
    let relayer = env.relayer.insecure_clone();
    set_pause(&mut env, &admin, PAUSE_PLACE).unwrap();

    for signer in [&admin, &relayer] {
        // The lowest unknown bit, the highest, and unknown bits mixed with valid ones.
        for flags in [4, 0x80, PAUSE_PLACE | 4, PAUSE_PLACE | PAUSE_FILL | 4, 0xff] {
            let result = set_pause(&mut env, signer, flags);

            assert_err(result, ErrorCode::BadConfig);
        }
    }
    assert_eq!(settings(&env).10, PAUSE_PLACE);
}

#[test]
fn set_pause_lets_the_relayer_add_bits() {
    let mut env = initialize_default();
    let relayer = env.relayer.insecure_clone();

    // One bit, the same value again, then the second bit.
    for flags in [PAUSE_FILL, PAUSE_FILL, PAUSE_FILL | PAUSE_PLACE] {
        set_pause(&mut env, &relayer, flags).unwrap();

        assert_eq!(settings(&env).10, flags);
    }
}

#[test]
fn set_pause_does_not_let_the_relayer_clear_bits() {
    let mut env = initialize_default();
    let admin = env.admin.insecure_clone();
    let relayer = env.relayer.insecure_clone();

    set_pause(&mut env, &admin, PAUSE_PLACE | PAUSE_FILL).unwrap();
    for flags in [PAUSE_PLACE, PAUSE_FILL, 0] {
        let result = set_pause(&mut env, &relayer, flags);

        assert_err(result, ErrorCode::Unauthorized);
    }
    assert_eq!(settings(&env).10, PAUSE_PLACE | PAUSE_FILL);

    // Swapping one bit for the other clears a bit too.
    set_pause(&mut env, &admin, PAUSE_PLACE).unwrap();
    for flags in [PAUSE_FILL, 0] {
        let result = set_pause(&mut env, &relayer, flags);

        assert_err(result, ErrorCode::Unauthorized);
    }
    assert_eq!(settings(&env).10, PAUSE_PLACE);

    // The admin still can.
    set_pause(&mut env, &admin, 0).unwrap();
    assert_eq!(settings(&env).10, 0);
}

#[test]
fn set_pause_treats_a_key_that_is_admin_and_relayer_as_the_admin() {
    let mut env = initialize_default();
    let admin = env.admin.insecure_clone();
    let args = SetConfigArgs {
        relayer: Some(admin.pubkey()),
        ..no_changes()
    };
    set_config_as_admin(&mut env, args, None).unwrap();
    set_pause(&mut env, &admin, PAUSE_PLACE | PAUSE_FILL).unwrap();

    set_pause(&mut env, &admin, 0).unwrap();

    assert_eq!(settings(&env).10, 0);
}

// --- register_trader -------------------------------------------------------------------

#[test]
fn register_trader_creates_a_trader_with_nonce_zero() {
    let mut env = initialize_default();
    let payer = funded_keypair(&mut env.svm, 10);
    // The user neither signs nor needs to exist on chain.
    let user = Pubkey::new_from_array([41; 32]);
    assert!(env.svm.get_account(&user).is_none());
    let trader_address = trader_address(&user);
    let instruction = register_trader_ix(&env, &env.registrar.pubkey(), &payer.pubkey(), &user);
    let payer_lamports = lamports(&env.svm, &payer.pubkey());
    let registrar_lamports = lamports(&env.svm, &env.registrar.pubkey());

    let meta = send_ok(&mut env.svm, &[instruction], &[&payer, &env.registrar]);
    println!(
        "compute units: register_trader = {}",
        meta.compute_units_consumed
    );

    let trader: Trader = load(&env.svm, &trader_address);
    assert_eq!(trader.user, user);
    assert_eq!(trader.next_nonce, 0);
    let (address, bump) =
        Pubkey::find_program_address(&[TRADER_SEED, user.as_ref()], &outcome_tokens::id());
    assert_eq!(trader_address, address);
    assert_eq!(trader.bump, bump);
    assert_eq!(trader.reserved, [0; 32]);

    let account = env.svm.get_account(&trader_address).unwrap();
    assert_eq!(account.owner, outcome_tokens::id());
    assert_eq!(account.data.len(), 8 + Trader::INIT_SPACE);
    let rent = env
        .svm
        .minimum_balance_for_rent_exemption(account.data.len());
    assert_eq!(account.lamports, rent);
    assert_eq!(
        lamports(&env.svm, &payer.pubkey()),
        payer_lamports - rent - meta.fee
    );
    assert_eq!(
        lamports(&env.svm, &env.registrar.pubkey()),
        registrar_lamports
    );
    assert!(env.svm.get_account(&user).is_none());

    let registered = events::<TraderRegistered>(&meta);
    assert_eq!(registered.len(), 1);
    assert_eq!(registered[0].user, user);
}

#[test]
fn register_trader_rejects_every_signer_but_the_registrar() {
    let mut env = initialize_default();
    let stranger = funded_keypair(&mut env.svm, 10);
    let user = Pubkey::new_from_array([41; 32]);

    for signer in [&env.admin, &env.relayer, &env.settler, &stranger] {
        let instruction = register_trader_ix(&env, &signer.pubkey(), &signer.pubkey(), &user);

        let result = send(&mut env.svm, &[instruction], &[signer]);

        assert_err(result, ErrorCode::Unauthorized);
    }
    assert!(is_closed(&env.svm, &trader_address(&user)));

    // A wallet cannot register itself.
    let own = stranger.pubkey();
    let instruction = register_trader_ix(&env, &own, &own, &own);
    let result = send(&mut env.svm, &[instruction], &[&stranger]);
    assert_err(result, ErrorCode::Unauthorized);
    assert!(is_closed(&env.svm, &trader_address(&own)));
}

#[test]
fn register_trader_fails_for_a_user_that_is_already_registered() {
    let mut env = initialize_default();
    let user = Pubkey::new_from_array([41; 32]);
    let other_user = Pubkey::new_from_array([42; 32]);
    register_trader(&mut env, &user);
    let registrar = env.registrar.pubkey();
    let instruction = register_trader_ix(&env, &registrar, &registrar, &user);

    let result = send(&mut env.svm, &[instruction], &[&env.registrar]);

    assert_already_in_use(result);
    let trader: Trader = load(&env.svm, &trader_address(&user));
    assert_eq!(trader.user, user);
    assert_eq!(trader.next_nonce, 0);

    // Other users are unaffected and get their own account.
    register_trader(&mut env, &other_user);
    assert_ne!(trader_address(&other_user), trader_address(&user));
    let trader: Trader = load(&env.svm, &trader_address(&other_user));
    assert_eq!(trader.user, other_user);
}

#[test]
fn register_trader_rejects_a_trader_account_at_another_users_address() {
    let mut env = initialize_default();
    let user = Pubkey::new_from_array([41; 32]);
    let other_user = Pubkey::new_from_array([42; 32]);
    let registrar = env.registrar.pubkey();
    let instruction = instruction(
        accounts::RegisterTrader {
            registrar,
            payer: registrar,
            config: env.config,
            user,
            trader: trader_address(&other_user),
            system_program: anchor_lang::solana_program::system_program::ID,
        },
        outcome_tokens::instruction::RegisterTrader {},
    );

    let result = send(&mut env.svm, &[instruction], &[&env.registrar]);

    assert_anchor_err(result, anchor_lang::error::ErrorCode::ConstraintSeeds);
    assert!(is_closed(&env.svm, &trader_address(&other_user)));
}

#[test]
fn register_trader_succeeds_when_the_trader_address_was_prefunded() {
    let mut env = initialize_default();
    let user = Pubkey::new_from_array([41; 32]);
    let trader_address = trader_address(&user);
    // Anyone can send lamports to a trader address before it exists.
    let prefund = env.svm.minimum_balance_for_rent_exemption(0);
    let transfer = system_instruction::transfer(&env.relayer.pubkey(), &trader_address, prefund);
    send_ok(&mut env.svm, &[transfer], &[&env.relayer]);

    register_trader(&mut env, &user);

    let trader: Trader = load(&env.svm, &trader_address);
    assert_eq!(trader.user, user);
    let account = env.svm.get_account(&trader_address).unwrap();
    assert_eq!(account.owner, outcome_tokens::id());
    assert_eq!(
        account.lamports,
        env.svm
            .minimum_balance_for_rent_exemption(account.data.len())
    );
}
