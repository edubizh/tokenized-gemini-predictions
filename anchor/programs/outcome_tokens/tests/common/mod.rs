//! Shared LiteSVM fixture for the program tests.
//!
//! The tests embed `target/deploy/outcome_tokens.so`, so run them as
//! `anchor build && cargo test`. A bare `cargo test` exercises the previous build.

#![allow(dead_code)]

use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{
            bpf_loader_upgradeable, instruction::Instruction, program_pack::Pack,
            system_instruction, system_program,
        },
        AccountDeserialize, Event, InstructionData, ToAccountMetas,
    },
    anchor_spl::{
        associated_token::{self, spl_associated_token_account},
        token::spl_token,
        token_2022::spl_token_2022::{self, extension::StateWithExtensions},
    },
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    outcome_tokens::{
        constants::{
            CONFIG_SEED, ESCROW_SEED, MARKET_SEED, MINT_SEED, ORDER_SEED, STABLE_DECIMALS,
            TRADER_SEED,
        },
        error::ErrorCode,
        instructions::{InitializeArgs, SetConfigArgs},
    },
    solana_keypair::Keypair,
    solana_message::{v0, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::{versioned::VersionedTransaction, InstructionError, TransactionError},
};

pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

/// LiteSVM starts with `unix_timestamp = 0`; tests run from a realistic time instead.
pub const START_TIME: i64 = 1_800_000_000;

// Configuration written by `initialize_default`.
pub const ORDER_TTL_SECS: u32 = 60;
pub const MIN_ORDER_UNITS: u64 = 100;
pub const MAX_ORDER_UNITS: u64 = 1_000_000;
pub const SETTLE_DELAY_SECS: u32 = 60;

// --- Environment -----------------------------------------------------------------------

/// The VM with the program deployed, plus the keys and addresses every test shares.
///
/// Keypair seeds below 10 belong to the fixture; tests derive their own wallets from 10 up.
pub struct Env {
    pub svm: LiteSVM,
    /// Upgrade authority of the program; the admin once `initialize` has run.
    pub admin: Keypair,
    pub relayer: Keypair,
    pub settler: Keypair,
    pub registrar: Keypair,
    /// Mint authority of the stand-in stablecoin.
    pub issuer: Keypair,
    /// Classic SPL Token mint with six decimals.
    pub stable_mint: Pubkey,
    /// Stable token account owned by the admin wallet.
    pub treasury: Pubkey,
    pub config: Pubkey,
}

/// Deploys the program with `admin` as its upgrade authority, sets the clock to
/// `START_TIME`, funds the role wallets and creates the stable mint and the treasury.
/// `initialize` has not run yet.
pub fn setup() -> Env {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(
        env!("CARGO_TARGET_TMPDIR"),
        "/../deploy/outcome_tokens.so"
    ));
    svm.add_program(outcome_tokens::id(), bytes).unwrap();

    let admin = funded_keypair(&mut svm, 1);
    let relayer = funded_keypair(&mut svm, 2);
    let settler = funded_keypair(&mut svm, 3);
    let registrar = funded_keypair(&mut svm, 4);
    let issuer = funded_keypair(&mut svm, 5);
    set_upgrade_authority(&mut svm, &outcome_tokens::id(), &admin.pubkey());
    set_time(&mut svm, START_TIME);

    let stable_mint = create_mint(
        &mut svm,
        &spl_token::ID,
        &issuer,
        &Keypair::new_from_array([6; 32]),
        STABLE_DECIMALS,
    );
    let treasury = create_token_account(
        &mut svm,
        &spl_token::ID,
        &admin,
        &stable_mint,
        &admin.pubkey(),
    );

    Env {
        svm,
        admin,
        relayer,
        settler,
        registrar,
        issuer,
        stable_mint,
        treasury,
        config: config_address(),
    }
}

/// `setup` followed by `initialize` with the fixture's roles and default configuration.
pub fn initialize_default() -> Env {
    let mut env = setup();
    let instruction = initialize_ix(initialize_accounts(&env), initialize_args(&env));
    send_ok(&mut env.svm, &[instruction], &[&env.admin]);
    env
}

// --- Wallets ---------------------------------------------------------------------------

/// A funded wallet derived from `seed`. Fixed keys keep PDA bump searches, and therefore
/// the compute units printed by the tests, the same on every run.
pub fn funded_keypair(svm: &mut LiteSVM, seed: u8) -> Keypair {
    let keypair = Keypair::new_from_array([seed; 32]);
    svm.airdrop(&keypair.pubkey(), 10 * LAMPORTS_PER_SOL)
        .unwrap();
    keypair
}

pub fn lamports(svm: &LiteSVM, address: &Pubkey) -> u64 {
    svm.get_account(address)
        .map_or(0, |account| account.lamports)
}

