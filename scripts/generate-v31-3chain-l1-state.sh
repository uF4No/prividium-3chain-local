#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SOURCE_STATE="${1:-$ROOT_DIR/chain-configs/zkos-l1-state-v31-base.json}"
OUTPUT_STATE="${2:-$ROOT_DIR/chain-configs/zkos-l1-state-v31-3chains-fixed.json}"
CHAIN3_CONFIG="${3:-$ROOT_DIR/chain-configs/chain3-fixed.json}"

BRIDGEHUB_ADDR="0x78b8b2dbaf2cb50b69a4a0ceee217b926c8520d2"
BRIDGEHUB_OWNER="0x0A01BB0bA326223f7E7381C76F1D615f25e9b8B4"
ANVIL_HOST="127.0.0.1"
ANVIL_PORT="29545"
ANVIL_URL="http://${ANVIL_HOST}:${ANVIL_PORT}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need_cmd anvil
need_cmd cast
need_cmd jq

if [[ ! -f "$SOURCE_STATE" ]]; then
  echo "Source state file not found: $SOURCE_STATE" >&2
  exit 1
fi

if [[ ! -f "$CHAIN3_CONFIG" ]]; then
  echo "Chain3 config file not found: $CHAIN3_CONFIG" >&2
  exit 1
fi

if [[ "$SOURCE_STATE" == "$OUTPUT_STATE" ]]; then
  echo "Source and output state paths must be different." >&2
  exit 1
fi

CHAIN3_COMMIT_PK="$(jq -r '.l1_sender.operator_commit_pk' "$CHAIN3_CONFIG")"
CHAIN3_PROVE_PK="$(jq -r '.l1_sender.operator_prove_pk' "$CHAIN3_CONFIG")"
CHAIN3_EXECUTE_PK="$(jq -r '.l1_sender.operator_execute_pk' "$CHAIN3_CONFIG")"

if [[ "$CHAIN3_COMMIT_PK" == "null" || "$CHAIN3_PROVE_PK" == "null" || "$CHAIN3_EXECUTE_PK" == "null" ]]; then
  echo "Missing l1_sender keys in $CHAIN3_CONFIG" >&2
  exit 1
fi

CHAIN3_COMMIT_ADDR="$(cast wallet address --private-key "$CHAIN3_COMMIT_PK")"
CHAIN3_PROVE_ADDR="$(cast wallet address --private-key "$CHAIN3_PROVE_PK")"
CHAIN3_EXECUTE_ADDR="$(cast wallet address --private-key "$CHAIN3_EXECUTE_PK")"

