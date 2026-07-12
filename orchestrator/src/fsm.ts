import {
  DeliverableType,
  isInsufficientBalance,
  type AgentClient,
  type Delivery,
  type Order,
} from '@croo-network/sdk';
import { ethers } from 'ethers';
import { FirewallGate, type SupplierDeliverable } from '../../firewall/src/gate.js';
import { groqJudge } from '../../firewall/src/judge-groq.js';
import type { WardConfig } from './config.js';
import { createClient, negotiateService } from './croo-client.js';
import { explainError } from './errors.js';
import { EventRouter, OrderRejectedError, OrderTimeoutError } from './events.js';
import { reportIntegrity, verifyDeliveryIntegrity } from './integrity.js';
import { Logger } from './logger.js';
import { EMPTY_TX, State, type Finding, type OrderTx, type SupplierOutcome, type Verdict } from './model.js';
import { assessDominance, buildPlan, deliveredCounterparties, orderedCounterparties, type Counterparty, type DominanceReport } from './plan.js';
import type { RegistryEntry } from './registry.js';
import { substitutePlaceholders } from './util.js';
import { Mutex, installShutdown, watchConnection } from './runtime.js';
import { collate, composeVerdict, normalizeFinding } from './verdict.js';

const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const MIN_ATTEMPT_MS = 10_000; // don't start a supplier with less than this left in the budget

class HaltError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HaltError';
  }
}

function priceUSDC(order: Order): number | null {
  if (order.paymentToken.toLowerCase() !== BASE_USDC) return null; // ceiling guard only applies to USDC
  try {
    return Number(ethers.formatUnits(order.price || '0', 6));
  } catch {
    return null;
  }
}

async function enrichTx(client: AgentClient, orderId: string, tx: OrderTx, log: Logger): Promise<void> {
  try {
    const o = await client.getOrder(orderId);
    tx.createTxHash = o.createTxHash;
    tx.payTxHash = o.payTxHash || tx.payTxHash;
    tx.deliverTxHash = o.deliverTxHash;
    tx.clearTxHash = o.clearTxHash;
  } catch (err) {
    log.warn('could not fetch tx hashes for trace', { order: orderId, error: (err as Error).message });
  }
}

/** One supplier through NEGOTIATE → PAY → AWAIT_DELIVERY → FIREWALL → NORMALIZE, bounded by the
 *  aggregate fan-out deadline. Never throws except HaltError (out-of-USDC) — all other failures
 *  isolate into the returned outcome so one supplier can't abort the run. */
