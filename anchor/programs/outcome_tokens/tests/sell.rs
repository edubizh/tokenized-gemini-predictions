//! `place_sell` and `fill_sell`, and `cancel_order` for sell orders.

mod common;

use {
    anchor_lang::prelude::Pubkey,
    anchor_spl::{token::spl_token, token_2022::spl_token_2022},
    common::*,
    outcome_tokens::{
        accounts,
        constants::{MAX_FEE_BASE, MAX_FEE_PER_UNIT, PAUSE_FILL, PAUSE_PLACE, PX_MAX},
        error::ErrorCode,
        events::{OrderCancelled, OrderFilled, OrderPlaced},
        instruction::{CancelOrder, FillBuy, FillSell, PlaceSell},
        instructions::SetConfigArgs,
        state::{Market, Order, OrderKind, Side},
    },
    solana_keypair::Keypair,
    solana_signer::Signer,
};

/// YES tokens the trader holds when a test starts.
const HELD: u64 = 1_000;
/// What buying them cost; the fill paid it to the treasury.
const BUY_COST: u64 = HELD * ORDER_LIMIT_PX as u64;
/// The trader's stable balance after that buy.
const STABLE_AFTER_BUY: u64 = TRADER_STABLE - BUY_COST;
/// Stable balance of the relayer's payout account.
const PAYOUT_STABLE: u64 = 1_000_000_000;
/// Proceeds of the fixture's sell order when all of it fills above its minimum price.
const PROCEEDS: u64 = SELL_QTY * 5_500;
/// A fee below the order's cap.
const FEE: u64 = 12_000;

/// The trading scene with a trader who holds `HELD` YES tokens and a relayer who can pay
/// out sale proceeds.
struct Holding {
    env: Env,
    market: MarketKeys,
    trader: TraderKeys,
    user_outcome: Pubkey,
    /// Stable token account of the relayer.
    payout_source: Pubkey,
}

fn holding() -> Holding {
    let Scene {
        mut env,
        market,
        trader,
    } = trading_scene();
    let user_outcome = buy_outcome(&mut env, &trader, &market, Side::Yes, HELD);
    let relayer = env.relayer.pubkey();
    let payout_source = create_stable_account(&mut env, &relayer, PAYOUT_STABLE);
    Holding {
        env,
        market,
        trader,
        user_outcome,
        payout_source,
    }
}

impl Holding {
    /// Sends `place_sell` for the trader, who also pays.
    fn try_place(&mut self, args: PlaceSell) -> SendResult {
        let user = self.trader.wallet.pubkey();
        let accounts = place_sell_accounts(
            &self.env,
            &user,
            &user,
            &self.market,
            args.side,
            &self.user_outcome,
        );
        send(
            &mut self.env.svm,
            &[instruction(accounts, args)],
            &[&self.trader.wallet],
        )
    }
}

/// `Holding` with the fixture's sell order placed by the trader, who also paid the rent.
struct Placed {
    env: Env,
    market: MarketKeys,
    trader: TraderKeys,
    user_outcome: Pubkey,
    payout_source: Pubkey,
    order: Pubkey,
    escrow: Pubkey,
    expires_at: i64,
}

fn placed_order() -> Placed {
    let Holding {
        mut env,
        market,
        trader,
        user_outcome,
        payout_source,
    } = holding();
    let order = place_sell(&mut env, &trader, &market, &user_outcome, place_sell_args());
    let expires_at = load::<Order>(&env.svm, &order).expires_at;
    Placed {
        env,
        market,
        trader,
        user_outcome,
        payout_source,
        order,
        escrow: escrow_address(&order),
        expires_at,
    }
}

impl Placed {
    /// The accounts of a fill that pays the trader's token accounts.
    fn fill_accounts(&self) -> accounts::FillSell {
        fill_sell_accounts(
            &self.env,
            &self.order,
            &self.payout_source,
            &self.trader.stable,
            &self.user_outcome,
        )
    }

    /// Sends `fill_sell` with those accounts, signed by the relayer.
    fn try_fill(&mut self, args: FillSell) -> SendResult {
        let accounts = self.fill_accounts();
        try_fill(&mut self.env, accounts, args)
    }

    /// Sends a cancel of the order that returns the tokens to the trader's account.
    fn try_cancel(&mut self, caller: &Keypair) -> SendResult {
        let accounts =
            cancel_order_accounts(&self.env, &caller.pubkey(), &self.order, &self.user_outcome);
        try_cancel_order(&mut self.env, caller, accounts)
    }

    /// Nothing was burned, paid or returned.
    fn assert_still_open(&self) {
        let svm = &self.env.svm;
        assert_eq!(token_balance(svm, &self.escrow), SELL_QTY);
        assert_eq!(mint_supply(svm, &self.market.yes_mint), HELD);
        assert_eq!(token_balance(svm, &self.payout_source), PAYOUT_STABLE);
        assert!(!is_closed(svm, &self.order));
    }

    fn assert_returned_and_closed(&self) {
        let svm = &self.env.svm;
        assert_eq!(token_balance(svm, &self.user_outcome), HELD);
        assert_eq!(mint_supply(svm, &self.market.yes_mint), HELD);
        assert!(is_closed(svm, &self.order));
        assert!(is_closed(svm, &self.escrow));
    }
}

/// Sends `fill_sell` signed by the relayer.
fn try_fill(env: &mut Env, accounts: accounts::FillSell, args: FillSell) -> SendResult {
    send(
        &mut env.svm,
        &[instruction(accounts, args)],
        &[&env.relayer],
    )
}

