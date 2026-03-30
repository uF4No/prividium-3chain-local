#!/usr/bin/env bash
set -euo pipefail

KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:5080}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:-prividium}"
KEYCLOAK_CLIENT_ID="${KEYCLOAK_CLIENT_ID:-prividium-client}"
KEYCLOAK_TEST_PASSWORD="${KEYCLOAK_TEST_PASSWORD:-password}"

required_users=(
  "admin@local.dev"
  "user@local.dev"
)

for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: $cmd is required"
    exit 1
  fi
done

failures=0
for required_user in "${required_users[@]}"; do
  response_file="$(mktemp)"
  http_code="$(
    curl -sS -o "$response_file" -w '%{http_code}' -X POST \
      -H "Content-Type: application/x-www-form-urlencoded" \
      --data-urlencode "client_id=$KEYCLOAK_CLIENT_ID" \
      --data-urlencode "username=$required_user" \
      --data-urlencode "password=$KEYCLOAK_TEST_PASSWORD" \
      --data-urlencode "grant_type=password" \
      "$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token"
  )"

  if [[ "$http_code" == "200" ]] && [[ "$(jq -r '.access_token // empty' "$response_file")" != "" ]]; then
    echo "[PASS] Keycloak seeded user can authenticate: $required_user"
  else
    err="$(jq -r '.error_description // .error // "unknown error"' "$response_file" 2>/dev/null || echo "unknown error")"
    echo "[FAIL] Keycloak seeded user missing or invalid credentials: $required_user ($err)"
    failures=$((failures + 1))
  fi

  rm -f "$response_file"
done

if [[ "$failures" -gt 0 ]]; then
  echo "Keycloak seed verification failed with $failures missing user(s)."
  exit 1
fi

echo "Keycloak seed verification passed."
