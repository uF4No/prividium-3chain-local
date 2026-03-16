#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "${REGENERATE_L1_STATE:-0}" == "1" ]]; then
  ./scripts/generate-v31-3chain-l1-state.sh
fi

docker compose up -d
./scripts/smoke-test-3chains.sh

if [[ "${RUN_INTEROP:-0}" == "1" ]]; then
  ./scripts/run-interop-matrix.sh
fi