/// The whole order above its minimum price.
fn full_fill() -> FillSell {
    FillSell {
        fill_qty: SELL_QTY,
        proceeds: PROCEEDS,
        fee: FEE,
    }
}

// --- place_sell ------------------------------------------------------------------------

#[test]
fn place_sell_escrows_the_tokens_and_writes_the_order() {
    let Holding {
        mut env,
        market,
        trader,
        user_outcome,
        ..
    } = holding();
    // A separate payer shows who is recorded as the rent payer.
    let payer = funded_keypair(&mut env.svm, 11);
    let user = trader.wallet.pubkey();
    // The buy that issued the tokens took nonce 0.
    let order = order_address(&user, 1);
    let escrow = escrow_address(&order);
    let placed_at = now(&env.svm);

    let accounts = place_sell_accounts(
        &env,
        &user,
        &payer.pubkey(),
        &market,
        Side::Yes,
        &user_outcome,
    );
    assert_eq!(accounts.order, order);
    let meta = send_ok(
        &mut env.svm,
        &[instruction(accounts, place_sell_args())],
        &[&payer, &trader.wallet],
    );
    println!(
        "compute units: place_sell = {}",
        meta.compute_units_consumed
    );

    let held = token_account(&env.svm, &escrow);
    assert_eq!(held.amount, SELL_QTY);
    assert_eq!(held.mint, market.yes_mint);
    assert_eq!(held.owner, order);
    assert_eq!(
        env.svm.get_account(&escrow).unwrap().owner,
        spl_token_2022::ID,
        "the escrow of a sell is a Token-2022 account"
    );
    assert_eq!(token_balance(&env.svm, &user_outcome), HELD - SELL_QTY);
    // Escrowed tokens still exist, and no stable tokens move at placement.
    assert_eq!(mint_supply(&env.svm, &market.yes_mint), HELD);
    assert_eq!(token_balance(&env.svm, &trader.stable), STABLE_AFTER_BUY);

    let expires_at = placed_at + i64::from(ORDER_TTL_SECS);
    let stored: Order = load(&env.svm, &order);
    assert_eq!(stored.user, user);
    assert_eq!(stored.market, market.market);
    assert_eq!(stored.side, Side::Yes as u8);
    assert_eq!(stored.kind, OrderKind::Sell as u8);
    assert_eq!(stored.qty_units, SELL_QTY);
    assert_eq!(stored.limit_px, SELL_MIN_PX);
    assert_eq!(stored.max_fee, SELL_MAX_FEE);
    assert_eq!(stored.expires_at, expires_at);
    assert_eq!(stored.rent_payer, payer.pubkey());
    assert_eq!(stored.nonce, 1);
    assert_eq!(stored.reserved, [0; 16]);
    assert_eq!(next_nonce(&env.svm, &user), 2);

    let placed = events::<OrderPlaced>(&meta);
    assert_eq!(placed.len(), 1);
    assert_eq!(placed[0].order, order);
    assert_eq!(placed[0].user, user);
    assert_eq!(placed[0].market, market.market);
    assert_eq!(placed[0].side, Side::Yes as u8);
    assert_eq!(placed[0].kind, OrderKind::Sell as u8);
    assert_eq!(placed[0].qty_units, SELL_QTY);
    assert_eq!(placed[0].limit_px, SELL_MIN_PX);
    assert_eq!(placed[0].max_fee, SELL_MAX_FEE);
    assert_eq!(placed[0].expires_at, expires_at);
    assert_eq!(placed[0].nonce, 1);
}

#[test]
fn place_sell_is_blocked_by_the_place_pause_only() {
    let mut holding = holding();

    set_pause_flags(&mut holding.env, PAUSE_PLACE);
    assert_err(holding.try_place(place_sell_args()), ErrorCode::Paused);

    set_pause_flags(&mut holding.env, PAUSE_FILL);
    holding.try_place(place_sell_args()).unwrap();
}

#[test]
fn place_sell_requires_an_open_market() {
    let mut holding = holding();
    halt_market(&mut holding.env, &holding.market.market);

    assert_err(
        holding.try_place(place_sell_args()),
        ErrorCode::MarketNotOpen,
    );
}

#[test]
fn place_sell_requires_both_outcome_mints() {
    let mut env = initialize_default();
    let relayer = env.relayer.pubkey();
    let args = create_market_args(&env, MARKET_SYMBOL);
    let address = market_address(&args.symbol_hash);
    let market = MarketKeys {
        market: address,
        yes_mint: mint_address(&address, Side::Yes),
        no_mint: mint_address(&address, Side::No),
        close_ts: args.close_ts,
    };
    let create = create_market_ix(&env, &relayer, &relayer, args);
    send_ok(&mut env.svm, &[create], &[&env.relayer]);
    // Only the mint of the side being sold exists.
    let create = create_outcome_mint_ix(
        &env,
        &relayer,
        &relayer,
        &market.market,
        outcome_mint_args(Side::Yes),
    );
    send_ok(&mut env.svm, &[create], &[&env.relayer]);
    let trader = create_trader(&mut env, 10, 0);
    let user = trader.wallet.pubkey();
    let user_outcome = create_outcome_account(&mut env, &market.yes_mint, &user);

    let accounts = place_sell_accounts(&env, &user, &user, &market, Side::Yes, &user_outcome);
    let result = send(
        &mut env.svm,
        &[instruction(accounts, place_sell_args())],
        &[&trader.wallet],
    );

    assert_err(result, ErrorCode::MintsNotReady);
}

