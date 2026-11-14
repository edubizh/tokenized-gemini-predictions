# Versions

Versions installed and used to build, test and deploy this repository. Recorded 2026-11-13 on macOS 15.7.9 (Apple Silicon). The lockfiles are the source of truth: `anchor/Cargo.lock` for Rust and `pnpm-lock.yaml` for JavaScript.

## Solana toolchain

| Tool | Version | Notes |
|---|---|---|
| Rust, host default | rustc 1.100.0, cargo 1.100.0 | rustup `stable`; not used inside `anchor/` |
| Rust, workspace | rustc 1.89.0, cargo 1.89.0 | pinned by `anchor/rust-toolchain.toml`; compiles the tests and the IDL build |
| Rust, SBF target | rustc 1.95.0-dev | part of platform tools v1.57; compiles the program |
| Platform tools | v1.57 | selected by `anchor build` (`--tools-version v1.57`, `--arch v3`) |
| Solana CLI (Agave) | 4.1.2 | ships `cargo-build-sbf` 4.1.0, whose own default is platform tools v1.54 |
| Anchor CLI | 1.2.2 | installed through `avm` 1.2.2 |
| Devnet cluster | 4.5.0-beta.0 | reported by `getVersion` at the time of deployment |

## Program crates

| Crate | Version |
|---|---|
| `anchor-lang`, `anchor-spl` | 1.2.2 |
| `litesvm` | 0.15.0 |
| `spl-token-interface` | 2.0.0 |
| `spl-token-2022-interface` | 2.1.0 |
| `spl-token-metadata-interface` | 0.8.0 |
| `spl-associated-token-account-interface` | 2.0.0 |
| `spl-pod` | 0.7.4 |
| `solana-sha256-hasher` | 3.1.0 |
| `solana-instruction` | 3.4.0 |
| `solana-pubkey` | 3.0.0 (same type as `solana-address` 2.6.1) |
| `solana-clock` | 3.1.1 |
| `solana-message` | 4.3.0 |
| `solana-transaction` | 4.1.5 |
| `solana-keypair` | 3.1.2 |
| `solana-signer` | 3.0.1 |
| `borsh` | 1.8.1 |

Programs bundled with LiteSVM 0.15.0 and used by the tests: Token-2022 11.0.0, SPL Token (the p-token build) and Associated Token Account 1.1.1. Devnet runs a different Token-2022 build, so compute-unit figures measured in LiteSVM are lower than on devnet.

## JavaScript

| Package | Version |
|---|---|
| Node.js | 24.6.0 |
| pnpm | 12.18.0 |
| TypeScript | 5.9.3 |
| `tsx` | 4.23.15 |
| `@solana/kit` | 8.6.0 |
| `@solana/sysvars` | 8.6.0 |
| `@solana-program/token-2022` | 0.20.1 |
| `@solana-program/system` | 0.16.0 (dependency of `@solana-program/token-2022`) |
| `codama` | 1.11.0 (runs `@codama/cli` 1.6.3) |
| `@codama/nodes-from-anchor` | 1.5.6 |
| `@codama/renderers-js` | 2.9.0 |
