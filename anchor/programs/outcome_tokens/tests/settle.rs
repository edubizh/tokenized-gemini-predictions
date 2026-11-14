//! `settle_market`, `revoke_settlement` and `redeem`.

mod common;

use {
    anchor_lang::prelude::Pubkey,
    anchor_spl::{token::spl_token, token_2022::spl_token_2022},
    common::*,
    outcome_tokens::{
        accounts,
        constants::{PAUSE_FILL, PAUSE_PLACE},
        error::ErrorCode,
        events::{MarketSettled, Redeemed, SettlementRevoked},
        instruction::{FillBuy, Redeem, RevokeSettlement, SettleMarket},
        state::{Market, MarketStatus, Order, Side},
    },
    solana_signer::Signer,
};

/// YES tokens Alice holds and NO tokens Bob holds when a test starts.
const YES_UNITS: u64 = 3_000;
const NO_UNITS: u64 = 1_500;
/// What the two buys cost; the fills paid it to the treasury.
const YES_COST: u64 = YES_UNITS * ORDER_LIMIT_PX as u64;
const NO_COST: u64 = NO_UNITS * ORDER_LIMIT_PX as u64;
/// Stable balance of the settler's funding account: more than any settlement here needs.
const FUNDER_STABLE: u64 = 1_000_000_000;

/// The fixture's market with supply on both sides and a settler who can fund a settlement.
struct Funded {
    env: Env,
    market: MarketKeys,
    /// Holds `YES_UNITS` in `alice_yes`.
    alice: TraderKeys,
    alice_yes: Pubkey,
    /// Holds `NO_UNITS` in `bob_no`.
    bob: TraderKeys,
    bob_no: Pubkey,
    /// Stable token account of the settler.
    funder: Pubkey,
    vault: Pubkey,
}

fn funded_market() -> Funded {
    let Scene {
        mut env,
        market,
        trader: alice,
    } = trading_scene();
    let bob = create_trader(&mut env, 12, TRADER_STABLE);
    let alice_yes = buy_outcome(&mut env, &alice, &market, Side::Yes, YES_UNITS);
    let bob_no = buy_outcome(&mut env, &bob, &market, Side::No, NO_UNITS);
    let settler = env.settler.pubkey();
    let funder = create_stable_account(&mut env, &settler, FUNDER_STABLE);
    let vault = vault_address(&market.market);
    Funded {
        env,
        market,
        alice,
        alice_yes,
        bob,
        bob_no,
        funder,
        vault,
    }
}

impl Funded {
    fn settle_accounts(&self) -> accounts::SettleMarket {
        settle_market_accounts(&self.env, &self.market, &self.funder)
    }

    /// Sends `settle_market` signed by the settler.
    fn try_settle(&mut self, yes_payout: u64, no_payout: u64) -> SendResult {
        let accounts = self.settle_accounts();
        try_settle_market(&mut self.env, accounts, yes_payout, no_payout)
    }

    fn stored_market(&self) -> Market {
        load(&self.env.svm, &self.market.market)
    }

    /// Moves the clock to the first second at which redemption is open.
    fn open_redemption(&mut self) {
        let redeem_after = self.stored_market().redeem_after;
        set_time(&mut self.env.svm, redeem_after);
    }

    /// Alice redeeming YES tokens into her stable account.
    fn yes_redeem_accounts(&self) -> accounts::Redeem {
        redeem_accounts(
            &self.env,
            &self.alice.wallet.pubkey(),
            &self.market.market,
            &self.market.yes_mint,
            &self.alice_yes,
            &self.alice.stable,
        )
    }

    /// Bob redeeming NO tokens into his stable account.
    fn no_redeem_accounts(&self) -> accounts::Redeem {
        redeem_accounts(
            &self.env,
            &self.bob.wallet.pubkey(),
            &self.market.market,
            &self.market.no_mint,
            &self.bob_no,
            &self.bob.stable,
        )
    }

    fn try_redeem_yes(&mut self, amount: u64) -> SendResult {
        let accounts = self.yes_redeem_accounts();
        try_redeem(&mut self.env, &self.alice.wallet, accounts, amount)
    }

    fn try_redeem_no(&mut self, amount: u64) -> SendResult {
        let accounts = self.no_redeem_accounts();
        try_redeem(&mut self.env, &self.bob.wallet, accounts, amount)
    }

