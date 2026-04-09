#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SQL_DIR="${PRIVATE_INTEROP_PERMISSIONS_OUTPUT_DIR:-$ROOT_DIR/.runtime}"
DEFAULT_COMPOSE_FILES="$ROOT_DIR/docker-compose-deps.yml:$ROOT_DIR/docker-compose.yml"
COMPOSE_FILES="${COMPOSE_FILES:-${COMPOSE_FILE:-$DEFAULT_COMPOSE_FILES}}"
if [[ -n "${PRIVATE_INTEROP_PGHOST:-}" ]]; then
  PGHOST_DEFAULT="$PRIVATE_INTEROP_PGHOST"
elif [[ -f "/.dockerenv" ]]; then
  PGHOST_DEFAULT="postgres"
else
  PGHOST_DEFAULT="127.0.0.1"
fi
PGUSER_DEFAULT="${PRIVATE_INTEROP_PGUSER:-postgres}"
PGPASSWORD_DEFAULT="${PRIVATE_INTEROP_PGPASSWORD:-postgres}"

compose() {
  local IFS=':'
  local -a files=()
  local -a args=()
  read -r -a files <<< "$COMPOSE_FILES"
  for file in "${files[@]}"; do
    [[ -n "$file" ]] && args+=(-f "$file")
  done
  (
    cd "$ROOT_DIR"
    docker compose "${args[@]}" "$@"
  )
}

run_psql_cmd() {
  local db="$1"
  shift
  if command -v psql >/dev/null 2>&1; then
    PGPASSWORD="$PGPASSWORD_DEFAULT" psql -h "$PGHOST_DEFAULT" -U "$PGUSER_DEFAULT" -d "$db" "$@"
    return
  fi
  compose exec -T postgres psql -U "$PGUSER_DEFAULT" -d "$db" "$@"
}

wait_for_tables() {
  local db="$1"
  until run_psql_cmd "$db" -c "SELECT 1 FROM users LIMIT 1" >/dev/null 2>&1; do
    echo "Waiting for $db tables..."
    sleep 3
  done
}

apply_sql() {
  local db="$1"
  local file="$2"
  if [[ ! -f "$file" ]]; then
    echo "Missing SQL file: $file" >&2
    exit 1
  fi
  wait_for_tables "$db"
  echo "Applying $(basename "$file") to $db..."
  if command -v psql >/dev/null 2>&1; then
    PGPASSWORD="$PGPASSWORD_DEFAULT" psql -h "$PGHOST_DEFAULT" -U "$PGUSER_DEFAULT" -d "$db" < "$file"
  else
    compose exec -T postgres psql -U "$PGUSER_DEFAULT" -d "$db" < "$file"
  fi
}

apply_sql "permissions_api_l2a" "$SQL_DIR/private-permissions-l2a.sql"
apply_sql "permissions_api_l2b" "$SQL_DIR/private-permissions-l2b.sql"
apply_sql "permissions_api_l2c" "$SQL_DIR/private-permissions-l2c.sql"
