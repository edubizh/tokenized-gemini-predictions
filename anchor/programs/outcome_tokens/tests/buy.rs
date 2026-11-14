//! `place_buy` and `fill_buy`.

mod common;

use {
    anchor_lang::prelude::Pubkey,
    anchor_spl::{token::spl_token, token_2022::spl_token_2022},
    common::*,
    outcome_tokens::{
        accounts,
        constants::{MAX_FEE_BASE, MAX_FEE_PER_UNIT, PAUSE_FILL, PAUSE_PLACE, TTL_MAX_SECS},
        error::ErrorCode,
        events::{OrderFilled, OrderPlaced},
        instruction::{CreateMarket, FillBuy, PlaceBuy},
        instructions::SetConfigArgs,
        state::{Order, OrderKind, Side, Trader},
    },
    solana_signer::Signer,
};

/// Sends `place_buy` for the scene's trader, who also pays.
fn try_place_buy(scene: &mut Scene, args: PlaceBuy) -> SendResult {
    let user = scene.trader.wallet.pubkey();
    let accounts = place_buy_accounts(
        &scene.env,
        &user,
        &user,
        &scene.market.market,
        &scene.trader.stable,
    );
    send(
        &mut scene.env.svm,
        &[instruction(accounts, args)],
        &[&scene.trader.wallet],
    )
}

// --- place_buy -------------------------------------------------------------------------

#[test]
fn place_buy_escrows_cost_plus_fee_cap_and_writes_the_order() {
    let Scene {
        mut env,
        market,
        trader,
    } = trading_scene();
    // A separate payer shows who is recorded as the rent payer.
    let payer = funded_keypair(&mut env.svm, 11);
    let user = trader.wallet.pubkey();
    let order = order_address(&user, 0);
    let escrow = escrow_address(&order);
    let placed_at = now(&env.svm);

    let accounts = place_buy_accounts(&env, &user, &payer.pubkey(), &market.market, &trader.stable);
    assert_eq!(accounts.order, order);
    let meta = send_ok(
        &mut env.svm,
        &[instruction(accounts, place_buy_args())],
        &[&payer, &trader.wallet],
    );
    println!("compute units: place_buy = {}", meta.compute_units_consumed);

    assert_eq!(
        ORDER_ESCROW,
        ORDER_QTY * u64::from(ORDER_LIMIT_PX) + ORDER_MAX_FEE
    );
    let held = token_account(&env.svm, &escrow);
    assert_eq!(held.amount, ORDER_ESCROW);
    assert_eq!(held.mint, env.stable_mint);
    assert_eq!(held.owner, order);
    assert_eq!(
        env.svm.get_account(&escrow).unwrap().owner,
        spl_token::ID,
        "the escrow of a buy is a classic token account"
    );
    assert_eq!(
        token_balance(&env.svm, &trader.stable),
        TRADER_STABLE - ORDER_ESCROW
    );

    let expires_at = placed_at + i64::from(ORDER_TTL_SECS);
    let stored: Order = load(&env.svm, &order);
    assert_eq!(stored.user, user);
    assert_eq!(stored.market, market.market);
    assert_eq!(stored.side, Side::Yes as u8);
    assert_eq!(stored.kind, OrderKind::Buy as u8);
    assert_eq!(stored.qty_units, ORDER_QTY);
    assert_eq!(stored.limit_px, ORDER_LIMIT_PX);
    assert_eq!(stored.max_fee, ORDER_MAX_FEE);
    assert_eq!(stored.expires_at, expires_at);
    assert_eq!(stored.rent_payer, payer.pubkey());
    assert_eq!(stored.nonce, 0);
    assert_eq!(stored.reserved, [0; 16]);
    assert_eq!(next_nonce(&env.svm, &user), 1);

    let placed = events::<OrderPlaced>(&meta);
    assert_eq!(placed.len(), 1);
    assert_eq!(placed[0].order, order);
    assert_eq!(placed[0].user, user);
    assert_eq!(placed[0].market, market.market);
    assert_eq!(placed[0].side, Side::Yes as u8);
    assert_eq!(placed[0].kind, OrderKind::Buy as u8);
    assert_eq!(placed[0].qty_units, ORDER_QTY);
    assert_eq!(placed[0].limit_px, ORDER_LIMIT_PX);
    assert_eq!(placed[0].max_fee, ORDER_MAX_FEE);
    assert_eq!(placed[0].expires_at, expires_at);
    assert_eq!(placed[0].nonce, 0);

    // The next order takes the next nonce and therefore another address.
    let args = PlaceBuy {
        side: Side::No,
        ..place_buy_args()
    };
    let second = place_buy(&mut env, &trader, &market.market, args);
    assert_eq!(second, order_address(&user, 1));
    assert_ne!(second, order);
    let stored: Order = load(&env.svm, &second);
    assert_eq!(stored.nonce, 1);
    assert_eq!(stored.side, Side::No as u8);
    assert_eq!(stored.rent_payer, user);
    assert_eq!(
        load::<Trader>(&env.svm, &trader_address(&user)).next_nonce,
        2
    );
}