    /// Sends `revoke_settlement` signed by the admin.
    fn try_revoke(&mut self) -> SendResult {
        let accounts =
            revoke_settlement_accounts(&self.env, &self.env.admin.pubkey(), &self.market.market);
        send(
            &mut self.env.svm,
            &[instruction(accounts, RevokeSettlement {})],
            &[&self.env.admin],
        )
    }

    fn assert_not_settled(&self) {
        let stored = self.stored_market();
        assert_ne!(stored.status, MarketStatus::Settled as u8);
        assert_eq!(stored.redeem_after, 0);
        assert!(is_closed(&self.env.svm, &self.vault));
        assert_eq!(token_balance(&self.env.svm, &self.funder), FUNDER_STABLE);
    }
}

// --- settle_market ---------------------------------------------------------------------

#[test]
fn settle_market_funds_the_vault_and_opens_redemption_after_the_delay() {
    let mut funded = funded_market();
    // A separate payer shows who funds the vault's rent.
    let payer = funded_keypair(&mut funded.env.svm, 13);
    let payer_lamports = lamports(&funded.env.svm, &payer.pubkey());
    let settled_at = now(&funded.env.svm);
    // Some markets resolve early: nothing ties a settlement to the close time.
    assert!(settled_at < funded.market.close_ts);
    assert_eq!(
        mint_supply(&funded.env.svm, &funded.market.no_mint),
        NO_UNITS
    );

    let mut accounts = funded.settle_accounts();
    accounts.payer = payer.pubkey();
    let args = SettleMarket {
        yes_payout: 10_000,
        no_payout: 0,
    };
    let meta = send_ok(
        &mut funded.env.svm,
        &[instruction(accounts, args)],
        &[&payer, &funded.env.settler],
    );
    println!(
        "compute units: settle_market = {}",
        meta.compute_units_consumed
    );

    // Every YES unit is worth 10,000 and the NO supply is worth nothing.
    let funding = YES_UNITS * 10_000;
    let svm = &funded.env.svm;
    let held = token_account(svm, &funded.vault);
    assert_eq!(held.amount, funding);
    assert_eq!(held.mint, funded.env.stable_mint);
    assert_eq!(held.owner, funded.market.market);
    let vault = svm.get_account(&funded.vault).unwrap();
    assert_eq!(vault.owner, spl_token::ID);
    assert_eq!(
        vault.lamports,
        svm.minimum_balance_for_rent_exemption(vault.data.len())
    );
    assert_eq!(
        lamports(svm, &payer.pubkey()),
        payer_lamports - vault.lamports - meta.fee
    );
    assert_eq!(token_balance(svm, &funded.funder), FUNDER_STABLE - funding);

    let redeem_after = settled_at + i64::from(SETTLE_DELAY_SECS);
    let stored = funded.stored_market();
    assert_eq!(stored.status, MarketStatus::Settled as u8);
    assert_eq!(stored.yes_payout, 10_000);
    assert_eq!(stored.no_payout, 0);
    assert_eq!(stored.redeem_after, redeem_after);

    let settled = events::<MarketSettled>(&meta);
    assert_eq!(settled.len(), 1);
    assert_eq!(settled[0].market, funded.market.market);
    assert_eq!(settled[0].yes_payout, 10_000);
    assert_eq!(settled[0].no_payout, 0);
    assert_eq!(settled[0].funding, funding);
    assert_eq!(settled[0].redeem_after, redeem_after);
}

#[test]
fn settle_market_requires_the_settler() {
    let mut funded = funded_market();
    // The relayer brings a funding account of its own, so only its role is wrong.
    let relayer = funded.env.relayer.pubkey();
    let relayer_stable = create_stable_account(&mut funded.env, &relayer, FUNDER_STABLE);
    let mut accounts = funded.settle_accounts();
    accounts.settler = relayer;
    accounts.payer = relayer;
    accounts.funder_stable = relayer_stable;
    let args = SettleMarket {
        yes_payout: 10_000,
        no_payout: 0,
    };

    let result = send(
        &mut funded.env.svm,
        &[instruction(accounts, args)],
        &[&funded.env.relayer],
    );

    assert_err(result, ErrorCode::Unauthorized);
    funded.assert_not_settled();
}

