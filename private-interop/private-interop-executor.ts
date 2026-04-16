#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import { Contract, ethers, providers, Wallet } from "ethers";
import { getAbi } from "./src/core/contracts";
import { ANVIL_DEFAULT_PRIVATE_KEY, INTEROP_BUNDLE_TUPLE_TYPE } from "./src/core/const";

type Manifest = {
  chains: Record<
    string,
    {
      key: string;
      rpcUrl: string;
      connectRpcUrl?: string;
      interopCenter: string;
      interopHandler: string;
    }
  >;
};

type ParsedArgs = {
  txHash?: string;
  fromChainId?: number;
  toChainId?: number;
  watch: boolean;
  pollMs: number;
  fromBlock?: number;
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
  gasLimit = Number(process.env.PRIVATE_INTEROP_EXECUTOR_GAS_LIMIT || "5000000")
): Promise<{ gasPrice: ethers.BigNumber; gasLimit: number; type: number }> {
  return {
    gasPrice: (await provider.getGasPrice()).mul(2),
    gasLimit,
    type: 0,
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { watch: false, pollMs: 3000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tx-hash") parsed.txHash = argv[++i];
    else if (arg === "--from-chain") parsed.fromChainId = Number(argv[++i]);
    else if (arg === "--to-chain") parsed.toChainId = Number(argv[++i]);
    else if (arg === "--watch") parsed.watch = true;
    else if (arg === "--poll-ms") parsed.pollMs = Number(argv[++i]);
    else if (arg === "--from-block") parsed.fromBlock = Number(argv[++i]);
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadManifest(): Manifest {
  const manifestPath = process.env.PRIVATE_INTEROP_MANIFEST_PATH || DEFAULT_MANIFEST_PATH;
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing private interop manifest at ${manifestPath}`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Manifest;
}

function getChainEntry(manifest: Manifest, chainId: number) {
  const entry = manifest.chains[String(chainId)];
  if (!entry) {
    throw new Error(`Chain ${chainId} not found in private interop manifest`);
  }
  return entry;
}

function encodeBundleData(interopBundle: unknown): string {
  return ethers.utils.defaultAbiCoder.encode([INTEROP_BUNDLE_TUPLE_TYPE], [interopBundle]);
}

function getBundleHash(sourceChainId: number, bundleData: string): string {
  return ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["uint256", "bytes"], [sourceChainId, bundleData]));
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

async function executeBundle(args: {
  manifest: Manifest;
  sourceChainId: number;
  sourceInteropCenter: string;
  destinationChainId: number;
  interopBundle: unknown;
}): Promise<string> {
  const destination = getChainEntry(args.manifest, args.destinationChainId);
  const provider = new providers.JsonRpcProvider(resolveRpcUrl(destination));
  const wallet = new Wallet(process.env.PRIVATE_INTEROP_EXECUTOR_KEY || ANVIL_DEFAULT_PRIVATE_KEY).connect(provider);
  const handler = new Contract(destination.interopHandler, getAbi("InteropHandler"), wallet);
  const bundleData = encodeBundleData(args.interopBundle);
  const bundleHash = getBundleHash(args.sourceChainId, bundleData);
  const proof = {
    chainId: args.sourceChainId,
    l1BatchNumber: 0,
    l2MessageIndex: 0,
    message: { txNumberInBatch: 0, sender: args.sourceInteropCenter, data: "0x" },
    proof: [],
  };

  try {
    const tx = await handler.executeBundle(bundleData, proof, await getTxOverrides(provider));
    await tx.wait();
    console.log(
      `Executed private bundle ${tx.hash} on chain ${args.destinationChainId} via ${destination.interopHandler}`
    );
    return tx.hash;
  } catch (error) {
    const status = Number((await handler.bundleStatus(bundleHash)).toString());
    if (status === BUNDLE_STATUS_FULLY_EXECUTED) {
      console.log(`Private bundle ${bundleHash} already executed on chain ${args.destinationChainId}`);
      return bundleHash;
    }
    throw error;
  }
}

async function handleReceipt(args: {
  manifest: Manifest;
  sourceChainId: number;
  receipt: providers.TransactionReceipt;
  destinationChainId?: number;
}): Promise<void> {
  const source = getChainEntry(args.manifest, args.sourceChainId);
  const interopCenter = new Contract(
    source.interopCenter,
    getAbi("InteropCenter"),
    new providers.JsonRpcProvider(resolveRpcUrl(source))
  );

  for (const logEntry of args.receipt.logs) {
    try {
      const parsed = interopCenter.interface.parseLog({
        topics: logEntry.topics as string[],
        data: logEntry.data,
      });
      if (parsed?.name !== "InteropBundleSent") {
        continue;
      }
      const bundle = parsed.args["interopBundle"];
      const destinationChainId = Number(bundle.destinationChainId.toString());
      if (args.destinationChainId && args.destinationChainId !== destinationChainId) {
        continue;
      }
      await executeBundle({
        manifest: args.manifest,
        sourceChainId: args.sourceChainId,
        sourceInteropCenter: source.interopCenter,
        destinationChainId,
        interopBundle: bundle,
      });
    } catch {
      // Skip non-interop logs
    }
  }
}

async function executeOneShot(parsed: ParsedArgs, manifest: Manifest): Promise<void> {
  if (!parsed.txHash || !parsed.fromChainId) {
    throw new Error("One-shot mode requires --tx-hash and --from-chain");
  }
  const source = getChainEntry(manifest, parsed.fromChainId);
  const provider = new providers.JsonRpcProvider(resolveRpcUrl(source));
  const receipt = await provider.getTransactionReceipt(parsed.txHash);
  if (!receipt) {
    throw new Error(`Transaction ${parsed.txHash} not found on chain ${parsed.fromChainId}`);
  }
  await handleReceipt({
    manifest,
    sourceChainId: parsed.fromChainId,
    receipt,
    destinationChainId: parsed.toChainId,
  });
}

async function executeWatch(parsed: ParsedArgs, manifest: Manifest): Promise<void> {
  const chainIds = parsed.fromChainId ? [parsed.fromChainId] : Object.keys(manifest.chains).map(Number);
  const state = new Map<number, number>();
  const seen = new Set<string>();
  const providerByChain = new Map<number, providers.JsonRpcProvider>();

  const getProvider = (chainId: number): providers.JsonRpcProvider => {
    const existing = providerByChain.get(chainId);
    if (existing) {
      return existing;
    }
    const source = getChainEntry(manifest, chainId);
    const provider = new providers.JsonRpcProvider(resolveRpcUrl(source));
    providerByChain.set(chainId, provider);
    return provider;
  };

  for (const chainId of chainIds) {
    try {
      const latest = await getProvider(chainId).getBlockNumber();
      state.set(chainId, parsed.fromBlock ?? latest);
    } catch (error) {
      providerByChain.delete(chainId);
      console.error(`Failed to initialize watcher for chain ${chainId}: ${formatError(error)}`);
    }
  }

  console.log(`Watching private interop on chain(s): ${chainIds.join(", ")}`);
  while (true) {
    for (const chainId of chainIds) {
      try {
        const source = getChainEntry(manifest, chainId);
        const provider = getProvider(chainId);
        if (!state.has(chainId)) {
          const latest = await provider.getBlockNumber();
          state.set(chainId, parsed.fromBlock ?? latest);
        }
        const fromBlock = (state.get(chainId) || 0) + 1;
        const toBlock = await provider.getBlockNumber();
        if (fromBlock > toBlock) {
          continue;
        }
        const logs = await provider.getLogs({
          address: source.interopCenter,
          fromBlock,
          toBlock,
        });
        state.set(chainId, toBlock);

        for (const logEntry of logs) {
          const key = `${logEntry.transactionHash}:${logEntry.logIndex}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          const receipt = await provider.getTransactionReceipt(logEntry.transactionHash);
          if (!receipt) {
            continue;
          }
          await handleReceipt({
            manifest,
            sourceChainId: chainId,
            receipt,
            destinationChainId: parsed.toChainId,
          });
        }
      } catch (error) {
        providerByChain.delete(chainId);
        console.error(`Watcher error on chain ${chainId}: ${formatError(error)}`);
      }
    }
    await sleep(parsed.pollMs);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const manifest = loadManifest();

  if (parsed.watch) {
    await executeWatch(parsed, manifest);
    return;
  }

  await executeOneShot(parsed, manifest);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
