//! `cancel_order`, exercised with buy orders. `sell.rs` covers sell orders.

mod common;

use {
    anchor_lang::prelude::Pubkey,
    anchor_spl::{token::spl_token, token_2022::spl_token_2022},
    common::*,
    outcome_tokens::{
        constants::{PAUSE_FILL, PAUSE_PLACE},
        error::ErrorCode,
        events::OrderCancelled,
        instruction::FillBuy,
        state::Order,
    },
    solana_keypair::Keypair,
    solana_signer::Signer,
};

/// The trading scene with the fixture's buy order placed by the trader, who also paid the
/// rent.
struct Placed {
    env: Env,
    market: MarketKeys,
    trader: TraderKeys,
    order: Pubkey,
    escrow: Pubkey,
    expires_at: i64,
}

fn placed_order() -> Placed {
    let Scene {
        mut env,
        market,
        trader,
    } = trading_scene();
    let order = place_buy(&mut env, &trader, &market.market, place_buy_args());
    let expires_at = load::<Order>(&env.svm, &order).expires_at;
    Placed {
        env,
        market,
        trader,
        order,
        escrow: escrow_address(&order),
        expires_at,
    }
}

impl Placed {
    /// Sends a cancel of the order that refunds the trader's stable account.
    fn try_cancel(&mut self, caller: &Keypair) -> SendResult {
        let accounts = cancel_order_accounts(
            &self.env,
            &caller.pubkey(),
            &self.order,
            &self.trader.stable,
        );
        try_cancel_order(&mut self.env, caller, accounts)
    }

    fn assert_refunded_and_closed(&self) {
        assert_eq!(
            token_balance(&self.env.svm, &self.trader.stable),
            TRADER_STABLE
        );
        assert!(is_closed(&self.env.svm, &self.order));
        assert!(is_closed(&self.env.svm, &self.escrow));
    }

    fn assert_still_open(&self) {
        assert_eq!(token_balance(&self.env.svm, &self.escrow), ORDER_ESCROW);
        assert!(!is_closed(&self.env.svm, &self.order));
    }
}

#[test]
fn cancel_order_by_the_relayer_refunds_the_escrow_and_closes_the_order() {
    let Scene {
        mut env,
        market,
        trader,
    } = trading_scene();
    // A separate payer shows where the rent goes.
    let payer = funded_keypair(&mut env.svm, 11);
    let user = trader.wallet.pubkey();
    let accounts = place_buy_accounts(&env, &user, &payer.pubkey(), &market.market, &trader.stable);
    let (order, escrow) = (accounts.order, accounts.escrow);
    send_ok(
        &mut env.svm,
        &[instruction(accounts, place_buy_args())],
        &[&payer, &trader.wallet],
    );
    let payer_lamports = lamports(&env.svm, &payer.pubkey());
    let rent = lamports(&env.svm, &order) + lamports(&env.svm, &escrow);
    let relayer = env.relayer.pubkey();

    // Well before the expiry.
    let accounts = cancel_order_accounts(&env, &relayer, &order, &trader.stable);
    assert_eq!(accounts.token_program, spl_token::ID);
    let again = cancel_order_accounts(&env, &relayer, &order, &trader.stable);
    let meta = send_ok(
        &mut env.svm,
        &[instruction(
            accounts,
            outcome_tokens::instruction::CancelOrder {},
        )],
        &[&env.relayer],
    );
    println!(
        "compute units: cancel_order = {}",
        meta.compute_units_consumed
    );

    assert_eq!(token_balance(&env.svm, &trader.stable), TRADER_STABLE);
    assert_eq!(token_balance(&env.svm, &env.treasury), 0);
    assert!(is_closed(&env.svm, &order));
    assert!(is_closed(&env.svm, &escrow));
    assert_eq!(lamports(&env.svm, &payer.pubkey()), payer_lamports + rent);

    let cancelled = events::<OrderCancelled>(&meta);
    assert_eq!(cancelled.len(), 1);
    assert_eq!(cancelled[0].order, order);
    assert_eq!(cancelled[0].user, user);
    assert_eq!(cancelled[0].market, market.market);
    assert_eq!(cancelled[0].by, relayer);

    // The order and its escrow are gone: there is nothing to cancel a second time.
    let relayer = env.relayer.insecure_clone();
    assert_anchor_err(
        try_cancel_order(&mut env, &relayer, again),
        anchor_lang::error::ErrorCode::AccountNotInitialized,
    );
}

#[test]
fn cancel_order_by_a_stranger_opens_one_second_after_the_expiry() {
    let mut placed = placed_order();
    let stranger = funded_keypair(&mut placed.env.svm, 12);

    // The order can still be filled at its expiry time.
    set_time(&mut placed.env.svm, placed.expires_at);
    assert_err(placed.try_cancel(&stranger), ErrorCode::OrderNotExpired);
    placed.assert_still_open();

    set_time(&mut placed.env.svm, placed.expires_at + 1);
    placed.try_cancel(&stranger).unwrap();
    placed.assert_refunded_and_closed();
}

