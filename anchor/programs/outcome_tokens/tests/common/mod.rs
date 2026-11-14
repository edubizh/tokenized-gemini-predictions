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
            system_instruction,
        },
        AccountDeserialize,
    },
    anchor_spl::{
        associated_token::{self, spl_associated_token_account},
        token::spl_token,
    },
    litesvm::{types::TransactionResult, LiteSVM},
    solana_keypair::Keypair,
    solana_message::{v0, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::{versioned::VersionedTransaction, InstructionError, TransactionError},
};

pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

/// LiteSVM starts with `unix_timestamp = 0`; tests run from a realistic time instead.
pub const START_TIME: i64 = 1_800_000_000;

pub struct Fixture {
    pub svm: LiteSVM,
    /// Upgrade authority of the program under test.
    pub admin: Keypair,
}

pub fn setup() -> Fixture {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(
        env!("CARGO_TARGET_TMPDIR"),
        "/../deploy/outcome_tokens.so"
    ));
    svm.add_program(outcome_tokens::id(), bytes).unwrap();

    let admin = funded_keypair(&mut svm, 1);
    set_upgrade_authority(&mut svm, &admin.pubkey());
    set_unix_time(&mut svm, START_TIME);

    Fixture { svm, admin }
}

/// A funded wallet derived from `seed`. Fixed keys keep PDA bump searches, and therefore
/// the compute units printed by the tests, the same on every run.
pub fn funded_keypair(svm: &mut LiteSVM, seed: u8) -> Keypair {
    let keypair = Keypair::new_from_array([seed; 32]);
    svm.airdrop(&keypair.pubkey(), 10 * LAMPORTS_PER_SOL)
        .unwrap();
    keypair
}

pub fn program_data_address() -> Pubkey {
    Pubkey::find_program_address(
        &[outcome_tokens::id().as_ref()],
        &bpf_loader_upgradeable::ID,
    )
    .0
}

/// `LiteSVM::add_program` writes a ProgramData account whose upgrade authority is `None`.
/// Patch the header in place: u32 variant (3 = ProgramData), u64 slot, then
/// `Option<Pubkey>` as one tag byte followed by the 32 key bytes.
pub fn set_upgrade_authority(svm: &mut LiteSVM, authority: &Pubkey) {
    let address = program_data_address();
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

/// Moves `Clock::unix_timestamp`. `LiteSVM::warp_to_slot` only changes the slot.
pub fn set_unix_time(svm: &mut LiteSVM, unix_timestamp: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar(&clock);
    // A new blockhash keeps a repeated instruction from being rejected as a duplicate.
    svm.expire_blockhash();
}

pub fn unix_time(svm: &LiteSVM) -> i64 {
    svm.get_sysvar::<Clock>().unix_timestamp
}

/// Sends one version-0 transaction. `signers[0]` pays the fee.
#[allow(clippy::result_large_err)]
pub fn send(
    svm: &mut LiteSVM,
    instructions: &[Instruction],
    signers: &[&Keypair],
) -> TransactionResult {
    let payer = signers[0].pubkey();
    let message =
        v0::Message::try_compile(&payer, instructions, &[], svm.latest_blockhash()).unwrap();
    let transaction =
        VersionedTransaction::try_new(VersionedMessage::V0(message), signers).unwrap();
    svm.send_transaction(transaction)
}

/// Sends a transaction that must succeed and returns the compute units it consumed.
pub fn send_ok(svm: &mut LiteSVM, instructions: &[Instruction], signers: &[&Keypair]) -> u64 {
    match send(svm, instructions, signers) {
        Ok(meta) => meta.compute_units_consumed,
        Err(failure) => panic!(
            "transaction failed: {:?}\n{}",
            failure.err,
            failure.meta.pretty_logs()
        ),
    }
}

/// Asserts that the transaction failed with the given custom program error code.
pub fn assert_custom_error(result: TransactionResult, expected: u32) {
    match result {
        Ok(_) => panic!("transaction succeeded, expected custom error {expected}"),
        Err(failure) => match failure.err {
            TransactionError::InstructionError(_, InstructionError::Custom(code)) => {
                assert_eq!(code, expected, "{}", failure.meta.pretty_logs())
            }
            other => panic!(
                "expected custom error {expected}, got {other:?}\n{}",
                failure.meta.pretty_logs()
            ),
        },
    }
}

pub fn program_error(code: outcome_tokens::error::ErrorCode) -> u32 {
    code.into()
}

pub fn anchor_error(code: anchor_lang::error::ErrorCode) -> u32 {
    code.into()
}

pub fn load<T: AccountDeserialize>(svm: &LiteSVM, address: &Pubkey) -> T {
    let account = svm.get_account(address).expect("account exists");
    T::try_deserialize(&mut account.data.as_slice()).unwrap()
}

/// True when the address holds no lamports and no data (never created, or closed).
pub fn is_closed(svm: &LiteSVM, address: &Pubkey) -> bool {
    svm.get_account(address)
        .is_none_or(|account| account.lamports == 0 && account.data.is_empty())
}

pub fn lamports(svm: &LiteSVM, address: &Pubkey) -> u64 {
    svm.get_account(address)
        .map_or(0, |account| account.lamports)
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

pub fn market_address(symbol_hash: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(
        &[outcome_tokens::MARKET_SEED, symbol_hash],
        &outcome_tokens::id(),
    )
    .0
}

pub fn mint_address(market: &Pubkey, side: u8) -> Pubkey {
    Pubkey::find_program_address(
        &[outcome_tokens::MINT_SEED, market.as_ref(), &[side]],
        &outcome_tokens::id(),
    )
    .0
}

pub fn order_address(user: &Pubkey, nonce: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[
            outcome_tokens::ORDER_SEED,
            user.as_ref(),
            &nonce.to_le_bytes(),
        ],
        &outcome_tokens::id(),
    )
    .0
}

pub fn escrow_address(order: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[outcome_tokens::ESCROW_SEED, order.as_ref()],
        &outcome_tokens::id(),
    )
    .0
}