#[test]
fn settle_market_rejects_payouts_that_do_not_add_up_to_the_total() {
    let mut funded = funded_market();

    for (yes_payout, no_payout) in [
        (0, 0),
        (10_000, 1),
        (5_000, 4_999),
        // Adds up to 10,000 only if the sum wraps.
        (u64::MAX, 10_001),
    ] {
        let result = funded.try_settle(yes_payout, no_payout);

        assert_err(result, ErrorCode::BadPayout);
        funded.assert_not_settled();
    }
}

#[test]
fn settle_market_cannot_settle_twice() {
    let mut funded = funded_market();
    funded.try_settle(10_000, 0).unwrap();
    let funder_before = token_balance(&funded.env.svm, &funded.funder);

    for (yes_payout, no_payout) in [(10_000, 0), (0, 10_000)] {
        let result = funded.try_settle(yes_payout, no_payout);

        assert_err(result, ErrorCode::AlreadySettled);
    }
    assert_eq!(funded.stored_market().yes_payout, 10_000);
    assert_eq!(
        token_balance(&funded.env.svm, &funded.funder),
        funder_before
    );
}

#[test]
fn settle_market_rejects_mints_that_are_not_the_markets() {
    let mut funded = funded_market();
    let other = create_market_with_mints(&mut funded.env, "OTHER-MARKET-1");

    // Swapped sides would fund the vault for the wrong supply.
    let mut swapped = funded.settle_accounts();
    swapped.yes_mint = funded.market.no_mint;
    swapped.no_mint = funded.market.yes_mint;
    // Another market's mints have no supply, so the vault would stay empty.
    let mut foreign_yes = funded.settle_accounts();
    foreign_yes.yes_mint = other.yes_mint;
    let mut foreign_no = funded.settle_accounts();
    foreign_no.no_mint = other.no_mint;

    for accounts in [swapped, foreign_yes, foreign_no] {
        let result = try_settle_market(&mut funded.env, accounts, 10_000, 0);

        assert_err(result, ErrorCode::WrongMint);
        funded.assert_not_settled();
    }
}

#[test]
fn settle_market_requires_both_outcome_mints() {
    let mut env = initialize_default();
    let settler = env.settler.pubkey();
    let relayer = env.relayer.pubkey();
    let funder = create_stable_account(&mut env, &settler, FUNDER_STABLE);
    let args = create_market_args(&env, MARKET_SYMBOL);
    let market = market_address(&args.symbol_hash);
    let keys = MarketKeys {
        market,
        yes_mint: mint_address(&market, Side::Yes),
        no_mint: mint_address(&market, Side::No),
        close_ts: args.close_ts,
    };
    let create = create_market_ix(&env, &relayer, &relayer, args);
    send_ok(&mut env.svm, &[create], &[&env.relayer]);

    // No mint yet, then only the YES mint.
    let accounts = settle_market_accounts(&env, &keys, &funder);
    assert_err(
        try_settle_market(&mut env, accounts, 10_000, 0),
        ErrorCode::MintsNotReady,
    );
    let create = create_outcome_mint_ix(
        &env,
        &relayer,
        &relayer,
        &market,
        outcome_mint_args(Side::Yes),
    );
    send_ok(&mut env.svm, &[create], &[&env.relayer]);
    let accounts = settle_market_accounts(&env, &keys, &funder);
    assert_err(
        try_settle_market(&mut env, accounts, 10_000, 0),
        ErrorCode::MintsNotReady,
    );

    assert!(is_closed(&env.svm, &vault_address(&market)));
    assert_eq!(
        load::<Market>(&env.svm, &market).status,
        MarketStatus::Open as u8
    );
}

#[test]
fn settle_market_fails_when_the_funder_cannot_cover_the_payouts() {
    let mut funded = funded_market();
    let settler = funded.env.settler.pubkey();
    let funding = YES_UNITS * 10_000;
    let short = create_stable_account(&mut funded.env, &settler, funding - 1);
    let mut accounts = funded.settle_accounts();
    accounts.funder_stable = short;

    let result = try_settle_market(&mut funded.env, accounts, 10_000, 0);

    assert_custom_err(
        result,
        spl_token::error::TokenError::InsufficientFunds as u32,
    );
    funded.assert_not_settled();
    assert_eq!(token_balance(&funded.env.svm, &short), funding - 1);
}

