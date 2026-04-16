# Private Interop Operations

## Commands

### Compose modes

Public-only stack:

```bash
docker compose -f docker-compose-deps.yml -f docker-compose.yml up -d
```

Public + private stack:

```bash
docker compose -f docker-compose-deps.yml -f docker-compose.yml -f docker-compose-private-interop.yml up -d
```

Bootstrap private interop:

```bash
./setup-private-interop-local
```

Run the private executor once:

```bash
./run-private-interop-executor --tx-hash <SOURCE_TX_HASH> --from-chain 6565
```

Run the private executor in watch mode:

```bash
./run-private-interop-executor --watch
```

Run private validation:

```bash
./run-private-interop-smoke
```

## Public Vs Private Transaction Paths

### Public interop

Use:

- `scripts/run-interop-matrix.sh`
- repo-local `sdk/` examples
- `interop-relay` / `cast-interop`

Flow:

1. Send through the public system `InteropCenter`.
2. Wait for the public path to relay/finalize.
3. Execute through the public handler path.

### Private interop

Use:

- `setup-private-interop-local`
- `run-private-interop-executor`
- `run-private-interop-smoke`

Flow:

1. Send through the private `PrivateInteropCenter`.
2. Extract the emitted bundle from the source-chain receipt.
3. Execute it on the destination `PrivateInteropHandler`.

The private flow is intentionally separate from `cast-interop`.

## How To Send A Public Interop Tx

For the existing public path:

```bash
./scripts/run-interop-matrix.sh
```

Or run one of the repo-local SDK examples from `sdk/`.

## How To Send A Private Interop Tx

### End-to-end smoke

The easiest path is:

```bash
./setup-private-interop-local
./run-private-interop-smoke
```

### Manual execution

1. Send a private-interop transaction on the source chain using the private contract addresses from `.runtime/private-interop.json`.
2. Capture the source transaction hash.
3. Execute the destination side:

```bash
./run-private-interop-executor --tx-hash <SOURCE_TX_HASH> --from-chain 6565
```

Or leave the executor watching:

```bash
./run-private-interop-executor --watch
```

## Compose Behavior

The shared deps file, [docker-compose-deps.yml](../docker-compose-deps.yml), carries the common infra and bootstrap prerequisites.

The public layer, [docker-compose.yml](../docker-compose.yml), adds the public app stack and public relay.

The private overlay, [docker-compose-private-interop.yml](../docker-compose-private-interop.yml), adds:

- `private-interop-setup`
- `private-interop-permissions`
- `private-interop-executor`

`private-interop-setup` and `private-interop-permissions` are one-shot services.

`private-interop-executor` is a long-running watcher that runs:

```bash
./run-private-interop-executor --watch
```

Public services remain in place, including:

- `interop-relay`

This keeps the shared infra split from the public app layer while making the combined public+private mode explicit.

## Debugging

Useful checks:

- confirm the manifest exists:

```bash
cat .runtime/private-interop.json
```

- confirm permissions were generated:

```bash
ls .runtime/private-permissions-l2*.sql
```

- confirm private permissions were applied:

```bash
./scripts/validate-private-interop-permissions.sh
```

- rerun the public regression:

```bash
./scripts/run-interop-matrix.sh
```

## Failure Modes

Common issues:

- missing `private-interop/out/` artifacts:
  `setup-private-interop-local` handles this by running `forge build`.
- missing local npm dependencies for the vendored `private-interop/` workspace:
  the wrappers install them on first use.
- stale manifest pointing to old deployments:
  rerun `./setup-private-interop-local`, or set `PRIVATE_INTEROP_FORCE_REDEPLOY=1`.
- permissions not yet applied:
  rerun `./scripts/apply-private-interop-permissions.sh`.