// --- Upgrade authority -----------------------------------------------------------------

/// ProgramData account of the program under test.
pub fn program_data_address() -> Pubkey {
    program_data_address_of(&outcome_tokens::id())
}

pub fn program_data_address_of(program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[program.as_ref()], &bpf_loader_upgradeable::ID).0
}

/// LiteSVM writes a ProgramData account whose upgrade authority is `None` for every
/// program it loads. Patch the header in place: u32 variant (3 = ProgramData), u64 slot,
/// then `Option<Pubkey>` as one tag byte followed by the 32 key bytes.
pub fn set_upgrade_authority(svm: &mut LiteSVM, program: &Pubkey, authority: &Pubkey) {
    let address = program_data_address_of(program);
    let mut account = svm.get_account(&address).expect("ProgramData account");
    assert_eq!(account.data[..4], [3, 0, 0, 0], "not a ProgramData account");
    assert_eq!(
        account.data[12], 0,
        "LiteSVM loads programs without an authority"
    );
    account.data[12] = 1;
    account.data[13..45].copy_from_slice(authority.as_ref());
    svm.set_account(address, account).unwrap();
}

// --- Clock -----------------------------------------------------------------------------

pub fn now(svm: &LiteSVM) -> i64 {
    svm.get_sysvar::<Clock>().unix_timestamp
}

/// Moves `Clock::unix_timestamp`. `LiteSVM::warp_to_slot` only changes the slot.
pub fn set_time(svm: &mut LiteSVM, unix_timestamp: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar(&clock);
}

pub fn advance_time(svm: &mut LiteSVM, seconds: i64) {
    set_time(svm, now(svm) + seconds);
}

// --- Transactions ----------------------------------------------------------------------

/// Compute units of a transaction that succeeded, or the failure with its logs.
pub type SendResult = Result<u64, Box<FailedTransactionMetadata>>;

fn execute(
    svm: &mut LiteSVM,
    instructions: &[Instruction],
    signers: &[&Keypair],
) -> Result<TransactionMetadata, Box<FailedTransactionMetadata>> {
    // A fresh blockhash per transaction: repeating an instruction must reach the program
    // again instead of being rejected as an already processed signature.
    svm.expire_blockhash();
    let payer = signers[0].pubkey();
    let message =
        v0::Message::try_compile(&payer, instructions, &[], svm.latest_blockhash()).unwrap();
    let transaction =
        VersionedTransaction::try_new(VersionedMessage::V0(message), signers).unwrap();
    svm.send_transaction(transaction).map_err(Box::new)
}

/// Sends one version-0 transaction. `signers[0]` pays the fee.
pub fn send(svm: &mut LiteSVM, instructions: &[Instruction], signers: &[&Keypair]) -> SendResult {
    execute(svm, instructions, signers).map(|meta| meta.compute_units_consumed)
}

/// Sends a transaction that must succeed and returns its metadata: compute units, fee
/// and logs.
pub fn send_ok(
    svm: &mut LiteSVM,
    instructions: &[Instruction],
    signers: &[&Keypair],
) -> TransactionMetadata {
    execute(svm, instructions, signers).unwrap_or_else(|failure| {
        panic!(
            "transaction failed: {:?}\n{}",
            failure.err,
            failure.meta.pretty_logs()
        )
    })
}

/// Asserts that the transaction failed with this program error.
pub fn assert_err(result: SendResult, expected: ErrorCode) {
    assert_custom_err(result, expected.into());
}

/// Asserts that the transaction failed with this framework error: an account type check
/// or a constraint that carries no program error.
pub fn assert_anchor_err(result: SendResult, expected: anchor_lang::error::ErrorCode) {
    assert_custom_err(result, expected.into());
}

/// Asserts that the transaction failed with this custom error number, whichever program
/// raised it.
pub fn assert_custom_err(result: SendResult, expected: u32) {
    match result {
        Ok(units) => panic!(
            "transaction succeeded ({units} compute units), expected custom error {expected}"
        ),
        Err(failure) => match failure.err {
            TransactionError::InstructionError(_, InstructionError::Custom(code)) => {
                assert_eq!(code, expected, "{}", failure.meta.pretty_logs())
            }
            ref other => panic!(
                "expected custom error {expected}, got {other:?}\n{}",
                failure.meta.pretty_logs()
            ),
        },
    }
}

/// Asserts that the transaction failed because the System program refused to create an
/// account that already exists, which is how a second `init` of the same address fails.
pub fn assert_already_in_use(result: SendResult) {
    let logs = match &result {
        Ok(_) => String::new(),
        Err(failure) => failure.meta.pretty_logs(),
    };
    // 0 is the System program's `AccountAlreadyInUse`; other programs reuse the number,
    // so the log line is checked as well.
    assert_custom_err(result, 0);
    assert!(logs.contains("already in use"), "{logs}");
}