async function runSupplier(
  client: AgentClient,
  router: EventRouter,
  payMutex: Mutex,
  gate: FirewallGate,
  cfg: WardConfig,
  target: string,
  entry: RegistryEntry,
  deadlineMs: number,
  log: Logger,
): Promise<SupplierOutcome> {
  const out: SupplierOutcome = {
    id: entry.id,
    label: entry.label,
    agentId: entry.agentId,
    dimension: entry.category,
    category: entry.category,
    cluster: entry.cluster,
    status: 'failed',
    orderId: undefined,
    ordered: false,
    tx: { ...EMPTY_TX },
    weight: 1,
    finding: undefined,
    reason: undefined,
  };
  const remaining = (): number => Math.max(0, deadlineMs - Date.now());

  // Drain any orphaned events from a prior (already-settled) supplier before we negotiate, so a late
  // event can't be mis-consumed by this one (single-in-flight invariant).
  router.beginSupplier();

  // NEGOTIATE
  log.step(State.Negotiate, 'opening negotiation', {
    supplier: entry.label,
    cluster: entry.cluster,
    agentId: entry.agentId,
    serviceId: entry.serviceId,
  });
  let negotiationId: string;
  try {
    const neg = await negotiateService(client, {
      serviceId: entry.serviceId,
      requirements: substitutePlaceholders(entry.requirementsTemplate, target, cfg.chain) as Record<string, unknown>,
    });
    negotiationId = neg.negotiationId;
    log.info('negotiation opened', { negotiation: negotiationId, status: neg.status });
  } catch (err) {
    out.reason = explainError(err, 'negotiateOrder');
    log.error(out.reason);
    return out;
  }

  // liveness: accept window (a dead/flaky agent never produces OrderCreated → no cost, fall to alternate).
  // Confirm correlation via the reliable REST Order.negotiationId; if a stale OrderCreated from another
  // negotiation slips through, discard it and re-wait rather than failing this supplier.
  let orderId: string | undefined;
  let created: Order | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    let candidateOrderId: string;
    try {
      candidateOrderId = await router.awaitOrderCreated(negotiationId, Math.min(cfg.acceptTimeoutMs, remaining()));
    } catch (err) {
      if (err instanceof OrderRejectedError) {
        out.reason = `negotiation ${err.kind} (${err.reasonText || 'no reason'}) — not live; try alternate`;
      } else if (err instanceof OrderTimeoutError) {
        out.reason = `liveness fail: no OrderCreated within ${cfg.acceptTimeoutMs}ms — supplier offline/not accepting; try alternate`;
      } else {
        out.reason = explainError(err, 'awaitOrderCreated');
      }
      log.warn(out.reason);
      return out;
    }
    let ord: Order;
    try {
      ord = await client.getOrder(candidateOrderId);
    } catch (err) {
      out.reason = explainError(err, 'getOrder(created)');
      log.error(out.reason);
      return out;
    }
    if (!ord.negotiationId || ord.negotiationId === negotiationId) {
      orderId = candidateOrderId;
      created = ord;
      break;
    }
    log.warn('stale OrderCreated from another negotiation — discarding, re-waiting', {
      got: candidateOrderId,
      itsNegotiation: ord.negotiationId,
      expected: negotiationId,
    });
  }
  if (!orderId || !created) {
    out.reason = 'no correlated OrderCreated (only stale events arrived) — try alternate';
    log.warn(out.reason);
    return out;
  }
  out.orderId = orderId;
  out.ordered = true;
  out.tx.createTxHash = created.createTxHash;
  log.step(State.Negotiate, 'provider accepted — order created on-chain', { order: orderId });
  log.tx('createOrder', created.createTxHash);

  const price = priceUSDC(created);
  if (price !== null && price > entry.priceCeiling) {
    out.reason = `price ${price} USDC exceeds ceiling ${entry.priceCeiling} — not paying, try alternate`;
    log.warn(out.reason);
    return out;
  }

  // PAY (sequential via the pay-mutex — no concurrent payOrder, AA-wallet nonce invariant)
  log.step(State.Pay, 'paying order (sequential, nonce-safe)', { order: orderId, priceUSDC: price ?? 'n/a' });
  try {
    const result = await payMutex.run(() => client.payOrder(orderId));
    out.tx.payTxHash = result.txHash;
    log.tx('pay', result.txHash);
  } catch (err) {
    if (isInsufficientBalance(err)) {
      throw new HaltError(explainError(err, 'payOrder')); // out of USDC — halt the whole run
    }
    out.reason = explainError(err, 'payOrder');
    log.error(out.reason);
    await enrichTx(client, orderId, out.tx, log);
    return out;
  }

  // AWAIT_DELIVERY (SLA window; timeout → CAP auto-refunds → partial, try alternate)
  log.step(State.AwaitDelivery, 'awaiting delivery (SLA window)', { order: orderId });
  try {
    const slaMs = Math.min(cfg.slaTimeoutMs, remaining());
    await router.awaitCompletion(orderId, slaMs);
  } catch (err) {
    if (err instanceof OrderTimeoutError) {
      out.reason = `SLA timeout — paid, no delivery; CAP auto-refunds escrow, source unavailable; try alternate`;
    } else if (err instanceof OrderRejectedError) {
      out.reason = `order ${err.kind} (${err.reasonText || 'no reason'}) — escrow refunded, source unavailable`;
    } else {
      out.reason = explainError(err, 'awaitCompletion');
    }
    log.warn(out.reason);
    await enrichTx(client, orderId, out.tx, log);
    return out;
  }

  let order: Order;
  let delivery: Delivery;
  try {
    order = await client.getOrder(orderId);
    delivery = await client.getDelivery(orderId);
  } catch (err) {
    out.reason = explainError(err, 'getOrder/getDelivery');
    log.error(out.reason);
    await enrichTx(client, orderId, out.tx, log);
    return out;
  }
  out.tx = {
    createTxHash: order.createTxHash,
    payTxHash: order.payTxHash || out.tx.payTxHash,
    deliverTxHash: order.deliverTxHash,
    clearTxHash: order.clearTxHash,
  };
  log.tx('deliver', order.deliverTxHash);

  const text = delivery.deliverableText || delivery.deliverableSchema || '';
  log.step(State.AwaitDelivery, 'delivery retrieved', { order: orderId, type: delivery.deliverableType, chars: text.length });

  const integrity = await verifyDeliveryIntegrity(order, delivery, cfg.rpcURL);
  reportIntegrity(log, order, integrity);

  // FIREWALL — every deliverable is screened before it can enter the verdict
  log.step(State.Firewall, 'screening deliverable through the firewall', { order: orderId });
  const deliverable: SupplierDeliverable = {
    source: entry.label,
    service: entry.label,
    orderId,
    category: entry.category,
    text,
  };
  const screen = await gate.screen([deliverable], cfg.request);
  for (const note of screen.notes) log.warn(`firewall: ${note}`);

  const quarantined = screen.quarantined[0];
  if (quarantined) {
    out.status = 'quarantined';
    out.reason = `firewall QUARANTINE (${quarantined.verdict}) — deliverable dropped, supplier flagged hostile`;
    log.step(State.Firewall, 'QUARANTINE — finding dropped, supplier flagged hostile', { order: orderId, verdict: quarantined.verdict });
    return out;
  }

  const admitted = screen.admitted[0];
  if (!admitted) {
    out.reason = 'firewall returned no admitted finding (unexpected)';
    log.error(out.reason);
    return out;
  }

  // NORMALIZE — pass = full weight, flag = contested + down-weighted
  log.step(State.Normalize, 'normalizing to §9 finding', { order: orderId, safety: admitted.safety, contested: admitted.contested });
  out.status = 'admitted';
  out.weight = admitted.weight;
  out.finding = normalizeFinding(entry, admitted, orderId, integrity.ok);
  out.reason = admitted.contested ? 'firewall FLAG — ingested contested + down-weighted' : undefined;
  return out;
}

