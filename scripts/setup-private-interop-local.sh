#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRIVATE_INTEROP_DIR="$ROOT_DIR/private-interop"
MANIFEST_PATH="${PRIVATE_INTEROP_MANIFEST_PATH:-$ROOT_DIR/.runtime/private-interop.json}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

ensure_private_interop_deps() {
  if [[ ! -d "$PRIVATE_INTEROP_DIR/node_modules" ]]; then
    echo "Installing private interop npm dependencies..."
    (cd "$PRIVATE_INTEROP_DIR" && npm install --no-package-lock)
  fi
}

ensure_foundry_artifacts() {
  if [[ ! -f "$PRIVATE_INTEROP_DIR/out/PrivateInteropCenter.sol/PrivateInteropCenter.json" ]]; then
    echo "Building foundry artifacts for private interop..."
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
}

main() {
  need_cmd node
  need_cmd npm
  need_cmd forge

  mkdir -p "$(dirname "$MANIFEST_PATH")"

  export PRIVATE_INTEROP_MANIFEST_PATH="$MANIFEST_PATH"
  export PRIVATE_INTEROP_CHAIN_A_RPC_URL="${PRIVATE_INTEROP_CHAIN_A_RPC_URL:-http://127.0.0.1:3050}"
  export PRIVATE_INTEROP_CHAIN_B_RPC_URL="${PRIVATE_INTEROP_CHAIN_B_RPC_URL:-http://127.0.0.1:3051}"
  export PRIVATE_INTEROP_CHAIN_C_RPC_URL="${PRIVATE_INTEROP_CHAIN_C_RPC_URL:-http://127.0.0.1:3052}"
  export PRIVATE_INTEROP_CHAIN_A_CONNECT_RPC_URL="${PRIVATE_INTEROP_CHAIN_A_CONNECT_RPC_URL:-$PRIVATE_INTEROP_CHAIN_A_RPC_URL}"
  export PRIVATE_INTEROP_CHAIN_B_CONNECT_RPC_URL="${PRIVATE_INTEROP_CHAIN_B_CONNECT_RPC_URL:-$PRIVATE_INTEROP_CHAIN_B_RPC_URL}"
  export PRIVATE_INTEROP_CHAIN_C_CONNECT_RPC_URL="${PRIVATE_INTEROP_CHAIN_C_CONNECT_RPC_URL:-$PRIVATE_INTEROP_CHAIN_C_RPC_URL}"

  ensure_private_interop_deps
  ensure_foundry_artifacts

  echo "Deploying private interop stack..."
  (cd "$PRIVATE_INTEROP_DIR" && npx ts-node deploy-private-interop-local.ts)

  echo "Generating private interop permission SQL..."
  (cd "$PRIVATE_INTEROP_DIR" && npx ts-node generate-private-interop-permissions.ts)

  if [[ "${PRIVATE_INTEROP_APPLY_PERMISSIONS:-1}" == "1" ]]; then
    "$ROOT_DIR/scripts/apply-private-interop-permissions.sh"
  fi
}

main "$@"