#[test]
fn cancel_order_by_the_user_waits_for_the_expiry_in_normal_operation() {
    let mut placed = placed_order();
    let user = placed.trader.wallet.insecure_clone();

    assert_err(placed.try_cancel(&user), ErrorCode::OrderNotExpired);

    // Neither a placement pause nor a halt stops fills, so neither frees the order.
    set_pause_flags(&mut placed.env, PAUSE_PLACE);
    halt_market(&mut placed.env, &placed.market.market);
    set_time(&mut placed.env.svm, placed.expires_at);
    assert_err(placed.try_cancel(&user), ErrorCode::OrderNotExpired);
    placed.assert_still_open();
}

#[test]
fn cancel_order_by_the_user_is_allowed_while_fills_are_paused() {
    let mut placed = placed_order();
    let user = placed.trader.wallet.insecure_clone();
    let stranger = funded_keypair(&mut placed.env.svm, 12);
    set_pause_flags(&mut placed.env, PAUSE_FILL);

    // The pause frees the order for its user only.
    assert_err(placed.try_cancel(&stranger), ErrorCode::OrderNotExpired);

    placed.try_cancel(&user).unwrap();
    placed.assert_refunded_and_closed();
}

#[test]
fn cancel_order_only_refunds_a_token_account_the_orders_user_owns() {
    let mut placed = placed_order();
    let attacker = funded_keypair(&mut placed.env.svm, 12);
    let attacker_stable = create_stable_account(&mut placed.env, &attacker.pubkey(), 0);
    let relayer = placed.env.relayer.insecure_clone();

    let accounts = cancel_order_accounts(
        &placed.env,
        &relayer.pubkey(),
        &placed.order,
        &attacker_stable,
    );
    assert_err(
        try_cancel_order(&mut placed.env, &relayer, accounts),
        ErrorCode::WrongOwner,
    );

    // Not after the expiry either, when anyone may cancel.
    set_time(&mut placed.env.svm, placed.expires_at + 1);
    let accounts = cancel_order_accounts(
        &placed.env,
        &attacker.pubkey(),
        &placed.order,
        &attacker_stable,
    );
    assert_err(
        try_cancel_order(&mut placed.env, &attacker, accounts),
        ErrorCode::WrongOwner,
    );
    assert_eq!(token_balance(&placed.env.svm, &attacker_stable), 0);
    placed.assert_still_open();

    // Any other stable account of the user will do.
    let user = placed.trader.wallet.pubkey();
    let other_stable = create_stable_account(&mut placed.env, &user, 0);
    let accounts = cancel_order_accounts(
        &placed.env,
        &attacker.pubkey(),
        &placed.order,
        &other_stable,
    );
    try_cancel_order(&mut placed.env, &attacker, accounts).unwrap();
    assert_eq!(token_balance(&placed.env.svm, &other_stable), ORDER_ESCROW);
}

#[test]
fn cancel_order_ignores_the_pause_flags_and_a_halted_market() {
    let mut placed = placed_order();
    let second = place_buy(
        &mut placed.env,
        &placed.trader,
        &placed.market.market,
        place_buy_args(),
    );
    let stranger = funded_keypair(&mut placed.env.svm, 12);
    let relayer = placed.env.relayer.insecure_clone();
    set_pause_flags(&mut placed.env, PAUSE_PLACE | PAUSE_FILL);
    halt_market(&mut placed.env, &placed.market.market);

    placed.try_cancel(&relayer).unwrap();
    assert!(is_closed(&placed.env.svm, &placed.order));

    set_time(&mut placed.env.svm, placed.expires_at + 1);
    let accounts = cancel_order_accounts(
        &placed.env,
        &stranger.pubkey(),
        &second,
        &placed.trader.stable,
    );
    try_cancel_order(&mut placed.env, &stranger, accounts).unwrap();
    assert!(is_closed(&placed.env.svm, &second));
    assert_eq!(
        token_balance(&placed.env.svm, &placed.trader.stable),
        TRADER_STABLE
    );
}

#[test]
fn cancel_order_refunds_tokens_donated_to_the_escrow() {
    let mut placed = placed_order();
    let relayer = placed.env.relayer.insecure_clone();
    let donation = 777;
    mint_stable(&mut placed.env, &placed.escrow, donation);

    placed.try_cancel(&relayer).unwrap();

    assert_eq!(
        token_balance(&placed.env.svm, &placed.trader.stable),
        TRADER_STABLE + donation
    );
    assert!(is_closed(&placed.env.svm, &placed.escrow));
}

