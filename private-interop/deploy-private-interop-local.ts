#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import { providers, Wallet } from "ethers";
import {
  deployPrivateInteropStack,
  PRIVATE_DEPLOYER_KEY,
  registerRemoteRouters,
} from "./src/helpers/private-interop-deployer";
import type { PrivateInteropAddresses } from "./src/core/types";

type ChainConfig = {
  key: string;
  chainId: number;
  connectRpcUrl: string;
  rpcUrl: string;
};

type Manifest = {
  generatedAt: string;
  l1ChainId: number;
  deployerAddress: string;
  chains: Record<
    string,
    {
      key: string;
      rpcUrl: string;
      connectRpcUrl: string;
      assetTracker: string;
      ntv: string;
      assetRouter: string;
      interopCenter: string;
      interopHandler: string;
    }
  >;
};

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_MANIFEST_PATH = path.join(REPO_ROOT, ".runtime/private-interop.json");
const DEFAULT_L1_CHAIN_ID = Number(process.env.PRIVATE_INTEROP_L1_CHAIN_ID || "31337");
const CHAINS: ChainConfig[] = [
  {
    key: "l2a",
    chainId: Number(process.env.PRIVATE_INTEROP_CHAIN_A_ID || "6565"),
    connectRpcUrl: process.env.PRIVATE_INTEROP_CHAIN_A_CONNECT_RPC_URL || "http://127.0.0.1:3050",
    rpcUrl: process.env.PRIVATE_INTEROP_CHAIN_A_RPC_URL || "http://127.0.0.1:3050",
  },
  {
    key: "l2b",
    chainId: Number(process.env.PRIVATE_INTEROP_CHAIN_B_ID || "6566"),
    connectRpcUrl: process.env.PRIVATE_INTEROP_CHAIN_B_CONNECT_RPC_URL || "http://127.0.0.1:3051",
    rpcUrl: process.env.PRIVATE_INTEROP_CHAIN_B_RPC_URL || "http://127.0.0.1:3051",
  },
  {
    key: "l2c",
    chainId: Number(process.env.PRIVATE_INTEROP_CHAIN_C_ID || "6567"),
    connectRpcUrl: process.env.PRIVATE_INTEROP_CHAIN_C_CONNECT_RPC_URL || "http://127.0.0.1:3052",
    rpcUrl: process.env.PRIVATE_INTEROP_CHAIN_C_RPC_URL || "http://127.0.0.1:3052",
  },
];

function log(line: string): void {
  console.log(line);
}

function loadManifest(manifestPath: string): Manifest | null {
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Manifest;
}

async function manifestMatchesChain(chain: ChainConfig, manifest: Manifest): Promise<boolean> {
  const deployed = manifest.chains[String(chain.chainId)];
  if (!deployed) return false;

  const provider = new providers.JsonRpcProvider(chain.connectRpcUrl);
  const addresses = [
    deployed.assetTracker,
    deployed.ntv,
    deployed.assetRouter,
    deployed.interopCenter,
    deployed.interopHandler,
  ];

  for (const address of addresses) {
    const code = await provider.getCode(address);
    if (!code || code === "0x") {
      return false;
    }
  }

  return true;
}

async function loadReusableManifest(manifestPath: string): Promise<Manifest | null> {
  const manifest = loadManifest(manifestPath);
  if (!manifest) {
    return null;
  }

  for (const chain of CHAINS) {
    if (!(await manifestMatchesChain(chain, manifest))) {
      return null;
    }
  }

  return manifest;
}

async function deployFresh(manifestPath: string): Promise<Manifest> {
  const deployerKey = process.env.PRIVATE_INTEROP_DEPLOYER_KEY || PRIVATE_DEPLOYER_KEY;
  const skipFunding = process.env.PRIVATE_INTEROP_SKIP_FUNDING === "1";
  const deployerAddress = new Wallet(deployerKey).address;
  const privateAddresses: Record<number, PrivateInteropAddresses> = {};

  for (const chain of CHAINS) {
    log(`\n=== Deploying private interop on ${chain.key} (${chain.chainId}) ===`);
    const provider = new providers.JsonRpcProvider(chain.connectRpcUrl);
    const gasPrice = await provider.getGasPrice();

    privateAddresses[chain.chainId] = await deployPrivateInteropStack(
      chain.connectRpcUrl,
      chain.chainId,
      DEFAULT_L1_CHAIN_ID,
      (line) => log(`  ${line}`),
      {
        deployerKey,
        skipFunding,
        destinationChainIds: CHAINS.map((item) => item.chainId),
        fundingGasOverrides: { gasPrice: gasPrice.mul(2), gasLimit: 30_000_000, type: 0 },
        deployGasOverrides: { gasPrice: gasPrice.mul(2), gasLimit: 30_000_000, type: 0 },
        initGasOverrides: { gasPrice: gasPrice.mul(2), gasLimit: 10_000_000, type: 0 },
      }
    );
  }

  log("\n=== Registering private remote routers ===");
  await registerRemoteRouters(
    CHAINS.map((chain) => ({ chainId: chain.chainId, rpcUrl: chain.connectRpcUrl })),
    privateAddresses,
    deployerKey,
    (line) => log(`  ${line}`)
  );

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    l1ChainId: DEFAULT_L1_CHAIN_ID,
    deployerAddress,
    chains: {},
  };

  for (const chain of CHAINS) {
    const addresses = privateAddresses[chain.chainId];
    manifest.chains[String(chain.chainId)] = {
      key: chain.key,
      rpcUrl: chain.rpcUrl,
      connectRpcUrl: chain.connectRpcUrl,
      assetTracker: addresses.assetTracker,
      ntv: addresses.ntv,
      assetRouter: addresses.assetRouter,
      interopCenter: addresses.interopCenter,
      interopHandler: addresses.interopHandler,
    };
  }

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  log(`\nPrivate interop manifest written to ${manifestPath}`);
  return manifest;
}

async function main(): Promise<void> {
  const manifestPath = process.env.PRIVATE_INTEROP_MANIFEST_PATH || DEFAULT_MANIFEST_PATH;
  const forceRedeploy = process.env.PRIVATE_INTEROP_FORCE_REDEPLOY === "1";

  if (!forceRedeploy) {
    const reusable = await loadReusableManifest(manifestPath);
    if (reusable) {
      log(`Reusing existing private interop manifest at ${manifestPath}`);
      await registerRemoteRouters(
        CHAINS.map((chain) => ({ chainId: chain.chainId, rpcUrl: chain.connectRpcUrl })),
        Object.fromEntries(
          Object.entries(reusable.chains).map(([chainId, chain]) => [
            Number(chainId),
            {
              assetTracker: chain.assetTracker,
              ntv: chain.ntv,
              assetRouter: chain.assetRouter,
              interopCenter: chain.interopCenter,
              interopHandler: chain.interopHandler,
            },
          ])
        ),
        process.env.PRIVATE_INTEROP_DEPLOYER_KEY || PRIVATE_DEPLOYER_KEY,
        (line) => log(`  ${line}`)
      );
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({ ...reusable, generatedAt: new Date().toISOString() }, null, 2)
      );
      return;
    }
  }

  await deployFresh(manifestPath);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
