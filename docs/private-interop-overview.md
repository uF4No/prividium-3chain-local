# Private Interop Overview

## Purpose

This repo now carries two interop paths:

- Public interop: the existing system-contract path already present in the local chain genesis and exercised by `scripts/run-interop-matrix.sh`.
- Private interop: a second path deployed after startup as user-space contracts on each local L2.

Private interop exists so the local Prividium stack can exercise the private flow without replacing or mutating the public path.

## Contract Stack

Each local L2 receives the following contracts:

- `PrivateL2AssetTracker`
- `PrivateL2NativeTokenVault`
- `PrivateL2AssetRouter`
- `PrivateInteropCenter`
- `PrivateInteropHandler`

These contracts are deployed at regular user-space addresses, not at the built-in system predeploy addresses used by public interop.

## Architecture

Public interop:

- uses the system `InteropCenter`, `InteropHandler`, `L2AssetRouter`, and `L2NativeTokenVault`,
- relies on `cast-interop` for the current local relay path,
- remains the path used by the repo-local SDK examples and `scripts/run-interop-matrix.sh`.

Private interop:

- uses the private contract stack listed above,
- is bootstrapped by `./setup-private-interop-local`,
- writes `.runtime/private-interop.json`,
- uses `./run-private-interop-executor` for local destination execution,
- does not depend on `cast-interop`.

The privacy property is specific:

- the shared L2->L1 interop message path carries only a private marker, bundle hash, and call count,
- the full bundle contents are not published there.

See [Private Interop Privacy Model](./private-interop-privacy.md) for the exact boundary and source-level explanation.

## Runtime Manifest

The private bootstrap writes `.runtime/private-interop.json`.

That manifest is the source of truth for:

- per-chain private contract addresses,
- the RPC URLs users should target,
- dynamic permission SQL generation,
- the private executor,
- the private smoke suite.

The manifest is intentionally generated at runtime because private contract addresses are deployment outputs, not static repo constants.

## Bootstrapping

Manual workflow on top of the public base stack:

```bash
docker compose -f docker-compose-deps.yml -f docker-compose.yml up -d
./setup-private-interop-local
```

Overlay workflow with public + private services:

```bash
docker compose -f docker-compose-deps.yml -f docker-compose.yml -f docker-compose-private-interop.yml up -d
```

The overlay adds:

- `private-interop-setup`
- `private-interop-permissions`
- `private-interop-executor`

## Operational Split

Use public interop when:

- you want to exercise the existing SDK path,
- you want the current `cast-interop` relay flow,
- you want to validate that the original public demo stack still works.

Use private interop when:

- you want to test the private contract stack,
- you want to validate Prividium permissioning for private methods,
- you want to exercise the local private executor flow.
