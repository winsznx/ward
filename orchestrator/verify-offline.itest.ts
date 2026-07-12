/**
 * Offline verification of the swarm logic with NO mainnet keys: PLAN (external-first ordering,
 * external-dominance cap), delivered-set dominance, multi-source §9 verdict aggregation, the
 * explicit GO-gate (partial/hostile/non-dominant never GO), and the race-safe EventRouter.
 *
 *   npx tsx verify-offline.itest.ts
 */
import { EventType, type Event, type EventStream } from '@croo-network/sdk';
import type { AdmittedFinding } from '../firewall/src/gate.js';
import { Logger } from './src/logger.js';
import { EventRouter, OrderRejectedError, OrderTimeoutError } from './src/events.js';
import { assessDominance, buildPlan, deliveredCounterparties, orderedCounterparties } from './src/plan.js';
import { loadRegistry, type Cluster, type RegistryEntry } from './src/registry.js';
import type { Finding, SupplierOutcome } from './src/model.js';
import { EMPTY_TX } from './src/model.js';
import { composeVerdict, normalizeFinding } from './src/verdict.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

function entry(id: string, category: string, cluster: Cluster, reliability = 0.5, agentId = `0x${id}`): RegistryEntry {
  return {
    id, label: id, agentId, serviceId: `svc-${id}`, category, cluster,
    requirementsTemplate: { t: '{{target}}' }, priceCeiling: 1, reliability, enabled: true,
  };
}
function finding(dimension: string, contested = false): Finding {
  return {
    source_agent: `0x${dimension}`, source_service: dimension, category: dimension, signal: 'sig',
    severity: contested ? 'warn' : 'info', firewall: { safety: contested ? 'suspicious' : 'safe', conformance: 1 },
    order_id: `ord-${dimension}`, settled: true,
  };
}
function outcome(o: {
  dimension: string; cluster: Cluster; status: SupplierOutcome['status'];
  finding?: Finding; weight?: number; reason?: string; ordered?: boolean;
}): SupplierOutcome {
  return {
    id: o.dimension, label: o.dimension, agentId: `0x${o.dimension}`, dimension: o.dimension, category: o.dimension,
    cluster: o.cluster, status: o.status, orderId: `ord-${o.dimension}`, ordered: o.ordered ?? true,
    tx: { ...EMPTY_TX }, weight: o.weight ?? 1, finding: o.finding, reason: o.reason,
  };
}
function cps(clusters: Cluster[]): { agentId: string; label: string; cluster: Cluster }[] {
  return clusters.map((cluster, i) => ({ agentId: `0x${i}`, label: `cp${i}`, cluster }));
}

function testPlan(): void {
  console.log('\n[plan]');

  // external ordered as primary even when its reliability is lower (external dominates supply)
  const p1 = buildPlan([entry('f-aud', 'audit', 'friendly', 0.9), entry('e-aud', 'audit', 'external', 0.4)]);
  const audit = p1.dimensions.find((d) => d.category === 'audit');
  assert(audit?.candidates[0]?.cluster === 'external', 'external candidate is PRIMARY even at lower reliability');
  assert(audit?.candidates[1]?.cluster === 'friendly', 'friendly is the ALTERNATE');

  // dominance cap: 2 external dims + 2 friendly dims -> drop least-reliable friendly so ext > friendly
  const p2 = buildPlan([
    entry('e1', 'audit', 'external', 0.5), entry('e2', 'address', 'external', 0.5),
    entry('f1', 'liquidity', 'friendly', 0.8), entry('f2', 'sentiment', 'friendly', 0.3),
  ]);
  const ext = p2.dimensions.filter((d) => d.primaryCluster === 'external').length;
  const fr = p2.dimensions.filter((d) => d.primaryCluster === 'friendly').length;
  assert(ext === 2 && fr === 1 && ext > fr, 'dominance cap: external strictly outnumbers friendly in the plan');
  assert(p2.droppedForDominance.includes('sentiment'), 'least-reliable friendly dimension (sentiment 0.3) held out');

  // no external supply -> flagged, friendly kept (never zero out coverage)
  const p3 = buildPlan([entry('f1', 'liquidity', 'friendly', 0.8), entry('f2', 'sentiment', 'friendly', 0.5)]);
  assert(p3.noExternalSupply && p3.dimensions.length === 2 && p3.droppedForDominance.length === 0, 'no external supply flagged; friendly dims retained');

  // delivered-set dominance
  assert(assessDominance(cps(['external', 'external', 'friendly'])).dominant, 'delivered 2 ext vs 1 friendly -> dominant');
  assert(!assessDominance(cps(['external', 'friendly', 'friendly'])).dominant, 'delivered 1 ext vs 2 friendly -> NOT dominant');

  // same agent backing multiple external dimensions: dominance is by DISTINCT AGENT, not dimension
  const p4 = buildPlan([
    entry('s', 'sentiment', 'external', 0.5, '0xR'), entry('m', 'macro', 'external', 0.5, '0xR'),
    entry('f1', 'liquidity', 'friendly', 0.8, '0xf1'), entry('f2', 'holders', 'friendly', 0.6, '0xf2'),
  ]);
  assert(p4.dimensions.length === 2 && p4.dimensions.every((d) => d.primaryCluster === 'external'), 'same-agent 2 ext dims = 1 distinct external agent; plan keeps the 2 external dims');
  assert(p4.droppedForDominance.length === 2, 'distinct-agent accounting drops BOTH friendlies (1 ext agent cannot dominate any friendly agent)');
}

