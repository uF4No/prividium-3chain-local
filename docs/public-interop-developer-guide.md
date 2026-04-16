# Public Interop Developer Guide

## Purpose

This guide is for application developers, script authors, and agents that need to send or observe `public interop` transactions in this repo's local 3-chain Prividium stack.

It covers the system-contract path used by the repo-local `sdk/` package and the public relay running in the local compose stack.

## Source Of Truth

Use these repo artifacts as the canonical source of truth:

- Public SDK package: `sdk/`
- Public examples: `sdk/examples/remote-call-3chains.ts`, `sdk/examples/message-verify.ts`, `sdk/examples/bundle-transfer.ts`
- Public interop relay service: `docker-compose.yml`
- End-to-end public matrix runner: `scripts/run-interop-matrix.sh`

For public interop in this repo, the `sdk/` package is the intended app-facing helper layer.

## Package Consumption

`interop-sdk` is not published to npm from this repo.

If your app vendors `prividium-3chain-local` as a submodule, install it from the local checkout:

```json
{
  "dependencies": {
    "interop-sdk": "file:../path/to/prividium-3chain-local/sdk",
    "ethers": "^6.0.0"
  }
}
```

Then import from the package name:

```ts
import { BundleBuilder, CallBuilder, sendBundle } from "interop-sdk";
```

Avoid deep-importing from `sdk/src/...` in app code unless you intentionally want to bind to repo internals.

## What Public Means In This Repo

`Public interop` here means:

- apps send through the standard system-contract path,
- source finalization and destination root availability are part of the normal lifecycle,
- bundle/message verification follows the public shared-root flow,
- the local stack runs a relay service based on `cast-interop`.

This is different from the repo's private path, which uses separate user-space contracts and receipt-driven execution.

## Addresses And Contracts

For the public path in this repo, apps normally use the fixed system-contract addresses exported by `interop-sdk`.

Most commonly used addresses:

- `L2_INTEROP_CENTER_ADDRESS`
- `L2_INTEROP_HANDLER_ADDRESS`
- `L2_INTEROP_ROOT_STORAGE_ADDRESS`
- `L2_MESSAGE_VERIFICATION_ADDRESS`
- `L2_ASSET_ROUTER_ADDRESS`
- `L2_NATIVE_TOKEN_VAULT_ADDRESS`
- `L2_TO_L1_MESSENGER_ADDRESS`

Unlike private interop, there is no `.runtime/private-interop.json` manifest for these public addresses.

## Contract Map

| Contract | Chain | Role | Typical app interaction |
|---|---|---|---|
| `InteropCenter` | Source chain | Entry point for public bundles and messages | Yes |
| `InteropHandler` | Destination chain | Verifies and executes public bundles | Usually no direct call when relay is running |
| `InteropRootStorage` | Destination chain | Stores published interop roots | Read-only |
| `L1Messenger` | Source chain | Sends shared L2->L1 messages | Yes, for message flow |
| `L2MessageVerification` | Destination chain | Verifies message inclusion | Read-only |
| `L2NativeTokenVault` | Source and destination | Token registration and bridged token lookup | Yes, when bridging tokens |
| `L2AssetRouter` | Source and destination | Public token bridge entry/finalize path | Usually inside bundle construction |

## Which Transactions Apps Need To Send

There are usually 3 transaction classes in the public flow.

### 1. Source-chain bundle send

A normal L2 contract write transaction through `InteropCenter`.

In app code, prefer:

- `sendBundle(signer, builder)` from `interop-sdk`, or
- `sendMessage(signer, payload)` for plain message flow.

### 2. Optional token-prep transactions

For custom ERC20 token bridging you may also need:

- `ERC20.approve(L2_NATIVE_TOKEN_VAULT_ADDRESS, amount)`
- `L2NativeTokenVault.ensureTokenIsRegistered(token)` once per source token

These are source-chain transactions.

### 3. Destination execution transaction

For bundles, a destination execution transaction may happen later through `InteropHandler.executeBundle(...)`.

