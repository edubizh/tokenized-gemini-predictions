//! The data layout that clients depend on: constants, error numbers, enum encodings,
//! account bytes and event bytes. Each expectation is written out by hand from the
//! specification, so a reordered field or a renumbered error fails here.

use {
    anchor_lang::{
        prelude::{borsh, Pubkey},
        AccountSerialize, AnchorDeserialize, Event, Space,
    },
    outcome_tokens::{
        constants::*,
        error::ErrorCode,
        events::*,
        state::{Config, Market, MarketStatus, Order, OrderKind, Side, Trader},
    },
};

/// Anchor's discriminator: the first eight bytes of `sha256("<namespace>:<Name>")`.
fn discriminator(namespace: &str, name: &str) -> Vec<u8> {
    let digest = solana_sha256_hasher::hash(format!("{namespace}:{name}").as_bytes());
    digest.to_bytes()[..8].to_vec()
}

fn key(byte: u8) -> Pubkey {
    Pubkey::new_from_array([byte; 32])
}

fn account_bytes(account: &impl AccountSerialize) -> Vec<u8> {
    let mut bytes = Vec::new();
    account.try_serialize(&mut bytes).unwrap();
    bytes
}

/// `discriminator ++ fields`, the fields already encoded and in declaration order.
fn expected_bytes(namespace: &str, name: &str, fields: &[&[u8]]) -> Vec<u8> {
    let mut bytes = discriminator(namespace, name);
    for field in fields {
        bytes.extend_from_slice(field);
    }
    bytes
}

#[test]
fn constants_match_the_spec() {
    assert_eq!(OUTCOME_DECIMALS, 2u8);
    assert_eq!(STABLE_DECIMALS, 6u8);
    assert_eq!(PX_MAX, 9_999u16);
    assert_eq!(PAYOUT_TOTAL, 10_000u64);
    assert_eq!(MAX_SYMBOL_LEN, 64usize);
    assert_eq!(MAX_NAME_LEN, 32usize);
    assert_eq!(MAX_TICKER_LEN, 10usize);
    assert_eq!(MAX_URI_LEN, 200usize);
    assert_eq!(TTL_MIN_SECS, 30u32);
    assert_eq!(TTL_MAX_SECS, 900u32);
    assert_eq!(CUTOFF_MIN_SECS, 30u32);
    assert_eq!(PAUSE_PLACE, 1u8);
    assert_eq!(PAUSE_FILL, 2u8);
    assert_eq!(MAX_FEE_PER_UNIT, 200u64);
    assert_eq!(MAX_FEE_BASE, 50_000u64);
}

#[test]
fn seeds_match_the_spec() {
    assert_eq!(CONFIG_SEED, b"config");
    assert_eq!(TRADER_SEED, b"trader");
    assert_eq!(MARKET_SEED, b"market");
    assert_eq!(MINT_SEED, b"mint");
    assert_eq!(ORDER_SEED, b"order");
    assert_eq!(ESCROW_SEED, b"escrow");
    assert_eq!(REDEEM_SEED, b"redeem");
}

#[test]
fn forbidden_stable_mints_are_the_mainnet_usdc_usdt_and_pyusd_mints() {
    assert_eq!(
        FORBIDDEN_STABLE_MINTS.map(|mint| mint.to_string()),
        [
            "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
            "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
        ]
    );
}

#[test]
fn error_codes_follow_the_spec_order() {
    let errors = [
        ErrorCode::Unauthorized,
        ErrorCode::BadConfig,
        ErrorCode::Paused,
        ErrorCode::RealStablecoinNotAllowed,
        ErrorCode::BadSymbol,
        ErrorCode::BadSymbolHash,
        ErrorCode::MintAlreadyCreated,
        ErrorCode::MintsNotReady,
        ErrorCode::MarketNotOpen,
        ErrorCode::AlreadySettled,
        ErrorCode::NotSettled,
        ErrorCode::TooCloseToClose,
        ErrorCode::BadQuantity,
        ErrorCode::BadPrice,
        ErrorCode::OffTick,
        ErrorCode::FeeCapTooHigh,
        ErrorCode::FillExceedsOrder,
        ErrorCode::CostOutOfRange,
        ErrorCode::ProceedsOutOfRange,
        ErrorCode::FeeExceedsCap,
        ErrorCode::SupplyCapExceeded,
        ErrorCode::OrderExpired,
        ErrorCode::OrderNotExpired,
        ErrorCode::WrongKind,
        ErrorCode::WrongMarket,
        ErrorCode::WrongMint,
        ErrorCode::WrongOwner,
        ErrorCode::BadPayout,
        ErrorCode::RedeemLocked,
        ErrorCode::RevokeWindowClosed,
        ErrorCode::MathOverflow,
    ];
    assert_eq!(errors.len(), 31);
    for (index, error) in errors.into_iter().enumerate() {
        assert_eq!(u32::from(error), 6_000 + index as u32, "{error:?}");
    }
}

