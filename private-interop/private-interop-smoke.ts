#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import { BigNumber, Contract, ContractFactory, ethers, providers, Wallet } from "ethers";
import { getAbi, getCreationBytecode } from "./src/core/contracts";
import { ANVIL_DEFAULT_PRIVATE_KEY, INTEROP_BUNDLE_TUPLE_TYPE } from "./src/core/const";
import {
  encodeAssetRouterBridgehubDepositData,
  encodeBridgeBurnData,
  encodeEvmAddress,
  encodeEvmChain,
} from "./src/core/data-encoding";

type Manifest = {
  chains: Record<
    string,
    {
      key: string;
      rpcUrl: string;
      connectRpcUrl?: string;
      assetTracker: string;
      ntv: string;
      assetRouter: string;
      interopCenter: string;
      interopHandler: string;
    }
  >;
};

type ChainCtx = {
  chainId: number;
  key: string;
  provider: providers.JsonRpcProvider;
  wallet: Wallet;
  assetTracker: string;
  ntv: string;
  assetRouter: string;
  interopCenter: string;
  interopHandler: string;
  greeter?: string;
};

const BUNDLE_STATUS_FULLY_EXECUTED = 2;

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_MANIFEST_PATH = path.join(REPO_ROOT, ".runtime/private-interop.json");
function shouldUseConnectRpcUrl(): boolean {
  if (process.env.PRIVATE_INTEROP_USE_CONNECT_RPC === "1") return true;
  if (process.env.PRIVATE_INTEROP_USE_CONNECT_RPC === "0") return false;
  return fs.existsSync("/.dockerenv");
}

function resolveRpcUrl(chain: Manifest["chains"][string]): string {
  if (shouldUseConnectRpcUrl() && chain.connectRpcUrl) {
    return chain.connectRpcUrl;
  }
  return chain.rpcUrl;
}

async function getTxOverrides(
  provider: providers.JsonRpcProvider,
  gasLimit = 5_000_000
): Promise<{ gasPrice: ethers.BigNumber; gasLimit: number; type: number }> {
  return {
    gasPrice: (await provider.getGasPrice()).mul(2),
    gasLimit,
    type: 0,
  };
}