#[test]
fn place_sell_stops_exactly_at_the_cutoff_before_close() {
    let mut holding = holding();
    let cutoff = holding.market.close_ts - i64::from(PLACE_CUTOFF_SECS);

    set_time(&mut holding.env.svm, cutoff);
    assert_err(
        holding.try_place(place_sell_args()),
        ErrorCode::TooCloseToClose,
    );

    set_time(&mut holding.env.svm, cutoff - 1);
    holding.try_place(place_sell_args()).unwrap();
}

#[test]
fn place_sell_rejects_a_quantity_of_zero_or_above_the_maximum() {
    let mut holding = holding();
    let with_qty = |qty_units| PlaceSell {
        qty_units,
        max_fee: 0,
        ..place_sell_args()
    };

    assert_err(holding.try_place(with_qty(0)), ErrorCode::BadQuantity);
    assert_err(
        holding.try_place(with_qty(MAX_ORDER_UNITS + 1)),
        ErrorCode::BadQuantity,
    );

    // The minimum order size applies to buys only: a holder can sell a single unit.
    const { assert!(MIN_ORDER_UNITS > 1) };
    holding.try_place(with_qty(1)).unwrap();
    assert_eq!(
        token_balance(&holding.env.svm, &holding.user_outcome),
        HELD - 1
    );
}

#[test]
fn place_sell_rejects_a_price_outside_the_range_or_off_the_tick() {
    let mut holding = holding();
    let with_px = |min_px| PlaceSell {
        min_px,
        ..place_sell_args()
    };

    assert_err(holding.try_place(with_px(0)), ErrorCode::BadPrice);
    assert_err(holding.try_place(with_px(10_000)), ErrorCode::BadPrice);
    assert_err(
        holding.try_place(with_px(SELL_MIN_PX + TICK_PX / 2)),
        ErrorCode::OffTick,
    );
    // The highest price on the fixture's tick.
    holding.try_place(with_px(9_900)).unwrap();
}

#[test]
fn place_sell_rejects_a_fee_cap_above_the_sanity_limit() {
    let mut holding = holding();
    let limit = SELL_QTY * MAX_FEE_PER_UNIT + MAX_FEE_BASE;
    // The order's minimum proceeds are far above that limit, so only this rule applies.
    const { assert!(SELL_QTY * SELL_MIN_PX as u64 > SELL_QTY * MAX_FEE_PER_UNIT + MAX_FEE_BASE) };
    let with_fee = |max_fee| PlaceSell {
        max_fee,
        ..place_sell_args()
    };

    assert_err(
        holding.try_place(with_fee(limit + 1)),
        ErrorCode::FeeCapTooHigh,
    );
    holding.try_place(with_fee(limit)).unwrap();
}

#[test]
fn place_sell_rejects_a_fee_cap_above_the_minimum_proceeds() {
    let mut holding = holding();
    // One unit at the lowest price on the tick is worth 100 at least: far below the
    // sanity limit, so only this rule applies.
    let tiny = |max_fee| PlaceSell {
        side: Side::Yes,
        qty_units: 1,
        min_px: TICK_PX,
        max_fee,
    };
    let min_proceeds = u64::from(TICK_PX);

    assert_err(
        holding.try_place(tiny(min_proceeds + 1)),
        ErrorCode::FeeCapTooHigh,
    );
    holding.try_place(tiny(min_proceeds)).unwrap();
}

#[test]
fn place_sell_rejects_substituted_accounts() {
    let mut holding = holding();
    let user = holding.trader.wallet.pubkey();
    let victim = create_trader(&mut holding.env, 12, TRADER_STABLE);
    let victim_outcome = buy_outcome(&mut holding.env, &victim, &holding.market, Side::Yes, HELD);
    let user_no = buy_outcome(
        &mut holding.env,
        &holding.trader,
        &holding.market,
        Side::No,
        HELD,
    );
    let base = |holding: &Holding| {
        place_sell_accounts(
            &holding.env,
            &user,
            &user,
            &holding.market,
            Side::Yes,
            &holding.user_outcome,
        )
    };
    let try_place = |holding: &mut Holding, accounts: accounts::PlaceSell| {
        send(
            &mut holding.env.svm,
            &[instruction(accounts, place_sell_args())],
            &[&holding.trader.wallet],
        )
    };

    // Only the user's own tokens can be escrowed.
    let mut accounts = base(&holding);
    accounts.user_outcome = victim_outcome;
    assert_err(try_place(&mut holding, accounts), ErrorCode::WrongOwner);
    assert_eq!(token_balance(&holding.env.svm, &victim_outcome), HELD);

    // The mint must be the market's mint for the side of the order.
    let mut accounts = base(&holding);
    accounts.outcome_mint = holding.market.no_mint;
    accounts.user_outcome = user_no;
    assert_err(try_place(&mut holding, accounts), ErrorCode::WrongMint);

    let mut accounts = base(&holding);
    accounts.user_outcome = user_no;
    assert_anchor_err(
        try_place(&mut holding, accounts),
        anchor_lang::error::ErrorCode::ConstraintTokenMint,
    );

    let mut accounts = base(&holding);
    accounts.token_program = spl_token::ID;
    assert_anchor_err(
        try_place(&mut holding, accounts),
        anchor_lang::error::ErrorCode::InvalidProgramId,
    );

    // Another trader's registration does not let this user place.
    let mut accounts = base(&holding);
    accounts.trader = trader_address(&victim.wallet.pubkey());
    assert_anchor_err(
        try_place(&mut holding, accounts),
        anchor_lang::error::ErrorCode::ConstraintSeeds,
    );
    assert_eq!(token_balance(&holding.env.svm, &holding.user_outcome), HELD);
}