#[test]
fn settle_market_only_draws_from_a_token_account_the_settler_owns() {
    let mut funded = funded_market();
    // Alice's balance would cover the funding.
    let mut accounts = funded.settle_accounts();
    accounts.funder_stable = funded.alice.stable;

    let result = try_settle_market(&mut funded.env, accounts, 10_000, 0);

    assert_err(result, ErrorCode::WrongOwner);
    funded.assert_not_settled();
}

#[test]
fn settle_market_is_not_blocked_by_lamports_sent_to_the_vault_address() {
    let mut funded = funded_market();
    // The smallest balance an account may be left with.
    let donation = funded.env.svm.minimum_balance_for_rent_exemption(0);
    funded.env.svm.airdrop(&funded.vault, donation).unwrap();

    funded.try_settle(10_000, 0).unwrap();

    // The payer only adds what the donation does not cover.
    let vault = funded.env.svm.get_account(&funded.vault).unwrap();
    assert_eq!(
        vault.lamports,
        funded
            .env
            .svm
            .minimum_balance_for_rent_exemption(vault.data.len())
    );
    assert_eq!(
        token_balance(&funded.env.svm, &funded.vault),
        YES_UNITS * 10_000
    );
}

// --- After settlement ------------------------------------------------------------------

#[test]
fn a_settled_market_takes_no_fills_orders_or_changes_but_releases_open_orders() {
    let mut funded = funded_market();
    let market = funded.market.market;
    let user = funded.alice.wallet.pubkey();
    let first = place_buy(&mut funded.env, &funded.alice, &market, place_buy_args());
    let second = place_buy(&mut funded.env, &funded.alice, &market, place_buy_args());
    let stable_before = token_balance(&funded.env.svm, &funded.alice.stable);
    funded.try_settle(10_000, 0).unwrap();
    // Both orders are still inside their lifetime.
    assert!(now(&funded.env.svm) < load::<Order>(&funded.env.svm, &first).expires_at);

    let accounts = fill_buy_accounts(&funded.env, &first, &funded.alice_yes, &funded.alice.stable);
    let fill = FillBuy {
        fill_qty: ORDER_QTY,
        cost: ORDER_QTY * u64::from(ORDER_LIMIT_PX),
        fee: 0,
    };
    let result = send(
        &mut funded.env.svm,
        &[instruction(accounts, fill)],
        &[&funded.env.relayer],
    );
    assert_err(result, ErrorCode::AlreadySettled);
    assert_eq!(
        mint_supply(&funded.env.svm, &funded.market.yes_mint),
        YES_UNITS
    );

    let accounts = place_buy_accounts(&funded.env, &user, &user, &market, &funded.alice.stable);
    let result = send(
        &mut funded.env.svm,
        &[instruction(accounts, place_buy_args())],
        &[&funded.alice.wallet],
    );
    assert_err(result, ErrorCode::MarketNotOpen);

    let admin = funded.env.admin.pubkey();
    let relayer = funded.env.relayer.pubkey();
    for status in [MarketStatus::Open, MarketStatus::Halted] {
        let change = set_market_ix(&funded.env, &admin, &market, Some(status), None);
        let result = send(&mut funded.env.svm, &[change], &[&funded.env.admin]);
        assert_err(result, ErrorCode::AlreadySettled);
    }
    let close_ts = funded.market.close_ts + 1;
    let change = set_market_ix(&funded.env, &relayer, &market, None, Some(close_ts));
    let result = send(&mut funded.env.svm, &[change], &[&funded.env.relayer]);
    assert_err(result, ErrorCode::AlreadySettled);

    // No fill can come any more, so the user need not wait for the expiry.
    let accounts = cancel_order_accounts(&funded.env, &user, &first, &funded.alice.stable);
    try_cancel_order(&mut funded.env, &funded.alice.wallet, accounts).unwrap();
    let accounts = cancel_order_accounts(&funded.env, &relayer, &second, &funded.alice.stable);
    let relayer = funded.env.relayer.insecure_clone();
    try_cancel_order(&mut funded.env, &relayer, accounts).unwrap();

    for order in [first, second] {
        assert!(is_closed(&funded.env.svm, &order));
        assert!(is_closed(&funded.env.svm, &escrow_address(&order)));
    }
    assert_eq!(
        token_balance(&funded.env.svm, &funded.alice.stable),
        stable_before + 2 * ORDER_ESCROW
    );
}