#[test]
fn enums_are_stored_as_the_spec_numbers() {
    assert_eq!(Side::Yes as u8, 0);
    assert_eq!(Side::No as u8, 1);
    assert_eq!(OrderKind::Buy as u8, 0);
    assert_eq!(OrderKind::Sell as u8, 1);
    assert_eq!(MarketStatus::Open as u8, 0);
    assert_eq!(MarketStatus::Halted as u8, 1);
    assert_eq!(MarketStatus::Settled as u8, 2);
}

#[test]
fn enum_arguments_encode_as_the_stored_number_and_reject_unknown_values() {
    // An instruction argument travels as one byte, the same number the accounts store.
    assert_eq!(borsh::to_vec(&Side::Yes).unwrap(), [0]);
    assert_eq!(borsh::to_vec(&Side::No).unwrap(), [1]);
    assert_eq!(borsh::to_vec(&OrderKind::Buy).unwrap(), [0]);
    assert_eq!(borsh::to_vec(&OrderKind::Sell).unwrap(), [1]);
    assert_eq!(borsh::to_vec(&MarketStatus::Open).unwrap(), [0]);
    assert_eq!(borsh::to_vec(&MarketStatus::Halted).unwrap(), [1]);
    assert_eq!(borsh::to_vec(&MarketStatus::Settled).unwrap(), [2]);

    assert_eq!(Side::try_from_slice(&[1]).unwrap(), Side::No);
    assert_eq!(OrderKind::try_from_slice(&[1]).unwrap(), OrderKind::Sell);
    assert_eq!(
        MarketStatus::try_from_slice(&[2]).unwrap(),
        MarketStatus::Settled
    );

    // Deserialization is the only validation an enum argument gets.
    assert!(Side::try_from_slice(&[2]).is_err());
    assert!(OrderKind::try_from_slice(&[2]).is_err());
    assert!(MarketStatus::try_from_slice(&[3]).is_err());
}

#[test]
fn config_layout_matches_the_spec() {
    let config = Config {
        admin: key(1),
        relayer: key(2),
        settler: key(3),
        registrar: key(4),
        stable_mint: key(5),
        treasury: key(6),
        order_ttl_secs: 0x0a0b_0c0d,
        min_order_units: 0x1112_1314_1516_1718,
        max_order_units: 0x2122_2324_2526_2728,
        settle_delay_secs: 0x3a3b_3c3d,
        pause_flags: 0x41,
        bump: 0x42,
        reserved: [0x43; 64],
    };

    let expected = expected_bytes(
        "account",
        "Config",
        &[
            &[1; 32],
            &[2; 32],
            &[3; 32],
            &[4; 32],
            &[5; 32],
            &[6; 32],
            &0x0a0b_0c0d_u32.to_le_bytes(),
            &0x1112_1314_1516_1718_u64.to_le_bytes(),
            &0x2122_2324_2526_2728_u64.to_le_bytes(),
            &0x3a3b_3c3d_u32.to_le_bytes(),
            &[0x41],
            &[0x42],
            &[0x43; 64],
        ],
    );
    assert_eq!(account_bytes(&config), expected);
    assert_eq!(8 + Config::INIT_SPACE, expected.len());
    assert_eq!(8 + Config::INIT_SPACE, 290);
}