// --- fill_sell -------------------------------------------------------------------------

#[test]
fn fill_sell_burns_the_tokens_and_pays_the_user_from_the_payout_source() {
    let Holding {
        mut env,
        market,
        trader,
        user_outcome,
        payout_source,
    } = holding();
    let payer = funded_keypair(&mut env.svm, 11);
    let user = trader.wallet.pubkey();
    let accounts = place_sell_accounts(
        &env,
        &user,
        &payer.pubkey(),
        &market,
        Side::Yes,
        &user_outcome,
    );
    let (order, escrow) = (accounts.order, accounts.escrow);
    send_ok(
        &mut env.svm,
        &[instruction(accounts, place_sell_args())],
        &[&payer, &trader.wallet],
    );
    let payer_lamports = lamports(&env.svm, &payer.pubkey());
    let rent = lamports(&env.svm, &order) + lamports(&env.svm, &escrow);

    let accounts = fill_sell_accounts(&env, &order, &payout_source, &trader.stable, &user_outcome);
    let meta = send_ok(
        &mut env.svm,
        &[instruction(accounts, full_fill())],
        &[&env.relayer],
    );
    println!("compute units: fill_sell = {}", meta.compute_units_consumed);

    // The sold tokens no longer exist.
    assert_eq!(mint_supply(&env.svm, &market.yes_mint), HELD - SELL_QTY);
    assert_eq!(token_balance(&env.svm, &user_outcome), HELD - SELL_QTY);
    assert_eq!(
        token_balance(&env.svm, &trader.stable),
        STABLE_AFTER_BUY + PROCEEDS - FEE
    );
    // The relayer keeps the fee: it pays out the proceeds net of it.
    assert_eq!(
        token_balance(&env.svm, &payout_source),
        PAYOUT_STABLE - (PROCEEDS - FEE)
    );
    assert_eq!(token_balance(&env.svm, &env.treasury), BUY_COST);
    assert!(is_closed(&env.svm, &order));
    assert!(is_closed(&env.svm, &escrow));
    assert_eq!(lamports(&env.svm, &payer.pubkey()), payer_lamports + rent);

    let filled = events::<OrderFilled>(&meta);
    assert_eq!(filled.len(), 1);
    assert_eq!(filled[0].order, order);
    assert_eq!(filled[0].user, user);
    assert_eq!(filled[0].market, market.market);
    assert_eq!(filled[0].side, Side::Yes as u8);
    assert_eq!(filled[0].kind, OrderKind::Sell as u8);
    assert_eq!(filled[0].fill_qty, SELL_QTY);
    assert_eq!(filled[0].amount, PROCEEDS);
    assert_eq!(filled[0].fee, FEE);
}

#[test]
fn fill_sell_partial_fill_returns_the_unfilled_tokens_and_closes_the_order() {
    let mut placed = placed_order();
    let (fill_qty, fee) = (250, 5_000);
    let proceeds = fill_qty * u64::from(SELL_MIN_PX);
    let again = placed.fill_accounts();

    placed
        .try_fill(FillSell {
            fill_qty,
            proceeds,
            fee,
        })
        .unwrap();

    let svm = &placed.env.svm;
    assert_eq!(mint_supply(svm, &placed.market.yes_mint), HELD - fill_qty);
    assert_eq!(token_balance(svm, &placed.user_outcome), HELD - fill_qty);
    assert_eq!(
        token_balance(svm, &placed.trader.stable),
        STABLE_AFTER_BUY + proceeds - fee
    );
    assert!(is_closed(svm, &placed.order));
    assert!(is_closed(svm, &placed.escrow));

    // The order and its escrow are gone: the remainder cannot be filled later.
    assert_anchor_err(
        try_fill(&mut placed.env, again, full_fill()),
        anchor_lang::error::ErrorCode::AccountNotInitialized,
    );
}

#[test]
fn fill_sell_succeeds_exactly_at_the_expiry_and_fails_one_second_later() {
    let mut late = placed_order();
    set_time(&mut late.env.svm, late.expires_at + 1);
    assert_err(late.try_fill(full_fill()), ErrorCode::OrderExpired);
    late.assert_still_open();

    let mut placed = placed_order();
    set_time(&mut placed.env.svm, placed.expires_at);
    placed.try_fill(full_fill()).unwrap();
}

#[test]
fn fill_sell_requires_the_relayer() {
    let mut placed = placed_order();
    let settler = placed.env.settler.pubkey();
    let settler_stable = create_stable_account(&mut placed.env, &settler, PAYOUT_STABLE);
    let mut accounts = placed.fill_accounts();
    accounts.relayer = settler;
    accounts.payout_source = settler_stable;

    let result = send(
        &mut placed.env.svm,
        &[instruction(accounts, full_fill())],
        &[&placed.env.settler],
    );

    assert_err(result, ErrorCode::Unauthorized);
}

