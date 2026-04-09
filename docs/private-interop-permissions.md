# Private Interop Permissions

## Why This Exists

The local Prividium stack does not grant generic unrestricted contract access to normal users.

The existing seed SQL already whitelists selected public interop system-contract methods. Private interop cannot rely on those rows because the private contracts are deployed dynamically and their addresses are not known ahead of time.

## Source Of Truth

Permissions are generated from:

- `.runtime/private-interop.json`

That manifest contains the private contract addresses for each local chain.

## Generated SQL

`./setup-private-interop-local` generates:

- `.runtime/private-permissions-l2a.sql`
- `.runtime/private-permissions-l2b.sql`
- `.runtime/private-permissions-l2c.sql`

Those files insert:

- private contract registrations into `contracts`,
- selected user-facing method permissions into `contract_function_permissions`.

## User-Facing Methods

The generated permissions cover the private equivalents of the public methods needed by local users:

- `PrivateInteropCenter.sendBundle(...)`
- `PrivateInteropHandler.getShadowAccountAddress(...)`
- `PrivateInteropHandler.bundleStatus(bytes32)`
- `PrivateL2NativeTokenVault.assetId(address)`
- `PrivateL2NativeTokenVault.tokenAddress(bytes32)`
- `PrivateL2NativeTokenVault.registerToken(address)`

The private asset router and private asset tracker are also registered as contracts, but setup-only methods are not granted to normal users.

## Setup-Only Methods

These remain out of the user permission set:

- `initialize(...)`
- `setRemoteRouter(...)`
- `setDestinationBaseTokenAssetId(...)`

They are used only during bootstrap.

## Application

Permissions are applied by:

- `scripts/apply-private-interop-permissions.sh`

That script can run:

- directly on the host when `psql` is available, or
- through `docker compose exec -T postgres ...` when `psql` is not installed locally.

The private compose overlay, [docker-compose-private-interop.yml](../docker-compose-private-interop.yml), includes a one-shot `private-interop-permissions` service that applies the same generated SQL after:

- private interop deployment succeeds,
- permissions API services are up,
- the base `prividium-seed` service has completed.

## Validation

Run:

```bash
./scripts/validate-private-interop-permissions.sh
```

This validation checks:

- all private contracts were inserted into each permissions database,
- expected private method-permission rows exist,
- only the seeded admin user has the `admin` role.

It is a structural validation of the local Prividium permission model. It does not replace full end-to-end UI/session testing.
