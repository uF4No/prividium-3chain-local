# Prividium 3-Chain Local Stack

> [!NOTE]
> This repo uses a custom branch of zksync os server, `sb/interop-type-b-demo`

Standalone local repo to run:

- L1 (Anvil)
- 3 L2 chains (6565/6566/6567)
- Prividium components for A/B/C
- Interop relay across all 3 chains
- SDK + interop matrix test script

This setup keeps the pinned server/protocol compatibility used in this project (no upgrade to latest/main).
It is self-contained; no submodules are required for runtime.

## Repo Contents

- `docker-compose.yml`: Full stack (L1 + 3x L2 + Prividium + relay + setup jobs)
- `chain-configs/`: chain configs + L1 state artifacts
- `local-chains/v31/genesis.json`: genesis input for zksync-os server
- `dev/`: keycloak export, block explorer configs, SQL seeds for l2a/l2b/l2c
- `scripts/generate-v31-3chain-l1-state.sh`: register chain 6567 into L1 state
- `scripts/smoke-test-3chains.sh`: service/RPC/L1-registration checks
- `scripts/run-interop-matrix.sh`: SDK interop test for all ordered pairs
- `sdk/`: SDK + examples (including `examples/remote-call-3chains.ts`)
- `ARTIFACTS_SHA256SUMS`: checksums for compose/genesis/chain config artifacts

## Requirements

- Docker + Docker Compose
- Foundry tools (`anvil`, `cast`)
- `jq`
- Node.js + npm

## Quay Authentication (Required for Prividium Images)

Some Prividium component images are hosted in Quay under Matter Labs private access.
Before running compose, authenticate to `quay.io` with credentials provided by the MatterLabs team.

```bash
DOCKER_USERNAME=matterlabs_enterprise+your_username
DOCKER_PASSWORD=super_secret_provided_by_matterlabs

docker login -u=$DOCKER_USERNAME -p=$DOCKER_PASSWORD quay.io
```

## Quick Start

From this repo root:

```bash
docker compose up -d
```

## Service URLs

| Chain | Chain ID | RPC URL | User Panel URL | Admin Panel URL |
|---|---:|---|---|---|
| Chain 1 (A) | 6565 | `http://localhost:3050` | `http://localhost:3001` | `http://localhost:3000` |
| Chain 2 (B) | 6566 | `http://localhost:3051` | `http://localhost:3301` | `http://localhost:3300` |
| Chain 3 (C) | 6567 | `http://localhost:3052` | `http://localhost:3601` | `http://localhost:3600` |

## Default Users

| Scope | Username | Password |
|---|---|---|
| Keycloak Admin Console (`http://localhost:5080`) | `admin` | `admin` |
| Prividium OIDC User | `admin@local.dev` | `password` |
| Prividium OIDC User | `user1@local.dev` | `password` |
| Prividium OIDC User | `user2@local.dev` | `password` |

## Validate Setup (Smoke Test)

After startup, validate services, RPC, and L1 registration:

```bash
./scripts/smoke-test-3chains.sh
```

## Run Interop Tests

Run the full ordered-pair interop matrix (A->B, A->C, B->A, B->C, C->A, C->B):

```bash
./scripts/run-interop-matrix.sh
```

Expected success line:

- `3-chain demo-sdk interop smoke passed (full ordered-pair matrix).`

## One-Command Bootstrap (Optional)

```bash
./scripts/bootstrap.sh
RUN_INTEROP=1 ./scripts/bootstrap.sh
REGENERATE_L1_STATE=1 RUN_INTEROP=1 ./scripts/bootstrap.sh
```

## Regenerate 3-Chain L1 State (Optional)

If you need to recreate the chain-6567 registration from the v31 base state:

```bash
./scripts/generate-v31-3chain-l1-state.sh
```

Defaults:

- source: `chain-configs/zkos-l1-state-v31-base.json`
- output: `chain-configs/zkos-l1-state-v31-3chains-fixed.json`
- chain3 config: `chain-configs/chain3-fixed.json`

## Notes

- `chain3-fixed.json` uses dedicated operator keys for chain 6567.
  Reusing chain2 keys can cause nonce collisions and unstable behavior.
- Interop relay is configured with all three RPC endpoints.
- Remote-call interop test contracts in `sdk/examples` are aligned with this stack's interop handler expectations.

## Stop / Reset

```bash
docker compose down
```

Full cleanup (including DB volume):

```bash
docker compose down -v
```