function loadManifest(): Manifest {
  const manifestPath = process.env.PRIVATE_INTEROP_MANIFEST_PATH || DEFAULT_MANIFEST_PATH;
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing private interop manifest at ${manifestPath}`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Manifest;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadChains(): ChainCtx[] {
  const manifest = loadManifest();
  return Object.entries(manifest.chains)
    .map(([chainId, chain]) => {
      const rpcUrl = resolveRpcUrl(chain);
      return {
        chainId: Number(chainId),
        key: chain.key,
        provider: new providers.JsonRpcProvider(rpcUrl),
        wallet: new Wallet(process.env.PRIVATE_INTEROP_EXECUTOR_KEY || ANVIL_DEFAULT_PRIVATE_KEY).connect(
          new providers.JsonRpcProvider(rpcUrl)
        ),
        assetTracker: chain.assetTracker,
        ntv: chain.ntv,
        assetRouter: chain.assetRouter,
        interopCenter: chain.interopCenter,
        interopHandler: chain.interopHandler,
      };
    })
    .sort((a, b) => a.chainId - b.chainId);
}

function encodeBundleData(interopBundle: unknown): string {
  return ethers.utils.defaultAbiCoder.encode([INTEROP_BUNDLE_TUPLE_TYPE], [interopBundle]);
}

function getBundleHash(sourceChainId: number, bundleData: string): string {
  return ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["uint256", "bytes"], [sourceChainId, bundleData]));
}

function describeChain(chain: ChainCtx): string {
  return `${chain.key} (${chain.chainId})`;
}

async function extractFirstBundle(
  source: ChainCtx,
  receipt: providers.TransactionReceipt
): Promise<{ bundle: unknown; destinationChainId: number; bundleHash: string }> {
  const interopCenter = new Contract(source.interopCenter, getAbi("InteropCenter"), source.provider);
  for (const logEntry of receipt.logs) {
    try {
      const parsed = interopCenter.interface.parseLog({
        topics: logEntry.topics as string[],
        data: logEntry.data,
      });
      if (parsed?.name !== "InteropBundleSent") {
        continue;
      }
      const bundle = parsed.args["interopBundle"];
      return {
        bundle,
        destinationChainId: Number(bundle.destinationChainId.toString()),
        bundleHash: getBundleHash(source.chainId, encodeBundleData(bundle)),
      };
    } catch {
      // Skip non-interop logs
    }
  }
  throw new Error(`Missing InteropBundleSent on source chain ${source.chainId}`);
}

async function executeBundle(source: ChainCtx, destination: ChainCtx, interopBundle: unknown): Promise<void> {
  const interopHandler = new Contract(destination.interopHandler, getAbi("InteropHandler"), destination.wallet);
  const bundleData = encodeBundleData(interopBundle);
  const bundleHash = getBundleHash(source.chainId, bundleData);
  const proof = {
    chainId: source.chainId,
    l1BatchNumber: 0,
    l2MessageIndex: 0,
    message: { txNumberInBatch: 0, sender: source.interopCenter, data: "0x" },
    proof: [],
  };

  try {
    const tx = await interopHandler.executeBundle(bundleData, proof, await getTxOverrides(destination.provider));
    const receipt = await tx.wait();
    if (receipt.status !== 1) {
      throw new Error(`Private executeBundle failed on chain ${destination.chainId}`);
    }
  } catch (error) {
    const status = Number((await interopHandler.bundleStatus(bundleHash)).toString());
    if (status === BUNDLE_STATUS_FULLY_EXECUTED) {
      return;
    }
    throw error;
  }
}

async function verifyDeployment(chains: ChainCtx[]): Promise<void> {
  for (const chain of chains) {
    for (const [name, address] of Object.entries({
      assetTracker: chain.assetTracker,
      ntv: chain.ntv,
      assetRouter: chain.assetRouter,
      interopCenter: chain.interopCenter,
      interopHandler: chain.interopHandler,
    })) {
      const code = await chain.provider.getCode(address);
      if (!code || code === "0x") {
        throw new Error(`${name} missing on chain ${chain.chainId}: ${address}`);
      }
    }
  }
}

async function verifyRemoteRouters(chains: ChainCtx[]): Promise<void> {
  for (const source of chains) {
    const router = new Contract(source.assetRouter, getAbi("PrivateL2AssetRouter"), source.provider);
    for (const destination of chains) {
      if (source.chainId === destination.chainId) continue;
      const remote = await router.remoteRouterAddress(destination.chainId);
      if (remote.toLowerCase() !== destination.assetRouter.toLowerCase()) {
        throw new Error(
          `Remote router mismatch on chain ${source.chainId} for ${destination.chainId}: ${remote} != ${destination.assetRouter}`
        );
      }
    }
  }
}

async function runTokenTransferSmoke(chains: ChainCtx[]): Promise<void> {
  const source = chains[0];
  const destination = chains[1];
  console.log(`\n🪙 === Private token transfer: ${source.key} -> ${destination.key} ===`);
  const tokenFactory = new ContractFactory(
    getAbi("TestnetERC20Token"),
    getCreationBytecode("TestnetERC20Token"),
    source.wallet
  );
  const token = await tokenFactory.deploy("Private Test Token", "PTT", 18, await getTxOverrides(source.provider, 10_000_000));
  await token.deployed();
  console.log(`🏗️ token deployed on ${describeChain(source)}: ${token.address}`);
  const amount = ethers.utils.parseUnits("5", 18);

  await (await token.mint(source.wallet.address, amount.mul(4), await getTxOverrides(source.provider))).wait();
  const sourceVault = new Contract(source.ntv, getAbi("L2NativeTokenVault"), source.wallet);
  await (await sourceVault.registerToken(token.address, await getTxOverrides(source.provider))).wait();
  const assetId = await sourceVault.assetId(token.address);
  await (await token.approve(source.ntv, amount, await getTxOverrides(source.provider))).wait();
  console.log(`📝 registered assetId: ${assetId}`);
  console.log(`👍 approved ${ethers.utils.formatUnits(amount, 18)} PTT for bridging`);

  const destinationVault = new Contract(destination.ntv, getAbi("L2NativeTokenVault"), destination.provider);
  const sourceBalanceBefore = await token.balanceOf(source.wallet.address);
  const destinationTokenBefore = await destinationVault.tokenAddress(assetId);
  const destinationBalanceBefore =
    destinationTokenBefore === ethers.constants.AddressZero
      ? BigNumber.from(0)
      : await new Contract(destinationTokenBefore, getAbi("TestnetERC20Token"), destination.provider).balanceOf(
          destination.wallet.address
        );

  const abiCoder = ethers.utils.defaultAbiCoder;
  const indirectCallSelector = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("indirectCall(uint256)")).slice(0, 10);
  const valueSelector = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("interopCallValue(uint256)")).slice(0, 10);
  const transferData = encodeBridgeBurnData(amount, source.wallet.address, token.address);
  const depositData = encodeAssetRouterBridgehubDepositData(assetId, transferData);
  const interopCenter = new Contract(source.interopCenter, getAbi("InteropCenter"), source.wallet);
  const tx = await interopCenter.sendBundle(
    encodeEvmChain(destination.chainId),
    [
      {
        to: encodeEvmAddress(destination.assetRouter),
        data: depositData,
        callAttributes: [
          indirectCallSelector + abiCoder.encode(["uint256"], [0]).slice(2),
          valueSelector + abiCoder.encode(["uint256"], [0]).slice(2),
        ],
      },
    ],
    [],
    { ...(await getTxOverrides(source.provider)), value: 0 }
  );
  const receipt = await tx.wait();
  const { bundle, destinationChainId, bundleHash } = await extractFirstBundle(source, receipt);
  if (destinationChainId !== destination.chainId) {
    throw new Error(`Destination mismatch for token smoke ${source.chainId} -> ${destination.chainId}`);
  }
  console.log(`📦 sent bundle: ${bundleHash}`);
  await executeBundle(source, destination, bundle);
  console.log(`⚙️ bundle executed on ${describeChain(destination)}`);

  const sourceBalanceAfter = await token.balanceOf(source.wallet.address);
  const destinationToken = await destinationVault.tokenAddress(assetId);
  const destinationBalanceAfter = await new Contract(
    destinationToken,
    getAbi("TestnetERC20Token"),
    destination.provider
  ).balanceOf(destination.wallet.address);

  if (!sourceBalanceBefore.sub(sourceBalanceAfter).eq(amount)) {
    throw new Error("Private token transfer source burn mismatch");
  }
  if (!destinationBalanceAfter.sub(destinationBalanceBefore).eq(amount)) {
    throw new Error("Private token transfer destination mint mismatch");
  }
  console.log(`🧾 destination token: ${destinationToken}`);
  console.log(`✅ transfer verified: ${ethers.utils.formatUnits(amount, 18)} PTT arrived on ${describeChain(destination)}`);
}

async function deployGreeter(chain: ChainCtx): Promise<string> {
  const factory = new ContractFactory(
    getAbi("TestInteropGreetingRecipient"),
    getCreationBytecode("TestInteropGreetingRecipient"),
    chain.wallet
  );
  const contract = await factory.deploy(await getTxOverrides(chain.provider));
  await contract.deployed();
  return contract.address;
}

async function waitForMessage(chain: ChainCtx, expected: string): Promise<void> {
  if (!chain.greeter) {
    throw new Error(`Missing greeter for chain ${chain.chainId}`);
  }
  const contract = new Contract(chain.greeter, getAbi("TestInteropGreetingRecipient"), chain.provider);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = (await contract.message()) as string;
    if (current === expected) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for private message smoke on chain ${chain.chainId}`);
}