/// The events of type `E` that a transaction logged, in order.
pub fn events<E: Event>(meta: &TransactionMetadata) -> Vec<E> {
    meta.logs
        .iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .map(decode_base64)
        .filter(|bytes| bytes.starts_with(E::DISCRIMINATOR))
        .map(|bytes| E::try_from_slice(&bytes[E::DISCRIMINATOR.len()..]).unwrap())
        .collect()
}

/// Standard padded base64, the encoding of `Program data:` log lines.
fn decode_base64(text: &str) -> Vec<u8> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bytes = Vec::with_capacity(text.len() * 3 / 4);
    let (mut buffer, mut bits) = (0u32, 0u32);
    for character in text.bytes().filter(|&character| character != b'=') {
        let value = ALPHABET
            .iter()
            .position(|&symbol| symbol == character)
            .expect("base64 character");
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    bytes
}

// --- Accounts --------------------------------------------------------------------------

pub fn load<T: AccountDeserialize>(svm: &LiteSVM, address: &Pubkey) -> T {
    let account = svm.get_account(address).expect("account exists");
    T::try_deserialize(&mut account.data.as_slice()).unwrap()
}

/// True when the address holds no lamports and no data (never created, or closed).
pub fn is_closed(svm: &LiteSVM, address: &Pubkey) -> bool {
    svm.get_account(address)
        .is_none_or(|account| account.lamports == 0 && account.data.is_empty())
}

pub fn hex32(hex: &str) -> [u8; 32] {
    assert_eq!(hex.len(), 64);
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).unwrap();
    }
    out
}

// --- Program addresses -----------------------------------------------------------------

pub fn config_address() -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], &outcome_tokens::id()).0
}

pub fn trader_address(user: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[TRADER_SEED, user.as_ref()], &outcome_tokens::id()).0
}

pub fn market_address(symbol_hash: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[MARKET_SEED, symbol_hash], &outcome_tokens::id()).0
}

pub fn mint_address(market: &Pubkey, side: u8) -> Pubkey {
    Pubkey::find_program_address(
        &[MINT_SEED, market.as_ref(), &[side]],
        &outcome_tokens::id(),
    )
    .0
}

pub fn order_address(user: &Pubkey, nonce: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[ORDER_SEED, user.as_ref(), &nonce.to_le_bytes()],
        &outcome_tokens::id(),
    )
    .0
}

pub fn escrow_address(order: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[ESCROW_SEED, order.as_ref()], &outcome_tokens::id()).0
}

// --- Instructions ----------------------------------------------------------------------

pub fn instruction(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction::new_with_bytes(
        outcome_tokens::id(),
        &data.data(),
        accounts.to_account_metas(None),
    )
}

/// The accounts `initialize_default` sends: the admin signs as authority and pays. Tests
/// replace single fields to probe one check at a time.
pub fn initialize_accounts(env: &Env) -> outcome_tokens::accounts::Initialize {
    outcome_tokens::accounts::Initialize {
        authority: env.admin.pubkey(),
        payer: env.admin.pubkey(),
        config: env.config,
        stable_mint: env.stable_mint,
        treasury: env.treasury,
        program: outcome_tokens::id(),
        program_data: program_data_address(),
        token_program: spl_token::ID,
        system_program: system_program::ID,
    }
}

/// The arguments `initialize_default` sends.
pub fn initialize_args(env: &Env) -> InitializeArgs {
    InitializeArgs {
        relayer: env.relayer.pubkey(),
        settler: env.settler.pubkey(),
        registrar: env.registrar.pubkey(),
        order_ttl_secs: ORDER_TTL_SECS,
        min_order_units: MIN_ORDER_UNITS,
        max_order_units: MAX_ORDER_UNITS,
        settle_delay_secs: SETTLE_DELAY_SECS,
    }
}

pub fn initialize_ix(
    accounts: outcome_tokens::accounts::Initialize,
    args: InitializeArgs,
) -> Instruction {
    instruction(accounts, outcome_tokens::instruction::Initialize { args })
}

pub fn set_config_ix(
    env: &Env,
    admin: &Pubkey,
    args: SetConfigArgs,
    new_treasury: Option<Pubkey>,
) -> Instruction {
    instruction(
        outcome_tokens::accounts::SetConfig {
            admin: *admin,
            config: env.config,
            new_treasury,
            token_program: spl_token::ID,
        },
        outcome_tokens::instruction::SetConfig { args },
    )
}

pub fn set_pause_ix(env: &Env, authority: &Pubkey, flags: u8) -> Instruction {
    instruction(
        outcome_tokens::accounts::SetPause {
            authority: *authority,
            config: env.config,
        },
        outcome_tokens::instruction::SetPause { flags },
    )
}