#[test]
fn place_buy_caps_the_expiry_at_the_close_time() {
    let mut scene = trading_scene();
    // With the longest lifetime (900 s against a cutoff of 300 s) an order placed just
    // before the cutoff would outlive the market.
    let args = SetConfigArgs {
        relayer: None,
        settler: None,
        registrar: None,
        order_ttl_secs: Some(TTL_MAX_SECS),
        min_order_units: None,
        max_order_units: None,
        settle_delay_secs: None,
    };
    let instruction = set_config_ix(&scene.env, &scene.env.admin.pubkey(), args, None);
    send_ok(&mut scene.env.svm, &[instruction], &[&scene.env.admin]);
    let close_ts = scene.market.close_ts;
    set_time(
        &mut scene.env.svm,
        close_ts - i64::from(PLACE_CUTOFF_SECS) - 1,
    );

    let order = place_buy(
        &mut scene.env,
        &scene.trader,
        &scene.market.market,
        place_buy_args(),
    );

    assert_eq!(load::<Order>(&scene.env.svm, &order).expires_at, close_ts);
}

#[test]
fn place_buy_is_blocked_by_the_place_pause_only() {
    let mut scene = trading_scene();

    set_pause_flags(&mut scene.env, PAUSE_PLACE);
    assert_err(
        try_place_buy(&mut scene, place_buy_args()),
        ErrorCode::Paused,
    );

    set_pause_flags(&mut scene.env, PAUSE_FILL);
    try_place_buy(&mut scene, place_buy_args()).unwrap();
}

#[test]
fn place_buy_requires_an_open_market() {
    let mut scene = trading_scene();
    halt_market(&mut scene.env, &scene.market.market);

    assert_err(
        try_place_buy(&mut scene, place_buy_args()),
        ErrorCode::MarketNotOpen,
    );
}

#[test]
fn place_buy_requires_both_outcome_mints() {
    let mut env = initialize_default();
    let relayer = env.relayer.pubkey();
    let args = create_market_args(&env, MARKET_SYMBOL);
    let market = market_address(&args.symbol_hash);
    let create = create_market_ix(&env, &relayer, &relayer, args);
    send_ok(&mut env.svm, &[create], &[&env.relayer]);
    let trader = create_trader(&mut env, 10, TRADER_STABLE);
    let user = trader.wallet.pubkey();
    let try_place = |env: &mut Env| {
        let accounts = place_buy_accounts(env, &user, &user, &market, &trader.stable);
        send(
            &mut env.svm,
            &[instruction(accounts, place_buy_args())],
            &[&trader.wallet],
        )
    };

    assert_err(try_place(&mut env), ErrorCode::MintsNotReady);

    // One mint is not enough, whichever side the order is for.
    let create = create_outcome_mint_ix(
        &env,
        &relayer,
        &relayer,
        &market,
        outcome_mint_args(Side::Yes),
    );
    send_ok(&mut env.svm, &[create], &[&env.relayer]);
    assert_err(try_place(&mut env), ErrorCode::MintsNotReady);

    let create = create_outcome_mint_ix(
        &env,
        &relayer,
        &relayer,
        &market,
        outcome_mint_args(Side::No),
    );
    send_ok(&mut env.svm, &[create], &[&env.relayer]);
    try_place(&mut env).unwrap();
}