#[test]
fn trader_layout_matches_the_spec() {
    let trader = Trader {
        user: key(1),
        next_nonce: 0x1112_1314_1516_1718,
        bump: 0x21,
        reserved: [0x22; 32],
    };

    let expected = expected_bytes(
        "account",
        "Trader",
        &[
            &[1; 32],
            &0x1112_1314_1516_1718_u64.to_le_bytes(),
            &[0x21],
            &[0x22; 32],
        ],
    );
    assert_eq!(account_bytes(&trader), expected);
    assert_eq!(8 + Trader::INIT_SPACE, expected.len());
    assert_eq!(8 + Trader::INIT_SPACE, 81);
}

#[test]
fn market_layout_matches_the_spec() {
    // The longest symbol the program accepts, so the bytes fill the reserved space.
    let symbol = "A".repeat(MAX_SYMBOL_LEN);
    let market = Market {
        symbol_hash: [1; 32],
        symbol: symbol.clone(),
        yes_mint: key(2),
        no_mint: key(3),
        status: MarketStatus::Halted as u8,
        close_ts: 0x1112_1314_1516_1718,
        place_cutoff_secs: 0x2a2b_2c2d,
        tick_px: 0x3132,
        max_supply_units: 0x4142_4344_4546_4748,
        yes_payout: 0x5152_5354_5556_5758,
        no_payout: 0x6162_6364_6566_6768,
        redeem_after: 0x7172_7374_7576_7778,
        bump: 0x7a,
        reserved: [0x7b; 64],
    };

    let expected = expected_bytes(
        "account",
        "Market",
        &[
            &[1; 32],
            &64u32.to_le_bytes(),
            symbol.as_bytes(),
            &[2; 32],
            &[3; 32],
            &[1],
            &0x1112_1314_1516_1718_i64.to_le_bytes(),
            &0x2a2b_2c2d_u32.to_le_bytes(),
            &0x3132_u16.to_le_bytes(),
            &0x4142_4344_4546_4748_u64.to_le_bytes(),
            &0x5152_5354_5556_5758_u64.to_le_bytes(),
            &0x6162_6364_6566_6768_u64.to_le_bytes(),
            &0x7172_7374_7576_7778_i64.to_le_bytes(),
            &[0x7a],
            &[0x7b; 64],
        ],
    );
    assert_eq!(account_bytes(&market), expected);
    assert_eq!(8 + Market::INIT_SPACE, expected.len());
    assert_eq!(8 + Market::INIT_SPACE, 284);
}

#[test]
fn order_layout_matches_the_spec() {
    let order = Order {
        user: key(1),
        market: key(2),
        side: Side::No as u8,
        kind: OrderKind::Buy as u8,
        qty_units: 0x1112_1314_1516_1718,
        limit_px: 0x2122,
        max_fee: 0x3132_3334_3536_3738,
        expires_at: 0x4142_4344_4546_4748,
        rent_payer: key(5),
        nonce: 0x6162_6364_6566_6768,
        bump: 0x71,
        reserved: [0x72; 16],
    };

    let expected = expected_bytes(
        "account",
        "Order",
        &[
            &[1; 32],
            &[2; 32],
            &[1],
            &[0],
            &0x1112_1314_1516_1718_u64.to_le_bytes(),
            &0x2122_u16.to_le_bytes(),
            &0x3132_3334_3536_3738_u64.to_le_bytes(),
            &0x4142_4344_4546_4748_i64.to_le_bytes(),
            &[5; 32],
            &0x6162_6364_6566_6768_u64.to_le_bytes(),
            &[0x71],
            &[0x72; 16],
        ],
    );
    assert_eq!(account_bytes(&order), expected);
    assert_eq!(8 + Order::INIT_SPACE, expected.len());
    assert_eq!(8 + Order::INIT_SPACE, 157);
}

#[test]
fn configuration_and_trader_events_match_the_spec() {
    assert_eq!(
        Initialized {}.data(),
        expected_bytes("event", "Initialized", &[])
    );
    assert_eq!(
        ConfigChanged {}.data(),
        expected_bytes("event", "ConfigChanged", &[])
    );
    assert_eq!(
        TraderRegistered { user: key(1) }.data(),
        expected_bytes("event", "TraderRegistered", &[&[1; 32]])
    );
}

