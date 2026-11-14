//! Whole-program scenarios: the full lifecycle of a market, and what each role cannot do.

mod common;

use {
    anchor_lang::prelude::Pubkey,
    anchor_spl::token_2022::spl_token_2022,
    common::*,
    outcome_tokens::{
        constants::{PAUSE_FILL, PAUSE_PLACE},
        error::ErrorCode,
        instruction::{FillBuy, FillSell, PlaceBuy, PlaceSell, SettleMarket},
        instructions::SetConfigArgs,
        state::{Market, MarketStatus, Order, Side},
    },
    solana_keypair::Keypair,
    solana_signer::Signer,
};

/// Stable balance of the relayer's payout account and of the settler's funding account.
const ROLE_STABLE: u64 = 1_000_000_000;

fn fill_buy(
    env: &mut Env,
    order: &Pubkey,
    user_outcome: &Pubkey,
    user_stable: &Pubkey,
    args: FillBuy,
) {
    let accounts = fill_buy_accounts(env, order, user_outcome, user_stable);
    send_ok(
        &mut env.svm,
        &[instruction(accounts, args)],
        &[&env.relayer],
    );
}

fn assert_order_closed(env: &Env, order: &Pubkey) {
    assert!(is_closed(&env.svm, order));
    assert!(is_closed(&env.svm, &escrow_address(order)));
}

// --- Full lifecycle --------------------------------------------------------------------