#[test]
fn place_buy_stops_exactly_at_the_cutoff_before_close() {
    let mut scene = trading_scene();
    let cutoff = scene.market.close_ts - i64::from(PLACE_CUTOFF_SECS);

    set_time(&mut scene.env.svm, cutoff);
    assert_err(
        try_place_buy(&mut scene, place_buy_args()),
        ErrorCode::TooCloseToClose,
    );

    set_time(&mut scene.env.svm, cutoff - 1);
    try_place_buy(&mut scene, place_buy_args()).unwrap();
}

#[test]
fn place_buy_handles_an_extreme_close_time_without_wrapping() {
    let mut scene = trading_scene();
    let market = scene.market.market;
    // `set_market` stores whatever close time the relayer sends.
    let set_close_ts = |env: &mut Env, close_ts: i64| {
        let instruction = set_market_ix(env, &env.relayer.pubkey(), &market, None, Some(close_ts));
        send_ok(&mut env.svm, &[instruction], &[&env.relayer]);
    };

    // The cutoff before the earliest possible close time is not representable.
    set_close_ts(&mut scene.env, i64::MIN);
    assert_err(
        try_place_buy(&mut scene, place_buy_args()),
        ErrorCode::MathOverflow,
    );

    set_close_ts(&mut scene.env, i64::MAX);
    let placed_at = now(&scene.env.svm);
    let order = place_buy(
        &mut scene.env,
        &scene.trader,
        &scene.market.market,
        place_buy_args(),
    );
    assert_eq!(
        load::<Order>(&scene.env.svm, &order).expires_at,
        placed_at + i64::from(ORDER_TTL_SECS)
    );
}

#[test]
fn place_buy_rejects_a_quantity_outside_the_configured_range() {
    let mut scene = trading_scene();
    let with_qty = |qty_units| PlaceBuy {
        qty_units,
        // Stays under the fee cap of the smallest order.
        max_fee: 0,
        ..place_buy_args()
    };

    assert_err(
        try_place_buy(&mut scene, with_qty(MIN_ORDER_UNITS - 1)),
        ErrorCode::BadQuantity,
    );
    assert_err(
        try_place_buy(&mut scene, with_qty(MAX_ORDER_UNITS + 1)),
        ErrorCode::BadQuantity,
    );
    try_place_buy(&mut scene, with_qty(MIN_ORDER_UNITS)).unwrap();
    try_place_buy(&mut scene, with_qty(MAX_ORDER_UNITS)).unwrap();
}

#[test]
fn place_buy_rejects_a_price_outside_the_range_or_off_the_tick() {
    let mut scene = trading_scene();
    let with_px = |limit_px| PlaceBuy {
        limit_px,
        ..place_buy_args()
    };

    assert_err(try_place_buy(&mut scene, with_px(0)), ErrorCode::BadPrice);
    assert_err(
        try_place_buy(&mut scene, with_px(10_000)),
        ErrorCode::BadPrice,
    );
    assert_err(
        try_place_buy(&mut scene, with_px(ORDER_LIMIT_PX + TICK_PX / 2)),
        ErrorCode::OffTick,
    );
    // The highest price on the fixture's tick.
    try_place_buy(&mut scene, with_px(9_900)).unwrap();
}

#[test]
fn place_buy_rejects_a_fee_cap_above_the_sanity_limit() {
    let mut scene = trading_scene();
    let limit = ORDER_QTY * MAX_FEE_PER_UNIT + MAX_FEE_BASE;
    let with_fee = |max_fee| PlaceBuy {
        max_fee,
        ..place_buy_args()
    };

    assert_err(
        try_place_buy(&mut scene, with_fee(limit + 1)),
        ErrorCode::FeeCapTooHigh,
    );
    try_place_buy(&mut scene, with_fee(limit)).unwrap();
}

#[test]
fn place_buy_requires_a_registered_trader() {
    let Scene {
        mut env, market, ..
    } = trading_scene();
    let stranger = funded_keypair(&mut env.svm, 12);
    let stable = create_stable_account(&mut env, &stranger.pubkey(), TRADER_STABLE);

    let accounts = place_buy_accounts(
        &env,
        &stranger.pubkey(),
        &stranger.pubkey(),
        &market.market,
        &stable,
    );
    let result = send(
        &mut env.svm,
        &[instruction(accounts, place_buy_args())],
        &[&stranger],
    );

    assert_anchor_err(result, anchor_lang::error::ErrorCode::AccountNotInitialized);
}

