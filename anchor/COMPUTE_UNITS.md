# Compute units

Compute units consumed by each instruction of `outcome_tokens`, measured in the LiteSVM
test suite. Each number is one successful call in the scenario named in the last column.

| Instruction | LiteSVM CU | Measured in |
|---|---:|---|
| `initialize` | 11,754 | `tests/admin.rs` |
| `set_config` | 5,268 | `tests/admin.rs` |
| `set_pause` | 4,404 | `tests/admin.rs` |
| `register_trader` | 15,424 | `tests/admin.rs` |
| `create_market` | 13,850 | `tests/markets.rs` |
| `create_outcome_mint` (YES) | 33,917 | `tests/markets.rs` |
| `create_outcome_mint` (NO) | 29,394 | `tests/markets.rs` |
| `set_market` | 7,076 | `tests/markets.rs` |
| `place_buy` | 26,665 | `tests/buy.rs`, separate payer |
| `fill_buy` | 29,284 | `tests/buy.rs`, full fill with a refund |
| `place_sell` | 33,050 | `tests/sell.rs`, separate payer |
| `fill_sell` | 30,271 | `tests/sell.rs`, full fill |
| `cancel_order` (buy order) | 18,158 | `tests/cancel.rs`, by the relayer |
| `cancel_order` (sell order) | 23,211 | `tests/sell.rs`, by the relayer |
| `settle_market` | 26,652 | `tests/settle.rs`, separate payer |
| `revoke_settlement` | 19,678 | `tests/settle.rs`, by the admin |
| `redeem` | 20,438 | `tests/settle.rs`, winning side |

## Reading the numbers

- **Devnet costs more.** LiteSVM bundles its own builds of the token programs. On devnet,
  calls into Token-2022 measured 25-45% higher than in LiteSVM. That affects every
  instruction that touches an outcome mint or an outcome token account:
  `create_outcome_mint`, `fill_buy`, `place_sell`, `fill_sell`, `cancel_order` of a sell
  order and `redeem`. Take compute-unit limits from a devnet simulation of the actual
  transaction, not from this table.
- **Addresses move the numbers.** Finding a program-derived address costs more or less
  depending on its bump. The two `create_outcome_mint` rows run the same code for two
  mint addresses and show the size of the effect. The tests use fixed keys, so the table
  is reproducible, but another wallet, market or order nonce shifts an instruction by a
  few thousand units.
- **The path matters.** A fill that leaves nothing to refund skips one token transfer, and
  a `redeem` of a side that settled at zero skips the payout transfer; both cost less than
  the rows above.

## Reproducing

From `anchor/`:

```sh
anchor build && cargo test -- --nocapture 2>/dev/null | grep "compute units:" | sort
```
