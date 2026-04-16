#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_COMPOSE_FILES="$ROOT_DIR/docker-compose-deps.yml:$ROOT_DIR/docker-compose.yml"
COMPOSE_FILES="${COMPOSE_FILES:-${COMPOSE_FILE:-$DEFAULT_COMPOSE_FILES}}"
CHAIN3_CONFIG="${CHAIN3_CONFIG:-$ROOT_DIR/chain-configs/chain3.json}"

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

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is required"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: docker daemon is not available"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required"
  exit 1
fi

if [[ ! -f "$CHAIN3_CONFIG" ]]; then
  echo "ERROR: chain3 config not found: $CHAIN3_CONFIG"
  exit 1
fi

failures=0

pass() { echo "[PASS] $*"; }
fail() {
  echo "[FAIL] $*"
  failures=$((failures + 1))
}

check_service_running() {
  local service="$1"
  if compose ps --status running --services | grep -qx "$service"; then
    pass "service '$service' is running"
  else
    fail "service '$service' is not running"
  fi
}

check_rpc_chain() {
  local label="$1"
  local url="$2"
  local expected_chain_id="$3"

  local chain_id=""
  local tries=10
  while (( tries > 0 )); do
    if chain_id="$(docker exec zkos-anvil sh -lc "cast chain-id -r $url" 2>/dev/null | tr -d '\r')"; then
      break
    fi
    tries=$((tries - 1))
    sleep 2
  done
  if [[ -z "$chain_id" ]]; then
    fail "$label: eth_chainId request failed"
    return
  fi

  if [[ "$chain_id" == "$expected_chain_id" ]]; then
    pass "$label: chain id is $chain_id"
  else
    fail "$label: chain id mismatch (got $chain_id, expected $expected_chain_id)"
  fi

  local block_number
  if block_number="$(docker exec zkos-anvil sh -lc "cast block-number -r $url" 2>/dev/null | tr -d '\r')"; then
    pass "$label: block number is $block_number"
  else
    fail "$label: eth_blockNumber request failed"
  fi
}

echo "== Service checks =="
for svc in anvil chain1 chain2 chain3 interop-relay permissions-api-l2a permissions-api-l2b permissions-api-l2c; do
  check_service_running "$svc"
done

echo
echo "== RPC checks =="
check_rpc_chain "anvil" "http://localhost:8545" "31337"
check_rpc_chain "chain1" "http://zkos-chain1:3050" "6565"
check_rpc_chain "chain2" "http://zkos-chain2:3051" "6566"
check_rpc_chain "chain3" "http://zkos-chain3:3052" "6567"

echo
echo "== L1 registration + roles checks =="

bridgehub="0x78b8b2dbaf2cb50b69a4a0ceee217b926c8520d2"
chain3_addr="$(docker exec zkos-anvil sh -lc "cast call --rpc-url http://localhost:8545 $bridgehub 'getZKChain(uint256)(address)' 6567" | tr -d '\r')"
if [[ "$chain3_addr" == "0x0000000000000000000000000000000000000000" ]]; then
  fail "bridgehub.getZKChain(6567) returned zero address"
else
  pass "bridgehub.getZKChain(6567) = $chain3_addr"
fi

ctm_addr="$(docker exec zkos-anvil sh -lc "cast call --rpc-url http://localhost:8545 $chain3_addr 'getChainTypeManager()(address)'" | tr -d '\r')"
timelock_addr="$(docker exec zkos-anvil sh -lc "cast call --rpc-url http://localhost:8545 $ctm_addr 'validatorTimelockPostV29()(address)'" | tr -d '\r')"

commit_role="$(docker exec zkos-anvil sh -lc "cast call --rpc-url http://localhost:8545 $timelock_addr 'COMMITTER_ROLE()(bytes32)'" | tr -d '\r')"
prove_role="$(docker exec zkos-anvil sh -lc "cast call --rpc-url http://localhost:8545 $timelock_addr 'PROVER_ROLE()(bytes32)'" | tr -d '\r')"
exec_role="$(docker exec zkos-anvil sh -lc "cast call --rpc-url http://localhost:8545 $timelock_addr 'EXECUTOR_ROLE()(bytes32)'" | tr -d '\r')"

commit_pk="$(jq -r '.l1_sender.operator_commit_pk' "$CHAIN3_CONFIG")"
prove_pk="$(jq -r '.l1_sender.operator_prove_pk' "$CHAIN3_CONFIG")"
exec_pk="$(jq -r '.l1_sender.operator_execute_pk' "$CHAIN3_CONFIG")"

commit_addr="$(docker exec zkos-anvil sh -lc "cast wallet address --private-key $commit_pk" | tr -d '\r')"
prove_addr="$(docker exec zkos-anvil sh -lc "cast wallet address --private-key $prove_pk" | tr -d '\r')"
exec_addr="$(docker exec zkos-anvil sh -lc "cast wallet address --private-key $exec_pk" | tr -d '\r')"

has_commit="$(docker exec zkos-anvil sh -lc "cast call --rpc-url http://localhost:8545 $timelock_addr 'hasRoleForChainId(uint256,bytes32,address)(bool)' 6567 $commit_role $commit_addr" | tr -d '\r')"
has_prove="$(docker exec zkos-anvil sh -lc "cast call --rpc-url http://localhost:8545 $timelock_addr 'hasRoleForChainId(uint256,bytes32,address)(bool)' 6567 $prove_role $prove_addr" | tr -d '\r')"
has_exec="$(docker exec zkos-anvil sh -lc "cast call --rpc-url http://localhost:8545 $timelock_addr 'hasRoleForChainId(uint256,bytes32,address)(bool)' 6567 $exec_role $exec_addr" | tr -d '\r')"

[[ "$has_commit" == "true" ]] && pass "chain3 commit sender has COMMITTER_ROLE" || fail "chain3 commit sender missing COMMITTER_ROLE"
[[ "$has_prove" == "true" ]] && pass "chain3 prove sender has PROVER_ROLE" || fail "chain3 prove sender missing PROVER_ROLE"
[[ "$has_exec" == "true" ]] && pass "chain3 execute sender has EXECUTOR_ROLE" || fail "chain3 execute sender missing EXECUTOR_ROLE"

echo
echo "== Regression checks =="
if docker logs --tail 300 zkos-chain2 2>&1 | grep -qi "nonce too low"; then
  fail "chain2 logs contain 'nonce too low'"
else
  pass "chain2 logs do not contain 'nonce too low'"
fi

if docker logs --tail 300 zkos-chain3 2>&1 | grep -qi "RoleAccessDenied"; then
  fail "chain3 logs contain 'RoleAccessDenied'"
else
  pass "chain3 logs do not contain 'RoleAccessDenied'"
fi

if docker logs --tail 300 zkos-chain3 2>&1 | grep -qi "commit component failed"; then
  fail "chain3 logs contain 'commit component failed'"
else
  pass "chain3 logs do not contain 'commit component failed'"
fi

if [[ "$failures" -gt 0 ]]; then
  echo
  echo "Smoke test completed with $failures failure(s)."
  exit 1
fi

echo
echo "Smoke test completed successfully."