#[test]
fn place_buy_cannot_use_another_traders_registration() {
    let Scene {
        mut env,
        market,
        trader,
    } = trading_scene();
    let stranger = funded_keypair(&mut env.svm, 12);
    let stable = create_stable_account(&mut env, &stranger.pubkey(), TRADER_STABLE);

    let mut accounts = place_buy_accounts(
        &env,
        &stranger.pubkey(),
        &stranger.pubkey(),
        &market.market,
        &stable,
    );
    accounts.trader = trader_address(&trader.wallet.pubkey());
    let result = send(
        &mut env.svm,
        &[instruction(accounts, place_buy_args())],
        &[&stranger],
    );

    assert_anchor_err(result, anchor_lang::error::ErrorCode::ConstraintSeeds);
}

#[test]
fn place_buy_only_spends_from_a_token_account_the_user_owns() {
    let mut scene = trading_scene();
    let victim = funded_keypair(&mut scene.env.svm, 12);
    let victim_stable = create_stable_account(&mut scene.env, &victim.pubkey(), TRADER_STABLE);
    let user = scene.trader.wallet.pubkey();

    let accounts = place_buy_accounts(
        &scene.env,
        &user,
        &user,
        &scene.market.market,
        &victim_stable,
    );
    let result = send(
        &mut scene.env.svm,
        &[instruction(accounts, place_buy_args())],
        &[&scene.trader.wallet],
    );

    assert_err(result, ErrorCode::WrongOwner);
    assert_eq!(token_balance(&scene.env.svm, &victim_stable), TRADER_STABLE);
}

#[test]
fn place_buy_rejects_the_token_2022_program() {
    let mut scene = trading_scene();
    let user = scene.trader.wallet.pubkey();

    let mut accounts = place_buy_accounts(
        &scene.env,
        &user,
        &user,
        &scene.market.market,
        &scene.trader.stable,
    );
    accounts.token_program = spl_token_2022::ID;
    let result = send(
        &mut scene.env.svm,
        &[instruction(accounts, place_buy_args())],
        &[&scene.trader.wallet],
    );

    assert_anchor_err(result, anchor_lang::error::ErrorCode::InvalidProgramId);
}

// --- fill_buy --------------------------------------------------------------------------

/// Cost of the fixture's order when all of it fills at its limit price.
const FULL_COST: u64 = ORDER_QTY * ORDER_LIMIT_PX as u64;
/// A fee below the order's cap.
const FEE: u64 = 12_000;

/// The trading scene with the fixture's order placed and a YES token account of the trader
/// to receive the fill.
struct Placed {
    env: Env,
    market: MarketKeys,
    trader: TraderKeys,
    order: Pubkey,
    user_outcome: Pubkey,
}

fn placed_order() -> Placed {
    let Scene {
        mut env,
        market,
        trader,
    } = trading_scene();
    let order = place_buy(&mut env, &trader, &market.market, place_buy_args());
    let user_outcome = create_outcome_account(&mut env, &market.yes_mint, &trader.wallet.pubkey());
    Placed {
        env,
        market,
        trader,
        order,
        user_outcome,
    }
}

impl Placed {
    /// The accounts of a fill into the trader's token accounts.
    fn fill_accounts(&self) -> accounts::FillBuy {
        fill_buy_accounts(
            &self.env,
            &self.order,
            &self.user_outcome,
            &self.trader.stable,
        )
    }

    /// Sends `fill_buy` with those accounts, signed by the relayer.
    fn try_fill(&mut self, args: FillBuy) -> SendResult {
        let accounts = self.fill_accounts();
        try_fill(&mut self.env, accounts, args)
    }
}

/// Sends `fill_buy` signed by the relayer.
fn try_fill(env: &mut Env, accounts: accounts::FillBuy, args: FillBuy) -> SendResult {
    send(
        &mut env.svm,
        &[instruction(accounts, args)],
        &[&env.relayer],
    )
}

