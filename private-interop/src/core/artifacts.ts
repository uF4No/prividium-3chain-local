/**
 * Low-level artifact loading from forge build output.
 *
 * This module is intentionally dependency-free (no imports from ./contracts or ./utils)
 * to serve as the foundation that both contracts.ts and utils.ts can import from
 * without circular dependencies.
 */
import type { JsonFragment } from "@ethersproject/abi";
import * as fs from "fs";
import * as path from "path";

function findPackageRoot(startDir: string): string {
  let current = startDir;
  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not locate package.json from ${startDir}`);
    }
    current = parent;
  }
}

const PACKAGE_ROOT = findPackageRoot(__dirname);
const ZKSTACK_OUT_ROOT = path.join(PACKAGE_ROOT, "zkstack-out");
const FORGE_OUT_ROOT = path.join(PACKAGE_ROOT, "out");

interface ForgeArtifact {
  abi: JsonFragment[];
  bytecode?: { object?: string };
  deployedBytecode?: { object?: string };
}

function loadArtifactFromOut(artifactRelativePath: string): ForgeArtifact {
  const artifactPath = path.join(FORGE_OUT_ROOT, artifactRelativePath);
  return JSON.parse(fs.readFileSync(artifactPath, "utf-8")) as ForgeArtifact;
}

/**
 * Load an ABI array from compiled artifacts.
 * Prefers zkstack-out/ (committed, ABI-only files) over out/ (forge build output).
 */
export function loadAbiFromOut(artifactRelativePath: string): JsonFragment[] {
  const zkstackPath = path.join(ZKSTACK_OUT_ROOT, artifactRelativePath);
  if (fs.existsSync(zkstackPath)) {
    return JSON.parse(fs.readFileSync(zkstackPath, "utf-8")) as JsonFragment[];
  }
  return loadArtifactFromOut(artifactRelativePath).abi;
}

/** Load deployed (runtime) bytecode. */
export function loadBytecodeFromOut(artifactRelativePath: string): string {
  const artifact = loadArtifactFromOut(artifactRelativePath);
  return artifact.deployedBytecode?.object || artifact.bytecode?.object || "0x";
}

/** Load creation (init) bytecode — needed for ContractFactory.deploy(). */
export function loadCreationBytecodeFromOut(artifactRelativePath: string): string {
  const artifact = loadArtifactFromOut(artifactRelativePath);
  return artifact.bytecode?.object || "0x";
}