In this local repo, that is usually handled automatically by the `interop-relay` service defined in `docker-compose.yml`, which runs:

```bash
cast-interop auto-relay --rpc http://chain1:3050 http://chain2:3051 http://chain3:3052 ...
```

Practical consequence:

- most user-facing apps only send the source transaction,
- then wait for source finalization and destination completion,
- and do not need to submit destination execution manually while the relay is running.

If you are not running the relay, you can still execute manually with `executeBundle(...)` from `interop-sdk`.

## Normal Lifecycle

For the public bundle path, the usual lifecycle is:

1. send bundle on the source chain,
2. wait for source finalization,
3. wait for destination root availability,
4. either let the relay execute the bundle or execute it yourself,
5. observe destination status or app-level effects.

For the public message path, the lifecycle is:

1. send message on the source chain,
2. wait for source finalization,
3. wait for destination root availability,
4. verify inclusion on the destination chain.

The repo-local SDK is built around that lifecycle.

## Address Encoding Rules

This flow also uses ERC-7930 interoperable address encoding.

Useful SDK helpers:

- `formatEvmV1(chainId)` for a chain-only destination encoding
- `formatEvmV1AddressOnly(address)` for an address-only destination encoding
- `formatEvmV1WithAddress(chainId, address)` when both are needed together

For bundle construction, prefer using `BundleBuilder` and `CallBuilder` instead of assembling the raw bytes manually.

## Minimal Bundle Flow

For a normal remote contract call, the app usually needs:

1. source provider and signer,
2. destination provider,
3. destination chain ID,
4. destination contract calldata,
5. a bundle built with `BundleBuilder` and `CallBuilder`.

### Example

```ts
import { ethers } from "ethers";
import {
  BundleBuilder,
  CallBuilder,
  sendBundle,
  waitForBundleFinalization,
  waitUntilRootAvailable,
  waitForBundleExecution,
} from "interop-sdk";

const sourceProvider = new ethers.JsonRpcProvider(sourceRpcUrl);
const destProvider = new ethers.JsonRpcProvider(destRpcUrl);
const sourceSigner = new ethers.Wallet(privateKey, sourceProvider);

const destinationCalldata = greeterIface.encodeFunctionData("setMessage", ["hello public interop"]);

const bundle = new BundleBuilder(destinationChainId)
  .addCall(new CallBuilder(destinationContract, destinationCalldata).build())
  .withUnbundler(sourceSigner.address);

const handle = await sendBundle(sourceSigner, bundle);
const finalizationInfo = await waitForBundleFinalization(sourceProvider, handle);

await waitUntilRootAvailable(destProvider, finalizationInfo.expectedRoot);
await waitForBundleExecution(destProvider, handle.bundleHash);
```

If you are not running the relay, replace `waitForBundleExecution(...)` with `executeBundle(destinationSigner, finalizationInfo)`.

## Token Bridge Flow

For token bridging on the public path, prefer the SDK helpers instead of manually encoding the router call.

Typical sequence:

1. register the token on the source chain if needed,
2. approve the source public native token vault,
3. build a token-transfer call with `CallBuilder.tokenTransfer(...)`,
4. send the bundle,
5. wait for finalization and destination execution,
6. resolve the bridged token on the destination chain with `getBridgedTokenAddress(...)` or `tokenAddress(assetId)`.

### Example