// --- redeem ----------------------------------------------------------------------------

#[test]
fn redeem_opens_at_redeem_after_pays_winners_and_only_burns_for_losers() {
    let mut funded = funded_market();
    funded.try_settle(10_000, 0).unwrap();
    let funding = YES_UNITS * 10_000;
    let redeem_after = funded.stored_market().redeem_after;
    let alice_stable = token_balance(&funded.env.svm, &funded.alice.stable);
    let bob_stable = token_balance(&funded.env.svm, &funded.bob.stable);

    set_time(&mut funded.env.svm, redeem_after - 1);
    assert_err(funded.try_redeem_yes(1_000), ErrorCode::RedeemLocked);
    assert_err(funded.try_redeem_no(NO_UNITS), ErrorCode::RedeemLocked);
    assert_eq!(token_balance(&funded.env.svm, &funded.vault), funding);

    // A winner redeems part of the position at the first open second.
    set_time(&mut funded.env.svm, redeem_after);
    let accounts = funded.yes_redeem_accounts();
    let meta = send_ok(
        &mut funded.env.svm,
        &[instruction(accounts, Redeem { amount: 1_000 })],
        &[&funded.alice.wallet],
    );
    println!("compute units: redeem = {}", meta.compute_units_consumed);
    let svm = &funded.env.svm;
    assert_eq!(token_balance(svm, &funded.alice_yes), YES_UNITS - 1_000);
    assert_eq!(mint_supply(svm, &funded.market.yes_mint), YES_UNITS - 1_000);
    assert_eq!(
        token_balance(svm, &funded.alice.stable),
        alice_stable + 10_000_000
    );
    assert_eq!(token_balance(svm, &funded.vault), funding - 10_000_000);
    let redeemed = events::<Redeemed>(&meta);
    assert_eq!(redeemed.len(), 1);
    assert_eq!(redeemed[0].market, funded.market.market);
    assert_eq!(redeemed[0].holder, funded.alice.wallet.pubkey());
    assert_eq!(redeemed[0].side, Side::Yes as u8);
    assert_eq!(redeemed[0].amount, 1_000);
    assert_eq!(redeemed[0].payout, 10_000_000);

    // A loser's tokens are burned for nothing.
    let accounts = funded.no_redeem_accounts();
    let meta = send_ok(
        &mut funded.env.svm,
        &[instruction(accounts, Redeem { amount: NO_UNITS })],
        &[&funded.bob.wallet],
    );
    let svm = &funded.env.svm;
    assert_eq!(token_balance(svm, &funded.bob_no), 0);
    assert_eq!(mint_supply(svm, &funded.market.no_mint), 0);
    assert_eq!(token_balance(svm, &funded.bob.stable), bob_stable);
    assert_eq!(token_balance(svm, &funded.vault), funding - 10_000_000);
    let redeemed = events::<Redeemed>(&meta);
    assert_eq!(redeemed.len(), 1);
    assert_eq!(redeemed[0].holder, funded.bob.wallet.pubkey());
    assert_eq!(redeemed[0].side, Side::No as u8);
    assert_eq!(redeemed[0].amount, NO_UNITS);
    assert_eq!(redeemed[0].payout, 0);

    // Once everyone has redeemed, nothing is left anywhere.
    funded.try_redeem_yes(YES_UNITS - 1_000).unwrap();
    let svm = &funded.env.svm;
    assert_eq!(token_balance(svm, &funded.vault), 0);
    assert_eq!(mint_supply(svm, &funded.market.yes_mint), 0);
    assert_eq!(mint_supply(svm, &funded.market.no_mint), 0);
    assert_eq!(
        token_balance(svm, &funded.alice.stable),
        alice_stable + funding
    );
}

