#!/usr/bin/env bash
# Fund the WSL deployer wallet on devnet (keypair stays in ~/.config, out of repo).
# Patient mode: the public faucet rate-limits per IP and resets over time.
set -u
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
TARGET=${1:-3.6}
echo "WALLET: $(solana address)"
for i in $(seq 1 24); do
  bal=$(solana balance | awk '{print $1}')
  echo "[try $i] balance: $bal SOL"
  ok=$(echo "$bal >= $TARGET" | bc -l)
  if [ "$ok" = "1" ]; then echo "FUNDED"; exit 0; fi
  solana airdrop 1 2>&1 | tail -1
  sleep 25
done
echo "FAUCET_DRY balance: $(solana balance)"
exit 1