// --- Classic SPL Token helpers (the stand-in stablecoin) -------------------------------

/// Creates a classic SPL Token mint with no freeze authority. `authority` pays and mints.
pub fn create_classic_mint(svm: &mut LiteSVM, authority: &Keypair, decimals: u8) -> Pubkey {
    let mint = Keypair::new();
    let space = spl_token::state::Mint::LEN;
    let instructions = [
        system_instruction::create_account(
            &authority.pubkey(),
            &mint.pubkey(),
            svm.minimum_balance_for_rent_exemption(space),
            space as u64,
            &spl_token::ID,
        ),
        spl_token::instruction::initialize_mint2(
            &spl_token::ID,
            &mint.pubkey(),
            &authority.pubkey(),
            None,
            decimals,
        )
        .unwrap(),
    ];
    send_ok(svm, &instructions, &[authority, &mint]);
    mint.pubkey()
}

/// Creates a classic token account at a fresh keypair address (deliberately not an ATA).
pub fn create_classic_token_account(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: &Pubkey,
    owner: &Pubkey,
) -> Pubkey {
    let account = Keypair::new();
    let space = spl_token::state::Account::LEN;
    let instructions = [
        system_instruction::create_account(
            &payer.pubkey(),
            &account.pubkey(),
            svm.minimum_balance_for_rent_exemption(space),
            space as u64,
            &spl_token::ID,
        ),
        spl_token::instruction::initialize_account3(&spl_token::ID, &account.pubkey(), mint, owner)
            .unwrap(),
    ];
    send_ok(svm, &instructions, &[payer, &account]);
    account.pubkey()
}

pub fn mint_classic(
    svm: &mut LiteSVM,
    authority: &Keypair,
    mint: &Pubkey,
    destination: &Pubkey,
    amount: u64,
) {
    let instruction = spl_token::instruction::mint_to(
        &spl_token::ID,
        mint,
        destination,
        &authority.pubkey(),
        &[],
        amount,
    )
    .unwrap();
    send_ok(svm, &[instruction], &[authority]);
}

pub fn classic_token_account(svm: &LiteSVM, address: &Pubkey) -> spl_token::state::Account {
    let account = svm.get_account(address).expect("token account exists");
    assert_eq!(account.owner, spl_token::ID);
    spl_token::state::Account::unpack(&account.data).unwrap()
}

pub fn classic_balance(svm: &LiteSVM, address: &Pubkey) -> u64 {
    classic_token_account(svm, address).amount
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
