#!/usr/bin/env bash
# Single quiet upgrade attempt; exit 0 only on successful deploy.
set -u
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
cd /mnt/c/Users/Val/ephemere
RPC="${RPC_URL:-https://api.devnet.solana.com}"
solana program deploy target/deploy/ephemere.so \
  --program-id target/deploy/ephemere-keypair.json \
  --max-len 450000 \
  --url "$RPC"
