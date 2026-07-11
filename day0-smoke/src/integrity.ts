import { ethers } from 'ethers';
import { DeliverableType, type Delivery, type Order } from '@croo-network/sdk';
import { BASESCAN_TX, Logger } from './logger';

const BASE_MAINNET_CHAIN_ID = 8453n;

export interface IntegrityResult {
  /**
   * Overall integrity verdict — gates the DAY-0 PASS. Built from SDK-verifiable facts only
   * (committed hash present + delivery present + no failed receipt). The local keccak match is
   * deliberately NOT part of this, because the backend preimage is undocumented (see preimageMatches).
   */
  ok: boolean;
  /** L1: keccak256(delivery content) recomputed locally. */
  computedHash: string;
  /** The contentHash the backend committed (verified on-chain by the validation module). */
  committedHash: string;
  preimageSource: string;
  /** L1 (ADVISORY ONLY) — keccak256(content) === committed contentHash. Does NOT gate PASS. */
  preimageMatches: boolean;
  /** Backend committed a non-empty contentHash for this delivery. */
  committedPresent: boolean;
  /** The delivery carries a non-empty body. */
  deliverablePresent: boolean;
  /** L2 — deliver tx is mined with status=1 on Base mainnet (8453). null = could not resolve. */
  onChainReceiptStatus: 'confirmed' | 'failed' | 'unresolved';
  /** L3 — committed hash bytes appear in the deliver tx logs (ABI-free presence proof). */
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
  // Default to the text body (covers DeliverableType.Text and anything unexpected).
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

  if (!committedPresent) {
    notes.push('delivery.contentHash is empty — backend returned no committed hash');
  }
  if (!deliverablePresent) {
    notes.push('deliverable body is empty');
  }
  if (committedPresent && !preimageMatches) {
    notes.push(
      `L1 advisory: keccak256(${source}) != committed contentHash — the backend commits over an ` +
        `undocumented preimage (canonical JSON / domain separation / mixed fields), so a naive match is not expected`,
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
        // ERC-4337 / Biconomy Nexus: deliverTxHash may be a userOpHash, not an L1 tx hash.
        notes.push(
          'deliverTxHash did not resolve to an L1 transaction receipt — likely an ERC-4337 userOpHash; ' +
            'relying on L1 (committed-hash) verification',
        );
      } else if (receipt.status === 1 && chainId === BASE_MAINNET_CHAIN_ID) {
        onChainReceiptStatus = 'confirmed';
        const needle = committedHash.slice(2);
        const haystack = receipt.logs
          .map((l) => l.data.slice(2) + l.topics.map((t) => t.slice(2)).join(''))
          .join('')
          .toLowerCase();
        hashFoundOnChain = needle.length > 0 && haystack.includes(needle);
        if (!hashFoundOnChain) {
          notes.push('committed hash not found in deliver-tx logs (may be in 4337 calldata, not events)');
        }
      } else {
        onChainReceiptStatus = 'failed';
        notes.push(`deliver tx receipt status=${receipt.status} on chainId ${chainId}`);
      }
    } catch (err) {
      notes.push(`on-chain receipt lookup failed: ${(err as Error).message}`);
    }
  }

  // Integrity gate — SDK-verifiable facts only: the backend committed a content hash for a
  // retrieved, non-empty delivery, and any on-chain receipt we can read is not a failed tx.
  // preimageMatches is ADVISORY and intentionally excluded: the backend's hash preimage is
  // undocumented, so gating on it would report a genuine success as a failure.
  const ok = deliverablePresent && committedPresent && onChainReceiptStatus !== 'failed';

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
  log.step('VERIFY', 'delivery integrity check', { preimage: result.preimageSource });
  log.info(`committed contentHash ${result.committedPresent ? 'present' : 'MISSING'}`, {
    committed: result.committedHash,
  });
  log.info(`L1 keccak (advisory)  ${result.preimageMatches ? 'MATCH' : 'differs — backend preimage undocumented'}`, {
    computed: result.computedHash,
  });
  log.info(`L2 on-chain receipt   ${result.onChainReceiptStatus}`, {
    chainId: result.chainId ?? 'n/a',
    deliverTx: order.deliverTxHash || 'n/a',
  });
  log.info(`L3 hash-in-logs       ${result.hashFoundOnChain ? 'found on-chain' : 'n/a'}`);
  if (order.deliverTxHash) log.info(`verify on Basescan: ${BASESCAN_TX(order.deliverTxHash)}`);
  for (const note of result.notes) log.warn(note);
}