/// The whole order at its limit price.
fn full_fill() -> FillBuy {
    FillBuy {
        fill_qty: ORDER_QTY,
        cost: FULL_COST,
        fee: FEE,
    }
}

#[test]
fn fill_buy_mints_to_the_user_pays_the_treasury_and_refunds_the_rest() {
    let Scene {
        mut env,
        market,
        trader,
    } = trading_scene();
    let payer = funded_keypair(&mut env.svm, 11);
    let user = trader.wallet.pubkey();
    let accounts = place_buy_accounts(&env, &user, &payer.pubkey(), &market.market, &trader.stable);
    let (order, escrow) = (accounts.order, accounts.escrow);
    send_ok(
        &mut env.svm,
        &[instruction(accounts, place_buy_args())],
        &[&payer, &trader.wallet],
    );
    let user_outcome = ata_address(&user, &market.yes_mint, &spl_token_2022::ID);
    let create = create_ata_idempotent_ix(
        &env.relayer.pubkey(),
        &user,
        &market.yes_mint,
        &spl_token_2022::ID,
    );
    send_ok(&mut env.svm, &[create], &[&env.relayer]);
    let payer_lamports = lamports(&env.svm, &payer.pubkey());
    let rent = lamports(&env.svm, &order) + lamports(&env.svm, &escrow);

    let accounts = fill_buy_accounts(&env, &order, &user_outcome, &trader.stable);
    let meta = send_ok(
        &mut env.svm,
        &[instruction(accounts, full_fill())],
        &[&env.relayer],
    );
    println!("compute units: fill_buy = {}", meta.compute_units_consumed);

    assert_eq!(token_balance(&env.svm, &user_outcome), ORDER_QTY);
    assert_eq!(mint_supply(&env.svm, &market.yes_mint), ORDER_QTY);
    assert_eq!(mint_supply(&env.svm, &market.no_mint), 0);
    assert_eq!(token_balance(&env.svm, &env.treasury), FULL_COST + FEE);
    // The unused part of the fee cap comes back.
    assert_eq!(
        token_balance(&env.svm, &trader.stable),
        TRADER_STABLE - FULL_COST - FEE
    );
    assert!(is_closed(&env.svm, &order));
    assert!(is_closed(&env.svm, &escrow));
    assert_eq!(lamports(&env.svm, &payer.pubkey()), payer_lamports + rent);

    let filled = events::<OrderFilled>(&meta);
    assert_eq!(filled.len(), 1);
    assert_eq!(filled[0].order, order);
    assert_eq!(filled[0].user, user);
    assert_eq!(filled[0].market, market.market);
    assert_eq!(filled[0].side, Side::Yes as u8);
    assert_eq!(filled[0].kind, OrderKind::Buy as u8);
    assert_eq!(filled[0].fill_qty, ORDER_QTY);
    assert_eq!(filled[0].amount, FULL_COST);
    assert_eq!(filled[0].fee, FEE);
}

#[test]
fn fill_buy_partial_fill_refunds_the_remainder_and_closes_the_order() {
    let mut placed = placed_order();
    let (fill_qty, fee) = (400, 5_000);
    let cost = fill_qty * u64::from(ORDER_LIMIT_PX);

    placed
        .try_fill(FillBuy {
            fill_qty,
            cost,
            fee,
        })
        .unwrap();

    let env = &placed.env;
    assert_eq!(token_balance(&env.svm, &placed.user_outcome), fill_qty);
    assert_eq!(mint_supply(&env.svm, &placed.market.yes_mint), fill_qty);
    assert_eq!(token_balance(&env.svm, &env.treasury), cost + fee);
    assert_eq!(
        token_balance(&env.svm, &placed.trader.stable),
        TRADER_STABLE - cost - fee
    );
    assert!(is_closed(&env.svm, &placed.order));
    assert!(is_closed(&env.svm, &escrow_address(&placed.order)));
}

#[test]
fn fill_buy_below_the_limit_price_refunds_the_difference() {
    let mut placed = placed_order();
    let cost = ORDER_QTY * 5_500;

    placed
        .try_fill(FillBuy {
            cost,
            ..full_fill()
        })
        .unwrap();

    let env = &placed.env;
    assert_eq!(token_balance(&env.svm, &placed.user_outcome), ORDER_QTY);
    assert_eq!(token_balance(&env.svm, &env.treasury), cost + FEE);
    assert_eq!(
        token_balance(&env.svm, &placed.trader.stable),
        TRADER_STABLE - cost - FEE
    );
}