#[test]
fn redeem_pays_both_sides_of_a_fractional_settlement() {
    let mut funded = funded_market();
    funded.try_settle(1_000, 9_000).unwrap();
    let (yes_value, no_value) = (YES_UNITS * 1_000, NO_UNITS * 9_000);
    assert_eq!(
        token_balance(&funded.env.svm, &funded.vault),
        yes_value + no_value
    );
    let alice_stable = token_balance(&funded.env.svm, &funded.alice.stable);
    let bob_stable = token_balance(&funded.env.svm, &funded.bob.stable);
    funded.open_redemption();

    funded.try_redeem_yes(YES_UNITS).unwrap();
    funded.try_redeem_no(NO_UNITS).unwrap();

    let svm = &funded.env.svm;
    assert_eq!(
        token_balance(svm, &funded.alice.stable),
        alice_stable + yes_value
    );
    assert_eq!(
        token_balance(svm, &funded.bob.stable),
        bob_stable + no_value
    );
    assert_eq!(token_balance(svm, &funded.vault), 0);
    assert_eq!(mint_supply(svm, &funded.market.yes_mint), 0);
    assert_eq!(mint_supply(svm, &funded.market.no_mint), 0);
}

#[test]
fn redeem_rejects_a_zero_amount_and_more_than_the_holder_has() {
    let mut funded = funded_market();
    funded.try_settle(10_000, 0).unwrap();
    funded.open_redemption();

    assert_err(funded.try_redeem_yes(0), ErrorCode::BadQuantity);
    assert_custom_err(
        funded.try_redeem_yes(YES_UNITS + 1),
        spl_token_2022::error::TokenError::InsufficientFunds as u32,
    );

    assert_eq!(token_balance(&funded.env.svm, &funded.alice_yes), YES_UNITS);
    assert_eq!(
        token_balance(&funded.env.svm, &funded.vault),
        YES_UNITS * 10_000
    );
}

#[test]
fn redeem_requires_a_settled_market() {
    let mut funded = funded_market();

    assert_err(funded.try_redeem_yes(1_000), ErrorCode::NotSettled);
    halt_market(&mut funded.env, &funded.market.market);
    assert_err(funded.try_redeem_yes(1_000), ErrorCode::NotSettled);

    assert_eq!(token_balance(&funded.env.svm, &funded.alice_yes), YES_UNITS);
}

#[test]
fn redeem_serves_a_holder_who_never_registered_as_a_trader() {
    let mut funded = funded_market();
    let carol = funded_keypair(&mut funded.env.svm, 14);
    let carol_yes =
        create_outcome_account(&mut funded.env, &funded.market.yes_mint, &carol.pubkey());
    let carol_stable = create_stable_account(&mut funded.env, &carol.pubkey(), 0);
    let gift = spl_token_2022::instruction::transfer_checked(
        &spl_token_2022::ID,
        &funded.alice_yes,
        &funded.market.yes_mint,
        &carol_yes,
        &funded.alice.wallet.pubkey(),
        &[],
        500,
        2,
    )
    .unwrap();
    send_ok(&mut funded.env.svm, &[gift], &[&funded.alice.wallet]);
    assert!(is_closed(&funded.env.svm, &trader_address(&carol.pubkey())));
    funded.try_settle(10_000, 0).unwrap();
    funded.open_redemption();

    let accounts = redeem_accounts(
        &funded.env,
        &carol.pubkey(),
        &funded.market.market,
        &funded.market.yes_mint,
        &carol_yes,
        &carol_stable,
    );
    try_redeem(&mut funded.env, &carol, accounts, 500).unwrap();

    assert_eq!(token_balance(&funded.env.svm, &carol_yes), 0);
    assert_eq!(token_balance(&funded.env.svm, &carol_stable), 5_000_000);
}

#[test]
fn redeem_is_not_blocked_by_the_pause_flags() {
    let mut funded = funded_market();
    funded.try_settle(10_000, 0).unwrap();
    funded.open_redemption();
    set_pause_flags(&mut funded.env, PAUSE_PLACE | PAUSE_FILL);

    funded.try_redeem_yes(YES_UNITS).unwrap();

    assert_eq!(token_balance(&funded.env.svm, &funded.vault), 0);
}