function printVerdict(log: Logger, verdict: Verdict, outcomes: SupplierOutcome[], counterparties: Counterparty[]): void {
  log.info('§9 VERDICT OBJECT:');
  console.log(JSON.stringify(verdict, null, 2));
  log.info('per-supplier trace:');
  for (const o of outcomes) {
    log.info(`  ${o.label} [${o.cluster}/${o.dimension}] → ${o.status}`, {
      order: o.orderId ?? 'n/a',
      create: o.tx.createTxHash || '-',
      pay: o.tx.payTxHash || '-',
      deliver: o.tx.deliverTxHash || '-',
    });
    if (o.reason) log.info(`    ↳ ${o.reason}`);
  }
  log.info(`counterparty set (${counterparties.length} distinct on-chain): ${counterparties.map((c) => `${c.label}[${c.cluster}]`).join(', ') || 'none'}`);
}

/** Halt with no verdict when the plan is empty (misconfigured registry). Distinct from HaltError
 *  (out-of-USDC): both abort the DD, callers map them to their own exit/refund behavior. */
export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

/** Everything a DD run needs beyond the target — an ALREADY-CONNECTED client/router so both the
 *  requester CLI (runWard) and the provider fulfil on the SAME websocket (one WS per key, 1008). */
export interface DDDeps {
  client: AgentClient;
  router: EventRouter;
  payMutex: Mutex;
  gate: FirewallGate;
  cfg: WardConfig;
  log: Logger;
}