#[test]
fn fill_buy_succeeds_exactly_at_the_expiry() {
    let mut placed = placed_order();
    let expires_at = load::<Order>(&placed.env.svm, &placed.order).expires_at;

    set_time(&mut placed.env.svm, expires_at);

    placed.try_fill(full_fill()).unwrap();
}

#[test]
fn fill_buy_fails_one_second_after_the_expiry() {
    let mut placed = placed_order();
    let expires_at = load::<Order>(&placed.env.svm, &placed.order).expires_at;

    set_time(&mut placed.env.svm, expires_at + 1);

    assert_err(placed.try_fill(full_fill()), ErrorCode::OrderExpired);
}

#[test]
fn fill_buy_requires_the_relayer() {
    let mut placed = placed_order();
    let mut accounts = placed.fill_accounts();
    accounts.relayer = placed.env.settler.pubkey();

    let result = send(
        &mut placed.env.svm,
        &[instruction(accounts, full_fill())],
        &[&placed.env.settler],
    );

    assert_err(result, ErrorCode::Unauthorized);
}

#[test]
fn fill_buy_is_blocked_by_the_fill_pause_only() {
    let mut placed = placed_order();

    set_pause_flags(&mut placed.env, PAUSE_FILL);
    assert_err(placed.try_fill(full_fill()), ErrorCode::Paused);

    set_pause_flags(&mut placed.env, PAUSE_PLACE);
    placed.try_fill(full_fill()).unwrap();
}

#[test]
fn fill_buy_rejects_a_quantity_of_zero_or_above_the_order() {
    let mut placed = placed_order();

    let nothing = FillBuy {
        fill_qty: 0,
        cost: 0,
        fee: 0,
    };
    assert_err(placed.try_fill(nothing), ErrorCode::FillExceedsOrder);

    let too_much = FillBuy {
        fill_qty: ORDER_QTY + 1,
        ..full_fill()
    };
    assert_err(placed.try_fill(too_much), ErrorCode::FillExceedsOrder);
}

#[test]
fn fill_buy_rejects_a_cost_outside_the_range_the_order_allows() {
    let mut placed = placed_order();
    let fill_qty = 400;
    let with_cost = |cost| FillBuy {
        fill_qty,
        cost,
        fee: FEE,
    };

    // Below one micro-dollar per unit.
    assert_err(
        placed.try_fill(with_cost(fill_qty - 1)),
        ErrorCode::CostOutOfRange,
    );
    // Above the limit price for the filled quantity, although the escrow could cover it.
    assert_err(
        placed.try_fill(with_cost(fill_qty * u64::from(ORDER_LIMIT_PX) + 1)),
        ErrorCode::CostOutOfRange,
    );
    placed.try_fill(with_cost(fill_qty)).unwrap();
}

#[test]
fn fill_buy_rejects_a_fee_above_the_orders_cap() {
    let mut placed = placed_order();
    let with_fee = |fee| FillBuy { fee, ..full_fill() };

    assert_err(
        placed.try_fill(with_fee(ORDER_MAX_FEE + 1)),
        ErrorCode::FeeExceedsCap,
    );

    // The whole escrow goes to the treasury and nothing is left to refund.
    placed.try_fill(with_fee(ORDER_MAX_FEE)).unwrap();
    assert_eq!(
        token_balance(&placed.env.svm, &placed.env.treasury),
        ORDER_ESCROW
    );
    assert_eq!(
        token_balance(&placed.env.svm, &placed.trader.stable),
        TRADER_STABLE - ORDER_ESCROW
    );
}

