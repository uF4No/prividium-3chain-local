# Private Interop Developer Guide

## Purpose

This guide is for application developers, script authors, and agents that need to send or execute `private interop` transactions in this repo's local 3-chain Prividium stack.

It focuses on the actual runtime behavior implemented here:

- source-side user txs go through the private user-space contracts, not the public system contracts,
- the source tx receipt contains the full bundle,
- the shared L2->L1 message only carries a private marker, bundle hash, and call count,
- destination execution is performed later through `PrivateInteropHandler`,
- the repo-local executor currently reconstructs execution from the source receipt plus a local proof stub.

This is different from the public SDK flow, so do not assume the public interop docs or system-contract addresses apply unchanged.

## What Is Private In This Repo

`Private interop` here means:

- the full bundle is not published on the shared interop transport,
- only `PRIVATE_BUNDLE_IDENTIFIER || keccak256(full_bundle) || callCount` is sent through the shared L2->L1 message path,
- the destination side still needs the full bundle in order to execute it.

It does **not** mean:

- the source transaction is hidden,
- the destination execution is hidden,
- the bundle is end-to-end encrypted.

For the architecture and privacy boundary, also see:

- [Private Interop Overview](./private-interop-overview.md)
- [Private Interop Privacy Model](./private-interop-privacy.md)
- [Private Interop Operations](./private-interop-operations.md)

## Source Of Truth

Use these repo artifacts as the canonical source of truth:

- Runtime addresses: `.runtime/private-interop.json`
- Source-side contract implementation: `private-interop/contracts/interop/PrivateInteropCenter.sol`
- Destination-side contract implementation: `private-interop/contracts/interop/PrivateInteropHandler.sol`
- Token bridge path: `private-interop/contracts/bridge/asset-router/PrivateL2AssetRouter.sol`
- Runtime execution logic: `private-interop/private-interop-executor.ts`
- Working examples: `private-interop/private-interop-smoke.ts`

Do **not** treat the repo-local `sdk/` package as a private-interop SDK:

- it is built around public system-contract addresses in `sdk/src/constants.ts`,
- it is meant for the public path,
- some of its simplified ABIs do not match the full private bundle shape used here.

For private interop, prefer the artifacts and ABIs under `private-interop/`.

## Package Consumption

Neither `interop-sdk` nor `private-interop` is published to the public npm registry from this repo.

If your app vendors `prividium-3chain-local` as a submodule, install the local packages from the checkout:

```json
{
  "dependencies": {
    "interop-sdk": "file:../path/to/prividium-3chain-local/sdk",
    "private-interop": "file:../path/to/prividium-3chain-local/private-interop"
  }
}
```

Practical guidance:

- use `private-interop` as the package boundary for private-flow helpers,
- use `interop-sdk` only for public-flow helpers,
- avoid deep-importing from `sdk/src/...` or `private-interop/src/...` in app code unless you explicitly want to couple to repo internals.

Version caveat:

- `private-interop` currently uses `ethers@5`,
- `sdk/` currently uses `ethers@6`.

If an app needs both, verify your dependency graph and bundler behavior carefully.

## Runtime Address Discovery

Private interop addresses are deployed at runtime and written to:

```json
{
  "generatedAt": "...",
  "l1ChainId": 31337,
  "deployerAddress": "...",
  "chains": {
    "6565": {
      "key": "l2a",
      "rpcUrl": "http://127.0.0.1:3050",
      "connectRpcUrl": "http://chain1:3050",
      "assetTracker": "...",
      "ntv": "...",
      "assetRouter": "...",
      "interopCenter": "...",
      "interopHandler": "..."
    }
  }
}
```

Rules:

- Host-side apps should usually use `rpcUrl`.
- Docker-internal services should usually use `connectRpcUrl`.
- Always read addresses from the manifest instead of hard-coding them.
- Even though this local setup currently deploys the same private addresses on all 3 chains, that is an implementation detail. Agents and apps should still resolve per-chain addresses from the manifest.

Bootstrap command:

```bash
./setup-private-interop-local
```

That command deploys the private stack, generates permissions, and writes `.runtime/private-interop.json`.

## Contract Map