#[test]
fn a_market_runs_from_the_first_order_to_the_last_redemption() {
    let Scene {
        mut env,
        market,
        trader: alice,
    } = trading_scene();
    let bob = create_trader(&mut env, 12, TRADER_STABLE);
    let stranger = funded_keypair(&mut env.svm, 13);
    let (relayer, settler) = (env.relayer.pubkey(), env.settler.pubkey());
    let payout_source = create_stable_account(&mut env, &relayer, ROLE_STABLE);
    let funder = create_stable_account(&mut env, &settler, ROLE_STABLE);
    let alice_yes = create_outcome_account(&mut env, &market.yes_mint, &alice.wallet.pubkey());
    let bob_no = create_outcome_account(&mut env, &market.no_mint, &bob.wallet.pubkey());
    let vault = vault_address(&market.market);
    let balance = |env: &Env, account: &Pubkey| token_balance(&env.svm, account);

    // Alice buys 1,000 YES at 6,000 or less. The venue fills all of it at 5,800.
    let (yes_cost, yes_fee) = (1_000 * 5_800, 12_000);
    let args = PlaceBuy {
        side: Side::Yes,
        qty_units: 1_000,
        limit_px: 6_000,
        max_fee: 20_000,
    };
    let alice_buy = place_buy(&mut env, &alice, &market.market, args);
    assert_eq!(balance(&env, &escrow_address(&alice_buy)), 6_020_000);
    assert_eq!(balance(&env, &alice.stable), TRADER_STABLE - 6_020_000);
    let fill = FillBuy {
        fill_qty: 1_000,
        cost: yes_cost,
        fee: yes_fee,
    };
    fill_buy(&mut env, &alice_buy, &alice_yes, &alice.stable, fill);
    let mut alice_stable = TRADER_STABLE - yes_cost - yes_fee;
    let mut treasury = yes_cost + yes_fee;
    assert_eq!(balance(&env, &alice_yes), 1_000);
    assert_eq!(balance(&env, &alice.stable), alice_stable);
    assert_eq!(balance(&env, &env.treasury), treasury);
    assert_eq!(mint_supply(&env.svm, &market.yes_mint), 1_000);
    assert_order_closed(&env, &alice_buy);

    // Bob buys 500 NO at 4,000 or less. Only 300 fill, at his limit.
    let (no_cost, no_fee) = (300 * 4_000, 8_000);
    let args = PlaceBuy {
        side: Side::No,
        qty_units: 500,
        limit_px: 4_000,
        max_fee: 10_000,
    };
    let bob_buy = place_buy(&mut env, &bob, &market.market, args);
    assert_eq!(balance(&env, &escrow_address(&bob_buy)), 2_010_000);
    let fill = FillBuy {
        fill_qty: 300,
        cost: no_cost,
        fee: no_fee,
    };
    fill_buy(&mut env, &bob_buy, &bob_no, &bob.stable, fill);
    let bob_stable = TRADER_STABLE - no_cost - no_fee;
    treasury += no_cost + no_fee;
    assert_eq!(balance(&env, &bob_no), 300);
    assert_eq!(balance(&env, &bob.stable), bob_stable);
    assert_eq!(balance(&env, &env.treasury), treasury);
    assert_eq!(mint_supply(&env.svm, &market.no_mint), 300);
    assert_order_closed(&env, &bob_buy);

    // Alice sells 400 YES back at 5,000 or more. The venue pays 6,500 per unit.
    let (proceeds, sell_fee) = (400 * 6_500, 9_000);
    let args = PlaceSell {
        side: Side::Yes,
        qty_units: 400,
        min_px: 5_000,
        max_fee: 15_000,
    };
    let alice_sell = place_sell(&mut env, &alice, &market, &alice_yes, args);
    assert_eq!(balance(&env, &escrow_address(&alice_sell)), 400);
    assert_eq!(balance(&env, &alice_yes), 600);
    let accounts = fill_sell_accounts(&env, &alice_sell, &payout_source, &alice.stable, &alice_yes);
    let fill = FillSell {
        fill_qty: 400,
        proceeds,
        fee: sell_fee,
    };
    send_ok(
        &mut env.svm,
        &[instruction(accounts, fill)],
        &[&env.relayer],
    );
    alice_stable += proceeds - sell_fee;
    assert_eq!(balance(&env, &alice_yes), 600);
    assert_eq!(balance(&env, &alice.stable), alice_stable);
    assert_eq!(
        balance(&env, &payout_source),
        ROLE_STABLE - (proceeds - sell_fee)
    );
    assert_eq!(balance(&env, &env.treasury), treasury);
    assert_eq!(mint_supply(&env.svm, &market.yes_mint), 600);
    assert_order_closed(&env, &alice_sell);

    // Bob's next order never fills. Once it has expired, a stranger sends his funds back.
    let bob_expired = place_buy(&mut env, &bob, &market.market, place_buy_args());
    assert_eq!(balance(&env, &bob.stable), bob_stable - ORDER_ESCROW);
    let expires_at = load::<Order>(&env.svm, &bob_expired).expires_at;
    set_time(&mut env.svm, expires_at + 1);
    let accounts = cancel_order_accounts(&env, &stranger.pubkey(), &bob_expired, &bob.stable);
    try_cancel_order(&mut env, &stranger, accounts).unwrap();
    assert_eq!(balance(&env, &bob.stable), bob_stable);
    assert_order_closed(&env, &bob_expired);

    // Trading stops.
    halt_market(&mut env, &market.market);
    let user = alice.wallet.pubkey();
    let accounts = place_buy_accounts(&env, &user, &user, &market.market, &alice.stable);
    let result = send(
        &mut env.svm,
        &[instruction(accounts, place_buy_args())],
        &[&alice.wallet],
    );
    assert_err(result, ErrorCode::MarketNotOpen);

    // YES wins. The settler funds what the 600 YES units in circulation are worth.
    let funding = 600 * 10_000;
    let accounts = settle_market_accounts(&env, &market, &funder);
    try_settle_market(&mut env, accounts, 10_000, 0).unwrap();
    assert_eq!(balance(&env, &vault), funding);
    assert_eq!(balance(&env, &funder), ROLE_STABLE - funding);
    let stored: Market = load(&env.svm, &market.market);
    assert_eq!(stored.status, MarketStatus::Settled as u8);

    // Redemption opens after the delay.
    let redeem_yes = |env: &Env| {
        redeem_accounts(
            env,
            &alice.wallet.pubkey(),
            &market.market,
            &market.yes_mint,
            &alice_yes,
            &alice.stable,
        )
    };
    set_time(&mut env.svm, stored.redeem_after - 1);
    let accounts = redeem_yes(&env);
    assert_err(
        try_redeem(&mut env, &alice.wallet, accounts, 600),
        ErrorCode::RedeemLocked,
    );
    set_time(&mut env.svm, stored.redeem_after);

    // Alice redeems her winning tokens.
    let accounts = redeem_yes(&env);
    try_redeem(&mut env, &alice.wallet, accounts, 600).unwrap();
    alice_stable += funding;
    assert_eq!(balance(&env, &alice_yes), 0);
    assert_eq!(balance(&env, &alice.stable), alice_stable);

    // Bob's tokens lost: redeeming burns them for nothing.
    let accounts = redeem_accounts(
        &env,
        &bob.wallet.pubkey(),
        &market.market,
        &market.no_mint,
        &bob_no,
        &bob.stable,
    );
    try_redeem(&mut env, &bob.wallet, accounts, 300).unwrap();
    assert_eq!(balance(&env, &bob_no), 0);
    assert_eq!(balance(&env, &bob.stable), bob_stable);

    // Nothing is left behind.
    assert_eq!(balance(&env, &vault), 0);
    assert_eq!(mint_supply(&env.svm, &market.yes_mint), 0);
    assert_eq!(mint_supply(&env.svm, &market.no_mint), 0);
    for (trader, placed) in [(&alice, 2), (&bob, 2)] {
        let user = trader.wallet.pubkey();
        assert_eq!(next_nonce(&env.svm, &user), placed);
        for nonce in 0..placed {
            assert_order_closed(&env, &order_address(&user, nonce));
        }
    }
    // The treasury holds the cost and fee of the two buy fills and nothing else.
    assert_eq!(
        balance(&env, &env.treasury),
        yes_cost + yes_fee + no_cost + no_fee
    );
    // Every stable token minted at the start is still in one of the accounts that took
    // part: the program neither created nor lost any.
    let held: u64 = [
        alice.stable,
        bob.stable,
        env.treasury,
        payout_source,
        funder,
        vault,
    ]
    .iter()
    .map(|account| balance(&env, account))
    .sum();
    assert_eq!(held, 2 * TRADER_STABLE + 2 * ROLE_STABLE);
    assert_eq!(
        mint_supply(&env.svm, &env.stable_mint),
        2 * TRADER_STABLE + 2 * ROLE_STABLE
    );
}

