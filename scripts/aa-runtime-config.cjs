#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function readConfig(configPath) {
  const resolvedPath = path.resolve(configPath);
  if (!fs.existsSync(resolvedPath)) {
    fail(`AA contracts config not found: ${resolvedPath}`);
  }

  const raw = fs.readFileSync(resolvedPath, 'utf8').trim();
  if (!raw) {
    fail(`AA contracts config is empty: ${resolvedPath}`);
  }

  return JSON.parse(raw);
}

function main() {
  const [chainKey, configPath = '/workspace/prividium-3chain-local/.runtime/aa-contracts.json'] =
    process.argv.slice(2);

  if (!chainKey) {
    fail('usage: aa-runtime-config.cjs <a|b> [aa-contracts-config-path]');
  }

  const config = readConfig(configPath);
  const chain = config?.chains?.[chainKey];
  if (!chain) {
    fail(`missing chains.${chainKey} in ${configPath}`);
  }

  const entries = {
    ENTRYPOINT: chain.entryPoint,
    ENTRYPOINT_SIMULATION_CONTRACT_V8: chain.entryPointSimulationV8,
    PIMLICO_SIMULATION_CONTRACT: chain.pimlicoSimulation
  };

  for (const [key, value] of Object.entries(entries)) {
    if (!value) {
      fail(`missing ${key} for chain ${chainKey}`);
    }
    process.stdout.write(`export ${key}=${shellQuote(value)}\n`);
  }
}

main();
