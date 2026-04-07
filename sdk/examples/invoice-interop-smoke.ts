import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import {
  BundleStatus,
  BundleBuilder,
  CallBuilder,
  executeBundle,
  getBundleOnChainStatus,
  getShadowAccountAddress,
  sendBundle,
  waitForBundleFinalization,
  waitUntilRootAvailable,
} from '../src';

const DEFAULT_ADMIN_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_BYTES32 = ethers.ZeroHash;
const POLL_MS = Number(process.env.INTEROP_POLL_MS ?? 3000);
const TIMEOUT_MS = Number(process.env.INTEROP_TIMEOUT_MS ?? 180000);
const BUNDLE_ALREADY_PROCESSED_SELECTOR = '0x5bba5111';

const ERC20_ABI = [
  'function mint(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function symbol() view returns (string)',
] as const;

const INVOICE_ABI = [
  'function admin() view returns (address)',
  'function crossChainFee() view returns (uint256)',
  'function whitelistToken(address token, string symbol)',
  'function getWhitelistedTokens() view returns (address[] tokenAddresses, string[] symbols)',
  'function exchangeRates(address token1, address token2) view returns (uint256)',
  'function setExchangeRate(address token1, address token2, uint256 rate)',
  'function getConversionAmount(address fromToken, address toToken, uint256 amount) view returns (uint256)',
  'function creatorPayoutInitiated(uint256 invoiceId) view returns (bool)',
  'function getUserCreatedInvoiceCount(address user) view returns (uint256)',
  'function getUserCreatedInvoices(address user, uint256 startIndex, uint256 endIndex) view returns (uint256[])',
  'function getInvoiceDetails(uint256 invoiceId) view returns ((uint256 id,address creator,address recipient,address creatorRefundAddress,address recipientRefundAddress,uint256 creatorChainId,uint256 recipientChainId,address billingToken,uint256 amount,address paymentToken,uint256 paymentAmount,uint8 status,uint256 createdAt,uint256 paidAt,string text))',
  'function createInvoice(address recipient, uint256 recipientChainId, address billingToken, uint256 amount, uint256 creatorChainId, address creatorRefundAddress, address recipientRefundAddress, string text) returns (uint256 invoiceId)',
  'function cancelInvoice(uint256 invoiceId)',
  'function payInvoice(uint256 invoiceId, address paymentToken) payable',
  'function triggerCreatorPayout(uint256 invoiceId)',
] as const;

const NATIVE_TOKEN_VAULT_ABI = [
  'function assetId(address token) view returns (bytes32)',
] as const;

const EXCHANGE_RATES = [
  { from: 'sgd', to: 'usdc', rate: ethers.parseUnits('0.74', 18) },
  { from: 'sgd', to: 'tbill', rate: ethers.parseUnits('0.74', 18) },
  { from: 'tbill', to: 'usdc', rate: ethers.parseUnits('1.02', 18) },
] as const;

enum InvoiceStatus {
  Created = 0,
  Paid = 1,
  Cancelled = 2,
}

type TokenKey = 'usdc' | 'sgd' | 'tbill';
type ChainKey = 'a' | 'b' | 'c';

type TokenDeployment = {
  address?: string;
  assetId?: string;
};

type ChainDeployment = {
  chainId?: number;
  rpcUrl?: string;
  nativeTokenVault?: string;
  tokens?: Partial<Record<TokenKey, TokenDeployment>>;
};

type ContractsConfig = {
  chains?: Partial<Record<ChainKey, ChainDeployment>>;
};

type ChainContext = {
  key: 'A' | 'B' | 'C';
  chainId: bigint;
  provider: ethers.JsonRpcProvider;
  admin: ethers.Wallet;
};

type TokenSet = Record<TokenKey, string>;

type InvoiceDetails = {
  id: bigint;
  creator: string;
  recipient: string;
  creatorRefundAddress: string;
  recipientRefundAddress: string;
  creatorChainId: bigint;
  recipientChainId: bigint;
  billingToken: string;
  amount: bigint;
  paymentToken: string;
  paymentAmount: bigint;
  status: bigint;
  createdAt: bigint;
  paidAt: bigint;
  text: string;
};

function fail(message: string): never {
  throw new Error(message);
}

function repoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

function resolveConfigPath(): string {
  const configured = process.env.CONTRACTS_CONFIG_PATH?.trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(process.cwd(), configured);
  }

  return path.resolve(repoRoot(), 'config', 'contracts.json');
}

function resolveArtifactPath(): string {
  return path.resolve(
    repoRoot(),
    'contracts',
    'out',
    'InvoicePayment.sol',
    'InvoicePayment.json',
  );
}

