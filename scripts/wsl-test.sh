#!/usr/bin/env bash
# Run the TS test suite inside WSL (bankrun has no Windows binding).
# Usage: wsl -d Ubuntu -- bash scripts/wsl-test.sh [mocha args...]
set -uo pipefail
cd /mnt/c/Users/Val/ephemere
export RUST_LOG=error # silence bankrun's solana_runtime debug firehose

if ! node -e 'require("solana-bankrun")' 2>/dev/null; then
  echo "--- installing node deps (linux bindings) ---"
  npm install > /tmp/npm-wsl.log 2>&1 || { tail -20 /tmp/npm-wsl.log; exit 1; }
fi

npx mocha -n import=tsx -t 1000000 "${@:-tests/**/*.ts}"
