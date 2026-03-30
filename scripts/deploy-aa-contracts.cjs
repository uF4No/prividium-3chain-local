#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const requireFromBundler = createRequire('/app/apps/bundler/noop.js');
const { createPublicClient, createWalletClient, defineChain, http } = requireFromBundler(
  '/app/node_modules/.pnpm/node_modules/viem'
);
const { privateKeyToAccount } = requireFromBundler('/app/node_modules/.pnpm/node_modules/viem/accounts');

const EMPTY_CONSTRUCTOR_ABI = [
  {
    type: 'constructor',
    inputs: [],
    stateMutability: 'nonpayable'
  }
];

let logFilePath = null;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function log(message) {
  console.log(message);
  if (!logFilePath) {
    return;
  }

  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
  fs.appendFileSync(logFilePath, `${new Date().toISOString()} ${message}\n`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    fail(`missing required env var ${name}`);
  }
  return value;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveAltoContractsDir() {
  const pnpmRoot = '/app/node_modules/.pnpm';
  const altoEntry = fs.readdirSync(pnpmRoot).find((entry) => entry.startsWith('@pimlico+alto@'));
  if (!altoEntry) {
    fail(`could not find @pimlico/alto under ${pnpmRoot}`);
  }

  return path.join(pnpmRoot, altoEntry, 'node_modules', '@pimlico', 'alto', 'contracts');
}

function loadArtifactBytecode(contractsDir, relativeArtifactPath, contractName) {
  const artifactPath = path.join(contractsDir, relativeArtifactPath);
  if (!fs.existsSync(artifactPath)) {
    fail(`missing ${contractName} artifact at ${artifactPath}`);
  }

  const artifact = readJson(artifactPath);
  const bytecode = artifact?.bytecode?.object;
  if (!bytecode || typeof bytecode !== 'string') {
    fail(`missing bytecode for ${contractName} in ${artifactPath}`);
  }

  return bytecode.startsWith('0x') ? bytecode : `0x${bytecode}`;
}

function readExistingConfig(outputPath) {
  if (!fs.existsSync(outputPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  } catch (error) {
    console.warn(`warning: ignoring unreadable ${outputPath}: ${error.message}`);
    return {};
  }
}

function makeChain(label, id, rpcUrl) {
  return {
    label,
    id,
    rpcUrl
  };
}

async function hasCode(publicClient, address) {
  if (!address) {
    return false;
  }

  const code = await publicClient.getBytecode({ address });
  return !!code && code !== '0x';
}

async function ensureContract(publicClient, walletClient, contractName, bytecode, configuredAddress) {
  if (configuredAddress && (await hasCode(publicClient, configuredAddress))) {
    return { address: configuredAddress, deployed: false };
  }

  if (configuredAddress) {
    log(`configured ${contractName} ${configuredAddress} has no code, redeploying`);
  } else {
    log(`deploying ${contractName}`);
  }

  const hash = await walletClient.deployContract({
    abi: EMPTY_CONSTRUCTOR_ABI,
    bytecode,
    args: [],
    gasPrice: 0n
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`failed to deploy ${contractName} (tx: ${hash})`);
  }

  return { address: receipt.contractAddress, deployed: true };
}

async function deployChain(chain, privateKey, existingChain, artifacts) {
  log(`Deploying AA support contracts on chain ${chain.label} (${chain.rpcUrl})`);

  const account = privateKeyToAccount(privateKey);
  const viemChain = defineChain({
    id: chain.id,
    name: `Prividium ${chain.label}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
      default: { http: [chain.rpcUrl] },
      public: { http: [chain.rpcUrl] }
    }
  });

  const transport = http(chain.rpcUrl);
  const publicClient = createPublicClient({ chain: viemChain, transport });
  const walletClient = createWalletClient({ chain: viemChain, transport, account });

  const entryPoint = await ensureContract(
    publicClient,
    walletClient,
    'EntryPoint',
    artifacts.entryPoint,
    existingChain?.entryPoint
  );
  const entryPointSimulationV8 = await ensureContract(
    publicClient,
    walletClient,
    'EntryPointSimulations08',
    artifacts.entryPointSimulationV8,
    existingChain?.entryPointSimulationV8
  );
  const pimlicoSimulation = await ensureContract(
    publicClient,
    walletClient,
    'PimlicoSimulations',
    artifacts.pimlicoSimulation,
    existingChain?.pimlicoSimulation
  );

  return {
    entryPoint: entryPoint.address,
    entryPointSimulationV8: entryPointSimulationV8.address,
    pimlicoSimulation: pimlicoSimulation.address,
    deployed: {
      entryPoint: entryPoint.deployed,
      entryPointSimulationV8: entryPointSimulationV8.deployed,
      pimlicoSimulation: pimlicoSimulation.deployed
    }
  };
}

async function main() {
  const outputPath = path.resolve(
    process.env.AA_CONTRACTS_OUTPUT_PATH ||
      '/workspace/prividium-3chain-local/.runtime/aa-contracts.json'
  );
  logFilePath = path.resolve(
    process.env.AA_CONTRACTS_LOG_PATH || path.join(path.dirname(outputPath), 'aa-contracts-deploy.log')
  );
  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
  fs.writeFileSync(logFilePath, '');
  const privateKey = requireEnv('DEPLOYER_PRIVATE_KEY');
  const chainA = makeChain(
    'A',
    Number(requireEnv('CHAIN_A_ID')),
    requireEnv('CHAIN_A_RPC_URL')
  );
  const chainB = makeChain(
    'B',
    Number(requireEnv('CHAIN_B_ID')),
    requireEnv('CHAIN_B_RPC_URL')
  );

  const contractsDir = resolveAltoContractsDir();
  const artifacts = {
    entryPoint: loadArtifactBytecode(contractsDir, 'EntryPoint.sol/EntryPoint.json', 'EntryPoint'),
    entryPointSimulationV8: loadArtifactBytecode(
      contractsDir,
      'EntryPointSimulations.sol/EntryPointSimulations08.json',
      'EntryPointSimulations08'
    ),
    pimlicoSimulation: loadArtifactBytecode(
      contractsDir,
      'PimlicoSimulations.sol/PimlicoSimulations.json',
      'PimlicoSimulations'
    )
  };

  const existing = readExistingConfig(outputPath);
  const result = {
    generatedAt: new Date().toISOString(),
    chains: {
      a: await deployChain(chainA, privateKey, existing?.chains?.a, artifacts),
      b: await deployChain(chainB, privateKey, existing?.chains?.b, artifacts)
    }
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);

  log(`Wrote ${outputPath}`);
}

main().catch((error) => {
  console.error('\nAA contract deployment failed:');
  console.error(error);
  process.exit(1);
});
