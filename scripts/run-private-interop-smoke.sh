#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRIVATE_INTEROP_DIR="$ROOT_DIR/private-interop"

if [[ ! -d "$PRIVATE_INTEROP_DIR/node_modules" ]]; then
  echo "Installing private interop npm dependencies..."
  (cd "$PRIVATE_INTEROP_DIR" && npm install --no-package-lock)
fi

if [[ ! -f "$PRIVATE_INTEROP_DIR/out/TestInteropGreetingRecipient.sol/TestInteropGreetingRecipient.json" ]]; then
  echo "Building private interop smoke artifacts..."
  (
    cd "$PRIVATE_INTEROP_DIR" && \
      FOUNDRY_PROFILE=anvil-interop forge build \
        contracts/interop/PrivateInteropCenter.sol \
        contracts/interop/PrivateInteropHandler.sol \
        contracts/bridge/asset-router/PrivateL2AssetRouter.sol \
        contracts/bridge/asset-tracker/PrivateL2AssetTracker.sol \
        contracts/bridge/ntv/PrivateL2NativeTokenVault.sol \
        contracts/dev-contracts/TestnetERC20Token.sol \
        contracts/dev-contracts/test/TestInteropGreetingRecipient.sol
  )
fi

cd "$PRIVATE_INTEROP_DIR"
npx ts-node private-interop-smoke.ts

"$ROOT_DIR/scripts/validate-private-interop-permissions.sh"

if [[ "${SKIP_PUBLIC_REGRESSION:-0}" != "1" ]]; then
  "$ROOT_DIR/scripts/run-interop-matrix.sh"
fi