```ts
import { ethers } from "ethers";
import {
  BundleBuilder,
  CallBuilder,
  sendBundle,
  waitForBundleFinalization,
  waitUntilRootAvailable,
  waitForBundleExecution,
  L2_NATIVE_TOKEN_VAULT_ADDRESS,
  NativeTokenVaultAbi,
  ERC20Abi,
} from "interop-sdk";

const sourceVault = new ethers.Contract(
  L2_NATIVE_TOKEN_VAULT_ADDRESS,
  [...NativeTokenVaultAbi, "function ensureTokenIsRegistered(address) returns (bytes32)"],
  sourceSigner
);

await (await sourceVault.ensureTokenIsRegistered(tokenAddress)).wait();
await (await new ethers.Contract(tokenAddress, ERC20Abi, sourceSigner).approve(
  L2_NATIVE_TOKEN_VAULT_ADDRESS,
  amount
)).wait();

const bundle = new BundleBuilder(destinationChainId)
  .addCall(CallBuilder.tokenTransfer(sourceChainId, tokenAddress, amount, receiverAddress))
  .withUnbundler(receiverAddress);

const handle = await sendBundle(sourceSigner, bundle);
const finalizationInfo = await waitForBundleFinalization(sourceProvider, handle);
await waitUntilRootAvailable(destProvider, finalizationInfo.expectedRoot);
await waitForBundleExecution(destProvider, handle.bundleHash);
```

## Message Verification Flow

For plain shared-message flow, use the message helpers:

- `sendMessage(...)`
- `waitForFinalization(...)`
- `verifyMessageInclusion(...)`

### Example

```ts
import { ethers } from "ethers";
import {
  sendMessage,
  waitForFinalization,
  waitUntilRootAvailable,
  verifyMessageInclusion,
} from "interop-sdk";

const sourceProvider = new ethers.JsonRpcProvider(sourceRpcUrl);
const destProvider = new ethers.JsonRpcProvider(destRpcUrl);
const sourceSigner = new ethers.Wallet(privateKey, sourceProvider);

const payload = ethers.hexlify(ethers.toUtf8Bytes("hello public interop"));
const handle = await sendMessage(sourceSigner, payload);
const finalizationInfo = await waitForFinalization(
  sourceProvider,
  handle,
  sourceSigner.address,
  payload
);

await waitUntilRootAvailable(destProvider, finalizationInfo.expectedRoot);
const verified = await verifyMessageInclusion(destProvider, finalizationInfo);
```

## Status Tracking

Useful SDK reads:

- `getBundleSourceStatus(provider, handle)`
- `getBundleDestinationStatus(provider, bundleHash, expectedRoot)`
- `waitForBundleExecution(provider, bundleHash)`
- `getMessageSourceStatus(provider, handle)`
- `verifyMessageInclusion(provider, finalizationInfo)`

Useful lower-level destination contract read:

- `InteropHandler.bundleStatus(bundleHash)`

## End-To-End Checklist

For a public bundle:

1. Ensure the public stack is running with `docker-compose-deps.yml` and `docker-compose.yml`.
2. Ensure `interop-relay` is running if you want automatic destination execution.
3. Build the bundle with `BundleBuilder` and `CallBuilder`.
4. Send it with `sendBundle(...)`.
5. Wait for source finalization.
6. Wait for destination root availability.
7. Wait for relay execution or execute manually.
8. Verify destination effects.

For a public message:

1. Send with `sendMessage(...)`.
2. Wait for source finalization.
3. Wait for destination root availability.
4. Verify inclusion on the destination chain.

## Common Mistakes

- Trying to install `interop-sdk` from the public npm registry instead of from the local repo path.
- Deep-importing from `sdk/src/...` in app code instead of using the package entrypoint.
- Using private-interop runtime addresses for the public path.
- Assuming bundle execution is synchronous with the source transaction.
- Forgetting to wait for destination root availability before checking destination verification state.
- Not running `interop-relay` and then wondering why bundles are never executed automatically.
- Using the private-flow assumptions from `docs/private-interop-developer-guide.md` for public transactions.

## Recommended Development Pattern

For user-facing applications:

- use `interop-sdk` as the package boundary,
- treat the source transaction as the user action,
- treat destination execution/finality as asynchronous,
- rely on the local relay for normal public-stack testing,
- fall back to manual `executeBundle(...)` only when debugging or building operator flows.

For agents:

- mirror `sdk/examples/remote-call-3chains.ts` for direct-call flows,
- mirror `sdk/examples/bundle-transfer.ts` for token bridging,
- mirror `sdk/examples/message-verify.ts` for public message verification.
