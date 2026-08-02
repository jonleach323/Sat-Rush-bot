#!/usr/bin/env bash
# One-command cluster switch: copies .env.devnet or .env.mainnet over .env
# and prints the redacted config summary so you SEE what you just armed.
#
#   pnpm switch:devnet
#   pnpm switch:mainnet     (MAINNET_CONFIRM stays unset in the file —
#                            arming it is a deliberate manual edit)
set -euo pipefail
TARGET="${1:?usage: switch-cluster.sh devnet|mainnet}"
case "$TARGET" in
  devnet|mainnet) ;;
  *) echo "invalid cluster '$TARGET' (devnet|mainnet)"; exit 1 ;;
esac
SRC=".env.$TARGET"
if [ ! -f "$SRC" ]; then
  echo "missing $SRC — create it once from .env.example with the $TARGET endpoints/caps"
  exit 1
fi
cp "$SRC" .env
echo "── .env now targets: $TARGET ──"
pnpm exec tsx src/config.ts
if [ "$TARGET" = "mainnet" ]; then
  echo ""
  echo "next: pnpm preflight   (expect mode_gate FATAL until you set MAINNET_CONFIRM=yes in .env)"
fi
