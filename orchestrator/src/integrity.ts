import { ethers } from 'ethers';
import { DeliverableType, OrderStatus, type Delivery, type Order } from '@croo-network/sdk';
import { BASESCAN_TX, Logger } from './logger.js';

const BASE_MAINNET_CHAIN_ID = 8453n;

export interface IntegrityResult {
  /**
   * Status-based integrity verdict (per Ward_SDK_GROUND_TRUTH.md): the backend committed a content
   * hash for a retrieved, non-empty delivery and any on-chain receipt we can read is not a failed tx.
   * The local keccak match is ADVISORY (backend preimage is undocumented), never the gate.
   */
  ok: boolean;
  computedHash: string;
  committedHash: string;
  preimageSource: string;
  /** L1 (ADVISORY ONLY) — keccak256(content) === committed contentHash. Does NOT gate ok. */
  preimageMatches: boolean;
  committedPresent: boolean;
  deliverablePresent: boolean;
  /** L2 — deliver tx mined with status=1 on Base mainnet. 'unresolved' = userOpHash / null. */
  onChainReceiptStatus: 'confirmed' | 'failed' | 'unresolved';
  hashFoundOnChain: boolean;
  chainId: bigint | null;
  notes: string[];
}

function normHex(hex: string): string {
  const h = (hex ?? '').toLowerCase().trim();
  return h.startsWith('0x') ? h : `0x${h}`;
}

function deliverablePreimage(delivery: Delivery): { bytes: Uint8Array; source: string } {
  if (delivery.deliverableType === DeliverableType.Schema) {
    return { bytes: ethers.toUtf8Bytes(delivery.deliverableSchema ?? ''), source: 'deliverableSchema' };
  }
  return { bytes: ethers.toUtf8Bytes(delivery.deliverableText ?? ''), source: 'deliverableText' };
}

export async function verifyDeliveryIntegrity(
  order: Order,
  delivery: Delivery,
  rpcURL: string,
): Promise<IntegrityResult> {
  const notes: string[] = [];

  const { bytes, source } = deliverablePreimage(delivery);
  const computedHash = ethers.keccak256(bytes);
  const committedHash = normHex(delivery.contentHash);
  const committedPresent = committedHash !== '0x';
  const deliverablePresent = bytes.length > 0;
  const preimageMatches = committedPresent && computedHash === committedHash;

  if (!committedPresent) notes.push('delivery.contentHash is empty — backend returned no committed hash');
  if (!deliverablePresent) notes.push('deliverable body is empty');
  if (committedPresent && !preimageMatches) {
    notes.push(
      `L1 advisory: keccak256(${source}) != committed contentHash — backend commits over an undocumented preimage`,
    );
  }

  let onChainReceiptStatus: IntegrityResult['onChainReceiptStatus'] = 'unresolved';
  let hashFoundOnChain = false;
  let chainId: bigint | null = null;

  const deliverTx = (order.deliverTxHash ?? '').trim();
  if (!deliverTx) {
    notes.push('order.deliverTxHash is empty — cannot perform on-chain confirmation');
  } else {
    try {
      const provider = new ethers.JsonRpcProvider(rpcURL);
      chainId = (await provider.getNetwork()).chainId;
      if (chainId !== BASE_MAINNET_CHAIN_ID) {
        notes.push(`RPC chainId ${chainId} is not Base mainnet (${BASE_MAINNET_CHAIN_ID}) — check BASE_RPC_URL`);
      }
      const receipt = await provider.getTransactionReceipt(deliverTx);
      if (!receipt) {
        notes.push('deliverTxHash did not resolve to an L1 receipt — likely an ERC-4337 userOpHash');
      } else if (receipt.status === 1 && chainId === BASE_MAINNET_CHAIN_ID) {
        onChainReceiptStatus = 'confirmed';
        const needle = committedHash.slice(2);
        const haystack = receipt.logs
          .map((l) => l.data.slice(2) + l.topics.map((t) => t.slice(2)).join(''))
          .join('')
          .toLowerCase();
        hashFoundOnChain = needle.length > 0 && haystack.includes(needle);
        if (!hashFoundOnChain) notes.push('committed hash not found in deliver-tx logs (may be in 4337 calldata)');
      } else {
        onChainReceiptStatus = 'failed';
        notes.push(`deliver tx receipt status=${receipt.status} on chainId ${chainId}`);
      }
    } catch (err) {
      notes.push(`on-chain receipt lookup failed: ${(err as Error).message}`);
    }
  }

  // Ground truth: status === 'completed' (the protocol's on-chain settlement signal) is REQUIRED;
  // committed contentHash present is required; keccak match + receipt are advisory.
  const completed = order.status === OrderStatus.Completed;
  if (!completed) notes.push(`order status is '${order.status}', not 'completed' — not settled`);
  const ok = completed && deliverablePresent && committedPresent && onChainReceiptStatus !== 'failed';

  return {
    ok,
    computedHash,
    committedHash,
    preimageSource: source,
    preimageMatches,
    committedPresent,
    deliverablePresent,
    onChainReceiptStatus,
    hashFoundOnChain,
    chainId,
    notes,
  };
}

export function reportIntegrity(log: Logger, order: Order, result: IntegrityResult): void {
  log.step('INTEGRITY', 'delivery integrity check', { preimage: result.preimageSource, settled: result.ok });
  log.info(`committed contentHash ${result.committedPresent ? 'present' : 'MISSING'}`, { committed: result.committedHash });
  log.info(`L1 keccak (advisory)  ${result.preimageMatches ? 'MATCH' : 'differs — backend preimage undocumented'}`);
  log.info(`L2 on-chain receipt   ${result.onChainReceiptStatus}`, {
    chainId: result.chainId ?? 'n/a',
    deliverTx: order.deliverTxHash || 'n/a',
  });
  if (order.deliverTxHash) log.info(`verify on Basescan: ${BASESCAN_TX(order.deliverTxHash)}`);
  for (const note of result.notes) log.warn(note);
}
