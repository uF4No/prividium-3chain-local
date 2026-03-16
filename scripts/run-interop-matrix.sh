#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_DIR="$ROOT_DIR/sdk"

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is required"
  exit 1
fi

cd "$SDK_DIR"

if [[ ! -d node_modules ]]; then
  echo "Installing SDK dependencies..."
  npm install
fi

PRIVATE_KEY="${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
L1_RPC="${L1_RPC:-http://127.0.0.1:8545}"
L2A_RPC="${L2A_RPC:-http://127.0.0.1:3050}"
L2B_RPC="${L2B_RPC:-http://127.0.0.1:3051}"
L2C_RPC="${L2C_RPC:-http://127.0.0.1:3052}"
INTEROP_POLL_MS="${INTEROP_POLL_MS:-3000}"
INTEROP_TIMEOUT_MS="${INTEROP_TIMEOUT_MS:-180000}"

PRIVATE_KEY="$PRIVATE_KEY" \
L1_RPC="$L1_RPC" \
L2A_RPC="$L2A_RPC" \
L2B_RPC="$L2B_RPC" \
L2C_RPC="$L2C_RPC" \
INTEROP_POLL_MS="$INTEROP_POLL_MS" \
INTEROP_TIMEOUT_MS="$INTEROP_TIMEOUT_MS" \
npx ts-node examples/remote-call-3chains.ts
