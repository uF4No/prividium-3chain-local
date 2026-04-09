# Prividium 3-Chain Local Stack

> [!NOTE]
> This repo uses a custom branch of zksync os server, `sb/interop-type-b-demo`

Standalone local repo to run:

- L1 (Anvil)
- 3 L2 chains (6565/6566/6567)
- Prividium components for A/B/C
- Public interop relay across all 3 chains
- Optional private interop overlay for all 3 chains
- SDK + interop matrix test scripts

This setup keeps the pinned server/protocol compatibility used in this project (no upgrade to latest/main).
It is self-contained; no submodules are required for runtime.

## Repo Contents

- `docker-compose-deps.yml`: shared infra and bootstrap prerequisites (L1, 3x L2, DB/auth, shared setup jobs, bundlers)
- `docker-compose.yml`: public Prividium and public interop layer on top of `docker-compose-deps.yml`
- `docker-compose-private-interop.yml`: overlay that adds private interop setup, permissions, and executor services
- `chain-configs/`: chain configs + L1 state artifacts
- `local-chains/v31/genesis.json`: genesis input for zksync-os server
- `.runtime/`: generated local runtime metadata (AA support-contract addresses, private-interop manifest, generated permission SQL, deploy logs)
- `dev/`: keycloak export, block explorer configs, SQL seeds for l2a/l2b/l2c
- `scripts/generate-v31-3chain-l1-state.sh`: register chain 6567 into L1 state
- `scripts/smoke-test-3chains.sh`: service/RPC/L1-registration checks
- `setup-private-interop-local`: post-start private interop bootstrap
- `run-private-interop-executor`: private bundle execution helper
- `run-private-interop-smoke`: private deployment/permissions/smoke validation
- `scripts/run-interop-matrix.sh`: public interop test for all ordered pairs
- `sdk/`: SDK + repo-local examples (including `examples/remote-call-3chains.ts`, `examples/message-verify.ts`, and `examples/bundle-transfer.ts`)
- `docs/private-interop-overview.md`: private interop architecture overview
- `docs/public-interop-developer-guide.md`: app/script developer guide for public interop
- `docs/private-interop-developer-guide.md`: app/script developer guide for private interop
- `docs/private-interop-permissions.md`: permission seeding and validation details
- `docs/private-interop-operations.md`: operational workflows for public and private interop

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

### Public Interop Only

From this repo root:

```bash
docker compose -f docker-compose-deps.yml -f docker-compose.yml up -d
```

### Public + Private Interop

Bring up the public base stack plus the private interop overlay:

```bash
docker compose -f docker-compose-deps.yml -f docker-compose.yml -f docker-compose-private-interop.yml up -d
```

## Interop Modes

This repo now exposes two interop paths:

- Public interop: the existing system-contract path, relayed by `interop-relay` / `cast-interop`.
- Private interop: a parallel user-space contract stack deployed on each local L2 after startup that sends only bundle hash + call count through the shared interop message path.

Public-only workflow:

```bash
docker compose -f docker-compose-deps.yml -f docker-compose.yml up -d
```

Public + private workflow:

```bash
docker compose -f docker-compose-deps.yml -f docker-compose.yml -f docker-compose-private-interop.yml up -d
```

Useful commands:

```bash
./setup-private-interop-local
./run-private-interop-executor --watch
./run-private-interop-smoke
```

Use the manual commands above if you started only the public stack and want to bootstrap private interop without the overlay.


## Validate Setup (Infrastructure Smoke)

After startup, validate services, RPC, relay presence, and L1 registration:

```bash
./scripts/smoke-test-3chains.sh
```

This is a stack health check only. It does not execute a cross-chain interop call.

## Run Public Interop Tests

If you started the public-only stack with:

```bash
docker compose -f docker-compose-deps.yml -f docker-compose.yml up -d
```

run the full ordered-pair public interop matrix (A->B, A->C, B->A, B->C, C->A, C->B):

```bash
./scripts/run-interop-matrix.sh
```

This script runs `sdk/examples/remote-call-3chains.ts`, which deploys a test greeting contract on each chain and verifies cross-chain execution across all ordered pairs.

Expected success line:

- `3-chain demo-sdk interop smoke passed (full ordered-pair matrix).`

Additional repo-local SDK examples:

- `sdk/examples/message-verify.ts`: send a message from one chain and verify inclusion on another
- `sdk/examples/bundle-transfer.ts`: send a token-transfer bundle from one chain to another

From `sdk/`:

```bash
PRIVATE_KEY=0x... L2_RPC_URL=http://127.0.0.1:3050 L2_RPC_URL_SECOND=http://127.0.0.1:3051 npx ts-node examples/message-verify.ts
PRIVATE_KEY=0x... L2_RPC_URL=http://127.0.0.1:3050 L2_RPC_URL_SECOND=http://127.0.0.1:3051 npx ts-node examples/bundle-transfer.ts
```

## Run Private Interop Tests

If you started the public-only compose file, bootstrap the private contract stack manually:

```bash
./setup-private-interop-local
```

This command:

- installs and uses the local `private-interop/` workspace,
- builds local private-interop foundry artifacts if needed,
- deploys the private interop contracts on chains `6565`, `6566`, and `6567`,
- writes `.runtime/private-interop.json`,
- generates dynamic permission SQL,
- applies those permissions to the local Prividium databases by default.

## Runtime Artifacts

The `.runtime/` directory is generated by local bootstrap/setup steps and is not source-of-truth chain state.

It is used for repo-local runtime metadata such as:

- `aa-contracts.json`: deployed AA support-contract addresses used by the local bundlers
- `private-interop.json`: deployed private-interop addresses for chains `6565`, `6566`, and `6567`
- `private-permissions-l2*.sql`: generated permission SQL derived from the private-interop manifest
- `aa-contracts-deploy.log`: local deploy log output

The actual pinned L1 snapshot and L2 genesis inputs live under `chain-configs/` and `local-chains/`, not `.runtime/`.

Run the private executor in watch mode:

```bash
./run-private-interop-executor --watch
```

If you started with `docker-compose-deps.yml`, `docker-compose.yml`, and `docker-compose-private-interop.yml`, the executor already runs as the `private-interop-executor` service.

Run the private validation suite:

```bash
./run-private-interop-smoke
```

The private smoke covers:

- contract deployment verification,
- remote-router registration checks,
- private permission validation,
- a private token transfer smoke,
- a private message smoke across all ordered pairs.

By default, `./run-private-interop-smoke` also reruns `./scripts/run-interop-matrix.sh` at the end as a public-regression check. If you want to skip that public rerun:

```bash
SKIP_PUBLIC_REGRESSION=1 ./run-private-interop-smoke
```

## Developer Guides

If you are building an app, script, or agent against this local stack, start with:

- [Public Interop Developer Guide](docs/public-interop-developer-guide.md)
- [Private Interop Developer Guide](docs/private-interop-developer-guide.md)

Use the public guide for the `sdk/` and system-contract flow.
Use the private guide for the manifest-driven `private-interop/` flow and executor model.

## Service URLs

| Chain | Chain ID | RPC URL | User Panel URL | Admin Panel URL | Block Explorer URL |
|---|---:|---|---|---|---|
| Chain 1 (A) | 6565 | `http://localhost:3050` | `http://localhost:3001` | `http://localhost:3000` | `http://localhost:3010` |
| Chain 2 (B) | 6566 | `http://localhost:3051` | `http://localhost:3301` | `http://localhost:3300` | `http://localhost:3310` |
| Chain 3 (C) | 6567 | `http://localhost:3052` | `http://localhost:3601` | `http://localhost:3600` | `http://localhost:3610` |

## Default Users

| Scope | Username | Password |
|---|---|---|
| Keycloak Admin Console (`http://localhost:5080`) | `admin` | `admin` |
| Prividium OIDC User | `admin@local.dev` | `password` |
| Prividium OIDC User | `user@local.dev` | `password` |
| Prividium OIDC User | `user2@local.dev` | `password` |

## One-Command Bootstrap (Optional)

```bash
./scripts/bootstrap.sh
RUN_PRIVATE_INTEROP=1 ./scripts/bootstrap.sh
RUN_PRIVATE_INTEROP=1 RUN_PRIVATE_SMOKE=1 ./scripts/bootstrap.sh
REGENERATE_L1_STATE=1 RUN_PRIVATE_INTEROP=1 RUN_INTEROP=1 ./scripts/bootstrap.sh
```

## Regenerate 3-Chain L1 State (Optional)

If you need to recreate the chain-6567 registration from the v31 base state:

```bash
./scripts/generate-v31-3chain-l1-state.sh
```

Defaults:

- source: `chain-configs/zkos-l1-state-v31-base.json`
- output: `chain-configs/zkos-l1-state-v31-3chains-fixed.json`
- chain3 config: `chain-configs/chain3.json`

## Notes

- Public interop relay is configured with all three RPC endpoints.
- Private interop is deployed separately and does not use `cast-interop`.
- The private compose overlay also runs a dedicated `private-interop-executor` watcher service.
- Remote-call interop test contracts in `sdk/examples` are aligned with the public interop handler expectations.
- Invoice smoke helpers are intentionally not documented here because the current local copies depend on contract config outside this repo.
- `demo-app` is no longer part of this compose stack.

## More Detail

- [Private Interop Overview](docs/private-interop-overview.md)
- [Public Interop Developer Guide](docs/public-interop-developer-guide.md)
- [Private Interop Developer Guide](docs/private-interop-developer-guide.md)
- [Private Interop Privacy Model](docs/private-interop-privacy.md)
- [Private Interop Permissions](docs/private-interop-permissions.md)
- [Private Interop Operations](docs/private-interop-operations.md)

## Stop / Reset

```bash
docker compose -f docker-compose-deps.yml -f docker-compose.yml down
docker compose -f docker-compose-deps.yml -f docker-compose.yml -f docker-compose-private-interop.yml down
```

Full cleanup (including DB volume):

```bash
docker compose -f docker-compose-deps.yml -f docker-compose.yml down -v
docker compose -f docker-compose-deps.yml -f docker-compose.yml -f docker-compose-private-interop.yml down -v
```