#[test]
fn fill_buy_never_mints_above_the_markets_supply_cap() {
    let mut env = initialize_default();
    let max_supply_units = ORDER_QTY + 500;
    let args = CreateMarket {
        max_supply_units,
        ..create_market_args(&env, MARKET_SYMBOL)
    };
    let market = create_market_with_mints_from(&mut env, args);
    let trader = create_trader(&mut env, 10, TRADER_STABLE);
    let user_outcome = create_outcome_account(&mut env, &market.yes_mint, &trader.wallet.pubkey());
    let first = place_buy(&mut env, &trader, &market.market, place_buy_args());
    let accounts = fill_buy_accounts(&env, &first, &user_outcome, &trader.stable);
    try_fill(&mut env, accounts, full_fill()).unwrap();
    let second = place_buy(&mut env, &trader, &market.market, place_buy_args());
    let fill = |env: &mut Env, fill_qty: u64| {
        let accounts = fill_buy_accounts(env, &second, &user_outcome, &trader.stable);
        let args = FillBuy {
            fill_qty,
            cost: fill_qty * u64::from(ORDER_LIMIT_PX),
            fee: FEE,
        };
        try_fill(env, accounts, args)
    };

    assert_err(fill(&mut env, 501), ErrorCode::SupplyCapExceeded);
    assert_eq!(mint_supply(&env.svm, &market.yes_mint), ORDER_QTY);

    fill(&mut env, 500).unwrap();
    assert_eq!(mint_supply(&env.svm, &market.yes_mint), max_supply_units);
}

#[test]
fn fill_buy_rejects_the_other_sides_mint() {
    let mut placed = placed_order();
    let user = placed.trader.wallet.pubkey();
    let user_no = create_outcome_account(&mut placed.env, &placed.market.no_mint, &user);

    let mut accounts = placed.fill_accounts();
    accounts.outcome_mint = placed.market.no_mint;
    accounts.user_outcome = user_no;
    assert_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        ErrorCode::WrongMint,
    );

    // The right mint cannot be minted into an account of the other mint either.
    let mut accounts = placed.fill_accounts();
    accounts.user_outcome = user_no;
    assert_anchor_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        anchor_lang::error::ErrorCode::ConstraintTokenMint,
    );
}

#[test]
fn fill_buy_rejects_another_market() {
    let mut placed = placed_order();
    let user = placed.trader.wallet.pubkey();
    let other = create_market_with_mints(&mut placed.env, "TEST-MARKET-2");
    let user_other = create_outcome_account(&mut placed.env, &other.yes_mint, &user);

    // Everything is consistent with the other market; only the order is not.
    let mut accounts = placed.fill_accounts();
    accounts.market = other.market;
    accounts.outcome_mint = other.yes_mint;
    accounts.user_outcome = user_other;

    assert_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        ErrorCode::WrongMarket,
    );
}

#[test]
fn fill_buy_only_pays_token_accounts_the_orders_user_owns() {
    let mut placed = placed_order();
    let attacker = funded_keypair(&mut placed.env.svm, 12);
    let attacker_outcome =
        create_outcome_account(&mut placed.env, &placed.market.yes_mint, &attacker.pubkey());
    let attacker_stable = create_stable_account(&mut placed.env, &attacker.pubkey(), 0);

    let mut accounts = placed.fill_accounts();
    accounts.user_outcome = attacker_outcome;
    assert_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        ErrorCode::WrongOwner,
    );

    let mut accounts = placed.fill_accounts();
    accounts.user_stable = attacker_stable;
    assert_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        ErrorCode::WrongOwner,
    );
}

#[test]
fn fill_buy_rejects_substituted_accounts() {
    let mut placed = placed_order();
    let attacker = funded_keypair(&mut placed.env.svm, 12);
    let attacker_stable = create_stable_account(&mut placed.env, &attacker.pubkey(), 0);
    let other_order = place_buy(
        &mut placed.env,
        &placed.trader,
        &placed.market.market,
        place_buy_args(),
    );

    let mut accounts = placed.fill_accounts();
    accounts.escrow = escrow_address(&other_order);
    assert_anchor_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        anchor_lang::error::ErrorCode::ConstraintSeeds,
    );

    let mut accounts = placed.fill_accounts();
    accounts.treasury = attacker_stable;
    assert_anchor_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        anchor_lang::error::ErrorCode::ConstraintAddress,
    );

    let mut accounts = placed.fill_accounts();
    accounts.rent_payer = attacker.pubkey();
    assert_anchor_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        anchor_lang::error::ErrorCode::ConstraintHasOne,
    );

    // Each token program is fixed: the stablecoin's is the classic one, the outcome
    // tokens' is Token-2022.
    let mut accounts = placed.fill_accounts();
    accounts.stable_token_program = spl_token_2022::ID;
    assert_anchor_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        anchor_lang::error::ErrorCode::InvalidProgramId,
    );

    let mut accounts = placed.fill_accounts();
    accounts.outcome_token_program = spl_token::ID;
    assert_anchor_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        anchor_lang::error::ErrorCode::InvalidProgramId,
    );
}

