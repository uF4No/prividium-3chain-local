#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRIVATE_INTEROP_DIR="$ROOT_DIR/private-interop"

if [[ ! -d "$PRIVATE_INTEROP_DIR/node_modules" ]]; then
  echo "Installing private interop npm dependencies..."
  (cd "$PRIVATE_INTEROP_DIR" && npm install --no-package-lock)
fi

cd "$PRIVATE_INTEROP_DIR"
npx ts-node private-interop-executor.ts "$@"