async function runMessageSmoke(chains: ChainCtx[]): Promise<void> {
  console.log("\n💬 === Deploying private greeting contracts ===");
  for (const chain of chains) {
    chain.greeter = await deployGreeter(chain);
    const contract = new Contract(chain.greeter, getAbi("TestInteropGreetingRecipient"), chain.provider);
    const message = (await contract.message()) as string;
    console.log(`🏗️ ${chain.key} greeter: ${chain.greeter}, message="${message}"`);
  }

  let seq = 1;
  for (const source of chains) {
    for (const destination of chains) {
      if (source.chainId === destination.chainId) continue;
      const expected = `private ${source.key}->${destination.key} #${seq++}`;
      console.log(`\n🔁 === ${source.key} -> ${destination.key} ===`);
      const interopCenter = new Contract(source.interopCenter, getAbi("InteropCenter"), source.wallet);
      const tx = await interopCenter.sendBundle(
        encodeEvmChain(destination.chainId),
        [
          {
            to: encodeEvmAddress(destination.greeter!),
            data: ethers.utils.defaultAbiCoder.encode(["string"], [expected]),
            callAttributes: [],
          },
        ],
        [],
        { ...(await getTxOverrides(source.provider)), value: 0 }
      );
      const receipt = await tx.wait();
      const { bundle, destinationChainId, bundleHash } = await extractFirstBundle(source, receipt);
      if (destinationChainId !== destination.chainId) {
        throw new Error(`Destination mismatch for message smoke ${source.chainId} -> ${destination.chainId}`);
      }
      console.log(`📦 sent bundle: ${bundleHash}`);
      await executeBundle(source, destination, bundle);
      console.log(`⚙️ bundle executed on ${describeChain(destination)}`);
      await waitForMessage(destination, expected);
      console.log(`✅ destination message updated: "${expected}"`);
    }
  }
}

async function main(): Promise<void> {
  const chains = loadChains();
  if (chains.length < 3) {
    throw new Error("Expected 3 chains in private interop manifest");
  }
  const orderedPairCount = chains.length * (chains.length - 1);

  console.log("🔍 Verifying private interop deployment...");
  await verifyDeployment(chains);
  console.log("🔗 Verifying private remote router registrations...");
  await verifyRemoteRouters(chains);
  console.log("🧪 Running private token transfer smoke...");
  await runTokenTransferSmoke(chains);
  console.log("🧪 Running private message smoke across all ordered pairs...");
  await runMessageSmoke(chains);
  console.log("✅ Private interop smoke passed.");
  console.log(`📊 Summary: ${chains.length} chains checked, 1 token transfer, ${orderedPairCount} ordered-pair messages.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