#[test]
fn fill_sell_is_blocked_by_the_fill_pause_only() {
    let mut placed = placed_order();

    set_pause_flags(&mut placed.env, PAUSE_FILL);
    assert_err(placed.try_fill(full_fill()), ErrorCode::Paused);
    placed.assert_still_open();

    // Neither a placement pause nor a halt stops fills.
    set_pause_flags(&mut placed.env, PAUSE_PLACE);
    halt_market(&mut placed.env, &placed.market.market);
    placed.try_fill(full_fill()).unwrap();
}

#[test]
fn fill_sell_is_refused_once_the_market_is_settled() {
    let mut placed = placed_order();
    let settler = placed.env.settler.pubkey();
    // Escrowed tokens are part of the supply a settlement funds.
    let funder = create_stable_account(&mut placed.env, &settler, HELD * 10_000);
    let accounts = settle_market_accounts(&placed.env, &placed.market, &funder);
    try_settle_market(&mut placed.env, accounts, 10_000, 0).unwrap();
    let vault = vault_address(&placed.market.market);
    assert_eq!(token_balance(&placed.env.svm, &vault), HELD * 10_000);

    assert_err(placed.try_fill(full_fill()), ErrorCode::AlreadySettled);
    placed.assert_still_open();

    // No fill can come any more, so the user takes the tokens back to redeem them.
    let user = placed.trader.wallet.insecure_clone();
    placed.try_cancel(&user).unwrap();
    placed.assert_returned_and_closed();

    // The tokens that sat in the escrow are paid like the rest.
    let redeem_after = load::<Market>(&placed.env.svm, &placed.market.market).redeem_after;
    set_time(&mut placed.env.svm, redeem_after);
    let accounts = redeem_accounts(
        &placed.env,
        &user.pubkey(),
        &placed.market.market,
        &placed.market.yes_mint,
        &placed.user_outcome,
        &placed.trader.stable,
    );
    try_redeem(&mut placed.env, &user, accounts, HELD).unwrap();
    let svm = &placed.env.svm;
    assert_eq!(
        token_balance(svm, &placed.trader.stable),
        STABLE_AFTER_BUY + HELD * 10_000
    );
    assert_eq!(token_balance(svm, &vault), 0);
    assert_eq!(mint_supply(svm, &placed.market.yes_mint), 0);
}

#[test]
fn fills_reject_an_order_of_the_other_kind() {
    let mut placed = placed_order();
    let buy = place_buy(
        &mut placed.env,
        &placed.trader,
        &placed.market.market,
        place_buy_args(),
    );

    let accounts = fill_sell_accounts(
        &placed.env,
        &buy,
        &placed.payout_source,
        &placed.trader.stable,
        &placed.user_outcome,
    );
    assert_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        ErrorCode::WrongKind,
    );
    assert_eq!(
        token_balance(&placed.env.svm, &escrow_address(&buy)),
        ORDER_ESCROW
    );

    let accounts = fill_buy_accounts(
        &placed.env,
        &placed.order,
        &placed.user_outcome,
        &placed.trader.stable,
    );
    let args = FillBuy {
        fill_qty: SELL_QTY,
        cost: SELL_QTY * u64::from(SELL_MIN_PX),
        fee: 0,
    };
    let result = send(
        &mut placed.env.svm,
        &[instruction(accounts, args)],
        &[&placed.env.relayer],
    );
    assert_err(result, ErrorCode::WrongKind);
    placed.assert_still_open();
}

#[test]
fn fill_sell_rejects_a_quantity_of_zero_or_above_the_order() {
    let mut placed = placed_order();

    let nothing = FillSell {
        fill_qty: 0,
        proceeds: 0,
        fee: 0,
    };
    assert_err(placed.try_fill(nothing), ErrorCode::FillExceedsOrder);

    let too_much = FillSell {
        fill_qty: SELL_QTY + 1,
        proceeds: (SELL_QTY + 1) * u64::from(SELL_MIN_PX),
        fee: 0,
    };
    assert_err(placed.try_fill(too_much), ErrorCode::FillExceedsOrder);
    placed.assert_still_open();
}

#[test]
fn fill_sell_rejects_proceeds_outside_the_range_the_order_allows() {
    let mut placed = placed_order();
    let fill_qty = 250;
    let with_proceeds = |proceeds| FillSell {
        fill_qty,
        proceeds,
        fee: FEE,
    };
    let lowest = fill_qty * u64::from(SELL_MIN_PX);
    let highest = fill_qty * u64::from(PX_MAX);

    // Below the user's minimum price for the filled quantity.
    assert_err(
        placed.try_fill(with_proceeds(lowest - 1)),
        ErrorCode::ProceedsOutOfRange,
    );
    // Above the highest price a unit can trade at.
    assert_err(
        placed.try_fill(with_proceeds(highest + 1)),
        ErrorCode::ProceedsOutOfRange,
    );
    placed.assert_still_open();

    placed.try_fill(with_proceeds(highest)).unwrap();
    assert_eq!(
        token_balance(&placed.env.svm, &placed.trader.stable),
        STABLE_AFTER_BUY + highest - FEE
    );
}

#[test]
fn fill_sell_accepts_proceeds_exactly_at_the_minimum_price() {
    let mut placed = placed_order();
    let proceeds = SELL_QTY * u64::from(SELL_MIN_PX);

    placed
        .try_fill(FillSell {
            proceeds,
            ..full_fill()
        })
        .unwrap();

    assert_eq!(
        token_balance(&placed.env.svm, &placed.trader.stable),
        STABLE_AFTER_BUY + proceeds - FEE
    );
}

