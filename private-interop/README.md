# Private Interop Helpers

Repo-local helpers and artifact loaders for the private interop path used by `prividium-3chain-local`.

This package is not published to npm. It is intended to be consumed as a local package from a checkout or submodule of this repo.

## Install From A Local Checkout

If your app vendors this repo as a submodule, install the package from that local path:

```bash
npm install ../path/to/prividium-3chain-local/private-interop
```

Or declare it directly in your app:

```json
{
  "dependencies": {
    "private-interop": "file:../path/to/prividium-3chain-local/private-interop"
  }
}
```

Then import from the package name:

```ts
import {
  encodeEvmChain,
  encodeEvmAddress,
  encodeBridgeBurnData,
  encodeAssetRouterBridgehubDepositData,
  getAbi,
} from "private-interop";
```

## Scope

This package exposes:

- encoding helpers from `src/core/data-encoding.ts`,
- constants and shared types from `src/core`,
- artifact/ABI loaders,
- deployer helpers from `src/helpers/private-interop-deployer.ts`.

The repo scripts such as `private-interop-executor.ts` and `private-interop-smoke.ts` remain repo-local scripts. Consume them from the submodule itself rather than through the package API.

## Version Note

This package currently uses `ethers@5`, while `sdk/` uses `ethers@6`. If an app needs both, treat them as separate local packages and verify your bundler/tooling handles the mixed dependency tree correctly.
