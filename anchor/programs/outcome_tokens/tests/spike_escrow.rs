//! Classic SPL Token escrow in a PDA-owned token account, released by clock time.

mod common;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        InstructionData, ToAccountMetas,
    },
    anchor_spl::token::spl_token,
    common::*,
    litesvm::LiteSVM,
    outcome_tokens::{error::ErrorCode, state::SpikeOrder},
    solana_keypair::Keypair,
    solana_signer::Signer,
};

const STABLE_DECIMALS: u8 = 6;
const STARTING_BALANCE: u64 = 1_000_000;
const DEPOSIT: u64 = 250_000;
const TTL_SECS: i64 = 60;
const NONCE: u64 = 7;

struct Escrow {
    svm: LiteSVM,
    /// Mint authority of the stand-in stablecoin.
    issuer: Keypair,
    user: Keypair,
    stable_mint: Pubkey,
    user_token: Pubkey,
    order: Pubkey,
    escrow: Pubkey,
}

/// A user holding `STARTING_BALANCE` of a classic 6-decimal mint, with nothing escrowed yet.
fn setup_user() -> Escrow {
    let Fixture { mut svm, .. } = setup();
    let issuer = funded_keypair(&mut svm, 2);
    let user = funded_keypair(&mut svm, 3);
    let stable_mint = create_classic_mint(&mut svm, &issuer, STABLE_DECIMALS);
    let user_token = create_classic_token_account(&mut svm, &user, &stable_mint, &user.pubkey());
    mint_classic(
        &mut svm,
        &issuer,
        &stable_mint,
        &user_token,
        STARTING_BALANCE,
    );
    let order = order_address(&user.pubkey(), NONCE);
    let escrow = escrow_address(&order);
    Escrow {
        svm,
        issuer,
        user,
        stable_mint,
        user_token,
        order,
        escrow,
    }
}

/// Same as `setup_user`, with `DEPOSIT` escrowed at `START_TIME` for `TTL_SECS`.
fn setup_escrowed() -> Escrow {
    let mut t = setup_user();
    let instruction = escrow_ix(&t, DEPOSIT, TTL_SECS);
    send_ok(&mut t.svm, &[instruction], &[&t.user]);
    t
}