#[test]
fn fill_sell_rejects_a_fee_above_the_orders_cap() {
    let mut placed = placed_order();
    let with_fee = |fee| FillSell { fee, ..full_fill() };

    assert_err(
        placed.try_fill(with_fee(SELL_MAX_FEE + 1)),
        ErrorCode::FeeExceedsCap,
    );
    placed.assert_still_open();

    placed.try_fill(with_fee(SELL_MAX_FEE)).unwrap();
    assert_eq!(
        token_balance(&placed.env.svm, &placed.trader.stable),
        STABLE_AFTER_BUY + PROCEEDS - SELL_MAX_FEE
    );
}

#[test]
fn fill_sell_rejects_a_fee_above_the_proceeds() {
    let mut placed = placed_order();
    // A small partial fill earns less than the order's fee cap.
    let fill_qty = 2;
    let proceeds = fill_qty * u64::from(SELL_MIN_PX);
    assert!(proceeds < SELL_MAX_FEE);
    let with_fee = |fee| FillSell {
        fill_qty,
        proceeds,
        fee,
    };

    assert_err(
        placed.try_fill(with_fee(proceeds + 1)),
        ErrorCode::FeeExceedsCap,
    );
    placed.assert_still_open();

    // The fee may take all of the proceeds and the user is paid nothing.
    placed.try_fill(with_fee(proceeds)).unwrap();
    assert_eq!(
        token_balance(&placed.env.svm, &placed.trader.stable),
        STABLE_AFTER_BUY
    );
    assert_eq!(
        token_balance(&placed.env.svm, &placed.user_outcome),
        HELD - fill_qty
    );
}

#[test]
fn fill_sell_only_draws_from_a_token_account_the_relayer_owns() {
    let mut placed = placed_order();
    let victim = funded_keypair(&mut placed.env.svm, 12);
    let victim_stable = create_stable_account(&mut placed.env, &victim.pubkey(), PAYOUT_STABLE);

    let mut accounts = placed.fill_accounts();
    accounts.payout_source = victim_stable;
    assert_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        ErrorCode::WrongOwner,
    );

    // The treasury is out of the relayer's reach as well.
    let mut accounts = placed.fill_accounts();
    accounts.payout_source = placed.env.treasury;
    assert_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        ErrorCode::WrongOwner,
    );
    assert_eq!(
        token_balance(&placed.env.svm, &victim_stable),
        PAYOUT_STABLE
    );
    assert_eq!(
        token_balance(&placed.env.svm, &placed.env.treasury),
        BUY_COST
    );
    placed.assert_still_open();
}

#[test]
fn fill_sell_never_draws_from_the_treasury_even_when_the_relayer_owns_it() {
    let mut placed = placed_order();
    let relayer = placed.env.relayer.pubkey();
    let treasury = create_stable_account(&mut placed.env, &relayer, PAYOUT_STABLE);
    let args = SetConfigArgs {
        relayer: None,
        settler: None,
        registrar: None,
        order_ttl_secs: None,
        min_order_units: None,
        max_order_units: None,
        settle_delay_secs: None,
    };
    let change = set_config_ix(
        &placed.env,
        &placed.env.admin.pubkey(),
        args,
        Some(treasury),
    );
    send_ok(&mut placed.env.svm, &[change], &[&placed.env.admin]);

    let mut accounts = placed.fill_accounts();
    accounts.payout_source = treasury;
    assert_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        ErrorCode::WrongOwner,
    );
    assert_eq!(token_balance(&placed.env.svm, &treasury), PAYOUT_STABLE);
    placed.assert_still_open();

    // The relayer's float account, kept apart from the treasury, pays as before.
    placed.try_fill(full_fill()).unwrap();
    let svm = &placed.env.svm;
    assert_eq!(token_balance(svm, &treasury), PAYOUT_STABLE);
    assert_eq!(
        token_balance(svm, &placed.payout_source),
        PAYOUT_STABLE - (PROCEEDS - FEE)
    );
    assert_eq!(
        token_balance(svm, &placed.trader.stable),
        STABLE_AFTER_BUY + PROCEEDS - FEE
    );
}

#[test]
fn fill_sell_only_pays_token_accounts_the_orders_user_owns() {
    let mut placed = placed_order();
    let attacker = funded_keypair(&mut placed.env.svm, 12);
    let attacker_outcome =
        create_outcome_account(&mut placed.env, &placed.market.yes_mint, &attacker.pubkey());
    let attacker_stable = create_stable_account(&mut placed.env, &attacker.pubkey(), 0);

    let mut accounts = placed.fill_accounts();
    accounts.user_stable = attacker_stable;
    assert_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        ErrorCode::WrongOwner,
    );

    let mut accounts = placed.fill_accounts();
    accounts.user_outcome = attacker_outcome;
    assert_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        ErrorCode::WrongOwner,
    );
    placed.assert_still_open();

    // Any other token accounts of the user will do.
    let user = placed.trader.wallet.pubkey();
    let other_stable = create_stable_account(&mut placed.env, &user, 0);
    let other_outcome = create_outcome_account(&mut placed.env, &placed.market.yes_mint, &user);
    let mut accounts = placed.fill_accounts();
    accounts.user_stable = other_stable;
    accounts.user_outcome = other_outcome;
    let partial = FillSell {
        fill_qty: 250,
        proceeds: 250 * u64::from(SELL_MIN_PX),
        fee: 0,
    };
    try_fill(&mut placed.env, accounts, partial).unwrap();
    assert_eq!(
        token_balance(&placed.env.svm, &other_stable),
        250 * u64::from(SELL_MIN_PX)
    );
    assert_eq!(
        token_balance(&placed.env.svm, &other_outcome),
        SELL_QTY - 250
    );
}