export interface DDResult {
  verdict: Verdict;
  outcomes: SupplierOutcome[];
  orderGraph: Counterparty[];
  dominance: DominanceReport;
}

/** The DD spine on an existing connection: PLAN → external-dominant fan-out → anti-sybil → §9 verdict.
 *  Does NOT connect, close, deliver, or print — the caller owns the socket and what to do with the
 *  verdict. Throws HaltError (out-of-USDC) or PlanError (empty plan); all per-supplier failures isolate. */
export async function runDD(deps: DDDeps, target: string): Promise<DDResult> {
  const { client, router, payMutex, gate, cfg, log } = deps;

  // PLAN — external-dominant fan-out across DD dimensions, primary + alternates per dimension
  const plan = buildPlan(cfg.registry);
  log.step(State.Plan, 'planned external-dominant fan-out', {
    target,
    dimensions: plan.dimensions.map((d) => `${d.category}(${d.primaryCluster}:${d.candidates.length})`).join(' '),
    dropped: plan.droppedForDominance.join(',') || 'none',
  });
  for (const d of plan.dimensions) {
    log.info(`  dimension ${d.category}: ${d.candidates.map((c) => `${c.label}[${c.cluster}]`).join(' → ')}`);
  }
  if (plan.noExternalSupply) log.warn('no external supplier configured — run will NOT be external-dominant (degraded)');
  if (plan.dimensions.length === 0) throw new PlanError('PLAN produced no dimensions — check the registry');

  // FAN-OUT — SEQUENTIAL (pay-mutex/nonce), per-supplier isolation, aggregate timeout budget
  const deadlineMs = Date.now() + cfg.fanoutBudgetMs;
  const outcomes: SupplierOutcome[] = [];
  const skippedForBudget: string[] = [];
  let coveredDimensions = 0;

  for (const dim of plan.dimensions) {
    if (deadlineMs - Date.now() < MIN_ATTEMPT_MS) {
      skippedForBudget.push(dim.category);
      log.warn('fan-out budget exhausted — skipping dimension', { dimension: dim.category });
      continue;
    }
    let covered = false;
    for (let i = 0; i < dim.candidates.length; i++) {
      const candidate = dim.candidates[i];
      if (!candidate) break;
      if (deadlineMs - Date.now() < MIN_ATTEMPT_MS) {
        skippedForBudget.push(dim.category);
        log.warn('fan-out budget exhausted mid-dimension', { dimension: dim.category });
        break;
      }
      if (i > 0) log.step(State.Plan, 'primary failed — falling to alternate', { dimension: dim.category, alternate: candidate.label });

      const outcome = await runSupplier(client, router, payMutex, gate, cfg, target, candidate, deadlineMs, log);
      outcomes.push(outcome);

      if (outcome.status === 'admitted') {
        covered = true;
        coveredDimensions += 1;
        break; // dimension covered — do not hire alternates
      }
    }
    if (!covered) log.warn('dimension uncovered after all candidates', { dimension: dim.category });
  }

  // ANTI-SYBIL — assert external-dominant directional consumption (not a reciprocal swap ring).
  // Dominance is judged on the DELIVERED (admitted) set — a supplier that ordered then failed, or was
  // firewall-quarantined as hostile, must NOT count as external corroboration. The on-chain ORDER GRAPH
  // (everyone we created an order with) is logged separately for the anti-sybil trace.
  const orderGraph = orderedCounterparties(outcomes);
  const dominance = assessDominance(deliveredCounterparties(outcomes));
  log.step(State.Collate, 'anti-sybil: counterparty composition (delivered set)', {
    external: dominance.externalDistinct,
    friendly: dominance.friendlyDistinct,
    dominant: dominance.dominant,
    orderGraph: orderGraph.map((c) => `${c.label}[${c.cluster}]`).join(',') || 'none',
  });
  if (!dominance.dominant) {
    log.warn('external-dominance NOT met on delivered set — friendly-heavy or thin; verdict degraded, surfaced on the verdict face');
  }

  // COLLATE (pass-through) → VERDICT
  const findings = outcomes.map((o) => o.finding).filter((f): f is Finding => f !== undefined);
  const { findings: collated } = collate(findings);
  log.step(State.Verdict, 'composing §9 verdict', { sources: outcomes.length, usable: collated.length, covered: coveredDimensions });
  const verdict = composeVerdict({
    target,
    outcomes,
    plannedDimensions: plan.dimensions.length,
    coveredDimensions,
    dominance,
    droppedForDominance: plan.droppedForDominance,
    noExternalSupply: plan.noExternalSupply,
    skippedForBudget,
  });

  return { verdict, outcomes, orderGraph, dominance };
}

