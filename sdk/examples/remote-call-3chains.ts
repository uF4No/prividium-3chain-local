import { AbiCoder, Contract, JsonRpcProvider, Wallet } from 'ethers';
import {
  BundleBuilder,
  CallBuilder,
  sendBundle,
  waitForBundleFinalization,
  waitUntilRootAvailable,
} from '../src';
import { GREETING_BYTECODE } from './greeting-bytecode';

const GREETING_ABI = [
  'function message() view returns (string)',
] as const;

const DEFAULT_L1_RPC = process.env.L1_RPC ?? 'http://127.0.0.1:8545';
const DEFAULT_L2A_RPC = process.env.L2A_RPC ?? 'http://127.0.0.1:3050';
const DEFAULT_L2B_RPC = process.env.L2B_RPC ?? 'http://127.0.0.1:3051';
const DEFAULT_L2C_RPC = process.env.L2C_RPC ?? 'http://127.0.0.1:3052';
const POLL_MS = Number(process.env.INTEROP_POLL_MS ?? 3000);
const TIMEOUT_MS = Number(process.env.INTEROP_TIMEOUT_MS ?? 180000);

type ChainCtx = {
  label: 'A' | 'B' | 'C';
  provider: JsonRpcProvider;
  wallet: Wallet;
  chainId: bigint;
  greeter: string;
};

function requirePrivateKey(): string {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    throw new Error('Set PRIVATE_KEY in env');
  }
  return pk;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMessage(args: {
  provider: JsonRpcProvider;
  greeter: string;
  expected: string;
  timeoutMs: number;
  pollMs: number;
}): Promise<void> {
  const contract = new Contract(args.greeter, GREETING_ABI, args.provider);
  const deadline = Date.now() + args.timeoutMs;
  while (Date.now() < deadline) {
    const current = (await contract.message()) as string;
    if (current === args.expected) {
      return;
    }
    await sleep(args.pollMs);
  }

  const last = (await contract.message()) as string;
  throw new Error(
    `Timed out waiting for message on ${args.greeter}. expected="${args.expected}", got="${last}"`,
  );
}

async function deployGreeter(wallet: Wallet): Promise<string> {
  const tx = await wallet.sendTransaction({
    data: GREETING_BYTECODE,
    gasLimit: 5_000_000n,
  });
  const receipt = await tx.wait();
  if (!receipt?.contractAddress) {
    throw new Error('Greeting deployment failed: missing contractAddress');
  }
  return receipt.contractAddress;
}

async function runPair(src: ChainCtx, dst: ChainCtx, sequence: number): Promise<void> {
  const payload = AbiCoder.defaultAbiCoder().encode(
    ['string'],
    [`greet ${src.label}->${dst.label} #${sequence}`],
  ) as `0x${string}`;

  const bundle = new BundleBuilder(dst.chainId)
    .addCall(new CallBuilder(dst.greeter, payload).build())
    .withUnbundler(src.wallet.address);

  console.log(`\n🔁 === ${src.label} -> ${dst.label} ===`);
  const handle = await sendBundle(src.wallet, bundle);
  console.log(`📦 sent bundle: ${handle.bundleHash}`);

  const finalization = await waitForBundleFinalization(src.provider, handle, {
    pollInterval: POLL_MS,
    timeout: TIMEOUT_MS,
  });
  console.log(`🧾 finalized on source batch: ${finalization.expectedRoot.batchNumber}`);

  await waitUntilRootAvailable(dst.provider, finalization.expectedRoot, {
    pollInterval: POLL_MS,
    timeout: TIMEOUT_MS,
  });
  console.log('🌱 root available on destination');

  const expected = `greet ${src.label}->${dst.label} #${sequence}`;
  await waitForMessage({
    provider: dst.provider,
    greeter: dst.greeter,
    expected,
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
  });
  console.log(`✅ destination message updated: "${expected}"`);
}

async function main() {
  const pk = requirePrivateKey();
  const l1 = new JsonRpcProvider(DEFAULT_L1_RPC);
  const a = new JsonRpcProvider(DEFAULT_L2A_RPC);
  const b = new JsonRpcProvider(DEFAULT_L2B_RPC);
  const c = new JsonRpcProvider(DEFAULT_L2C_RPC);

  const [l1Net, aNet, bNet, cNet] = await Promise.all([
    l1.getNetwork(),
    a.getNetwork(),
    b.getNetwork(),
    c.getNetwork(),
  ]);
  console.log(`L1 chainId: ${l1Net.chainId}`);
  console.log(`A chainId: ${aNet.chainId}, B chainId: ${bNet.chainId}, C chainId: ${cNet.chainId}`);

  const chains: ChainCtx[] = [
    { label: 'A', provider: a, wallet: new Wallet(pk, a), chainId: aNet.chainId, greeter: '' },
    { label: 'B', provider: b, wallet: new Wallet(pk, b), chainId: bNet.chainId, greeter: '' },
    { label: 'C', provider: c, wallet: new Wallet(pk, c), chainId: cNet.chainId, greeter: '' },
  ];
  const orderedPairCount = chains.length * (chains.length - 1);

  for (const chain of chains) {
    const bal = await chain.provider.getBalance(chain.wallet.address);
    console.log(`${chain.label} balance: ${bal}`);
    if (bal === 0n) {
      throw new Error(`Signer has zero balance on ${chain.label}`);
    }
  }

  console.log('\n💬 === Deploying Greeting contracts ===');
  for (const chain of chains) {
    chain.greeter = await deployGreeter(chain.wallet);
    const contract = new Contract(chain.greeter, GREETING_ABI, chain.provider);
    const msg = (await contract.message()) as string;
    console.log(`🏗️ ${chain.label} greeter: ${chain.greeter}, message="${msg}"`);
  }

  let seq = 1;
  for (const src of chains) {
    for (const dst of chains) {
      if (src.label === dst.label) continue;
      await runPair(src, dst, seq++);
    }
  }

  console.log('\n✅ 3-chain demo-sdk interop smoke passed (full ordered-pair matrix).');
  console.log(`📊 Summary: ${chains.length} chains checked, ${chains.length} greeter deployments, ${orderedPairCount} ordered-pair messages.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