fn escrow_ix(t: &Escrow, amount: u64, ttl_secs: i64) -> Instruction {
    Instruction::new_with_bytes(
        outcome_tokens::id(),
        &outcome_tokens::instruction::SpikeEscrow {
            nonce: NONCE,
            amount,
            ttl_secs,
        }
        .data(),
        outcome_tokens::accounts::SpikeEscrow {
            user: t.user.pubkey(),
            order: t.order,
            escrow: t.escrow,
            stable_mint: t.stable_mint,
            user_token: t.user_token,
            token_program: spl_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn release_ix(t: &Escrow, caller: &Pubkey, destination: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        outcome_tokens::id(),
        &outcome_tokens::instruction::SpikeRelease {}.data(),
        outcome_tokens::accounts::SpikeRelease {
            caller: *caller,
            user: t.user.pubkey(),
            order: t.order,
            escrow: t.escrow,
            stable_mint: t.stable_mint,
            destination: *destination,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
    )
}

#[test]
fn escrow_moves_the_amount_into_a_token_account_owned_by_the_order_pda() {
    let mut t = setup_user();

    let instruction = escrow_ix(&t, DEPOSIT, TTL_SECS);
    let units = send_ok(&mut t.svm, &[instruction], &[&t.user]);
    println!("compute units: spike_escrow = {units}");
    assert!(units < 200_000);

    let escrow = classic_token_account(&t.svm, &t.escrow);
    assert_eq!(escrow.amount, DEPOSIT);
    assert_eq!(escrow.owner, t.order);
    assert_eq!(escrow.mint, t.stable_mint);
    assert_eq!(
        classic_balance(&t.svm, &t.user_token),
        STARTING_BALANCE - DEPOSIT
    );

    let order: SpikeOrder = load(&t.svm, &t.order);
    assert_eq!(order.user, t.user.pubkey());
    assert_eq!(order.nonce, NONCE);
    assert_eq!(order.expires_at, START_TIME + TTL_SECS);
    assert_eq!(
        t.svm.get_account(&t.order).unwrap().owner,
        outcome_tokens::id()
    );
}

#[test]
fn escrow_rejects_a_zero_amount_and_a_non_positive_ttl() {
    let mut t = setup_user();

    let instruction = escrow_ix(&t, 0, TTL_SECS);
    let result = send(&mut t.svm, &[instruction], &[&t.user]);
    assert_custom_error(result, program_error(ErrorCode::ZeroAmount));

    let instruction = escrow_ix(&t, DEPOSIT, 0);
    let result = send(&mut t.svm, &[instruction], &[&t.user]);
    assert_custom_error(result, program_error(ErrorCode::InvalidTtl));

    assert!(is_closed(&t.svm, &t.order));
    assert!(is_closed(&t.svm, &t.escrow));
    assert_eq!(classic_balance(&t.svm, &t.user_token), STARTING_BALANCE);
}

#[test]
fn release_fails_at_expiry_and_succeeds_one_second_later() {
    let mut t = setup_escrowed();
    let expires_at = START_TIME + TTL_SECS;
    // Anyone may crank the release; the refund goes to an account the user owns that is
    // neither the funding account nor an associated token account.
    let cranker = funded_keypair(&mut t.svm, 4);
    let destination =
        create_classic_token_account(&mut t.svm, &cranker, &t.stable_mint, &t.user.pubkey());
    let instruction = release_ix(&t, &cranker.pubkey(), &destination);

    set_unix_time(&mut t.svm, expires_at);
    assert_eq!(unix_time(&t.svm), expires_at);
    let result = send(&mut t.svm, std::slice::from_ref(&instruction), &[&cranker]);
    assert_custom_error(result, program_error(ErrorCode::NotExpired));
    assert_eq!(classic_balance(&t.svm, &t.escrow), DEPOSIT);
    assert_eq!(classic_balance(&t.svm, &destination), 0);

    set_unix_time(&mut t.svm, expires_at + 1);
    let rent = lamports(&t.svm, &t.order) + lamports(&t.svm, &t.escrow);
    let user_lamports = lamports(&t.svm, &t.user.pubkey());
    let units = send_ok(&mut t.svm, &[instruction], &[&cranker]);
    println!("compute units: spike_release = {units}");
    assert!(units < 200_000);

    assert!(is_closed(&t.svm, &t.escrow));
    assert!(is_closed(&t.svm, &t.order));
    assert_eq!(classic_balance(&t.svm, &destination), DEPOSIT);
    assert_eq!(
        classic_balance(&t.svm, &t.user_token) + classic_balance(&t.svm, &destination),
        STARTING_BALANCE
    );
    // The rent of both closed accounts returns to the user who paid it.
    assert!(rent > 0);
    assert_eq!(lamports(&t.svm, &t.user.pubkey()), user_lamports + rent);
}

#[test]
fn release_sweeps_the_live_escrow_balance() {
    let mut t = setup_escrowed();
    // A third party donates one base unit to the escrow; it must not block the release.
    mint_classic(&mut t.svm, &t.issuer, &t.stable_mint, &t.escrow, 1);
    assert_eq!(classic_balance(&t.svm, &t.escrow), DEPOSIT + 1);

    set_unix_time(&mut t.svm, START_TIME + TTL_SECS + 1);
    let instruction = release_ix(&t, &t.user.pubkey(), &t.user_token);
    send_ok(&mut t.svm, &[instruction], &[&t.user]);

    assert!(is_closed(&t.svm, &t.escrow));
    assert!(is_closed(&t.svm, &t.order));
    assert_eq!(classic_balance(&t.svm, &t.user_token), STARTING_BALANCE + 1);
}

#[test]
fn release_rejects_destinations_with_another_owner_or_mint() {
    let mut t = setup_escrowed();
    let stranger = funded_keypair(&mut t.svm, 5);
    set_unix_time(&mut t.svm, START_TIME + TTL_SECS + 1);

    let strangers_account =
        create_classic_token_account(&mut t.svm, &stranger, &t.stable_mint, &stranger.pubkey());
    let instruction = release_ix(&t, &stranger.pubkey(), &strangers_account);
    let result = send(&mut t.svm, &[instruction], &[&stranger]);
    assert_custom_error(
        result,
        anchor_error(anchor_lang::error::ErrorCode::ConstraintTokenOwner),
    );

    let other_mint = create_classic_mint(&mut t.svm, &stranger, STABLE_DECIMALS);
    let other_mint_account =
        create_classic_token_account(&mut t.svm, &stranger, &other_mint, &t.user.pubkey());
    let instruction = release_ix(&t, &stranger.pubkey(), &other_mint_account);
    let result = send(&mut t.svm, &[instruction], &[&stranger]);
    assert_custom_error(
        result,
        anchor_error(anchor_lang::error::ErrorCode::ConstraintTokenMint),
    );

    assert_eq!(classic_balance(&t.svm, &t.escrow), DEPOSIT);
    assert_eq!(classic_balance(&t.svm, &strangers_account), 0);
}

#[test]
fn warping_the_slot_does_not_move_the_unix_timestamp() {
    let mut t = setup_escrowed();
    let slot = t.svm.get_sysvar::<anchor_lang::prelude::Clock>().slot;

    t.svm.warp_to_slot(slot + 1_000_000);
    t.svm.expire_blockhash();

    assert_eq!(unix_time(&t.svm), START_TIME);
    let instruction = release_ix(&t, &t.user.pubkey(), &t.user_token);
    let result = send(&mut t.svm, &[instruction], &[&t.user]);
    assert_custom_error(result, program_error(ErrorCode::NotExpired));
}
