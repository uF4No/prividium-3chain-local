import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import {
  BundleBuilder,
  BundleStatus,
  executeBundle,
  getBundleOnChainStatus,
  getShadowAccountAddress,
  sendBundle,
  waitForBundleFinalization,
  waitUntilRootAvailable
} from '../src';

const DEFAULT_ADMIN_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const POLL_MS = Number(process.env.INTEROP_POLL_MS ?? 3000);
const TIMEOUT_MS = Number(process.env.INTEROP_TIMEOUT_MS ?? 180000);
const INVOICE_ID = BigInt(process.env.INVOICE_ID ?? '3');
const BUNDLE_ALREADY_PROCESSED_SELECTOR = '0x5bba5111';

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function mint(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)'
] as const;

const INVOICE_ABI = [
  'function getInvoiceDetails(uint256 invoiceId) view returns ((uint256 id,address creator,address recipient,address creatorRefundAddress,address recipientRefundAddress,uint256 creatorChainId,uint256 recipientChainId,address billingToken,uint256 amount,address paymentToken,uint256 paymentAmount,uint8 status,uint256 createdAt,uint256 paidAt,string text))',
  'function getConversionAmount(address fromToken, address toToken, uint256 amount) view returns (uint256)',
  'function crossChainFee() view returns (uint256)',
  'function payInvoice(uint256 invoiceId, address paymentToken) payable'
] as const;

type ChainKey = 'b' | 'c';
type TokenKey = 'usdc' | 'sgd' | 'tbill';

type TokenDeployment = {
  address?: string;
};

type ChainDeployment = {
  chainId?: number;
  rpcUrl?: string;
  admin?: string;
  invoicePayment?: string;
  tokens?: Partial<Record<TokenKey, TokenDeployment>>;
};

type ContractsConfig = {
  chains?: Partial<Record<ChainKey, ChainDeployment>>;
};

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

type BundleExecutionResult = {
  txHash: string;
  bundleHash: string;
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
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }

  return path.resolve(repoRoot(), 'config', 'contracts.json');
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

function requireRpcUrl(chainConfig: ChainDeployment, label: string): string {
  const value = chainConfig.rpcUrl?.trim();
  if (!value) {
    fail(`Missing RPC URL for chain ${label}`);
  }
  return value;
}

function requireInvoiceAddress(chainConfig: ChainDeployment): string {
  return normalizeAddress(chainConfig.invoicePayment, 'chain C invoicePayment');
}

async function ensureNativeBalance(
  admin: ethers.Wallet,
  recipient: string,
  minimumBalance: bigint
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
    value: minimumBalance - current
  });
  await tx.wait();
}

async function getTokenBalance(
  provider: ethers.Provider,
  tokenAddress: string,
  account: string
): Promise<bigint> {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  return (await token.balanceOf(account)) as bigint;
}

async function mintToken(
  tokenAddress: string,
  admin: ethers.Wallet,
  recipient: string,
  amount: bigint
): Promise<void> {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, admin);
  const tx = await token.mint(recipient, amount);
  await tx.wait();
}

async function readAllowance(
  provider: ethers.Provider,
  tokenAddress: string,
  owner: string,
  spender: string
): Promise<bigint> {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  return (await token.allowance(owner, spender)) as bigint;
}

