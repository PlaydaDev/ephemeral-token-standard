#!/usr/bin/env bash
# Deploy the program to devnet from WSL. The deployer keypair lives in
# ~/.config/solana/id.json (NEVER in the repo); the program keypair lives in
# target/deploy/ (gitignored).
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
cd /mnt/c/Users/Val/ephemere

echo "cluster : $(solana config get | grep 'RPC URL')"
echo "deployer: $(solana address)  ($(solana balance))"

solana program deploy target/deploy/ephemere.so \
  --program-id target/deploy/ephemere-keypair.json \
  --max-len 450000 \
  --url https://api.devnet.solana.com

solana program show 4UxnYz4N5b5MnvMeGNqYGyvcu3izQYC7m6df9RhYTygo --url https://api.devnet.solana.com