#[test]
fn cancel_order_rejects_substituted_accounts() {
    let mut placed = placed_order();
    let relayer = placed.env.relayer.insecure_clone();
    let user = placed.trader.wallet.pubkey();
    let other_market = create_market_with_mints(&mut placed.env, "TEST-MARKET-2");
    let other_order = place_buy(
        &mut placed.env,
        &placed.trader,
        &placed.market.market,
        place_buy_args(),
    );
    let other_mint = create_mint(
        &mut placed.env.svm,
        &spl_token::ID,
        &relayer,
        &Keypair::new_from_array([13; 32]),
        6,
    );
    let other_mint_account = create_token_account(
        &mut placed.env.svm,
        &spl_token::ID,
        &relayer,
        &other_mint,
        &user,
    );
    let attacker = funded_keypair(&mut placed.env.svm, 12);
    let base = |placed: &Placed| {
        cancel_order_accounts(
            &placed.env,
            &relayer.pubkey(),
            &placed.order,
            &placed.trader.stable,
        )
    };

    // The permission rule reads the market's status, so it must be the order's market.
    let mut accounts = base(&placed);
    accounts.market = other_market.market;
    assert_err(
        try_cancel_order(&mut placed.env, &relayer, accounts),
        ErrorCode::WrongMarket,
    );

    let mut accounts = base(&placed);
    accounts.escrow = escrow_address(&other_order);
    assert_anchor_err(
        try_cancel_order(&mut placed.env, &relayer, accounts),
        anchor_lang::error::ErrorCode::ConstraintSeeds,
    );

    let mut accounts = base(&placed);
    accounts.user_token = other_mint_account;
    assert_anchor_err(
        try_cancel_order(&mut placed.env, &relayer, accounts),
        anchor_lang::error::ErrorCode::ConstraintTokenMint,
    );

    // Naming another mint does not help, even with a matching account of the user.
    let mut accounts = base(&placed);
    accounts.escrow_mint = other_mint;
    accounts.user_token = other_mint_account;
    assert_anchor_err(
        try_cancel_order(&mut placed.env, &relayer, accounts),
        anchor_lang::error::ErrorCode::ConstraintTokenMint,
    );

    let mut accounts = base(&placed);
    accounts.rent_payer = attacker.pubkey();
    assert_anchor_err(
        try_cancel_order(&mut placed.env, &relayer, accounts),
        anchor_lang::error::ErrorCode::ConstraintHasOne,
    );

    // The token program must be the one that owns the escrow.
    let mut accounts = base(&placed);
    accounts.token_program = spl_token_2022::ID;
    assert_anchor_err(
        try_cancel_order(&mut placed.env, &relayer, accounts),
        anchor_lang::error::ErrorCode::ConstraintTokenTokenProgram,
    );
    placed.assert_still_open();
}

#[test]
fn cancel_order_prevents_a_later_fill() {
    let mut placed = placed_order();
    let relayer = placed.env.relayer.insecure_clone();
    let user = placed.trader.wallet.pubkey();
    let user_outcome = create_outcome_account(&mut placed.env, &placed.market.yes_mint, &user);
    let fill = fill_buy_accounts(
        &placed.env,
        &placed.order,
        &user_outcome,
        &placed.trader.stable,
    );
    placed.try_cancel(&relayer).unwrap();

    let args = FillBuy {
        fill_qty: ORDER_QTY,
        cost: ORDER_QTY * u64::from(ORDER_LIMIT_PX),
        fee: 0,
    };
    let result = send(&mut placed.env.svm, &[instruction(fill, args)], &[&relayer]);

    assert_anchor_err(result, anchor_lang::error::ErrorCode::AccountNotInitialized);
    assert_eq!(mint_supply(&placed.env.svm, &placed.market.yes_mint), 0);
    assert_eq!(token_balance(&placed.env.svm, &placed.env.treasury), 0);
}

#[test]
fn order_addresses_never_repeat_after_an_order_is_closed() {
    let mut placed = placed_order();
    let relayer = placed.env.relayer.insecure_clone();
    let user = placed.trader.wallet.pubkey();
    assert_eq!(placed.order, order_address(&user, 0));

    // Closed by a cancel.
    placed.try_cancel(&relayer).unwrap();
    let second = place_buy(
        &mut placed.env,
        &placed.trader,
        &placed.market.market,
        place_buy_args(),
    );
    assert_eq!(second, order_address(&user, 1));
    assert_ne!(second, placed.order);
    assert!(is_closed(&placed.env.svm, &placed.order));

    // Closed by a fill.
    let user_outcome = create_outcome_account(&mut placed.env, &placed.market.yes_mint, &user);
    let fill = fill_buy_accounts(&placed.env, &second, &user_outcome, &placed.trader.stable);
    let args = FillBuy {
        fill_qty: ORDER_QTY,
        cost: ORDER_QTY * u64::from(ORDER_LIMIT_PX),
        fee: 0,
    };
    send_ok(&mut placed.env.svm, &[instruction(fill, args)], &[&relayer]);
    let third = place_buy(
        &mut placed.env,
        &placed.trader,
        &placed.market.market,
        place_buy_args(),
    );
    assert_eq!(third, order_address(&user, 2));
    assert_eq!(load::<Order>(&placed.env.svm, &third).nonce, 2);
    assert!(is_closed(&placed.env.svm, &placed.order));
    assert!(is_closed(&placed.env.svm, &second));
}