| Contract | Chain | Role | Typical app interaction |
|---|---|---|---|
| `PrivateInteropCenter` | Source chain | Entry point for sending private bundles | Yes |
| `PrivateInteropHandler` | Destination chain | Verifies and executes private bundles | Usually executor/operator, not end user |
| `PrivateL2NativeTokenVault` | Source and destination | Token registration, asset ID lookup, bridged token lookup | Yes, when bridging tokens |
| `PrivateL2AssetRouter` | Source and destination | Indirect-call bridge path and deposit finalization | Usually only inside bundle construction |
| `PrivateL2AssetTracker` | Source and destination | Accounting/support contract for bridge flow | No direct user interaction in normal apps |

## Which Transactions Apps Need To Send

There are usually 3 transaction classes in the private flow.

### 1. Source-chain bundle send

A normal L2 contract write transaction:

- `to = <source PrivateInteropCenter>`
- `data = sendBundle(bytes destinationChainId, InteropCallStarter[] callStarters, bytes[] bundleAttributes)`
- `value = 0`

This is the main user action for private interop.

### 2. Optional token-prep transactions

For custom ERC20 token bridging you may also need:

- `ERC20.approve(<source private NTV>, amount)`
- `PrivateL2NativeTokenVault.registerToken(token)` once per source token, if not already registered

These are source-chain transactions.

### 3. Destination execution transaction

A destination-side executor later sends:

- `to = <destination PrivateInteropHandler>`
- `data = executeBundle(bytes bundle, MessageInclusionProof proof)`
- `value = 0`

In this repo's default setup, this is normally sent by:

- `private-interop-executor` service, or
- `./run-private-interop-executor`

Normal Prividium user permissions do not grant `executeBundle(...)` by default, so user-facing web apps typically send step 1 and rely on the executor for step 3.

## ABI Shapes You Need

### Source entrypoint

```solidity
function sendBundle(
    bytes calldata _destinationChainId,
    InteropCallStarter[] calldata _callStarters,
    bytes[] calldata _bundleAttributes
) external payable returns (bytes32 bundleHash);
```

`InteropCallStarter` is:

```solidity
struct InteropCallStarter {
    bytes to;
    bytes data;
    bytes[] callAttributes;
}
```

### Destination entrypoint

```solidity
function executeBundle(
    bytes memory _bundle,
    MessageInclusionProof memory _proof
) external;
```

### Bundle event

The source transaction emits:

```solidity
event InteropBundleSent(
    bytes32 l2l1MsgHash,
    bytes32 interopBundleHash,
    InteropBundle interopBundle
);
```

Important private-path note:

- in the current private implementation, `l2l1MsgHash` is emitted as `bytes32(0)` because `PrivateInteropCenter._sendBundleToL1(...)` returns `0`,
- the important fields are `interopBundleHash` and `interopBundle`.

That means private apps should not depend on `l2l1MsgHash` as a real transport handle.

## Address Encoding Rules

This flow uses ERC-7930 interoperable address encoding.

### `_destinationChainId`

The `sendBundle` destination argument is:

- an ERC-7930 EVM address encoding,
- with a chain reference,
- with an empty address field.

In other words, it encodes the destination chain ID only.

### `InteropCallStarter.to`

Each call starter `to` is:

- an ERC-7930 EVM address encoding,
- with an empty chain reference,
- with a populated address field.

So the bundle-level destination chain ID tells the protocol which chain to target, while each call starter supplies only the destination contract address.

Helpers already exist in the repo:

- `sdk/src/address.ts`
- `private-interop/src/core/data-encoding.ts`

Useful helpers:

- `formatEvmV1(chainId)` or `encodeEvmChain(chainId)` for `_destinationChainId`
- `formatEvmV1AddressOnly(address)` or `encodeEvmAddress(address)` for `callStarter.to`

If you consume this repo as local packages, prefer:

- `import { encodeEvmChain, encodeEvmAddress } from "private-interop"`
- or `import { formatEvmV1, formatEvmV1AddressOnly } from "interop-sdk"`

## Attribute Encoding Rules

Both call attributes and bundle attributes are passed as `bytes[]`.

Each entry is encoded as:

- `4-byte selector`
- followed by standard ABI-encoded arguments for that selector

In practice, the easiest way to build attributes is to use an interface and call `encodeFunctionData(...)`.

Supported attribute signatures:

- `interopCallValue(uint256)`
- `indirectCall(uint256)`
- `executionAddress(bytes)`
- `unbundlerAddress(bytes)`
- `useFixedFee(bool)`
- `shadowAccount()`

### Private-flow constraints

Private interop has some important constraints that differ from the public path:

