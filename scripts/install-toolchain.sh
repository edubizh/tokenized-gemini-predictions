#!/usr/bin/env bash
# Installs the pinned Solana build toolchain for macOS arm64.
# Rust (rustup, minimal profile) -> Solana CLI 4.1.2 -> AVM -> Anchor 1.2.2
set -euo pipefail

step() { printf '\n===== %s =====\n' "$1"; }

step "1/3 rustup + stable Rust (minimal profile)"
if command -v rustup >/dev/null 2>&1 || [ -x "$HOME/.cargo/bin/rustup" ]; then
  echo "rustup already present"
else
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
# shellcheck disable=SC1091
. "$HOME/.cargo/env"
rustc --version
cargo --version

step "2/3 Solana CLI 4.1.2 (the version Anchor 1.2.2 is tested with)"
SOLANA_BIN="$HOME/.local/share/solana/install/active_release/bin"
if [ -x "$SOLANA_BIN/solana" ]; then
  echo "solana already present"
else
  sh -c "$(curl -sSfL https://release.anza.xyz/v4.1.2/install)"
fi
export PATH="$SOLANA_BIN:$PATH"
solana --version

step "3/3 AVM (built from the v1.2.2 tag) + Anchor 1.2.2"
if [ -x "$HOME/.cargo/bin/avm" ]; then
  echo "avm already present"
else
  cargo install --git https://github.com/otter-sec/anchor --tag v1.2.2 avm --locked
fi
avm install 1.2.2
avm use 1.2.2
export PATH="$HOME/.avm/bin:$PATH"
anchor --version

step "done"
echo "rustc:  $(rustc --version)"
echo "solana: $(solana --version)"
echo "anchor: $(anchor --version)"