// --- Role separation -------------------------------------------------------------------

/// YES tokens Alice holds before she places her sell order.
const HELD: u64 = 1_000;

/// The fixture's market with one holder who has a buy order and a sell order open, a
/// relayer who can pay out proceeds and a settler who can fund a settlement.
struct Roles {
    env: Env,
    market: MarketKeys,
    alice: TraderKeys,
    alice_yes: Pubkey,
    buy_order: Pubkey,
    sell_order: Pubkey,
    /// Stable token account of the relayer.
    payout_source: Pubkey,
    /// Stable token account of the settler.
    funder: Pubkey,
}

fn roles() -> Roles {
    let Scene {
        mut env,
        market,
        trader: alice,
    } = trading_scene();
    let alice_yes = buy_outcome(&mut env, &alice, &market, Side::Yes, HELD);
    let (relayer, settler) = (env.relayer.pubkey(), env.settler.pubkey());
    let payout_source = create_stable_account(&mut env, &relayer, ROLE_STABLE);
    let funder = create_stable_account(&mut env, &settler, ROLE_STABLE);
    let buy_order = place_buy(&mut env, &alice, &market.market, place_buy_args());
    let sell_order = place_sell(&mut env, &alice, &market, &alice_yes, place_sell_args());
    Roles {
        env,
        market,
        alice,
        alice_yes,
        buy_order,
        sell_order,
        payout_source,
        funder,
    }
}

impl Roles {
    /// Sends `fill_buy` and `fill_sell` for the two open orders with `signer` in the
    /// relayer's place, paying sale proceeds out of `signer_stable`.
    fn try_fills(&mut self, signer: &Keypair, signer_stable: &Pubkey) -> [SendResult; 2] {
        let mut accounts = fill_buy_accounts(
            &self.env,
            &self.buy_order,
            &self.alice_yes,
            &self.alice.stable,
        );
        accounts.relayer = signer.pubkey();
        let args = FillBuy {
            fill_qty: ORDER_QTY,
            cost: ORDER_QTY * u64::from(ORDER_LIMIT_PX),
            fee: 0,
        };
        let buy = send(&mut self.env.svm, &[instruction(accounts, args)], &[signer]);

        let mut accounts = fill_sell_accounts(
            &self.env,
            &self.sell_order,
            signer_stable,
            &self.alice.stable,
            &self.alice_yes,
        );
        accounts.relayer = signer.pubkey();
        let args = FillSell {
            fill_qty: SELL_QTY,
            proceeds: SELL_QTY * u64::from(SELL_MIN_PX),
            fee: 0,
        };
        let sell = send(&mut self.env.svm, &[instruction(accounts, args)], &[signer]);
        [buy, sell]
    }