TMP_DIR="$(mktemp -d)"
cleanup() {
  if [[ -n "${ANVIL_PID:-}" ]]; then
    kill "$ANVIL_PID" >/dev/null 2>&1 || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# Reuse an existing 6566 createNewChain calldata from the source snapshot.
calldata_6566="$TMP_DIR/create_chain_6566.hex"
jq -r '
  first(
    .transactions
    | to_entries[]
    | .value.info.traces[]?.trace
    | select(
        (.address | ascii_downcase) == "0x78b8b2dbaf2cb50b69a4a0ceee217b926c8520d2"
        and (.data | startswith("0xf113c88b00000000000000000000000000000000000000000000000000000000000019a6"))
      )
    | .data
  )
' "$SOURCE_STATE" > "$calldata_6566"

if [[ ! -s "$calldata_6566" ]]; then
  echo "Failed to extract createNewChain calldata for chain 6566 from $SOURCE_STATE" >&2
  exit 1
fi

# Patch first function argument (chain id) from 6566 (0x19a6) to 6567 (0x19a7).
calldata_6567="$TMP_DIR/create_chain_6567.hex"
sed 's/^\(0xf113c88b000000000000000000000000000000000000000000000000000000000000\)19a6/\119a7/' "$calldata_6566" > "$calldata_6567"

mkdir -p "$(dirname "$OUTPUT_STATE")"
rm -f "$OUTPUT_STATE"

anvil \
  --host "$ANVIL_HOST" \
  --port "$ANVIL_PORT" \
  --load-state "$SOURCE_STATE" \
  --dump-state "$OUTPUT_STATE" \
  >/tmp/anvil-generate-v31-3chain.log 2>&1 &
ANVIL_PID=$!

sleep 2

cast rpc --rpc-url "$ANVIL_URL" anvil_setBalance "$BRIDGEHUB_OWNER" 0x3635c9adc5dea00000 >/dev/null
cast rpc --rpc-url "$ANVIL_URL" anvil_impersonateAccount "$BRIDGEHUB_OWNER" >/dev/null

cast send \
  --rpc-url "$ANVIL_URL" \
  --unlocked \
  --from "$BRIDGEHUB_OWNER" \
  "$BRIDGEHUB_ADDR" \
  "$(cat "$calldata_6567")" \
  >/tmp/send-generate-v31-3chain.log

# Validate registration before terminating anvil (dump happens on shutdown).
get_chain_6567="$(cast call --rpc-url "$ANVIL_URL" "$BRIDGEHUB_ADDR" 'getZKChain(uint256)(address)' 6567)"
asset_6567="$(cast call --rpc-url "$ANVIL_URL" "$BRIDGEHUB_ADDR" 'baseTokenAssetId(uint256)(bytes32)' 6567)"
get_chain_6566="$(cast call --rpc-url "$ANVIL_URL" "$BRIDGEHUB_ADDR" 'getZKChain(uint256)(address)' 6566)"

if [[ "$get_chain_6567" == "0x0000000000000000000000000000000000000000" ]]; then
  echo "Chain 6567 registration failed: getZKChain returned zero address." >&2
  exit 1
fi

if [[ "$asset_6567" == "0x0000000000000000000000000000000000000000000000000000000000000000" ]]; then
  echo "Chain 6567 registration failed: baseTokenAssetId returned zero." >&2
  exit 1
fi

ctm_6567="$(cast call --rpc-url "$ANVIL_URL" "$get_chain_6567" 'getChainTypeManager()(address)')"
validator_timelock="$(cast call --rpc-url "$ANVIL_URL" "$ctm_6567" 'validatorTimelockPostV29()(address)')"
chain_admin_6567="$(cast call --rpc-url "$ANVIL_URL" "$get_chain_6567" 'getAdmin()(address)')"

da_pair_6566_json="$(cast call --rpc-url "$ANVIL_URL" --json "$get_chain_6566" 'getDAValidatorPair()(address,uint8)')"
da_validator_6566="$(echo "$da_pair_6566_json" | jq -r '.[0]')"
da_scheme_6566="$(echo "$da_pair_6566_json" | jq -r '.[1]')"
token_multiplier_nom_6566="$(cast call --rpc-url "$ANVIL_URL" "$get_chain_6566" 'baseTokenGasPriceMultiplierNominator()(uint128)')"
token_multiplier_den_6566="$(cast call --rpc-url "$ANVIL_URL" "$get_chain_6566" 'baseTokenGasPriceMultiplierDenominator()(uint128)')"

committer_role="$(cast call --rpc-url "$ANVIL_URL" "$validator_timelock" 'COMMITTER_ROLE()(bytes32)')"
precommitter_role="$(cast call --rpc-url "$ANVIL_URL" "$validator_timelock" 'PRECOMMITTER_ROLE()(bytes32)')"
reverter_role="$(cast call --rpc-url "$ANVIL_URL" "$validator_timelock" 'REVERTER_ROLE()(bytes32)')"
prover_role="$(cast call --rpc-url "$ANVIL_URL" "$validator_timelock" 'PROVER_ROLE()(bytes32)')"
executor_role="$(cast call --rpc-url "$ANVIL_URL" "$validator_timelock" 'EXECUTOR_ROLE()(bytes32)')"

precommitter_count_6566="$(cast call --rpc-url "$ANVIL_URL" "$validator_timelock" 'getRoleMemberCount(address,bytes32)(uint256)' "$get_chain_6566" "$precommitter_role")"
if [[ "$precommitter_count_6566" != "0" ]]; then
  shared_operator_addr="$(cast call --rpc-url "$ANVIL_URL" "$validator_timelock" 'getRoleMember(address,bytes32,uint256)(address)' "$get_chain_6566" "$precommitter_role" 0)"
else
  shared_operator_addr="0x0000000000000000000000000000000000000000"
fi

for addr in "$chain_admin_6567" "$CHAIN3_COMMIT_ADDR" "$CHAIN3_PROVE_ADDR" "$CHAIN3_EXECUTE_ADDR"; do
  cast rpc --rpc-url "$ANVIL_URL" anvil_setBalance "$addr" 0x3635c9adc5dea00000 >/dev/null
done

if [[ "$shared_operator_addr" != "0x0000000000000000000000000000000000000000" ]]; then
  cast rpc --rpc-url "$ANVIL_URL" anvil_setBalance "$shared_operator_addr" 0x3635c9adc5dea00000 >/dev/null
fi

cast rpc --rpc-url "$ANVIL_URL" anvil_impersonateAccount "$chain_admin_6567" >/dev/null

cast send \
  --rpc-url "$ANVIL_URL" \
  --unlocked \
  --from "$chain_admin_6567" \
  "$get_chain_6567" \
  'setDAValidatorPair(address,uint8)' \
  "$da_validator_6566" \
  "$da_scheme_6566" \
  >/dev/null

cast send \
  --rpc-url "$ANVIL_URL" \
  --unlocked \
  --from "$chain_admin_6567" \
  "$get_chain_6567" \
  'setTokenMultiplier(uint128,uint128)' \
  "$token_multiplier_nom_6566" \
  "$token_multiplier_den_6566" \
  >/dev/null

cast send \
  --rpc-url "$ANVIL_URL" \
  --unlocked \
  --from "$chain_admin_6567" \
  "$get_chain_6567" \
  'unpauseDeposits()' \
  >/dev/null

grant_role() {
  local role="$1"
  local addr="$2"
  cast send \
    --rpc-url "$ANVIL_URL" \
    --unlocked \
    --from "$chain_admin_6567" \
    "$validator_timelock" \
    'grantRole(address,bytes32,address)' \
    "$get_chain_6567" \
    "$role" \
    "$addr" \
    >/dev/null
}

if [[ "$shared_operator_addr" != "0x0000000000000000000000000000000000000000" ]]; then
  grant_role "$precommitter_role" "$shared_operator_addr"
  grant_role "$reverter_role" "$shared_operator_addr"
  grant_role "$prover_role" "$shared_operator_addr"
  grant_role "$executor_role" "$shared_operator_addr"
fi

grant_role "$committer_role" "$CHAIN3_COMMIT_ADDR"
grant_role "$prover_role" "$CHAIN3_PROVE_ADDR"
grant_role "$executor_role" "$CHAIN3_EXECUTE_ADDR"

has_commit="$(cast call --rpc-url "$ANVIL_URL" "$validator_timelock" 'hasRoleForChainId(uint256,bytes32,address)(bool)' 6567 "$committer_role" "$CHAIN3_COMMIT_ADDR")"
has_prove="$(cast call --rpc-url "$ANVIL_URL" "$validator_timelock" 'hasRoleForChainId(uint256,bytes32,address)(bool)' 6567 "$prover_role" "$CHAIN3_PROVE_ADDR")"
has_execute="$(cast call --rpc-url "$ANVIL_URL" "$validator_timelock" 'hasRoleForChainId(uint256,bytes32,address)(bool)' 6567 "$executor_role" "$CHAIN3_EXECUTE_ADDR")"

if [[ "$has_commit" != "true" || "$has_prove" != "true" || "$has_execute" != "true" ]]; then
  echo "Chain 6567 role assignment failed." >&2
  echo "commit=$has_commit prove=$has_prove execute=$has_execute" >&2
  exit 1
fi

da_pair_6567_json="$(cast call --rpc-url "$ANVIL_URL" --json "$get_chain_6567" 'getDAValidatorPair()(address,uint8)')"
da_validator_6567="$(echo "$da_pair_6567_json" | jq -r '.[0]')"
token_multiplier_nom_6567="$(cast call --rpc-url "$ANVIL_URL" "$get_chain_6567" 'baseTokenGasPriceMultiplierNominator()(uint128)')"
token_multiplier_den_6567="$(cast call --rpc-url "$ANVIL_URL" "$get_chain_6567" 'baseTokenGasPriceMultiplierDenominator()(uint128)')"
deposits_paused_6567="$(cast call --rpc-url "$ANVIL_URL" "$get_chain_6567" 'depositsPaused()(bool)')"
if [[ "$da_validator_6567" == "0x0000000000000000000000000000000000000000" ]]; then
  echo "Chain 6567 DA validator pair is not configured." >&2
  exit 1
fi

if [[ "$token_multiplier_den_6567" == "0" ]]; then
  echo "Chain 6567 base token gas price multiplier denominator is not configured." >&2
  exit 1
fi

if [[ "$deposits_paused_6567" != "false" ]]; then
  echo "Chain 6567 deposits remain paused." >&2
  exit 1
fi

kill "$ANVIL_PID" >/dev/null 2>&1 || true
wait "$ANVIL_PID" 2>/dev/null || true
unset ANVIL_PID

echo "Generated: $OUTPUT_STATE"
echo "getZKChain(6567)      = $get_chain_6567"
echo "baseTokenAssetId(6567)= $asset_6567"
echo "validatorTimelock     = $validator_timelock"
echo "chain6567 admin       = $chain_admin_6567"
echo "chain6567 daValidator = $da_validator_6567"
echo "chain6567 token mul   = $token_multiplier_nom_6567/$token_multiplier_den_6567"
echo "chain6567 deposits    = $deposits_paused_6567"
echo "chain3 commit sender  = $CHAIN3_COMMIT_ADDR"
echo "chain3 prove sender   = $CHAIN3_PROVE_ADDR"
echo "chain3 execute sender = $CHAIN3_EXECUTE_ADDR"