- `interopCallValue` must be `0`
- `msg.value` should be `0`
- private interop does not collect base-token value for bundle execution
- `indirectCall(...)` is the important attribute for token bridging

If you send a non-zero `interopCallValue`, `PrivateInteropCenter` reverts.

### Execution and unbundler restrictions

- `executionAddress(bytes)` is optional
- if omitted, execution is permissionless at the contract level
- `unbundlerAddress(bytes)` is optional
- if omitted, the center defaults the unbundler to the original sender

Be careful with `executionAddress(...)`:

- if you set it, your destination executor must match it,
- otherwise `executeBundle(...)` will revert.

## Repo-Specific Lifecycle Difference From Public Interop

For the public path, the usual lifecycle is:

1. send bundle
2. wait for source finalization
3. wait for destination root availability
4. verify/execute using public proof flow

For the private path implemented in this repo, the practical lifecycle is:

1. send `PrivateInteropCenter.sendBundle(...)` on the source chain
2. parse `InteropBundleSent` from the source receipt
3. extract the full `interopBundle` from that event
4. ABI-encode that bundle and send it to the destination `PrivateInteropHandler.executeBundle(...)`
5. the current local `PrivateInteropHandler` trusts the executor and skips proof verification on pre-v31 chains

So:

- there is no `cast-interop` step,
- there is no public root-wait step in the repo's private executor flow,
- source receipt parsing is a first-class part of the private flow here.

That behavior is implemented in:

- `private-interop/private-interop-executor.ts`
- `private-interop/contracts/interop/PrivateInteropHandler.sol`

Do not model a private app after the public SDK flow without adapting it.

## Minimal Direct-Call Flow

For a normal remote contract call, the source app only needs to send one bundle with one call.

### Source-side transaction

Use:

- `to = sourceChain.interopCenter`
- `_destinationChainId = encodeEvmChain(destinationChainId)`
- `_callStarters[0].to = encodeEvmAddress(destinationContract)`
- `_callStarters[0].data = destination calldata`
- `_callStarters[0].callAttributes = []`
- `_bundleAttributes = []` or optional execution/unbundler restrictions
- `msg.value = 0`

### Example

```ts
import { ethers } from "ethers";

const interopCenterAbi = [
  "function sendBundle(bytes,(bytes,bytes,bytes[])[],bytes[]) payable returns (bytes32)",
  "event InteropBundleSent(bytes32 l2l1MsgHash, bytes32 interopBundleHash, tuple(bytes1 version,uint256 sourceChainId,uint256 destinationChainId,bytes32 destinationBaseTokenAssetId,bytes32 interopBundleSalt,tuple(bytes1 version,bool shadowAccount,address to,address from,uint256 value,bytes data)[] calls,tuple(bytes executionAddress,bytes unbundlerAddress,bool useFixedFee) bundleAttributes) interopBundle)"
];

function encodeEvmChain(chainId: bigint | number): string {
  const value = BigInt(chainId);
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  const chainBytes = ethers.getBytes(`0x${hex}`);
  return ethers.hexlify(new Uint8Array([0x00, 0x01, 0x00, 0x00, chainBytes.length, ...chainBytes, 0x00]));
}

function encodeEvmAddress(address: string): string {
  const addr = ethers.getBytes(address);
  return ethers.hexlify(new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x14, ...addr]));
}

const provider = new ethers.JsonRpcProvider(sourceRpcUrl);
const signer = new ethers.Wallet(privateKey, provider);
const interopCenter = new ethers.Contract(sourceInteropCenter, interopCenterAbi, signer);
const greeterIface = new ethers.Interface(["function setMessage(string)"]);

const destinationCalldata = greeterIface.encodeFunctionData("setMessage", ["hello private interop"]);

const tx = await interopCenter.sendBundle(
  encodeEvmChain(destinationChainId),
  [
    {
      to: encodeEvmAddress(destinationContract),
      data: destinationCalldata,
      callAttributes: [],
    },
  ],
  [],
  { value: 0n }
);

const receipt = await tx.wait();
```

## Token Bridge Flow

Token transfer is the most important special case because it uses the indirect-call path.

### What changes

Instead of sending a direct destination contract call, the source bundle sends a call starter that tells `PrivateInteropCenter` to call the source chain's private asset router locally via `initiateIndirectCall(...)`.

That router then returns the actual destination-side call starter, which points to `finalizeDeposit(...)` on the destination private asset router.

### Important subtlety

The call starter for an indirect token bridge should conceptually target the **source** chain private asset router, because `PrivateInteropCenter` calls it locally.