    /// Sends `settle_market` with `signer` in the settler's place, funded from
    /// `signer_stable`.
    fn try_settle_as(&mut self, signer: &Keypair, signer_stable: &Pubkey) -> SendResult {
        let mut accounts = settle_market_accounts(&self.env, &self.market, signer_stable);
        accounts.settler = signer.pubkey();
        accounts.payer = signer.pubkey();
        let args = SettleMarket {
            yes_payout: 0,
            no_payout: 10_000,
        };
        send(&mut self.env.svm, &[instruction(accounts, args)], &[signer])
    }

    /// Sends a `set_config` signed by `signer` that would hand it the settler role.
    fn try_set_config_as(&mut self, signer: &Keypair) -> SendResult {
        let args = SetConfigArgs {
            relayer: None,
            settler: Some(signer.pubkey()),
            registrar: None,
            order_ttl_secs: None,
            min_order_units: None,
            max_order_units: None,
            settle_delay_secs: None,
        };
        let change = set_config_ix(&self.env, &signer.pubkey(), args, None);
        send(&mut self.env.svm, &[change], &[signer])
    }

    fn try_revoke_as(&mut self, signer: &Keypair) -> SendResult {
        let accounts = revoke_settlement_accounts(&self.env, &signer.pubkey(), &self.market.market);
        try_revoke_settlement(&mut self.env, signer, accounts)
    }

    /// Settles `(10_000, 0)` as the settler.
    fn settle(&mut self) {
        let accounts = settle_market_accounts(&self.env, &self.market, &self.funder);
        try_settle_market(&mut self.env, accounts, 10_000, 0).unwrap();
    }
}

#[test]
fn the_relayer_cannot_change_config_resume_reopen_settle_or_revoke() {
    let mut roles = roles();
    let relayer = roles.env.relayer.insecure_clone();
    let market = roles.market.market;

    assert_err(roles.try_set_config_as(&relayer), ErrorCode::Unauthorized);

    // It can pause, but not lift any part of a pause.
    let pause = set_pause_ix(&roles.env, &relayer.pubkey(), PAUSE_PLACE | PAUSE_FILL);
    send_ok(&mut roles.env.svm, &[pause], &[&relayer]);
    for flags in [PAUSE_PLACE, PAUSE_FILL, 0] {
        let resume = set_pause_ix(&roles.env, &relayer.pubkey(), flags);
        let result = send(&mut roles.env.svm, &[resume], &[&relayer]);
        assert_err(result, ErrorCode::Unauthorized);
    }

    // It can halt a market, but not reopen it.
    halt_market(&mut roles.env, &market);
    let reopen = set_market_ix(
        &roles.env,
        &relayer.pubkey(),
        &market,
        Some(MarketStatus::Open),
        None,
    );
    let result = send(&mut roles.env.svm, &[reopen], &[&relayer]);
    assert_err(result, ErrorCode::Unauthorized);

    let payout_source = roles.payout_source;
    assert_err(
        roles.try_settle_as(&relayer, &payout_source),
        ErrorCode::Unauthorized,
    );

    // Nor can it send a funded vault to the treasury.
    roles.settle();
    assert_err(roles.try_revoke_as(&relayer), ErrorCode::Unauthorized);
    let vault = vault_address(&market);
    assert_eq!(token_balance(&roles.env.svm, &vault), HELD * 10_000);
}

#[test]
fn the_settler_cannot_fill() {
    let mut roles = roles();
    let settler = roles.env.settler.insecure_clone();
    let funder = roles.funder;

    for result in roles.try_fills(&settler, &funder) {
        assert_err(result, ErrorCode::Unauthorized);
    }

    let svm = &roles.env.svm;
    assert_eq!(mint_supply(svm, &roles.market.yes_mint), HELD);
    assert_eq!(token_balance(svm, &funder), ROLE_STABLE);
    assert!(!is_closed(svm, &roles.buy_order));
    assert!(!is_closed(svm, &roles.sell_order));
}