#[test]
fn fill_sell_rejects_substituted_accounts() {
    let mut placed = placed_order();
    let user = placed.trader.wallet.pubkey();
    let attacker = funded_keypair(&mut placed.env.svm, 12);
    let user_no = buy_outcome(
        &mut placed.env,
        &placed.trader,
        &placed.market,
        Side::No,
        HELD,
    );
    let other_market = create_market_with_mints(&mut placed.env, "TEST-MARKET-2");
    let user_other = create_outcome_account(&mut placed.env, &other_market.yes_mint, &user);
    let other_order = place_sell(
        &mut placed.env,
        &placed.trader,
        &placed.market,
        &placed.user_outcome,
        PlaceSell {
            qty_units: 100,
            max_fee: 0,
            ..place_sell_args()
        },
    );

    // The other side's mint, with a token account of the user that matches it.
    let mut accounts = placed.fill_accounts();
    accounts.outcome_mint = placed.market.no_mint;
    accounts.user_outcome = user_no;
    assert_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        ErrorCode::WrongMint,
    );

    // Everything is consistent with the other market; only the order is not.
    let mut accounts = placed.fill_accounts();
    accounts.market = other_market.market;
    accounts.outcome_mint = other_market.yes_mint;
    accounts.user_outcome = user_other;
    assert_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        ErrorCode::WrongMarket,
    );

    let mut accounts = placed.fill_accounts();
    accounts.escrow = escrow_address(&other_order);
    assert_anchor_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        anchor_lang::error::ErrorCode::ConstraintSeeds,
    );

    let mut accounts = placed.fill_accounts();
    accounts.user_outcome = user_no;
    assert_anchor_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        anchor_lang::error::ErrorCode::ConstraintTokenMint,
    );

    let mut accounts = placed.fill_accounts();
    accounts.rent_payer = attacker.pubkey();
    assert_anchor_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        anchor_lang::error::ErrorCode::ConstraintHasOne,
    );

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

    // A payout in another mint: first only the source, then a consistent set of accounts
    // around a mint that is not the configured one.
    let relayer = placed.env.relayer.pubkey();
    let other_mint = create_other_stable_mint(&mut placed.env);
    let other_source =
        create_other_stable_account(&mut placed.env, &other_mint, &relayer, PAYOUT_STABLE);
    let user_other_stable = create_other_stable_account(&mut placed.env, &other_mint, &user, 0);

    let mut accounts = placed.fill_accounts();
    accounts.payout_source = other_source;
    assert_anchor_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        anchor_lang::error::ErrorCode::ConstraintTokenMint,
    );

    let mut accounts = placed.fill_accounts();
    accounts.stable_mint = other_mint;
    accounts.payout_source = other_source;
    accounts.user_stable = user_other_stable;
    assert_anchor_err(
        try_fill(&mut placed.env, accounts, full_fill()),
        anchor_lang::error::ErrorCode::ConstraintAddress,
    );
    assert_eq!(token_balance(&placed.env.svm, &other_source), PAYOUT_STABLE);
    assert_eq!(token_balance(&placed.env.svm, &user_other_stable), 0);
    placed.assert_still_open();
}

#[test]
fn fill_sell_of_a_no_order_burns_no_tokens_only() {
    let Holding {
        mut env,
        market,
        trader,
        payout_source,
        ..
    } = holding();
    // The trader holds both sides, bought at the same price.
    let user_no = buy_outcome(&mut env, &trader, &market, Side::No, HELD);
    let stable_before = STABLE_AFTER_BUY - BUY_COST;
    assert_eq!(token_balance(&env.svm, &trader.stable), stable_before);
    let args = PlaceSell {
        side: Side::No,
        ..place_sell_args()
    };
    let order = place_sell(&mut env, &trader, &market, &user_no, args);
    assert_eq!(
        token_account(&env.svm, &escrow_address(&order)).mint,
        market.no_mint
    );

    let accounts = fill_sell_accounts(&env, &order, &payout_source, &trader.stable, &user_no);
    assert_eq!(accounts.outcome_mint, market.no_mint);
    let meta = send_ok(
        &mut env.svm,
        &[instruction(accounts, full_fill())],
        &[&env.relayer],
    );

    assert_eq!(mint_supply(&env.svm, &market.no_mint), HELD - SELL_QTY);
    assert_eq!(mint_supply(&env.svm, &market.yes_mint), HELD);
    assert_eq!(token_balance(&env.svm, &user_no), HELD - SELL_QTY);
    assert_eq!(
        token_balance(&env.svm, &trader.stable),
        stable_before + PROCEEDS - FEE
    );
    assert_eq!(
        token_balance(&env.svm, &payout_source),
        PAYOUT_STABLE - (PROCEEDS - FEE)
    );
    assert!(is_closed(&env.svm, &order));
    assert!(is_closed(&env.svm, &escrow_address(&order)));
    let filled = events::<OrderFilled>(&meta);
    assert_eq!(filled.len(), 1);
    assert_eq!(filled[0].side, Side::No as u8);
    assert_eq!(filled[0].fill_qty, SELL_QTY);
}