In this local setup the private contracts are currently deployed at the same address on each L2, so using the destination router address appears to work. Do not rely on that coincidence in generic tooling. Read the source chain router from the manifest and target that.

### Token prep

Before the first bridge of a custom token on the source chain:

1. call `PrivateL2NativeTokenVault.registerToken(tokenAddress)`
2. call `ERC20.approve(sourcePrivateNtv, amount)`
3. fetch `assetId = PrivateL2NativeTokenVault.assetId(tokenAddress)`

### Deposit payload format

The bridge call data used in the smoke test is:

- `transferData = abi.encode(amount, remoteReceiver, tokenAddress)`
- `depositData = 0x01 || abi.encode(assetId, transferData)`

That `depositData` becomes the `data` field of the indirect call starter.

### Call attributes

For token bridging, use:

- `indirectCall(0)`
- `interopCallValue(0)`

`interopCallValue(0)` is explicit in the repo smoke test and is safe for agents to mirror.

### Example

```ts
import { ethers } from "ethers";

const attrAbi = [
  "function indirectCall(uint256)",
  "function interopCallValue(uint256)"
];

const ntvAbi = [
  "function registerToken(address)",
  "function assetId(address) view returns (bytes32)"
];

const erc20Abi = [
  "function approve(address spender, uint256 amount) returns (bool)"
];

const attr = new ethers.Interface(attrAbi);
const ntv = new ethers.Contract(sourceNtv, ntvAbi, signer);
const token = new ethers.Contract(tokenAddress, erc20Abi, signer);

await (await ntv.registerToken(tokenAddress)).wait();
const assetId = await ntv.assetId(tokenAddress);
await (await token.approve(sourceNtv, amount)).wait();

const transferData = ethers.AbiCoder.defaultAbiCoder().encode(
  ["uint256", "address", "address"],
  [amount, destinationReceiver, tokenAddress]
);

const depositData = ethers.concat([
  "0x01",
  ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes"], [assetId, transferData]),
]);

const tx = await interopCenter.sendBundle(
  encodeEvmChain(destinationChainId),
  [
    {
      to: encodeEvmAddress(sourceAssetRouter),
      data: depositData,
      callAttributes: [
        attr.encodeFunctionData("indirectCall", [0n]),
        attr.encodeFunctionData("interopCallValue", [0n]),
      ],
    },
  ],
  [],
  { value: 0n }
);
```

### Destination-side result

After the bundle is executed on the destination chain:

- the destination private asset router finalizes the deposit,
- the destination private NTV exposes the bridged token via `tokenAddress(assetId)`,
- the destination token balance should increase by the bridged amount.

## How To Extract The Full Bundle

The source receipt is the easiest place to get the full bundle.

The repo executor does exactly this:

1. parse all logs with the source `PrivateInteropCenter` ABI
2. find `InteropBundleSent`
3. read `parsed.args["interopBundle"]`
4. read `parsed.args["interopBundleHash"]`
5. use the full `interopBundle` as the input to destination execution

This is important because the private L2->L1 message does **not** publish the full bundle.

## How To Execute On The Destination Chain

The executor's logic is the canonical example.

### Bundle encoding

The executor ABI-encodes the `InteropBundle` struct before calling `executeBundle(...)`.

In this repo, the tuple type used is:

```txt
tuple(
  bytes1,
  uint256,
  uint256,
  bytes32,
  bytes32,
  tuple(bytes1,bool,address,address,uint256,bytes)[],
  tuple(bytes,bytes,bool)
)
```

That corresponds to:

```txt
(
  version,
  sourceChainId,
  destinationChainId,
  destinationBaseTokenAssetId,
  interopBundleSalt,
  calls,
  bundleAttributes
)
```

### Local proof object

The repo-local executor currently sends this proof shape:

```ts
const proof = {
  chainId: sourceChainId,
  l1BatchNumber: 0,
  l2MessageIndex: 0,
  message: {
    txNumberInBatch: 0,
    sender: sourceInteropCenter,
    data: "0x",
  },
  proof: [],
};
```

Why this works in this repo:

- `PrivateInteropHandler` overrides `_verifyBundle(...)`
- on the current local pre-v31 setup it marks the bundle `Verified`
- it does not perform full proof verification

That behavior is a local-stack shortcut, not a generic production guarantee.

### Example executor call