function testCounterparties(): void {
  console.log('\n[counterparties — dominance on the DELIVERED (admitted) set]');
  const outs = [
    outcome({ dimension: 'audit', cluster: 'external', status: 'admitted', finding: finding('audit') }),
    outcome({ dimension: 'risk', cluster: 'external', status: 'quarantined', reason: 'QUARANTINE' }), // hostile external
    outcome({ dimension: 'liquidity', cluster: 'friendly', status: 'admitted', finding: finding('liquidity') }),
    outcome({ dimension: 'sentiment', cluster: 'external', status: 'failed', reason: 'SLA timeout' }),
  ];
  const delivered = deliveredCounterparties(outs);
  assert(delivered.length === 2, 'delivered set = admitted only (quarantined + failed excluded)');
  const dom = assessDominance(delivered);
  assert(!dom.dominant && dom.externalDistinct === 1 && dom.friendlyDistinct === 1, 'a quarantined external does NOT count as corroboration -> 1 vs 1 -> NOT dominant');
  assert(orderedCounterparties(outs).length === 4, 'order graph = every counterparty we created an order with (trace)');
}

function testRegistry(): void {
  console.log('\n[registry — strict enabled validation]');
  const mk = (enabled: unknown) => JSON.stringify([{ id: 'x', label: 'X', agentId: '0x', serviceId: 'svc-x', category: 'audit', cluster: 'external', requirementsTemplate: { a: '{{target}}' }, enabled }]);
  let threw = false;
  try { loadRegistry(mk('true')); } catch { threw = true; }
  assert(threw, 'enabled:"true" (non-boolean) is rejected, not silently coerced to false');
  const reg = loadRegistry(mk(true));
  assert(reg.some((e) => e.id === 'x' && (e.requirementsTemplate as { a: string }).a === '{{target}}'), 'valid entry parsed; template kept raw for per-order substitution');
}