#[test]
fn redeem_rejects_substituted_mints_token_accounts_and_vaults() {
    let mut funded = funded_market();
    let other = create_market_with_mints(&mut funded.env, "OTHER-MARKET-1");
    let alice = funded.alice.wallet.insecure_clone();
    let alice_no = create_outcome_account(&mut funded.env, &funded.market.no_mint, &alice.pubkey());
    funded.try_settle(10_000, 0).unwrap();
    funded.open_redemption();

    // A mint of another market.
    let mut accounts = funded.yes_redeem_accounts();
    accounts.outcome_mint = other.yes_mint;
    assert_err(
        try_redeem(&mut funded.env, &alice, accounts, 1_000),
        ErrorCode::WrongMint,
    );
    // Someone else's tokens.
    let mut accounts = funded.yes_redeem_accounts();
    accounts.outcome_mint = funded.market.no_mint;
    accounts.holder_outcome = funded.bob_no;
    assert_err(
        try_redeem(&mut funded.env, &alice, accounts, 1_000),
        ErrorCode::WrongOwner,
    );
    // A payout to someone else's account.
    let mut accounts = funded.yes_redeem_accounts();
    accounts.holder_stable = funded.bob.stable;
    assert_err(
        try_redeem(&mut funded.env, &alice, accounts, 1_000),
        ErrorCode::WrongOwner,
    );
    // Losing tokens presented as the winning side: the token account decides nothing.
    let mut accounts = funded.yes_redeem_accounts();
    accounts.holder_outcome = alice_no;
    assert_anchor_err(
        try_redeem(&mut funded.env, &alice, accounts, 1_000),
        anchor_lang::error::ErrorCode::ConstraintTokenMint,
    );
    // The vault of another market.
    let mut accounts = funded.yes_redeem_accounts();
    accounts.vault = vault_address(&other.market);
    assert_anchor_err(
        try_redeem(&mut funded.env, &alice, accounts, 1_000),
        anchor_lang::error::ErrorCode::ConstraintSeeds,
    );

    assert_eq!(
        token_balance(&funded.env.svm, &funded.vault),
        YES_UNITS * 10_000
    );
    assert_eq!(token_balance(&funded.env.svm, &funded.alice_yes), YES_UNITS);
}

// --- revoke_settlement -----------------------------------------------------------------

/// What a revoked settlement leaves behind: the funding in the treasury on top of the buy
/// costs, no vault, and a halted market without payouts.
fn assert_revoked(funded: &Funded, funding: u64) {
    let svm = &funded.env.svm;
    assert_eq!(
        token_balance(svm, &funded.env.treasury),
        YES_COST + NO_COST + funding
    );
    assert!(is_closed(svm, &funded.vault));
    let stored = funded.stored_market();
    assert_eq!(stored.status, MarketStatus::Halted as u8);
    assert_eq!(stored.yes_payout, 0);
    assert_eq!(stored.no_payout, 0);
    assert_eq!(stored.redeem_after, 0);
}

#[test]
fn revoke_settlement_by_the_admin_returns_the_funding_and_halts_the_market() {
    let mut funded = funded_market();
    funded.try_settle(10_000, 0).unwrap();
    let funding = YES_UNITS * 10_000;
    assert_eq!(
        token_balance(&funded.env.svm, &funded.env.treasury),
        YES_COST + NO_COST
    );
    // The last second of the window.
    let redeem_after = funded.stored_market().redeem_after;
    set_time(&mut funded.env.svm, redeem_after - 1);
    let admin = funded.env.admin.pubkey();
    let admin_lamports = lamports(&funded.env.svm, &admin);
    let vault_lamports = lamports(&funded.env.svm, &funded.vault);

    let accounts = revoke_settlement_accounts(&funded.env, &admin, &funded.market.market);
    let meta = send_ok(
        &mut funded.env.svm,
        &[instruction(accounts, RevokeSettlement {})],
        &[&funded.env.admin],
    );
    println!(
        "compute units: revoke_settlement = {}",
        meta.compute_units_consumed
    );

    assert_revoked(&funded, funding);
    // The vault's rent goes to the signer.
    assert_eq!(
        lamports(&funded.env.svm, &admin),
        admin_lamports + vault_lamports - meta.fee
    );
    let revoked = events::<SettlementRevoked>(&meta);
    assert_eq!(revoked.len(), 1);
    assert_eq!(revoked[0].market, funded.market.market);
    // Nothing can be redeemed against a revoked settlement.
    set_time(&mut funded.env.svm, redeem_after);
    assert_err(funded.try_redeem_yes(1_000), ErrorCode::NotSettled);
}