pub fn register_trader_ix(
    env: &Env,
    registrar: &Pubkey,
    payer: &Pubkey,
    user: &Pubkey,
) -> Instruction {
    instruction(
        outcome_tokens::accounts::RegisterTrader {
            registrar: *registrar,
            payer: *payer,
            config: env.config,
            user: *user,
            trader: trader_address(user),
            system_program: system_program::ID,
        },
        outcome_tokens::instruction::RegisterTrader {},
    )
}

/// Registers `user` as a trader, signed and paid for by the registrar.
pub fn register_trader(env: &mut Env, user: &Pubkey) {
    let registrar = env.registrar.pubkey();
    let instruction = register_trader_ix(env, &registrar, &registrar, user);
    send_ok(&mut env.svm, &[instruction], &[&env.registrar]);
}

// --- Tokens ----------------------------------------------------------------------------
//
// `token_program` is `spl_token::ID` (the stablecoin) or `spl_token_2022::ID` (outcome
// tokens). Both programs accept the instructions built here.

/// Creates a mint with no freeze authority at the address of `mint`. `authority` pays and
/// becomes the mint authority.
pub fn create_mint(
    svm: &mut LiteSVM,
    token_program: &Pubkey,
    authority: &Keypair,
    mint: &Keypair,
    decimals: u8,
) -> Pubkey {
    let space = spl_token_2022::state::Mint::LEN;
    let instructions = [
        system_instruction::create_account(
            &authority.pubkey(),
            &mint.pubkey(),
            svm.minimum_balance_for_rent_exemption(space),
            space as u64,
            token_program,
        ),
        spl_token_2022::instruction::initialize_mint2(
            token_program,
            &mint.pubkey(),
            &authority.pubkey(),
            None,
            decimals,
        )
        .unwrap(),
    ];
    send_ok(svm, &instructions, &[authority, mint]);
    mint.pubkey()
}

/// Creates a token account at a fresh keypair address (deliberately not an associated
/// token account).
pub fn create_token_account(
    svm: &mut LiteSVM,
    token_program: &Pubkey,
    payer: &Keypair,
    mint: &Pubkey,
    owner: &Pubkey,
) -> Pubkey {
    let account = Keypair::new();
    let space = spl_token_2022::state::Account::LEN;
    let instructions = [
        system_instruction::create_account(
            &payer.pubkey(),
            &account.pubkey(),
            svm.minimum_balance_for_rent_exemption(space),
            space as u64,
            token_program,
        ),
        spl_token_2022::instruction::initialize_account3(
            token_program,
            &account.pubkey(),
            mint,
            owner,
        )
        .unwrap(),
    ];
    send_ok(svm, &instructions, &[payer, &account]);
    account.pubkey()
}

pub fn mint_tokens(
    svm: &mut LiteSVM,
    token_program: &Pubkey,
    authority: &Keypair,
    mint: &Pubkey,
    destination: &Pubkey,
    amount: u64,
) {
    let instruction = spl_token_2022::instruction::mint_to(
        token_program,
        mint,
        destination,
        &authority.pubkey(),
        &[],
        amount,
    )
    .unwrap();
    send_ok(svm, &[instruction], &[authority]);
}

/// A token account of either token program, without its extensions.
pub fn token_account(svm: &LiteSVM, address: &Pubkey) -> spl_token_2022::state::Account {
    let account = svm.get_account(address).expect("token account exists");
    StateWithExtensions::<spl_token_2022::state::Account>::unpack(&account.data)
        .unwrap()
        .base
}

pub fn token_balance(svm: &LiteSVM, address: &Pubkey) -> u64 {
    token_account(svm, address).amount
}

/// Creates a stable token account owned by `owner` and mints `amount` into it.
pub fn create_stable_account(env: &mut Env, owner: &Pubkey, amount: u64) -> Pubkey {
    let stable_mint = env.stable_mint;
    let account = create_token_account(
        &mut env.svm,
        &spl_token::ID,
        &env.issuer,
        &stable_mint,
        owner,
    );
    mint_stable(env, &account, amount);
    account
}

pub fn mint_stable(env: &mut Env, destination: &Pubkey, amount: u64) {
    let stable_mint = env.stable_mint;
    mint_tokens(
        &mut env.svm,
        &spl_token::ID,
        &env.issuer,
        &stable_mint,
        destination,
        amount,
    );
}

// --- Associated token accounts ---------------------------------------------------------

pub fn ata_address(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    associated_token::get_associated_token_address_with_program_id(owner, mint, token_program)
}

pub fn create_ata_idempotent_ix(
    payer: &Pubkey,
    owner: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
) -> Instruction {
    spl_associated_token_account::instruction::create_associated_token_account_idempotent(
        payer,
        owner,
        mint,
        token_program,
    )
}
