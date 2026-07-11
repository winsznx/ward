import { ethers } from 'ethers';
import { verifyDeliveryIntegrity } from './src/integrity';
import type { Delivery, Order } from '@croo-network/sdk';

const RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main() {
  // 1) keccak known-answer vector (ethers wiring sanity)
  const EMPTY = ethers.keccak256(new Uint8Array());
  assert(EMPTY === '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470', 'keccak256("") matches known vector');

  const text = JSON.stringify({ echo: 'ok' });
  const contentHash = ethers.keccak256(ethers.toUtf8Bytes(text));
  console.log(`  keccak256(${text}) = ${contentHash}`);

  // 2) grab a real, successful Base-mainnet tx to exercise the on-chain layers
  const provider = new ethers.JsonRpcProvider(RPC);
  const net = await provider.getNetwork();
  assert(net.chainId === 8453n, `RPC is Base mainnet (chainId=${net.chainId})`);

  const head = await provider.getBlockNumber();
  let realTx = '';
  for (let b = head; b > head - 6 && !realTx; b--) {
    const block = await provider.getBlock(b);
    for (const tx of block?.transactions ?? []) {
      const r = await provider.getTransactionReceipt(tx);
      if (r && r.status === 1 && r.logs.length > 0) { realTx = tx; break; }
    }
  }
  assert(realTx !== '', `found a real successful Base tx with logs: ${realTx}`);

  // 3) happy path: committed hash present, delivery present, L2 confirmed -> ok; L1 advisory matches
  const order = { deliverTxHash: realTx, status: 'completed' } as unknown as Order;
  const delivery = { deliverableType: 'text', deliverableText: text, contentHash } as unknown as Delivery;

  const result = await verifyDeliveryIntegrity(order, delivery, RPC);
  console.log('  result:', JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  assert(result.preimageMatches === true, 'L1 advisory matches when contentHash = keccak(text)');
  assert(result.onChainReceiptStatus === 'confirmed', 'L2 deliver tx confirmed on Base mainnet');
  assert(result.ok === true, 'gate ok: committed hash + delivery present + receipt not failed');

  // 4a) preimage is ADVISORY: tampering the body flips L1 but does NOT flip the gate
  //     (the gate must not depend on reproducing the undocumented backend preimage)
  const tampered = { ...delivery, deliverableText: text + ' ' } as unknown as Delivery;
  const adv = await verifyDeliveryIntegrity(order, tampered, RPC);
  assert(adv.preimageMatches === false, 'L1 advisory flips on changed content');
  assert(adv.ok === true, 'gate stays ok — L1 keccak is advisory, not the gate');

  // 4b) the real gate: a missing backend contentHash fails it
  const noHash = { ...delivery, contentHash: '' } as unknown as Delivery;
  const bad = await verifyDeliveryIntegrity(order, noHash, RPC);
  assert(bad.committedPresent === false, 'committedPresent false when backend hash missing');
  assert(bad.ok === false, 'gate fails when no committed contentHash');

  console.log('\nINTEGRITY ITEST PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
