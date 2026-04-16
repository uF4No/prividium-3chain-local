#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST_PATH="${PRIVATE_INTEROP_MANIFEST_PATH:-$ROOT_DIR/.runtime/private-interop.json}"
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

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

query_db() {
  local db="$1"
  local sql="$2"
  if command -v psql >/dev/null 2>&1; then
    PGPASSWORD="$PGPASSWORD_DEFAULT" psql -h "$PGHOST_DEFAULT" -U "$PGUSER_DEFAULT" -d "$db" -tA -c "$sql"
    return
  fi
  compose exec -T postgres psql -U "$PGUSER_DEFAULT" -d "$db" -tA -c "$sql"
}

validate_chain() {
  local suffix="$1"
  local chain_id="$2"
  local db="permissions_api_${suffix}"
  local interop_center ntv interop_handler asset_router asset_tracker

  interop_center="$(jq -r ".chains[\"$chain_id\"].interopCenter" "$MANIFEST_PATH")"
  ntv="$(jq -r ".chains[\"$chain_id\"].ntv" "$MANIFEST_PATH")"
  interop_handler="$(jq -r ".chains[\"$chain_id\"].interopHandler" "$MANIFEST_PATH")"
  asset_router="$(jq -r ".chains[\"$chain_id\"].assetRouter" "$MANIFEST_PATH")"
  asset_tracker="$(jq -r ".chains[\"$chain_id\"].assetTracker" "$MANIFEST_PATH")"

  for address in "$interop_center" "$ntv" "$interop_handler" "$asset_router" "$asset_tracker"; do
    local count
    count="$(query_db "$db" "SELECT COUNT(*) FROM contracts WHERE contract_address = decode('${address#0x}', 'hex');")"
    [[ "$count" -ge 1 ]] || {
      echo "Missing private contract registration for $address in $db" >&2
      exit 1
    }
  done

  local ic_perms ntv_perms ih_perms admin_roles user1_admin user2_admin
  ic_perms="$(query_db "$db" "SELECT COUNT(*) FROM contract_function_permissions WHERE contract_address = decode('${interop_center#0x}', 'hex');")"
  ntv_perms="$(query_db "$db" "SELECT COUNT(*) FROM contract_function_permissions WHERE contract_address = decode('${ntv#0x}', 'hex');")"
  ih_perms="$(query_db "$db" "SELECT COUNT(*) FROM contract_function_permissions WHERE contract_address = decode('${interop_handler#0x}', 'hex');")"
  [[ "$ic_perms" -ge 1 && "$ntv_perms" -ge 3 && "$ih_perms" -ge 2 ]] || {
    echo "Private permission rows incomplete in $db" >&2
    exit 1
  }

  admin_roles="$(query_db "$db" "SELECT COUNT(*) FROM user_roles WHERE role_name = 'admin';")"
  user1_admin="$(query_db "$db" "SELECT COUNT(*) FROM user_roles WHERE role_name = 'admin' AND user_id = 'u1Xe7K-cDnUzqyJ559R7B';")"
  user2_admin="$(query_db "$db" "SELECT COUNT(*) FROM user_roles WHERE role_name = 'admin' AND user_id = 'u2Yf8L-dEoVarxK660S8C';")"
  [[ "$admin_roles" -eq 1 && "$user1_admin" -eq 0 && "$user2_admin" -eq 0 ]] || {
    echo "Unexpected admin role assignments in $db" >&2
    exit 1
  }
}

need_cmd jq

validate_chain "l2a" "6565"
validate_chain "l2b" "6566"
validate_chain "l2c" "6567"
echo "Private interop permission validation passed."