#[test]
fn fill_buy_works_on_a_halted_market() {
    let mut placed = placed_order();
    halt_market(&mut placed.env, &placed.market.market);

    placed.try_fill(full_fill()).unwrap();

    assert_eq!(
        token_balance(&placed.env.svm, &placed.user_outcome),
        ORDER_QTY
    );
}

#[test]
fn fill_buy_cannot_fill_an_order_twice() {
    let mut placed = placed_order();
    let again = placed.fill_accounts();
    placed.try_fill(full_fill()).unwrap();

    // The order and its escrow are gone.
    assert_anchor_err(
        try_fill(&mut placed.env, again, full_fill()),
        anchor_lang::error::ErrorCode::AccountNotInitialized,
    );
    assert_eq!(
        token_balance(&placed.env.svm, &placed.user_outcome),
        ORDER_QTY
    );
}

#[test]
fn fill_buy_accepts_any_token_account_of_the_user_as_destination() {
    let mut placed = placed_order();
    let user = placed.trader.wallet.pubkey();
    assert_ne!(
        placed.user_outcome,
        ata_address(&user, &placed.market.yes_mint, &spl_token_2022::ID)
    );
    // The refund goes to a second stable account, not the one that funded the order.
    let other_stable = create_stable_account(&mut placed.env, &user, 0);

    let mut accounts = placed.fill_accounts();
    accounts.user_stable = other_stable;
    try_fill(&mut placed.env, accounts, full_fill()).unwrap();

    assert_eq!(
        token_balance(&placed.env.svm, &placed.user_outcome),
        ORDER_QTY
    );
    assert_eq!(
        token_balance(&placed.env.svm, &other_stable),
        ORDER_MAX_FEE - FEE
    );
}

#[test]
fn fill_buy_refunds_tokens_donated_to_the_escrow() {
    let mut placed = placed_order();
    let donation = 777;
    mint_stable(&mut placed.env, &escrow_address(&placed.order), donation);

    placed.try_fill(full_fill()).unwrap();

    assert_eq!(
        token_balance(&placed.env.svm, &placed.env.treasury),
        FULL_COST + FEE
    );
    assert_eq!(
        token_balance(&placed.env.svm, &placed.trader.stable),
        TRADER_STABLE - FULL_COST - FEE + donation
    );
    assert!(is_closed(&placed.env.svm, &escrow_address(&placed.order)));
}

#[test]
fn fill_buy_survives_the_user_closing_their_token_account_after_placing() {
    let mut placed = placed_order();
    let user = placed.trader.wallet.pubkey();
    let closed = placed.fill_accounts();
    // The account the relayer expected to mint into is empty, so its owner can close it.
    let close = spl_token_2022::instruction::close_account(
        &spl_token_2022::ID,
        &placed.user_outcome,
        &user,
        &user,
        &[],
    )
    .unwrap();
    send_ok(&mut placed.env.svm, &[close], &[&placed.trader.wallet]);
    assert!(is_closed(&placed.env.svm, &placed.user_outcome));
    assert_anchor_err(
        try_fill(&mut placed.env, closed, full_fill()),
        anchor_lang::error::ErrorCode::AccountNotInitialized,
    );

    // Any token account of the user will do, so the relayer creates a fresh one.
    let fresh = create_outcome_account(&mut placed.env, &placed.market.yes_mint, &user);
    let mut accounts = placed.fill_accounts();
    accounts.user_outcome = fresh;
    try_fill(&mut placed.env, accounts, full_fill()).unwrap();

    assert_eq!(token_balance(&placed.env.svm, &fresh), ORDER_QTY);
    assert_eq!(
        token_balance(&placed.env.svm, &placed.env.treasury),
        FULL_COST + FEE
    );
    assert!(is_closed(&placed.env.svm, &placed.order));
}
