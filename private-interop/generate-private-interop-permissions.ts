#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import { getAbi } from "./src/core/contracts";

type Manifest = {
  chains: Record<
    string,
    {
      key: string;
      assetTracker: string;
      ntv: string;
      assetRouter: string;
      interopCenter: string;
      interopHandler: string;
    }
  >;
};

type ContractSpec = {
  contractName: "PrivateInteropCenter" | "PrivateInteropHandler" | "PrivateL2NativeTokenVault" | "PrivateL2AssetRouter" | "PrivateL2AssetTracker";
  label: string;
  address: string;
  methods: string[];
};

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_MANIFEST_PATH = path.join(REPO_ROOT, ".runtime/private-interop.json");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, ".runtime");

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function loadManifest(): Manifest {
  const manifestPath = process.env.PRIVATE_INTEROP_MANIFEST_PATH || DEFAULT_MANIFEST_PATH;
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing private interop manifest at ${manifestPath}`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Manifest;
}

function buildContractSpecs(chain: Manifest["chains"][string]): ContractSpec[] {
  return [
    {
      contractName: "PrivateInteropCenter",
      label: "Private Interop Center",
      address: chain.interopCenter,
      methods: ["sendBundle(bytes,(bytes,bytes,bytes[])[],bytes[])"],
    },
    {
      contractName: "PrivateInteropHandler",
      label: "Private Interop Handler",
      address: chain.interopHandler,
      methods: ["getShadowAccountAddress(uint256,address)", "getShadowAccountAddress(address)", "bundleStatus(bytes32)"],
    },
    {
      contractName: "PrivateL2NativeTokenVault",
      label: "Private Native Token Vault",
      address: chain.ntv,
      methods: ["assetId(address)", "tokenAddress(bytes32)", "registerToken(address)"],
    },
    {
      contractName: "PrivateL2AssetRouter",
      label: "Private L2 Asset Router",
      address: chain.assetRouter,
      methods: [],
    },
    {
      contractName: "PrivateL2AssetTracker",
      label: "Private L2 Asset Tracker",
      address: chain.assetTracker,
      methods: [],
    },
  ];
}

function getSuffix(chainKey: string): string {
  if (chainKey.endsWith("a")) return "l2a";
  if (chainKey.endsWith("b")) return "l2b";
  if (chainKey.endsWith("c")) return "l2c";
  return chainKey;
}

function buildSql(chainId: number, chain: Manifest["chains"][string]): string {
  const lines: string[] = [];
  lines.push(`-- Auto-generated private interop permissions for chain ${chainId}`);
  lines.push("");

  for (const spec of buildContractSpecs(chain)) {
    const abi = JSON.stringify(getAbi(spec.contractName));
    lines.push(
      `INSERT INTO contracts (contract_address, abi, name, description, disclose_erc_20_balance, disclose_bytecode, template_id) VALUES (` +
        `decode('${spec.address.slice(2).toLowerCase()}', 'hex'), ` +
        `'${escapeSql(abi)}', ` +
        `'${escapeSql(spec.label)}', ` +
        `NULL, false, false, NULL` +
        `) ON CONFLICT (contract_address) DO NOTHING;`
    );
  }

  lines.push("");
  const permissions: string[] = [];
  for (const spec of buildContractSpecs(chain)) {
    if (spec.methods.length === 0) continue;
    const iface = new ethers.utils.Interface(getAbi(spec.contractName));
    for (const signature of spec.methods) {
      if (!iface.functions[signature]) {
        continue;
      }
      const selector = iface.getSighash(signature).slice(2).toLowerCase();
      const accessType = signature.startsWith("get") || signature.startsWith("assetId") || signature.startsWith("tokenAddress") || signature.startsWith("bundleStatus")
        ? "read"
        : "write";
      permissions.push(
        `(` +
          `decode('${spec.address.slice(2).toLowerCase()}', 'hex'), ` +
          `decode('${selector}', 'hex'), ` +
          `'function ${escapeSql(signature)}', ` +
          `'public', ` +
          `'${accessType}'` +
          `)`
      );
    }
  }

  if (permissions.length > 0) {
    lines.push(
      "INSERT INTO contract_function_permissions (contract_address, method_selector, function_signature, rule_type, access_type)"
    );
    lines.push(`VALUES`);
    lines.push(permissions.join(",\n"));
    lines.push("ON CONFLICT (contract_address, method_selector) DO NOTHING;");
  }

  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const manifest = loadManifest();
  const outputDir = process.env.PRIVATE_INTEROP_PERMISSIONS_OUTPUT_DIR || DEFAULT_OUTPUT_DIR;
  fs.mkdirSync(outputDir, { recursive: true });

  for (const [chainId, chain] of Object.entries(manifest.chains)) {
    const suffix = getSuffix(chain.key);
    const outputPath = path.join(outputDir, `private-permissions-${suffix}.sql`);
    fs.writeFileSync(outputPath, buildSql(Number(chainId), chain));
    console.log(`Wrote ${outputPath}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
