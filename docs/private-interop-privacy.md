# Private Interop Privacy Model

## Summary

`Private interop` in this repo does not mean:

- end-to-end encrypted interop,
- hidden transaction existence,
- hidden execution from the source chain or destination chain.

It means that the **full interop bundle is not published through the normal shared L2->L1 interop message path**.

Instead of exposing the full bundle contents on that path, private interop publishes only:

- a private-bundle marker,
- the bundle hash,
- the number of calls in the bundle.

That is the core privacy property.

## Public vs Private

Public interop:

- sends the full ABI-encoded bundle through the L2->L1 messenger,
- allows downstream verification/execution using the full bundle message,
- exposes the bundle contents to observers of that message path.

Private interop:

- does not send the full bundle through the L2->L1 messenger,
- sends only `PRIVATE_BUNDLE_IDENTIFIER || keccak256(bundle) || callCount`,
- executes the bundle later using the full bundle supplied to the private handler/executor.

The practical effect is that observers of the shared interop transport can see that a private bundle exists, but cannot read the actual calls from the message itself.

## Source-Level Mechanism

The distinction is implemented directly in the private contract overrides.

Public interop in [InteropCenter.sol](../private-interop/contracts/interop/InteropCenter.sol#L533) sends:

- `BUNDLE_IDENTIFIER || full_bundle_bytes`

Public interop in [InteropHandler.sol](../private-interop/contracts/interop/InteropHandler.sol#L378) reconstructs and verifies:

- `BUNDLE_IDENTIFIER || full_bundle_bytes`

Private interop in [PrivateInteropCenter.sol](../private-interop/contracts/interop/PrivateInteropCenter.sol#L91) sends only:

- `PRIVATE_BUNDLE_IDENTIFIER || keccak256(full_bundle) || callCount`

Private interop in [PrivateInteropHandler.sol](../private-interop/contracts/interop/PrivateInteropHandler.sol#L33) expects:

- `PRIVATE_BUNDLE_IDENTIFIER || keccak256(full_bundle) || callCount`

That is why the bundle contents are withheld from the public/shared message path.

## What Is Actually Hidden

The hidden part is the full bundle payload as it traverses the L2->L1 message transport.

That includes data such as:

- the target contract address for each call,
- the calldata for each call,
- the original sender/recipient call structure,
- bundle-level execution attributes,
- per-call value semantics.

For private interop, the shared message path reveals only:

- that a private bundle was emitted,
- the bundle hash,
- how many calls were in the bundle.

## What Is Not Hidden

Private interop is not cryptographic secrecy across the whole system.

The following parties/components can still observe the full bundle:

- the source chain, because the source transaction includes the call that creates the bundle,
- the destination-side executor/handler, because it needs the full bundle to execute it,
- operators or privileged infrastructure with access to those execution paths,
- anyone with access to permissioned Prividium RPCs that expose the relevant contract interactions.

So the privacy boundary is specific:

- hidden from the shared/public interop transport,
- not hidden from the chains that originate and execute the bundle.

## Why Separate Contracts Exist

The private flow is not just a flag on the public contracts. It uses a separate contract stack:

- `PrivateL2AssetTracker`
- `PrivateL2NativeTokenVault`
- `PrivateL2AssetRouter`
- `PrivateInteropCenter`
- `PrivateInteropHandler`

This matters because the route itself is distinct.

[Messaging.sol](../private-interop/contracts/common/Messaging.sol#L8) defines separate `Public` and `Private` routes, and [PrivateL2AssetRouter.sol](../private-interop/contracts/bridge/asset-router/PrivateL2AssetRouter.sol#L64) forces the private route.

That separation avoids mixing public and private interop for the same flow.

## Relationship To Prividium Permissioning

This repo has two different privacy/control layers:

1. Protocol-level private interop
2. Prividium permissioned RPC / contract access

They are related, but not the same.

Protocol-level private interop:

- hides bundle contents from the shared interop message transport,
- changes how bundles are represented and verified,
- uses dedicated private router / vault / handler contracts.

Prividium permissioning:

- controls who can call or read contracts through the Prividium-accessible RPC surface,
- limits which users can use the private contracts,
- does not itself make the bundle cryptographically secret.

So:

- private interop is about **what is published on the interop transport**,
- Prividium permissions are about **who is allowed to interact with the contracts and RPCs**.

## Why This Matters

Without the private variant, the full bundle would be visible in the shared interop message path.

With the private variant:

- observers can still detect that a bundle exists,
- but they cannot reconstruct the bundle contents from the message transport alone,
- and the local Prividium stack can layer permissioned access on top of that reduced exposure.

This is why the feature is worth documenting carefully: `private` here is a precise transport/privacy claim, not a general confidentiality guarantee.