```ts
const handlerAbi = [
  "function executeBundle(bytes,(uint256,uint256,uint256,(uint16,address,bytes),bytes32[]))"
];

const handler = new ethers.Contract(destinationInteropHandler, handlerAbi, executorSigner);

const bundleData = ethers.AbiCoder.defaultAbiCoder().encode(
  [
    "tuple(bytes1,uint256,uint256,bytes32,bytes32,tuple(bytes1,bool,address,address,uint256,bytes)[],tuple(bytes,bytes,bool))"
  ],
  [interopBundle]
);

await (await handler.executeBundle(bundleData, proof)).wait();
```

## Status Tracking

Useful reads:

- `PrivateInteropHandler.bundleStatus(bundleHash)`
- `PrivateL2NativeTokenVault.assetId(tokenAddress)`
- `PrivateL2NativeTokenVault.tokenAddress(assetId)`
- `PrivateInteropHandler.getShadowAccountAddress(ownerChainId, ownerAddress)`

On destination:

- `0 = Unreceived`
- `1 = Verified`
- `2 = FullyExecuted`
- `3 = Unbundled`

In the normal private executor flow, a successful destination execution should end at `FullyExecuted`.

## Permission Model In This Repo

The generated local Prividium permissions intentionally expose only a subset of methods to normal users.

User-facing methods include:

- `PrivateInteropCenter.sendBundle(...)`
- `PrivateInteropHandler.getShadowAccountAddress(...)`
- `PrivateInteropHandler.bundleStatus(bytes32)`
- `PrivateL2NativeTokenVault.assetId(address)`
- `PrivateL2NativeTokenVault.tokenAddress(bytes32)`
- `PrivateL2NativeTokenVault.registerToken(address)`

Setup-only methods are not user-facing:

- `initialize(...)`
- `setRemoteRouter(...)`
- `setDestinationBaseTokenAssetId(...)`

Practical consequence:

- web apps and user scripts should usually send the source bundle and query status,
- executor/operator infrastructure handles destination `executeBundle(...)`.

For details see [Private Interop Permissions](./private-interop-permissions.md).

## End-To-End Checklist

For a direct private message call:

1. Read `.runtime/private-interop.json`.
2. Choose source chain RPC + `interopCenter`.
3. Encode destination chain as ERC-7930 chain-only bytes.
4. Encode destination contract as ERC-7930 address-only bytes.
5. Call `sendBundle(...)` with `msg.value = 0`.
6. Parse `InteropBundleSent` from the receipt.
7. Ensure the private executor is running, or execute the bundle yourself on the destination handler.
8. Poll `bundleStatus(bundleHash)` on the destination chain if needed.

For a token bridge:

1. Read source and destination private addresses from the manifest.
2. Register the source token in source private NTV if needed.
3. Approve the source private NTV for the amount.
4. Fetch the source `assetId`.
5. Build `depositData = 0x01 || abi.encode(assetId, transferData)`.
6. Send a private bundle with an indirect call targeting the source private asset router.
7. Let the executor run or execute the bundle manually.
8. Resolve the destination bridged token with `destinationNtv.tokenAddress(assetId)`.
9. Check the destination token balance.

## Common Mistakes

- Using the public system-contract addresses from `sdk/src/constants.ts` instead of the runtime private addresses.
- Assuming the public SDK receipt/finalization flow applies unchanged to private interop.
- Depending on `InteropBundleSent.l2l1MsgHash` for private flow bookkeeping.
- Sending non-zero `interopCallValue` in private interop.
- Sending non-zero `msg.value` with `sendBundle(...)` in the private path.
- Targeting the wrong asset router for indirect token-bridge calls.
- Setting `executionAddress(...)` to an address your executor does not control.
- Forgetting that destination execution is a second transaction, not an automatic side effect of the source tx.

## Recommended Development Pattern

For user-facing applications:

- build the source-side transaction yourself,
- rely on `.runtime/private-interop.json` for addresses,
- parse and persist `bundleHash` and the full `interopBundle`,
- treat destination execution as an asynchronous step,
- either keep `private-interop-executor` running or build an internal executor service that mirrors `private-interop/private-interop-executor.ts`.

For agents:

- prefer using the private artifacts and manifest directly,
- if consuming helpers from a submodule-backed app, import from `private-interop` instead of `private-interop/src/...`,
- mirror `private-interop/private-interop-smoke.ts` for working message and token-bridge examples,
- mirror `private-interop/private-interop-executor.ts` for destination execution behavior.