function testVerdict(): void {
  console.log('\n[verdict — multi-source aggregation + GO gate]');

  const f = normalizeFinding(entry('attestr', 'audit', 'external'), admittedFinding(false), 'ord1', true);
  assert(f.firewall.safety === 'safe' && f.firewall.conformance === 1 && f.severity === 'info', 'NORMALIZE: §9 finding from registry entry');

  // A: full external-dominant clean coverage -> CAUTION (coverage gate CLEAR; GO gated on content scoring)
  const oA = [
    outcome({ dimension: 'audit', cluster: 'external', status: 'admitted', finding: finding('audit') }),
    outcome({ dimension: 'sentiment', cluster: 'external', status: 'admitted', finding: finding('sentiment') }),
  ];
  const vA = composeVerdict({ target: '0xT', outcomes: oA, plannedDimensions: 2, coveredDimensions: 2, dominance: assessDominance(cps(['external', 'external'])), droppedForDominance: [], noExternalSupply: false, skippedForBudget: [] });
  assert(vA.verdict === 'caution', 'full clean dominant -> CAUTION (never GO without content scoring)');
  assert(vA.notes.includes('coverage gate CLEAR'), 'invariant: coverage blockers empty surfaced as CLEAR');
  assert(vA.sources_run === 2 && vA.findings.length === 2, 'aggregates both sources into §9');
  assert(/0x[0-9a-f]{64}/.test(vA.evidence_hash), 'evidence_hash computed over the aggregate');

  // B: partial coverage + a failed source + a budget-skip -> CAUTION, GO blocked, nothing swallowed
  const oB = [
    outcome({ dimension: 'audit', cluster: 'external', status: 'admitted', finding: finding('audit') }),
    outcome({ dimension: 'sentiment', cluster: 'external', status: 'failed', reason: 'SLA timeout' }),
  ];
  const vB = composeVerdict({ target: '0xT', outcomes: oB, plannedDimensions: 3, coveredDimensions: 1, dominance: assessDominance(cps(['external'])), droppedForDominance: [], noExternalSupply: false, skippedForBudget: ['liquidity'] });
  assert(vB.verdict === 'caution' && vB.notes.includes('GO blocked'), 'partial coverage -> CAUTION, GO blocked');
  assert(vB.notes.includes('partial coverage') && vB.notes.includes('thin coverage'), 'partial + thin blockers surfaced');
  assert(vB.sources_failed === 1 && vB.notes.includes('skipped') && vB.notes.includes('SLA timeout'), 'failure + budget-skip on the verdict face (no gap swallowed)');

  // C: quarantine-only (no usable) -> NO-GO
  const oC = [outcome({ dimension: 'audit', cluster: 'external', status: 'quarantined', reason: 'firewall QUARANTINE' })];
  const vC = composeVerdict({ target: '0xT', outcomes: oC, plannedDimensions: 1, coveredDimensions: 0, dominance: assessDominance(cps(['external'])), droppedForDominance: [], noExternalSupply: false, skippedForBudget: [] });
  assert(vC.verdict === 'no-go' && vC.sources_quarantined === 1, 'quarantine-only -> NO-GO');
  assert(vC.notes.includes('attempted injection'), 'injection surfaced');

  // D: quarantine + some usable -> CAUTION (an attack present never yields GO, but usable data isn't zero)
  const oD = [
    outcome({ dimension: 'audit', cluster: 'external', status: 'admitted', finding: finding('audit') }),
    outcome({ dimension: 'sentiment', cluster: 'external', status: 'quarantined', reason: 'QUARANTINE' }),
  ];
  const vD = composeVerdict({ target: '0xT', outcomes: oD, plannedDimensions: 2, coveredDimensions: 1, dominance: assessDominance(cps(['external', 'external'])), droppedForDominance: [], noExternalSupply: false, skippedForBudget: [] });
  assert(vD.verdict === 'caution' && vD.notes.includes('attempted injection'), 'quarantine + usable -> CAUTION, attack still surfaced');

  // E: friendly-heavy (not external-dominant) full coverage -> CAUTION, dominance blocker + lower confidence
  const oE = [
    outcome({ dimension: 'audit', cluster: 'external', status: 'admitted', finding: finding('audit') }),
    outcome({ dimension: 'liquidity', cluster: 'friendly', status: 'admitted', finding: finding('liquidity') }),
    outcome({ dimension: 'sentiment', cluster: 'friendly', status: 'admitted', finding: finding('sentiment') }),
  ];
  const vE = composeVerdict({ target: '0xT', outcomes: oE, plannedDimensions: 3, coveredDimensions: 3, dominance: assessDominance(cps(['external', 'friendly', 'friendly'])), droppedForDominance: [], noExternalSupply: false, skippedForBudget: [] });
  assert(vE.verdict === 'caution' && vE.notes.includes('not external-dominant'), 'friendly-heavy -> not dominant, surfaced, GO blocked');
  assert(vE.confidence < vA.confidence, 'non-dominant supply lowers confidence vs external-dominant');
}

interface FakeStream { push: (e: Event) => void; asEventStream: EventStream; }
function fakeStream(): FakeStream {
  let handler: ((e: Event) => void) | null = null;
  const stub = { onAny: (h: (e: Event) => void) => { handler = h; } };
  return { push: (e) => handler?.(e), asEventStream: stub as unknown as EventStream };
}
const ev = (type: string, ids: { negotiation_id?: string; order_id?: string; reason?: string }): Event => ({ type, raw: {}, ...ids });