#[test]
fn market_events_match_the_spec() {
    assert_eq!(
        MarketCreated {
            market: key(1),
            symbol: "BTC-UP".to_string(),
        }
        .data(),
        expected_bytes(
            "event",
            "MarketCreated",
            &[&[1; 32], &6u32.to_le_bytes(), b"BTC-UP"]
        )
    );
    assert_eq!(
        OutcomeMintCreated {
            market: key(1),
            side: Side::No as u8,
            mint: key(2),
        }
        .data(),
        expected_bytes("event", "OutcomeMintCreated", &[&[1; 32], &[1], &[2; 32]])
    );
    assert_eq!(
        MarketStatusChanged {
            market: key(1),
            status: MarketStatus::Halted as u8,
            close_ts: 0x1112_1314_1516_1718,
        }
        .data(),
        expected_bytes(
            "event",
            "MarketStatusChanged",
            &[&[1; 32], &[1], &0x1112_1314_1516_1718_i64.to_le_bytes()]
        )
    );
    assert_eq!(
        MarketSettled {
            market: key(1),
            yes_payout: 0x1112_1314_1516_1718,
            no_payout: 0x2122_2324_2526_2728,
            funding: 0x3132_3334_3536_3738,
            redeem_after: 0x4142_4344_4546_4748,
        }
        .data(),
        expected_bytes(
            "event",
            "MarketSettled",
            &[
                &[1; 32],
                &0x1112_1314_1516_1718_u64.to_le_bytes(),
                &0x2122_2324_2526_2728_u64.to_le_bytes(),
                &0x3132_3334_3536_3738_u64.to_le_bytes(),
                &0x4142_4344_4546_4748_i64.to_le_bytes(),
            ]
        )
    );
    assert_eq!(
        SettlementRevoked { market: key(1) }.data(),
        expected_bytes("event", "SettlementRevoked", &[&[1; 32]])
    );
    assert_eq!(
        Redeemed {
            market: key(1),
            holder: key(2),
            side: Side::No as u8,
            amount: 0x1112_1314_1516_1718,
            payout: 0x2122_2324_2526_2728,
        }
        .data(),
        expected_bytes(
            "event",
            "Redeemed",
            &[
                &[1; 32],
                &[2; 32],
                &[1],
                &0x1112_1314_1516_1718_u64.to_le_bytes(),
                &0x2122_2324_2526_2728_u64.to_le_bytes(),
            ]
        )
    );
}

#[test]
fn order_events_match_the_spec() {
    assert_eq!(
        OrderPlaced {
            order: key(1),
            user: key(2),
            market: key(3),
            side: Side::No as u8,
            kind: OrderKind::Buy as u8,
            qty_units: 0x1112_1314_1516_1718,
            limit_px: 0x2122,
            max_fee: 0x3132_3334_3536_3738,
            expires_at: 0x4142_4344_4546_4748,
            nonce: 0x5152_5354_5556_5758,
        }
        .data(),
        expected_bytes(
            "event",
            "OrderPlaced",
            &[
                &[1; 32],
                &[2; 32],
                &[3; 32],
                &[1],
                &[0],
                &0x1112_1314_1516_1718_u64.to_le_bytes(),
                &0x2122_u16.to_le_bytes(),
                &0x3132_3334_3536_3738_u64.to_le_bytes(),
                &0x4142_4344_4546_4748_i64.to_le_bytes(),
                &0x5152_5354_5556_5758_u64.to_le_bytes(),
            ]
        )
    );
    assert_eq!(
        OrderFilled {
            order: key(1),
            user: key(2),
            market: key(3),
            side: Side::No as u8,
            kind: OrderKind::Buy as u8,
            fill_qty: 0x1112_1314_1516_1718,
            amount: 0x2122_2324_2526_2728,
            fee: 0x3132_3334_3536_3738,
        }
        .data(),
        expected_bytes(
            "event",
            "OrderFilled",
            &[
                &[1; 32],
                &[2; 32],
                &[3; 32],
                &[1],
                &[0],
                &0x1112_1314_1516_1718_u64.to_le_bytes(),
                &0x2122_2324_2526_2728_u64.to_le_bytes(),
                &0x3132_3334_3536_3738_u64.to_le_bytes(),
            ]
        )
    );
    assert_eq!(
        OrderCancelled {
            order: key(1),
            user: key(2),
            market: key(3),
            by: key(4),
        }
        .data(),
        expected_bytes(
            "event",
            "OrderCancelled",
            &[&[1; 32], &[2; 32], &[3; 32], &[4; 32]]
        )
    );
}