export async function runWard(cfg: WardConfig): Promise<number> {
  const log = new Logger('ward');

  // INTAKE
  log.step(State.Intake, 'token-DD intake', { target: cfg.target, chain: cfg.chain, request: cfg.request });

  const client = createClient(cfg, log);
  const payMutex = new Mutex();
  const gate = new FirewallGate(groqJudge); // production firewall judge wired (Groq, GROQ_API_KEY)

  const stream = await client.connectWebSocket();
  const router = new EventRouter(stream, log);
  watchConnection(stream, log);
  installShutdown(stream, log);
  log.step(State.Intake, 'websocket connected (one-per-key 1008 watchdog active)');

  let result: DDResult;
  try {
    result = await runDD({ client, router, payMutex, gate, cfg, log }, cfg.target);
  } catch (err) {
    if (err instanceof HaltError) {
      log.error(`HALT: ${err.message}`);
      log.banner('WARD HALTED — operator action required (no verdict)', false);
      stream.close();
      return 2;
    }
    if (err instanceof PlanError) {
      log.error(err.message);
      log.banner('WARD HALTED — empty plan', false);
      stream.close();
      return 2;
    }
    stream.close();
    throw err;
  }
  const { verdict, outcomes, orderGraph } = result;

  // DELIVER_TO_HUMAN
  if (cfg.humanOrderId) {
    log.step(State.DeliverToHuman, 'delivering verdict to complete the human order', { humanOrder: cfg.humanOrderId });
    try {
      const res = await client.deliverOrder(cfg.humanOrderId, {
        deliverableType: DeliverableType.Text,
        deliverableText: JSON.stringify(verdict),
      });
      log.tx('deliver(human)', res.txHash);
      log.step(State.Integrity, 'verifying H2A settlement');
      const humanOrder = await client.getOrder(cfg.humanOrderId);
      const humanDelivery = await client.getDelivery(cfg.humanOrderId);
      const hi = await verifyDeliveryIntegrity(humanOrder, humanDelivery, cfg.rpcURL);
      reportIntegrity(log, humanOrder, hi);
      log.info('H2A settlement', { status: humanOrder.status, settled: hi.ok });
    } catch (err) {
      log.error(explainError(err, 'deliverOrder(human)'));
    }
  } else {
    log.step(State.DeliverToHuman, 'no human order configured — delivering verdict to operator console');
  }

  // SETTLE
  log.step(State.Settle, 'settled — emitting §9 verdict + evidence');
  printVerdict(log, verdict, outcomes, orderGraph);
  log.banner(`WARD VERDICT: ${verdict.verdict.toUpperCase()} (confidence ${verdict.confidence.toFixed(2)})`, verdict.verdict !== 'no-go');

  stream.close();
  return 0;
}