#[test]
fn a_stranger_can_only_cancel_expired_orders_and_redeem_its_own_tokens() {
    let mut roles = roles();
    let market = roles.market.market;
    let user = roles.alice.wallet.pubkey();
    let stranger = funded_keypair(&mut roles.env.svm, 13);
    let stranger_stable = create_stable_account(&mut roles.env, &stranger.pubkey(), ROLE_STABLE);
    let stranger_yes =
        create_outcome_account(&mut roles.env, &roles.market.yes_mint, &stranger.pubkey());

    // Every privileged instruction refuses it.
    assert_err(roles.try_set_config_as(&stranger), ErrorCode::Unauthorized);
    let key = stranger.pubkey();
    let privileged = [
        set_pause_ix(&roles.env, &key, PAUSE_PLACE),
        register_trader_ix(&roles.env, &key, &key, &key),
        create_market_ix(
            &roles.env,
            &key,
            &key,
            create_market_args(&roles.env, "TEST-MARKET-2"),
        ),
        set_market_ix(&roles.env, &key, &market, Some(MarketStatus::Halted), None),
    ];
    for instruction in privileged {
        let result = send(&mut roles.env.svm, &[instruction], &[&stranger]);
        assert_err(result, ErrorCode::Unauthorized);
    }
    for result in roles.try_fills(&stranger, &stranger_stable) {
        assert_err(result, ErrorCode::Unauthorized);
    }
    assert_err(
        roles.try_settle_as(&stranger, &stranger_stable),
        ErrorCode::Unauthorized,
    );

    // An order is out of its reach until the order has expired, and even then the
    // escrow only goes back to the order's user.
    let expires_at = load::<Order>(&roles.env.svm, &roles.buy_order).expires_at;
    let cancel = |roles: &mut Roles, order: Pubkey, user_token: Pubkey| {
        let accounts = cancel_order_accounts(&roles.env, &stranger.pubkey(), &order, &user_token);
        try_cancel_order(&mut roles.env, &stranger, accounts)
    };
    let (buy_order, sell_order) = (roles.buy_order, roles.sell_order);
    let (alice_stable, alice_yes) = (roles.alice.stable, roles.alice_yes);
    set_time(&mut roles.env.svm, expires_at);
    assert_err(
        cancel(&mut roles, buy_order, alice_stable),
        ErrorCode::OrderNotExpired,
    );
    assert_err(
        cancel(&mut roles, sell_order, alice_yes),
        ErrorCode::OrderNotExpired,
    );
    set_time(&mut roles.env.svm, expires_at + 1);
    assert_err(
        cancel(&mut roles, buy_order, stranger_stable),
        ErrorCode::WrongOwner,
    );
    assert_err(
        cancel(&mut roles, sell_order, stranger_yes),
        ErrorCode::WrongOwner,
    );
    let stable_before = token_balance(&roles.env.svm, &alice_stable);
    cancel(&mut roles, buy_order, alice_stable).unwrap();
    cancel(&mut roles, sell_order, alice_yes).unwrap();
    assert_eq!(
        token_balance(&roles.env.svm, &alice_stable),
        stable_before + ORDER_ESCROW
    );
    assert_eq!(token_balance(&roles.env.svm, &alice_yes), HELD);
    assert_eq!(token_balance(&roles.env.svm, &stranger_stable), ROLE_STABLE);
    assert_eq!(token_balance(&roles.env.svm, &stranger_yes), 0);

    // It cannot undo a settlement.
    roles.settle();
    assert_err(roles.try_revoke_as(&stranger), ErrorCode::Unauthorized);

    // It cannot redeem tokens that someone else holds.
    let redeem_after = load::<Market>(&roles.env.svm, &market).redeem_after;
    set_time(&mut roles.env.svm, redeem_after);
    let accounts = redeem_accounts(
        &roles.env,
        &stranger.pubkey(),
        &market,
        &roles.market.yes_mint,
        &alice_yes,
        &stranger_stable,
    );
    assert_err(
        try_redeem(&mut roles.env, &stranger, accounts, HELD),
        ErrorCode::WrongOwner,
    );
    assert_eq!(token_balance(&roles.env.svm, &alice_yes), HELD);

    // Tokens it holds itself are paid like anyone's.
    let gift = spl_token_2022::instruction::transfer_checked(
        &spl_token_2022::ID,
        &alice_yes,
        &roles.market.yes_mint,
        &stranger_yes,
        &user,
        &[],
        100,
        2,
    )
    .unwrap();
    send_ok(&mut roles.env.svm, &[gift], &[&roles.alice.wallet]);
    let accounts = redeem_accounts(
        &roles.env,
        &stranger.pubkey(),
        &market,
        &roles.market.yes_mint,
        &stranger_yes,
        &stranger_stable,
    );
    try_redeem(&mut roles.env, &stranger, accounts, 100).unwrap();
    assert_eq!(
        token_balance(&roles.env.svm, &stranger_stable),
        ROLE_STABLE + 100 * 10_000
    );
}