#[test]
fn fill_sell_returns_tokens_donated_to_the_escrow() {
    let mut placed = placed_order();
    let donor = create_trader(&mut placed.env, 12, TRADER_STABLE);
    let donor_outcome = buy_outcome(&mut placed.env, &donor, &placed.market, Side::Yes, 300);
    let donation = 250;
    let donate = spl_token_2022::instruction::transfer_checked(
        &spl_token_2022::ID,
        &donor_outcome,
        &placed.market.yes_mint,
        &placed.escrow,
        &donor.wallet.pubkey(),
        &[],
        donation,
        2,
    )
    .unwrap();
    send_ok(&mut placed.env.svm, &[donate], &[&donor.wallet]);

    placed.try_fill(full_fill()).unwrap();

    // Exactly the filled quantity was burned; the surplus went to the user.
    let svm = &placed.env.svm;
    assert_eq!(
        mint_supply(svm, &placed.market.yes_mint),
        HELD + 300 - SELL_QTY
    );
    assert_eq!(
        token_balance(svm, &placed.user_outcome),
        HELD - SELL_QTY + donation
    );
    assert_eq!(
        token_balance(svm, &placed.trader.stable),
        STABLE_AFTER_BUY + PROCEEDS - FEE
    );
    assert!(is_closed(svm, &placed.escrow));
    assert!(is_closed(svm, &placed.order));
}

// --- cancel_order ----------------------------------------------------------------------

#[test]
fn cancel_order_by_the_relayer_returns_the_tokens_of_a_sell_order() {
    let Holding {
        mut env,
        market,
        trader,
        user_outcome,
        payout_source,
    } = holding();
    let payer = funded_keypair(&mut env.svm, 11);
    let user = trader.wallet.pubkey();
    let accounts = place_sell_accounts(
        &env,
        &user,
        &payer.pubkey(),
        &market,
        Side::Yes,
        &user_outcome,
    );
    let (order, escrow) = (accounts.order, accounts.escrow);
    send_ok(
        &mut env.svm,
        &[instruction(accounts, place_sell_args())],
        &[&payer, &trader.wallet],
    );
    let payer_lamports = lamports(&env.svm, &payer.pubkey());
    let rent = lamports(&env.svm, &order) + lamports(&env.svm, &escrow);
    let relayer = env.relayer.insecure_clone();
    let fill = fill_sell_accounts(&env, &order, &payout_source, &trader.stable, &user_outcome);

    // Well before the expiry.
    let accounts = cancel_order_accounts(&env, &relayer.pubkey(), &order, &user_outcome);
    assert_eq!(accounts.token_program, spl_token_2022::ID);
    assert_eq!(accounts.escrow_mint, market.yes_mint);
    let meta = send_ok(
        &mut env.svm,
        &[instruction(accounts, CancelOrder {})],
        &[&relayer],
    );
    println!(
        "compute units: cancel_order (sell) = {}",
        meta.compute_units_consumed
    );

    assert_eq!(token_balance(&env.svm, &user_outcome), HELD);
    assert_eq!(mint_supply(&env.svm, &market.yes_mint), HELD);
    assert_eq!(token_balance(&env.svm, &trader.stable), STABLE_AFTER_BUY);
    assert!(is_closed(&env.svm, &order));
    assert!(is_closed(&env.svm, &escrow));
    assert_eq!(lamports(&env.svm, &payer.pubkey()), payer_lamports + rent);

    let cancelled = events::<OrderCancelled>(&meta);
    assert_eq!(cancelled.len(), 1);
    assert_eq!(cancelled[0].order, order);
    assert_eq!(cancelled[0].user, user);
    assert_eq!(cancelled[0].market, market.market);
    assert_eq!(cancelled[0].by, relayer.pubkey());

    // A cancelled order cannot be filled.
    assert_anchor_err(
        try_fill(&mut env, fill, full_fill()),
        anchor_lang::error::ErrorCode::AccountNotInitialized,
    );
    assert_eq!(token_balance(&env.svm, &payout_source), PAYOUT_STABLE);
}

#[test]
fn cancel_order_by_a_stranger_returns_the_tokens_one_second_after_the_expiry() {
    let mut placed = placed_order();
    let stranger = funded_keypair(&mut placed.env.svm, 12);

    // The order can still be filled at its expiry time.
    set_time(&mut placed.env.svm, placed.expires_at);
    assert_err(placed.try_cancel(&stranger), ErrorCode::OrderNotExpired);
    placed.assert_still_open();

    set_time(&mut placed.env.svm, placed.expires_at + 1);
    placed.try_cancel(&stranger).unwrap();
    placed.assert_returned_and_closed();
}

#[test]
fn cancel_order_only_returns_tokens_to_an_account_the_orders_user_owns() {
    let mut placed = placed_order();
    let attacker = funded_keypair(&mut placed.env.svm, 12);
    let attacker_outcome =
        create_outcome_account(&mut placed.env, &placed.market.yes_mint, &attacker.pubkey());
    set_time(&mut placed.env.svm, placed.expires_at + 1);

    let accounts = cancel_order_accounts(
        &placed.env,
        &attacker.pubkey(),
        &placed.order,
        &attacker_outcome,
    );
    assert_err(
        try_cancel_order(&mut placed.env, &attacker, accounts),
        ErrorCode::WrongOwner,
    );

    assert_eq!(token_balance(&placed.env.svm, &attacker_outcome), 0);
    placed.assert_still_open();
}