function readJsonFile<T>(filePath: string): T {
  if (!fs.existsSync(filePath)) {
    fail(`Missing required file: ${filePath}`);
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function normalizeAddress(value: string | undefined, label: string): string {
  if (!value) {
    fail(`Missing ${label}`);
  }

  try {
    return ethers.getAddress(value);
  } catch {
    fail(`Invalid ${label}: ${value}`);
  }
}

function normalizeRpcUrl(chainConfig: ChainDeployment | undefined, envKey: string, label: string): string {
  const override = process.env[envKey]?.trim();
  if (override) {
    return override;
  }

  const fromConfig = chainConfig?.rpcUrl?.trim();
  if (!fromConfig) {
    fail(`Missing RPC URL for chain ${label}`);
  }
  return fromConfig;
}

function requireChainConfig(config: ContractsConfig, key: ChainKey): ChainDeployment {
  const chain = config.chains?.[key];
  if (!chain) {
    fail(`Missing chain ${key.toUpperCase()} in contracts config`);
  }
  return chain;
}

function requireChainId(chainConfig: ChainDeployment, label: string): bigint {
  if (!chainConfig.chainId) {
    fail(`Missing chain ID for chain ${label}`);
  }
  return BigInt(chainConfig.chainId);
}

function requireNativeTokenVault(chainConfig: ChainDeployment, label: string): string {
  return normalizeAddress(chainConfig.nativeTokenVault, `nativeTokenVault for chain ${label}`);
}

function requireTokenSet(chainConfig: ChainDeployment, label: string): TokenSet {
  const tokens = chainConfig.tokens;
  if (!tokens) {
    fail(`Missing tokens for chain ${label}`);
  }

  return {
    usdc: normalizeAddress(tokens.usdc?.address, `${label} USDC address`),
    sgd: normalizeAddress(tokens.sgd?.address, `${label} SGD address`),
    tbill: normalizeAddress(tokens.tbill?.address, `${label} TBILL address`),
  };
}

async function ensureCode(provider: ethers.Provider, address: string, label: string): Promise<void> {
  const code = await provider.getCode(address);
  if (!code || code === '0x') {
    fail(`No contract code found for ${label} at ${address}`);
  }
}

async function ensureNativeBalance(
  admin: ethers.Wallet,
  recipient: string,
  minimumBalance: bigint,
): Promise<void> {
  const provider = admin.provider;
  if (!provider) {
    fail('Admin wallet is missing a provider');
  }

  const current = await provider.getBalance(recipient);
  if (current >= minimumBalance) {
    return;
  }

  const tx = await admin.sendTransaction({
    to: recipient,
    value: minimumBalance - current,
  });
  await tx.wait();
}

async function ensureContractEthBalance(
  admin: ethers.Wallet,
  contractAddress: string,
  minimumBalance: bigint,
): Promise<void> {
  await ensureNativeBalance(admin, contractAddress, minimumBalance);
}

async function mintToken(tokenAddress: string, admin: ethers.Wallet, recipient: string, amount: bigint): Promise<void> {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, admin);
  const tx = await token.mint(recipient, amount);
  await tx.wait();
}

async function getTokenBalance(
  provider: ethers.Provider,
  tokenAddress: string,
  account: string,
): Promise<bigint> {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  return (await token.balanceOf(account)) as bigint;
}

async function waitForTokenBalanceAtLeast(args: {
  provider: ethers.Provider;
  tokenAddress: string;
  account: string;
  expectedMinimum: bigint;
  label: string;
}): Promise<bigint> {
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const balance = await getTokenBalance(args.provider, args.tokenAddress, args.account);
    if (balance >= args.expectedMinimum) {
      return balance;
    }
    await sleep(POLL_MS);
  }

  const finalBalance = await getTokenBalance(args.provider, args.tokenAddress, args.account);
  fail(
    `${args.label} did not reach expected balance. expected>=${args.expectedMinimum} got=${finalBalance}`,
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function deployInvoicePayment(admin: ethers.Wallet): Promise<ethers.Contract> {
  const artifact = readJsonFile<{ abi: unknown; bytecode?: { object?: string } }>(resolveArtifactPath());
  const bytecode = artifact.bytecode?.object;
  if (!bytecode) {
    fail(`InvoicePayment artifact missing bytecode: ${resolveArtifactPath()}`);
  }

  const factory = new ethers.ContractFactory(
    artifact.abi as ethers.InterfaceAbi,
    bytecode,
    admin,
  );
  const contract = (await factory.deploy(admin.address)) as ethers.Contract;
  await contract.waitForDeployment();
  return contract;
}

async function ensureWhitelist(invoice: ethers.Contract, tokenAddress: string, symbol: string): Promise<void> {
  const [tokenAddresses] = (await invoice.getWhitelistedTokens()) as [string[], string[]];
  const alreadyWhitelisted = tokenAddresses.some(
    (candidate) => candidate.toLowerCase() === tokenAddress.toLowerCase(),
  );
  if (alreadyWhitelisted) {
    return;
  }

  const tx = await invoice.whitelistToken(tokenAddress, symbol);
  await tx.wait();
}

async function ensureExchangeRate(
  invoice: ethers.Contract,
  fromToken: string,
  toToken: string,
  expectedRate: bigint,
): Promise<void> {
  const current = (await invoice.exchangeRates(fromToken, toToken)) as bigint;
  if (current === expectedRate) {
    return;
  }

  const tx = await invoice.setExchangeRate(fromToken, toToken, expectedRate);
  await tx.wait();
}

async function assertRegisteredAssetId(
  provider: ethers.Provider,
  nativeTokenVault: string,
  tokenAddress: string,
  label: string,
): Promise<void> {
  const vault = new ethers.Contract(nativeTokenVault, NATIVE_TOKEN_VAULT_ABI, provider);
  const assetId = (await vault.assetId(tokenAddress)) as string;
  if (assetId === ZERO_BYTES32) {
    fail(`${label} is not registered in the Native Token Vault: ${tokenAddress}`);
  }
}

async function sendInteropBundleAndWait(args: {
  label: string;
  sourceWallet: ethers.Signer;
  destinationProvider: ethers.Provider;
  destinationExecutor: ethers.Signer;
  builder: BundleBuilder;
}): Promise<void> {
  console.log(`\n=== ${args.label} ===`);

  const sourceProvider = args.sourceWallet.provider;
  if (!sourceProvider) {
    fail(`${args.label}: source wallet is missing a provider`);
  }

  const handle = await sendBundle(args.sourceWallet, args.builder);
  console.log(`sent bundle: ${handle.bundleHash}`);
  console.log(`source tx: ${handle.txHash}`);

  const finalization = await waitForBundleFinalization(sourceProvider, handle, {
    pollInterval: POLL_MS,
    timeout: TIMEOUT_MS,
  });
  console.log(`source finalized in batch ${finalization.expectedRoot.batchNumber}`);

  await waitUntilRootAvailable(args.destinationProvider, finalization.expectedRoot, {
    pollInterval: POLL_MS,
    timeout: TIMEOUT_MS,
  });
  console.log('destination root available');

  const destinationStatus = await getBundleOnChainStatus(
    args.destinationProvider,
    handle.bundleHash,
  );
  if (
    destinationStatus === BundleStatus.FullyExecuted ||
    destinationStatus === BundleStatus.Unbundled
  ) {
    console.log(`destination bundle already processed with status ${destinationStatus}`);
    return;
  }

  try {
    const receipt = await executeBundle(args.destinationExecutor, finalization);
    console.log(`bundle executed on destination tx ${receipt.hash}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusAfterFailure = await getBundleOnChainStatus(
      args.destinationProvider,
      handle.bundleHash,
    );
    if (
      statusAfterFailure === BundleStatus.FullyExecuted ||
      statusAfterFailure === BundleStatus.Unbundled
    ) {
      console.log(
        `destination bundle finished externally after execution attempt; final status ${statusAfterFailure}`,
      );
      return;
    }
    if (
      message.includes(BUNDLE_ALREADY_PROCESSED_SELECTOR) ||
      message.includes('BundleAlreadyProcessed') ||
      message.includes('already been executed') ||
      message.includes('has been unbundled and cannot be executed as a whole')
    ) {
      console.log(`destination bundle was already processed externally: ${message}`);
      return;
    }
    throw error;
  }
}

function toInvoiceDetails(raw: unknown): InvoiceDetails {
  const invoice = raw as InvoiceDetails;
  return {
    id: invoice.id,
    creator: ethers.getAddress(invoice.creator),
    recipient: ethers.getAddress(invoice.recipient),
    creatorRefundAddress: ethers.getAddress(invoice.creatorRefundAddress),
    recipientRefundAddress: ethers.getAddress(invoice.recipientRefundAddress),
    creatorChainId: invoice.creatorChainId,
    recipientChainId: invoice.recipientChainId,
    billingToken: ethers.getAddress(invoice.billingToken),
    amount: invoice.amount,
    paymentToken:
      invoice.paymentToken && invoice.paymentToken !== ZERO_ADDRESS
        ? ethers.getAddress(invoice.paymentToken)
        : ZERO_ADDRESS,
    paymentAmount: invoice.paymentAmount,
    status: invoice.status,
    createdAt: invoice.createdAt,
    paidAt: invoice.paidAt,
    text: invoice.text,
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    fail(message);
  }
}

async function main() {
  const configPath = resolveConfigPath();
  const config = readJsonFile<ContractsConfig>(configPath);

  const chainAConfig = requireChainConfig(config, 'a');
  const chainBConfig = requireChainConfig(config, 'b');
  const chainCConfig = requireChainConfig(config, 'c');

  const adminPrivateKey = process.env.ADMIN_PRIVATE_KEY?.trim() || DEFAULT_ADMIN_PRIVATE_KEY;

  const chainAProvider = new ethers.JsonRpcProvider(
    normalizeRpcUrl(chainAConfig, 'L2A_RPC', 'A'),
  );
  const chainBProvider = new ethers.JsonRpcProvider(
    normalizeRpcUrl(chainBConfig, 'L2B_RPC', 'B'),
  );
  const chainCProvider = new ethers.JsonRpcProvider(
    normalizeRpcUrl(chainCConfig, 'L2C_RPC', 'C'),
  );

  const chainA: ChainContext = {
    key: 'A',
    chainId: requireChainId(chainAConfig, 'A'),
    provider: chainAProvider,
    admin: new ethers.Wallet(adminPrivateKey, chainAProvider),
  };
  const chainB: ChainContext = {
    key: 'B',
    chainId: requireChainId(chainBConfig, 'B'),
    provider: chainBProvider,
    admin: new ethers.Wallet(adminPrivateKey, chainBProvider),
  };
  const chainC: ChainContext = {
    key: 'C',
    chainId: requireChainId(chainCConfig, 'C'),
    provider: chainCProvider,
    admin: new ethers.Wallet(adminPrivateKey, chainCProvider),
  };

  const tokensA = requireTokenSet(chainAConfig, 'chain A');
  const tokensC = requireTokenSet(chainCConfig, 'chain C');
  const nativeTokenVaultC = requireNativeTokenVault(chainCConfig, 'C');

  console.log(`Using contracts config: ${configPath}`);
  console.log(`Chain A: ${chainA.chainId} ${chainAProvider._getConnection().url}`);
  console.log(`Chain B: ${chainB.chainId} ${chainBProvider._getConnection().url}`);
  console.log(`Chain C: ${chainC.chainId} ${chainCProvider._getConnection().url}`);
  console.log(`Admin deployer: ${chainC.admin.address}`);

  await Promise.all([
    ensureCode(chainA.provider, tokensA.sgd, 'chain A SGD'),
    ensureCode(chainC.provider, tokensC.usdc, 'chain C USDC'),
    ensureCode(chainC.provider, tokensC.sgd, 'chain C SGD'),
    ensureCode(chainC.provider, tokensC.tbill, 'chain C TBILL'),
  ]);

  await Promise.all([
    assertRegisteredAssetId(chainC.provider, nativeTokenVaultC, tokensC.usdc, 'chain C USDC'),
    assertRegisteredAssetId(chainC.provider, nativeTokenVaultC, tokensC.sgd, 'chain C SGD'),
    assertRegisteredAssetId(chainC.provider, nativeTokenVaultC, tokensC.tbill, 'chain C TBILL'),
  ]);

  const creatorA = ethers.Wallet.createRandom().connect(chainA.provider);
  const actorB = ethers.Wallet.createRandom().connect(chainB.provider);
  const creatorC = ethers.Wallet.createRandom().connect(chainC.provider);
  const creatorAOnC = new ethers.Wallet(creatorA.privateKey, chainC.provider);
  const actorBOnC = new ethers.Wallet(actorB.privateKey, chainC.provider);

  await Promise.all([
    ensureNativeBalance(chainA.admin, creatorA.address, ethers.parseEther('0.05')),
    ensureNativeBalance(chainB.admin, actorB.address, ethers.parseEther('0.05')),
  ]);
  await ensureNativeBalance(chainC.admin, creatorAOnC.address, ethers.parseEther('0.05'));
  await ensureNativeBalance(chainC.admin, actorBOnC.address, ethers.parseEther('0.05'));
  await ensureNativeBalance(chainC.admin, creatorC.address, ethers.parseEther('0.05'));

  console.log(`Random creator on A: ${creatorA.address}`);
  console.log(`Random actor on B: ${actorB.address}`);
  console.log(`Random creator on C: ${creatorC.address}`);

  const creatorShadowOnC = await getShadowAccountAddress(
    chainC.provider,
    chainA.chainId,
    creatorA.address,
  );
  const actorBShadowOnC = await getShadowAccountAddress(
    chainC.provider,
    chainB.chainId,
    actorB.address,
  );

  console.log(`Creator shadow on C: ${creatorShadowOnC}`);
  console.log(`Actor B shadow on C: ${actorBShadowOnC}`);

  const invoice = await deployInvoicePayment(chainC.admin);
  const invoiceAddress = await invoice.getAddress();
  console.log(`Deployed InvoicePayment on C: ${invoiceAddress}`);
  await ensureContractEthBalance(chainC.admin, invoiceAddress, ethers.parseEther('0.05'));

  const crossChainFee = (await invoice.crossChainFee()) as bigint;
  const fundInvoiceTx = await chainC.admin.sendTransaction({
    to: invoiceAddress,
    value: crossChainFee * 50n,
  });
  await fundInvoiceTx.wait();

  await ensureWhitelist(invoice, tokensC.usdc, 'USDC');
  await ensureWhitelist(invoice, tokensC.sgd, 'SGD');
  await ensureWhitelist(invoice, tokensC.tbill, 'TBILL');

  for (const rate of EXCHANGE_RATES) {
    await ensureExchangeRate(invoice, tokensC[rate.from], tokensC[rate.to], rate.rate);
  }

  await mintToken(tokensC.sgd, chainC.admin, invoiceAddress, ethers.parseUnits('10000', 18));
  await mintToken(tokensC.usdc, chainC.admin, invoiceAddress, ethers.parseUnits('10000', 18));
  await mintToken(tokensC.tbill, chainC.admin, invoiceAddress, ethers.parseUnits('10000', 18));
  await mintToken(tokensC.sgd, chainC.admin, actorBShadowOnC, ethers.parseUnits('500', 18));
  await mintToken(tokensC.usdc, chainC.admin, actorBShadowOnC, ethers.parseUnits('500', 18));

  const invoiceInterface = new ethers.Interface(INVOICE_ABI);
  const erc20Interface = new ethers.Interface(ERC20_ABI);

  const scenarioOneBillingAmount = ethers.parseUnits('100', 18);
  const createdByACountBefore = (await invoice.getUserCreatedInvoiceCount(creatorA.address)) as bigint;

  const createScenarioOneCalldata = invoiceInterface.encodeFunctionData('createInvoice', [
    actorB.address,
    chainB.chainId,
    tokensC.sgd,
    scenarioOneBillingAmount,
    chainA.chainId,
    creatorA.address,
    actorB.address,
    'Smoke scenario 1: A creates, A cancels',
  ]);

  await sendInteropBundleAndWait({
    label: 'Scenario 1: create invoice from chain A into chain C',
    sourceWallet: creatorA,
    destinationProvider: chainC.provider,
    destinationExecutor: creatorAOnC,
    builder: new BundleBuilder(chainC.chainId)
      .addShadowAccountCall(invoiceAddress, createScenarioOneCalldata)
      .withUnbundler(creatorAOnC.address),
  });

  const createdByACountAfter = (await invoice.getUserCreatedInvoiceCount(creatorA.address)) as bigint;
  assert(
    createdByACountAfter === createdByACountBefore + 1n,
    `Expected A creator invoice count to increase by 1, got before=${createdByACountBefore} after=${createdByACountAfter}`,
  );

  const [scenarioOneInvoiceId] = (await invoice.getUserCreatedInvoices(
    creatorA.address,
    createdByACountBefore,
    createdByACountAfter,
  )) as bigint[];
  const scenarioOneAfterCreate = toInvoiceDetails(
    await invoice.getInvoiceDetails(scenarioOneInvoiceId),
  );

  assert(
    scenarioOneAfterCreate.status === BigInt(InvoiceStatus.Created),
    `Scenario 1 invoice should be Created, got status=${scenarioOneAfterCreate.status}`,
  );
  assert(
    scenarioOneAfterCreate.creator === ethers.getAddress(creatorShadowOnC),
    `Scenario 1 creator should be the A shadow account, got ${scenarioOneAfterCreate.creator}`,
  );
  assert(
    scenarioOneAfterCreate.creatorRefundAddress === creatorA.address,
    'Scenario 1 creator refund address mismatch',
  );
  assert(
    scenarioOneAfterCreate.recipientRefundAddress === actorB.address,
    'Scenario 1 recipient refund address mismatch',
  );

  const cancelScenarioOneCalldata = invoiceInterface.encodeFunctionData('cancelInvoice', [
    scenarioOneInvoiceId,
  ]);

  await sendInteropBundleAndWait({
    label: 'Scenario 1: cancel invoice from chain A into chain C',
    sourceWallet: creatorA,
    destinationProvider: chainC.provider,
    destinationExecutor: creatorAOnC,
    builder: new BundleBuilder(chainC.chainId)
      .addShadowAccountCall(invoiceAddress, cancelScenarioOneCalldata)
      .withUnbundler(creatorAOnC.address),
  });

  const scenarioOneAfterCancel = toInvoiceDetails(
    await invoice.getInvoiceDetails(scenarioOneInvoiceId),
  );

  assert(
    scenarioOneAfterCancel.status === BigInt(InvoiceStatus.Cancelled),
    `Scenario 1 invoice should be Cancelled, got status=${scenarioOneAfterCancel.status}`,
  );

  const createdByBCountBefore = (await invoice.getUserCreatedInvoiceCount(actorB.address)) as bigint;

  const scenarioTwoBillingAmount = ethers.parseUnits('50', 18);
  const createScenarioTwoCalldata = invoiceInterface.encodeFunctionData('createInvoice', [
    creatorA.address,
    chainA.chainId,
    tokensC.tbill,
    scenarioTwoBillingAmount,
    chainB.chainId,
    actorB.address,
    creatorA.address,
    'Smoke scenario 2: B creates, B cancels',
  ]);

  await sendInteropBundleAndWait({
    label: 'Scenario 2: create invoice from chain B into chain C',
    sourceWallet: actorB,
    destinationProvider: chainC.provider,
    destinationExecutor: actorBOnC,
    builder: new BundleBuilder(chainC.chainId)
      .addShadowAccountCall(invoiceAddress, createScenarioTwoCalldata)
      .withUnbundler(actorBOnC.address),
  });

  const createdByBCountAfter = (await invoice.getUserCreatedInvoiceCount(actorB.address)) as bigint;
  assert(
    createdByBCountAfter === createdByBCountBefore + 1n,
    `Expected B creator invoice count to increase by 1, got before=${createdByBCountBefore} after=${createdByBCountAfter}`,
  );

  const [scenarioTwoInvoiceId] = (await invoice.getUserCreatedInvoices(
    actorB.address,
    createdByBCountBefore,
    createdByBCountAfter,
  )) as bigint[];
  const scenarioTwoAfterCreate = toInvoiceDetails(
    await invoice.getInvoiceDetails(scenarioTwoInvoiceId),
  );

  assert(
    scenarioTwoAfterCreate.status === BigInt(InvoiceStatus.Created),
    `Scenario 2 invoice should be Created, got status=${scenarioTwoAfterCreate.status}`,
  );
  assert(
    scenarioTwoAfterCreate.creator === ethers.getAddress(actorBShadowOnC),
    `Scenario 2 creator should be the B shadow account, got ${scenarioTwoAfterCreate.creator}`,
  );
  assert(
    scenarioTwoAfterCreate.amount === scenarioTwoBillingAmount,
    `Scenario 2 amount mismatch: expected=${scenarioTwoBillingAmount} got=${scenarioTwoAfterCreate.amount}`,
  );

  const cancelScenarioTwoCalldata = invoiceInterface.encodeFunctionData('cancelInvoice', [
    scenarioTwoInvoiceId,
  ]);

  await sendInteropBundleAndWait({
    label: 'Scenario 2: cancel invoice from chain B into chain C',
    sourceWallet: actorB,
    destinationProvider: chainC.provider,
    destinationExecutor: actorBOnC,
    builder: new BundleBuilder(chainC.chainId)
      .addShadowAccountCall(invoiceAddress, cancelScenarioTwoCalldata)
      .withUnbundler(actorBOnC.address),
  });

  const scenarioTwoAfterCancel = toInvoiceDetails(
    await invoice.getInvoiceDetails(scenarioTwoInvoiceId),
  );
  assert(
    scenarioTwoAfterCancel.status === BigInt(InvoiceStatus.Cancelled),
    `Scenario 2 invoice should be Cancelled, got status=${scenarioTwoAfterCancel.status}`,
  );

  const scenarioThreeBillingAmount = ethers.parseUnits('100', 18);
  const scenarioThreePaymentAmount = (await invoice.getConversionAmount(
    tokensC.sgd,
    tokensC.usdc,
    scenarioThreeBillingAmount,
  )) as bigint;
  console.log(
    'Scenario 3 uses a chain C creator so payInvoice can be exercised from chain B without a nested payout back out of chain C.',
  );
  assert(
    scenarioThreePaymentAmount === ethers.parseUnits('74', 18),
    `Unexpected payment amount for scenario 3 SGD->USDC conversion: ${scenarioThreePaymentAmount}`,
  );

  const createdByCCountBefore = (await invoice.getUserCreatedInvoiceCount(creatorC.address)) as bigint;
  const creatorCSgdBalanceBefore = await getTokenBalance(chainC.provider, tokensC.sgd, creatorC.address);
  const actorBUsdcShadowBalanceBefore = await getTokenBalance(
    chainC.provider,
    tokensC.usdc,
    actorBShadowOnC,
  );
  const invoiceAsCreatorC = new ethers.Contract(invoiceAddress, INVOICE_ABI, creatorC);

  const localCreateTx = await invoiceAsCreatorC.createInvoice(
    actorB.address,
    chainB.chainId,
    tokensC.sgd,
    scenarioThreeBillingAmount,
    chainC.chainId,
    creatorC.address,
    actorB.address,
    'Smoke scenario 3: C creates locally, B pays via interop',
  );
  await localCreateTx.wait();

  const createdByCCountAfter = (await invoice.getUserCreatedInvoiceCount(creatorC.address)) as bigint;
  assert(
    createdByCCountAfter === createdByCCountBefore + 1n,
    `Expected C creator invoice count to increase by 1, got before=${createdByCCountBefore} after=${createdByCCountAfter}`,
  );

  const [scenarioThreeInvoiceId] = (await invoice.getUserCreatedInvoices(
    creatorC.address,
    createdByCCountBefore,
    createdByCCountAfter,
  )) as bigint[];

  const approveForPayCalldata = erc20Interface.encodeFunctionData('approve', [
    invoiceAddress,
    ethers.MaxUint256,
  ]);
  const payScenarioThreeCalldata = invoiceInterface.encodeFunctionData('payInvoice', [
    scenarioThreeInvoiceId,
    tokensC.usdc,
  ]);

  await sendInteropBundleAndWait({
    label: 'Scenario 3: pay local chain C invoice from chain B into chain C',
    sourceWallet: actorB,
    destinationProvider: chainC.provider,
    destinationExecutor: actorBOnC,
    builder: new BundleBuilder(chainC.chainId)
      .addShadowAccountCall(tokensC.usdc, approveForPayCalldata)
      .addShadowAccountCall(invoiceAddress, payScenarioThreeCalldata)
      .withUnbundler(actorBOnC.address),
  });

  const scenarioThreeAfterPay = toInvoiceDetails(
    await invoice.getInvoiceDetails(scenarioThreeInvoiceId),
  );
  assert(
    scenarioThreeAfterPay.status === BigInt(InvoiceStatus.Paid),
    `Scenario 3 invoice should be Paid, got status=${scenarioThreeAfterPay.status}`,
  );
  assert(
    scenarioThreeAfterPay.paymentToken === tokensC.usdc,
    `Scenario 3 payment token mismatch: ${scenarioThreeAfterPay.paymentToken}`,
  );
  assert(
    scenarioThreeAfterPay.paymentAmount === scenarioThreePaymentAmount,
    `Scenario 3 payment amount mismatch: expected=${scenarioThreePaymentAmount} got=${scenarioThreeAfterPay.paymentAmount}`,
  );

  const actorBUsdcShadowBalanceAfter = await getTokenBalance(
    chainC.provider,
    tokensC.usdc,
    actorBShadowOnC,
  );
  assert(
    actorBUsdcShadowBalanceAfter === actorBUsdcShadowBalanceBefore - scenarioThreePaymentAmount,
    `Scenario 3 shadow payer balance mismatch: before=${actorBUsdcShadowBalanceBefore} after=${actorBUsdcShadowBalanceAfter}`,
  );

  const creatorCSgdBalanceAfter = await waitForTokenBalanceAtLeast({
    provider: chainC.provider,
    tokenAddress: tokensC.sgd,
    account: creatorC.address,
    expectedMinimum: creatorCSgdBalanceBefore + scenarioThreeBillingAmount,
    label: 'Scenario 3 creator SGD balance on chain C',
  });
  console.log(
    `Scenario 3 payout arrived on C: ${ethers.formatUnits(creatorCSgdBalanceAfter - creatorCSgdBalanceBefore, 18)} SGD`,
  );

  const scenarioFourBillingAmount = ethers.parseUnits('75', 18);
  const createdByAFinalBefore = (await invoice.getUserCreatedInvoiceCount(creatorA.address)) as bigint;
  const creatorASgdBalanceBefore = await getTokenBalance(chainA.provider, tokensA.sgd, creatorA.address);
  const actorBSgdShadowBalanceBefore = await getTokenBalance(
    chainC.provider,
    tokensC.sgd,
    actorBShadowOnC,
  );

  const createScenarioFourCalldata = invoiceInterface.encodeFunctionData('createInvoice', [
    actorB.address,
    chainB.chainId,
    tokensC.sgd,
    scenarioFourBillingAmount,
    chainA.chainId,
    creatorA.address,
    actorB.address,
    'Smoke scenario 4: A creates cross-chain, B pays, payout deferred then triggered from C',
  ]);

  await sendInteropBundleAndWait({
    label: 'Scenario 4: create invoice from chain A into chain C',
    sourceWallet: creatorA,
    destinationProvider: chainC.provider,
    destinationExecutor: creatorAOnC,
    builder: new BundleBuilder(chainC.chainId)
      .addShadowAccountCall(invoiceAddress, createScenarioFourCalldata)
      .withUnbundler(creatorAOnC.address),
  });

  const createdByAFinalAfter = (await invoice.getUserCreatedInvoiceCount(creatorA.address)) as bigint;
  assert(
    createdByAFinalAfter === createdByAFinalBefore + 1n,
    `Expected A creator invoice count to increase by 1 for scenario 4, got before=${createdByAFinalBefore} after=${createdByAFinalAfter}`,
  );

  const [scenarioFourInvoiceId] = (await invoice.getUserCreatedInvoices(
    creatorA.address,
    createdByAFinalBefore,
    createdByAFinalAfter,
  )) as bigint[];

  const approveScenarioFourCalldata = erc20Interface.encodeFunctionData('approve', [
    invoiceAddress,
    ethers.MaxUint256,
  ]);
  const payScenarioFourCalldata = invoiceInterface.encodeFunctionData('payInvoice', [
    scenarioFourInvoiceId,
    tokensC.sgd,
  ]);

  await sendInteropBundleAndWait({
    label: 'Scenario 4: pay cross-chain invoice from chain B into chain C with deferred payout',
    sourceWallet: actorB,
    destinationProvider: chainC.provider,
    destinationExecutor: actorBOnC,
    builder: new BundleBuilder(chainC.chainId)
      .addShadowAccountCall(tokensC.sgd, approveScenarioFourCalldata)
      .addShadowAccountCall(invoiceAddress, payScenarioFourCalldata)
      .withUnbundler(actorBOnC.address),
  });

  const scenarioFourAfterPay = toInvoiceDetails(
    await invoice.getInvoiceDetails(scenarioFourInvoiceId),
  );
  assert(
    scenarioFourAfterPay.status === BigInt(InvoiceStatus.Paid),
    `Scenario 4 invoice should be Paid, got status=${scenarioFourAfterPay.status}`,
  );
  assert(
    scenarioFourAfterPay.paymentToken === tokensC.sgd,
    `Scenario 4 payment token mismatch: ${scenarioFourAfterPay.paymentToken}`,
  );
  assert(
    scenarioFourAfterPay.paymentAmount === scenarioFourBillingAmount,
    `Scenario 4 payment amount mismatch: expected=${scenarioFourBillingAmount} got=${scenarioFourAfterPay.paymentAmount}`,
  );

  const scenarioFourPayoutInitiatedBefore = (await invoice.creatorPayoutInitiated(
    scenarioFourInvoiceId,
  )) as boolean;
  assert(
    !scenarioFourPayoutInitiatedBefore,
    'Scenario 4 creator payout should not be initiated immediately after payment',
  );

  const actorBSgdShadowBalanceAfterPay = await getTokenBalance(
    chainC.provider,
    tokensC.sgd,
    actorBShadowOnC,
  );
  assert(
    actorBSgdShadowBalanceAfterPay === actorBSgdShadowBalanceBefore - scenarioFourBillingAmount,
    `Scenario 4 shadow payer balance mismatch: before=${actorBSgdShadowBalanceBefore} after=${actorBSgdShadowBalanceAfterPay}`,
  );

  const payoutOperatorBalanceBefore = await getTokenBalance(
    chainC.provider,
    tokensC.sgd,
    chainC.admin.address,
  );

  const triggerPayoutTx = await invoice.triggerCreatorPayout(scenarioFourInvoiceId);
  await triggerPayoutTx.wait();

  const scenarioFourDeferredAfterTrigger = (await invoice.creatorPayoutInitiated(
    scenarioFourInvoiceId,
  )) as boolean;
  assert(
    scenarioFourDeferredAfterTrigger,
    'Scenario 4 deferred payout should be marked initiated after trigger',
  );

  const payoutOperatorBalanceAfterRelease = await getTokenBalance(
    chainC.provider,
    tokensC.sgd,
    chainC.admin.address,
  );
  assert(
    payoutOperatorBalanceAfterRelease === payoutOperatorBalanceBefore + scenarioFourBillingAmount,
    `Scenario 4 payout operator balance mismatch: before=${payoutOperatorBalanceBefore} after=${payoutOperatorBalanceAfterRelease}`,
  );

  const approvePayoutBridgeTx = await new ethers.Contract(tokensC.sgd, ERC20_ABI, chainC.admin).approve(
    nativeTokenVaultC,
    scenarioFourBillingAmount,
  );
  await approvePayoutBridgeTx.wait();

  await sendInteropBundleAndWait({
    label: 'Scenario 4: bridge released payout from chain C into chain A',
    sourceWallet: chainC.admin,
    destinationProvider: chainA.provider,
    destinationExecutor: creatorA,
    builder: new BundleBuilder(chainA.chainId)
      .addCall(
        CallBuilder.tokenTransfer(
          chainC.chainId,
          tokensC.sgd,
          scenarioFourBillingAmount,
          creatorA.address,
        ),
      )
      .withUnbundler(creatorA.address),
  });

  const creatorASgdBalanceAfter = await waitForTokenBalanceAtLeast({
    provider: chainA.provider,
    tokenAddress: tokensA.sgd,
    account: creatorA.address,
    expectedMinimum: creatorASgdBalanceBefore + scenarioFourBillingAmount,
    label: 'Scenario 4 creator SGD balance on chain A',
  });
  console.log(
    `Scenario 4 payout arrived on A: ${ethers.formatUnits(creatorASgdBalanceAfter - creatorASgdBalanceBefore, 18)} SGD`,
  );

  console.log('\nInvoice interop smoke passed.');
  console.log(`Scenario 1 invoice ID: ${scenarioOneInvoiceId.toString()}`);
  console.log(`Scenario 2 invoice ID: ${scenarioTwoInvoiceId.toString()}`);
  console.log(`Scenario 3 invoice ID: ${scenarioThreeInvoiceId.toString()}`);
  console.log(`Scenario 4 invoice ID: ${scenarioFourInvoiceId.toString()}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