#[test]
fn revoke_settlement_by_the_settler_works() {
    let mut funded = funded_market();
    funded.try_settle(1_000, 9_000).unwrap();
    let settler = funded.env.settler.insecure_clone();

    let accounts =
        revoke_settlement_accounts(&funded.env, &settler.pubkey(), &funded.market.market);
    try_revoke_settlement(&mut funded.env, &settler, accounts).unwrap();

    assert_revoked(&funded, YES_UNITS * 1_000 + NO_UNITS * 9_000);
}

#[test]
fn revoke_settlement_requires_the_admin_or_the_settler_and_pays_only_the_treasury() {
    let mut funded = funded_market();
    funded.try_settle(10_000, 0).unwrap();
    let funding = YES_UNITS * 10_000;
    let market = funded.market.market;

    for stranger in [
        funded.env.relayer.insecure_clone(),
        funded.env.registrar.insecure_clone(),
        funded.alice.wallet.insecure_clone(),
    ] {
        let accounts = revoke_settlement_accounts(&funded.env, &stranger.pubkey(), &market);
        let result = try_revoke_settlement(&mut funded.env, &stranger, accounts);

        assert_err(result, ErrorCode::Unauthorized);
    }
    // The settler cannot send the funding back to itself.
    let settler = funded.env.settler.insecure_clone();
    let mut accounts = revoke_settlement_accounts(&funded.env, &settler.pubkey(), &market);
    accounts.treasury = funded.funder;
    let result = try_revoke_settlement(&mut funded.env, &settler, accounts);
    assert_anchor_err(result, anchor_lang::error::ErrorCode::ConstraintAddress);

    assert_eq!(token_balance(&funded.env.svm, &funded.vault), funding);
    assert_eq!(funded.stored_market().status, MarketStatus::Settled as u8);
}

#[test]
fn revoke_settlement_closes_when_redemption_opens() {
    let mut funded = funded_market();
    funded.try_settle(10_000, 0).unwrap();
    let redeem_after = funded.stored_market().redeem_after;

    for time in [redeem_after, redeem_after + 1] {
        set_time(&mut funded.env.svm, time);

        assert_err(funded.try_revoke(), ErrorCode::RevokeWindowClosed);
    }

    assert_eq!(
        token_balance(&funded.env.svm, &funded.vault),
        YES_UNITS * 10_000
    );
    assert_eq!(funded.stored_market().status, MarketStatus::Settled as u8);
}

#[test]
fn revoke_settlement_requires_a_settled_market() {
    let mut funded = funded_market();

    assert_err(funded.try_revoke(), ErrorCode::NotSettled);
    halt_market(&mut funded.env, &funded.market.market);
    assert_err(funded.try_revoke(), ErrorCode::NotSettled);
}

#[test]
fn a_revoked_market_can_be_settled_again_with_other_payouts() {
    let mut funded = funded_market();
    funded.try_settle(10_000, 0).unwrap();
    let first_funding = YES_UNITS * 10_000;
    funded.try_revoke().unwrap();
    advance_time(&mut funded.env.svm, 10);
    let settled_at = now(&funded.env.svm);

    funded.try_settle(0, 10_000).unwrap();

    let second_funding = NO_UNITS * 10_000;
    assert_eq!(
        token_balance(&funded.env.svm, &funded.vault),
        second_funding
    );
    assert_eq!(
        token_balance(&funded.env.svm, &funded.funder),
        FUNDER_STABLE - first_funding - second_funding
    );
    let stored = funded.stored_market();
    assert_eq!(stored.status, MarketStatus::Settled as u8);
    assert_eq!(stored.yes_payout, 0);
    assert_eq!(stored.no_payout, 10_000);
    assert_eq!(
        stored.redeem_after,
        settled_at + i64::from(SETTLE_DELAY_SECS)
    );

    // Redemption follows the second settlement.
    let bob_stable = token_balance(&funded.env.svm, &funded.bob.stable);
    funded.open_redemption();
    funded.try_redeem_yes(YES_UNITS).unwrap();
    funded.try_redeem_no(NO_UNITS).unwrap();
    assert_eq!(
        token_balance(&funded.env.svm, &funded.bob.stable),
        bob_stable + second_funding
    );
    assert_eq!(token_balance(&funded.env.svm, &funded.vault), 0);
}
