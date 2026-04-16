#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DEFAULT_COMPOSE_FILES="$ROOT_DIR/docker-compose-deps.yml:$ROOT_DIR/docker-compose.yml"
COMPOSE_FILES="${COMPOSE_FILES:-${COMPOSE_FILE:-$DEFAULT_COMPOSE_FILES}}"

compose() {
  local IFS=':'
  local -a files=()
  local -a args=()
  read -r -a files <<< "$COMPOSE_FILES"
  for file in "${files[@]}"; do
    [[ -n "$file" ]] && args+=(-f "$file")
  done
  docker compose "${args[@]}" "$@"
}

if [[ "${REGENERATE_L1_STATE:-0}" == "1" ]]; then
  ./scripts/generate-v31-3chain-l1-state.sh
fi

compose up -d
./scripts/smoke-test-3chains.sh

if [[ "${RUN_PRIVATE_INTEROP:-0}" == "1" ]]; then
  ./setup-private-interop-local
fi

if [[ "${RUN_INTEROP:-0}" == "1" ]]; then
  ./scripts/run-interop-matrix.sh
fi

if [[ "${RUN_PRIVATE_SMOKE:-0}" == "1" ]]; then
  ./run-private-interop-smoke
fi