async function testEventRouter(): Promise<void> {
  console.log('\n[event router]');
  const log = new Logger('test');
  const keepAlive = setInterval(() => undefined, 10_000);

  const s1 = fakeStream();
  const r1 = new EventRouter(s1.asEventStream, log);
  s1.push(ev(EventType.OrderCreated, { negotiation_id: 'neg1', order_id: 'ord1' }));
  assert((await r1.awaitOrderCreated('neg1', 1000)) === 'ord1', 'buffered OrderCreated resolves on later await (no lost event)');

  const s2 = fakeStream();
  const r2 = new EventRouter(s2.asEventStream, log);
  const completed = r2.awaitCompletion('ord2', 1000);
  s2.push(ev(EventType.OrderCompleted, { order_id: 'ord2' }));
  await completed;
  s2.push(ev(EventType.OrderCompleted, { order_id: 'ord2' }));
  console.log('  ok: completion resolves; duplicate redelivery ignored (idempotent)');

  const s3 = fakeStream();
  const r3 = new EventRouter(s3.asEventStream, log);
  const waitNeg = r3.awaitOrderCreated('neg3', 1000);
  s3.push(ev(EventType.NegotiationRejected, { negotiation_id: 'neg3', reason: 'busy' }));
  let rejected: unknown;
  try { await waitNeg; } catch (e) { rejected = e; }
  assert(rejected instanceof OrderRejectedError && rejected.kind === 'negotiation_rejected', 'NegotiationRejected -> OrderRejectedError(kind)');

  const s4 = fakeStream();
  const r4 = new EventRouter(s4.asEventStream, log);
  let timedOut: unknown;
  try { await r4.awaitCompletion('ordX', 40); } catch (e) { timedOut = e; }
  assert(timedOut instanceof OrderTimeoutError, 'no delivery within SLA -> OrderTimeoutError');

  const s5 = fakeStream();
  const r5 = new EventRouter(s5.asEventStream, log);
  s5.push(ev(EventType.OrderCreated, { order_id: 'ordNoNeg' })); // negotiation_id ABSENT
  assert((await r5.awaitOrderCreated('any-neg', 1000)) === 'ordNoNeg', 'OrderCreated without negotiation_id still resolves (no dead-stop)');

  clearInterval(keepAlive);
}

async function testEventIsolation(): Promise<void> {
  console.log('\n[event isolation — beginSupplier drain + negotiation correlation]');
  const log = new Logger('test');
  const keepAlive = setInterval(() => undefined, 10_000);

  // beginSupplier drains a prior supplier's orphaned OrderCreated so it can't poison the next supplier
  const s1 = fakeStream();
  const r1 = new EventRouter(s1.asEventStream, log);
  s1.push(ev(EventType.OrderCreated, { order_id: 'ordPrior' })); // buffered (no waiter)
  r1.beginSupplier();
  let drained: unknown;
  try { await r1.awaitOrderCreated('negNew', 40); } catch (e) { drained = e; }
  assert(drained instanceof OrderTimeoutError, "beginSupplier drains a prior supplier's buffered OrderCreated (no leak-forward)");

  // a NegotiationRejected for negA must NOT reject a wait for negB (correlated by negotiationId)
  const s2 = fakeStream();
  const r2 = new EventRouter(s2.asEventStream, log);
  s2.push(ev(EventType.NegotiationRejected, { negotiation_id: 'negA', reason: 'busy' }));
  let wrongPoison: unknown;
  try { await r2.awaitOrderCreated('negB', 40); } catch (e) { wrongPoison = e; }
  assert(wrongPoison instanceof OrderTimeoutError, "negA's rejection does NOT poison negB's wait (no cross-supplier failure)");
  let ownReject: unknown;
  try { await r2.awaitOrderCreated('negA', 1000); } catch (e) { ownReject = e; }
  assert(ownReject instanceof OrderRejectedError, 'the matching negotiation (negA) still receives its own rejection');

  clearInterval(keepAlive);
}

function admittedFinding(contested: boolean): AdmittedFinding {
  return {
    source: 'attestr', service: 'attestr', orderId: 'ord1', category: 'audit',
    text: 'Ownership renounced, owner can mint — describes a risk.',
    safety: contested ? 'suspicious' : 'safe', action: contested ? 'flag' : 'pass',
    contested, weight: contested ? 0.35 : 1, indicators: [], judgeRationale: null,
  };
}

(async () => {
  testPlan();
  testCounterparties();
  testRegistry();
  testVerdict();
  await testEventRouter();
  await testEventIsolation();
  console.log('\nORCHESTRATOR SWARM OFFLINE ITEST PASS\n');
})().catch((e) => { console.error(e); process.exit(1); });