async function sendInteropBundleAndWait(args: {
  label: string;
  sourceWallet: ethers.Signer;
  destinationProvider: ethers.Provider;
  destinationExecutor: ethers.Signer;
  builder: BundleBuilder;
}): Promise<BundleExecutionResult> {
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
    timeout: TIMEOUT_MS
  });
  console.log(`source finalized in batch ${finalization.expectedRoot.batchNumber}`);

  await waitUntilRootAvailable(args.destinationProvider, finalization.expectedRoot, {
    pollInterval: POLL_MS,
    timeout: TIMEOUT_MS
  });
  console.log('destination root available');

  const destinationStatus = await getBundleOnChainStatus(args.destinationProvider, handle.bundleHash);
  if (
    destinationStatus === BundleStatus.FullyExecuted ||
    destinationStatus === BundleStatus.Unbundled
  ) {
    console.log(`destination bundle already processed with status ${destinationStatus}`);
    return {
      txHash: handle.txHash,
      bundleHash: handle.bundleHash
    };
  }

  try {
    const receipt = await executeBundle(args.destinationExecutor, finalization);
    console.log(`bundle executed on destination tx ${receipt.hash}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusAfterFailure = await getBundleOnChainStatus(
      args.destinationProvider,
      handle.bundleHash
    );
    if (
      statusAfterFailure === BundleStatus.FullyExecuted ||
      statusAfterFailure === BundleStatus.Unbundled
    ) {
      console.log(
        `destination bundle finished externally after execution attempt; final status ${statusAfterFailure}`
      );
      return {
        txHash: handle.txHash,
        bundleHash: handle.bundleHash
      };
    }
    if (
      message.includes(BUNDLE_ALREADY_PROCESSED_SELECTOR) ||
      message.includes('BundleAlreadyProcessed') ||
      message.includes('already been executed') ||
      message.includes('has been unbundled and cannot be executed as a whole')
    ) {
      console.log(`destination bundle was already processed externally: ${message}`);
      return {
        txHash: handle.txHash,
        bundleHash: handle.bundleHash
      };
    }
    throw error;
  }

  return {
    txHash: handle.txHash,
    bundleHash: handle.bundleHash
  };
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
      invoice.paymentToken && invoice.paymentToken !== ethers.ZeroAddress
        ? ethers.getAddress(invoice.paymentToken)
        : ethers.ZeroAddress,
    paymentAmount: invoice.paymentAmount,
    status: invoice.status,
    createdAt: invoice.createdAt,
    paidAt: invoice.paidAt,
    text: invoice.text
  };
}

async function main() {
  const config = readJsonFile<ContractsConfig>(resolveConfigPath());
  const chainBConfig = requireChainConfig(config, 'b');
  const chainCConfig = requireChainConfig(config, 'c');

  const chainBProvider = new ethers.JsonRpcProvider(requireRpcUrl(chainBConfig, 'B'));
  const chainCProvider = new ethers.JsonRpcProvider(requireRpcUrl(chainCConfig, 'C'));
  const chainBId = requireChainId(chainBConfig, 'B');
  const chainCId = requireChainId(chainCConfig, 'C');

  const adminPrivateKey = process.env.ADMIN_PRIVATE_KEY ?? DEFAULT_ADMIN_PRIVATE_KEY;
  const adminB = new ethers.Wallet(adminPrivateKey, chainBProvider);
  const adminC = new ethers.Wallet(adminPrivateKey, chainCProvider);

  const invoiceAddress = requireInvoiceAddress(chainCConfig);
  const invoice = new ethers.Contract(invoiceAddress, INVOICE_ABI, chainCProvider);
  const invoiceBefore = toInvoiceDetails(await invoice.getInvoiceDetails(INVOICE_ID));
  if (invoiceBefore.id !== INVOICE_ID) {
    fail(`Invoice ${INVOICE_ID.toString()} not found on chain C.`);
  }

  const paymentToken = invoiceBefore.billingToken;
  const paymentAmount = (await invoice.getConversionAmount(
    invoiceBefore.billingToken,
    paymentToken,
    invoiceBefore.amount
  )) as bigint;
  const crossChainFee = (await invoice.crossChainFee()) as bigint;

  const actorBPrivateKey = process.env.DIAGNOSTIC_B_PRIVATE_KEY ?? ethers.Wallet.createRandom().privateKey;
  const actorB = new ethers.Wallet(actorBPrivateKey, chainBProvider);
  const actorBOnC = new ethers.Wallet(actorBPrivateKey, chainCProvider);
  const actorBShadowOnC = await getShadowAccountAddress(chainCProvider, chainBId, actorB.address);

  console.log(`Invoice ${INVOICE_ID.toString()} status before: ${invoiceBefore.status.toString()}`);
  console.log(`Invoice billing token: ${paymentToken}`);
  console.log(`Invoice amount: ${invoiceBefore.amount.toString()}`);
  console.log(`Payment amount: ${paymentAmount.toString()}`);
  console.log(`Invoice creator chain: ${invoiceBefore.creatorChainId.toString()}`);
  console.log(`Invoice recipient chain: ${invoiceBefore.recipientChainId.toString()}`);
  console.log(`Invoice contract crossChainFee: ${crossChainFee.toString()}`);
  console.log(`Diagnostic payer on B: ${actorB.address}`);
  console.log(`Diagnostic payer shadow on C: ${actorBShadowOnC}`);

  await ensureNativeBalance(adminB, actorB.address, ethers.parseEther('0.05'));
  await ensureNativeBalance(adminC, actorBOnC.address, ethers.parseEther('0.05'));

  const shadowBalanceBefore = await getTokenBalance(chainCProvider, paymentToken, actorBShadowOnC);
  if (shadowBalanceBefore < paymentAmount) {
    const topUp = paymentAmount - shadowBalanceBefore;
    console.log(`Minting ${topUp.toString()} payment tokens to diagnostic shadow account on C`);
    await mintToken(paymentToken, adminC, actorBShadowOnC, topUp);
  }

  const approveData = new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [
    invoiceAddress,
    ethers.MaxUint256
  ]);
  const payData = new ethers.Interface(INVOICE_ABI).encodeFunctionData('payInvoice', [
    INVOICE_ID,
    paymentToken
  ]);

  const approveResult = await sendInteropBundleAndWait({
    label: `Approve-only settlement diagnostic for invoice ${INVOICE_ID.toString()}`,
    sourceWallet: actorB,
    destinationProvider: chainCProvider,
    destinationExecutor: actorBOnC,
    builder: new BundleBuilder(chainCId)
      .addShadowAccountCall(paymentToken, approveData)
      .withUnbundler(actorBOnC.address)
  });

  const allowanceAfterApprove = await readAllowance(
    chainCProvider,
    paymentToken,
    actorBShadowOnC,
    invoiceAddress
  );
  console.log(`Allowance after approve-only bundle: ${allowanceAfterApprove.toString()}`);

  if (allowanceAfterApprove < paymentAmount) {
    fail(
      `Approve-only bundle did not set enough allowance. Required ${paymentAmount.toString()}, got ${allowanceAfterApprove.toString()}. Source tx ${approveResult.txHash}`
    );
  }

  const payResult = await sendInteropBundleAndWait({
    label: `Pay-only settlement diagnostic for invoice ${INVOICE_ID.toString()}`,
    sourceWallet: actorB,
    destinationProvider: chainCProvider,
    destinationExecutor: actorBOnC,
    builder: new BundleBuilder(chainCId)
      .addShadowAccountCall(invoiceAddress, payData)
      .withUnbundler(actorBOnC.address)
  });

  const invoiceAfter = toInvoiceDetails(await invoice.getInvoiceDetails(INVOICE_ID));
  const shadowBalanceAfter = await getTokenBalance(chainCProvider, paymentToken, actorBShadowOnC);

  console.log(`Invoice ${INVOICE_ID.toString()} status after: ${invoiceAfter.status.toString()}`);
  console.log(`Invoice payment token after: ${invoiceAfter.paymentToken}`);
  console.log(`Invoice payment amount after: ${invoiceAfter.paymentAmount.toString()}`);
  console.log(`Shadow account balance after: ${shadowBalanceAfter.toString()}`);
  console.log(`Approve-only source tx: ${approveResult.txHash}`);
  console.log(`Approve-only bundle: ${approveResult.bundleHash}`);
  console.log(`Pay-only source tx: ${payResult.txHash}`);
  console.log(`Pay-only bundle: ${payResult.bundleHash}`);

  if (invoiceAfter.status !== 1n) {
    fail(`Pay-only bundle completed but invoice ${INVOICE_ID.toString()} is still not marked Paid.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
