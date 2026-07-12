import { ethers } from 'ethers';
import type { AdmittedFinding } from '../../firewall/src/gate.js';
import type { DominanceReport } from './plan.js';
import type { RegistryEntry } from './registry.js';
import type { Contradiction, Finding, RiskLevel, RiskRead, Severity, SupplierOutcome, Verdict, VerdictLabel } from './model.js';

const SIGNAL_MAX = 280;
const CONFIDENCE_CAP = 0.8;
const GO_CONFIDENCE_CAP = 0.95;

const RISK_RANK: Record<RiskLevel, number> = { unknown: 0, clean: 1, caution: 2, dangerous: 3 };
const BADGE_DANGER = /\b(danger|dangerous|high|critical|fail(ed)?|scam|honeypot|rug|malicious|unsafe|blacklist|blocked|reject)\b/i;
const BADGE_CAUTION = /\b(caution|medium|moderate|warn|warning|suspicious|review)\b/i;
const BADGE_CLEAN = /\b(safe|low|pass(ed)?|clean|verified|legit|ok)\b/i;

/**
 * Content risk-scoring (§9): read a firewall-admitted deliverable's OWN risk signal — separate from the
 * firewall (which asks "is this trying to hijack me?"). Conservative by construction: `clean` and
 * `dangerous` are only asserted from an explicit structured badge/score (e.g. Attestr `{badge, riskScore}`);
 * heterogeneous prose stays `unknown` so it can never manufacture a false GO. Worst signal wins.
 */
export function readRisk(text: string): RiskRead {
  let badge: string | undefined;
  let score: number | undefined;
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const b = o.badge ?? o.rating ?? o.risk ?? o.verdict ?? o.status ?? o.result;
    if (typeof b === 'string') badge = b;
    const s = o.riskScore ?? o.risk_score ?? o.score;
    if (typeof s === 'number' && Number.isFinite(s)) score = s;
  } catch {
    // not JSON — fall back to a shallow structured scan
  }
  if (badge === undefined) {
    const m = text.match(/"?badge"?\s*[:=]\s*"?(safe|caution|dangerous|high|low|medium|critical)/i);
    if (m && m[1]) badge = m[1];
  }
  if (score === undefined) {
    const m = text.match(/"?risk[_ ]?score"?\s*[:=]\s*"?(\d{1,3})/i);
    if (m && m[1]) score = Number(m[1]);
  }

  let level: RiskLevel = 'unknown';
  const worst = (l: RiskLevel): void => {
    if (RISK_RANK[l] > RISK_RANK[level]) level = l;
  };
  if (badge) {
    if (BADGE_DANGER.test(badge)) worst('dangerous');
    else if (BADGE_CAUTION.test(badge)) worst('caution');
    else if (BADGE_CLEAN.test(badge)) worst('clean');
  }
  if (score !== undefined) {
    // higher = riskier, 0-100 (Attestr semantics)
    if (score >= 70) worst('dangerous');
    else if (score >= 35) worst('caution');
    else worst('clean');
  }
  return { level, ...(score !== undefined ? { score } : {}), ...(badge ? { badge } : {}) };
}

/** NORMALIZE: a firewall-admitted deliverable -> a §9 Finding. */
export function normalizeFinding(
  entry: RegistryEntry,
  admitted: AdmittedFinding,
  orderId: string,
  settled: boolean,
): Finding {
  const severity: Severity = admitted.contested ? 'warn' : 'info';
  return {
    source_agent: entry.agentId,
    source_service: entry.label,
    category: entry.category,
    signal: admitted.text.replace(/\s+/g, ' ').trim().slice(0, SIGNAL_MAX),
    severity,
    firewall: { safety: admitted.safety, conformance: 1 }, // conformance scorer pending — pass-through 1.0
    risk: readRisk(admitted.text),
    order_id: orderId,
    settled,
  };
}

/** COLLATE: single-source-per-dimension pass-through. Cross-source contradictions are a later prompt (§7.3). */
export function collate(findings: Finding[]): { findings: Finding[]; contradictions: Contradiction[] } {
  return { findings, contradictions: [] };
}

export interface VerdictContext {
  target: string;
  outcomes: SupplierOutcome[];
  /** dimensions the plan set out to cover. */
  plannedDimensions: number;
  /** distinct dimensions with at least one admitted finding. */
  coveredDimensions: number;
  dominance: DominanceReport;
  droppedForDominance: string[];
  noExternalSupply: boolean;
  /** dimensions skipped because the aggregate fan-out budget ran out. */
  skippedForBudget: string[];
}

/**
 * VERDICT: aggregate all sources into the §9 object. The GO gate is EXPLICIT — partial coverage,
 * non-external-dominant supply, any quarantine, any contested finding, or thin (<2) corroboration
 * each block GO. Content risk-scoring (a later prompt) is an additional gate, so GO is unreachable
 * for now by construction — but the coverage gate is live and testable.
 */
export function composeVerdict(ctx: VerdictContext): Verdict {
  const { target, outcomes, plannedDimensions, coveredDimensions, dominance } = ctx;

  const findings = outcomes
    .map((o) => o.finding)
    .filter((f): f is Finding => f !== undefined);
  const sources_run = outcomes.length;
  const sources_quarantined = outcomes.filter((o) => o.status === 'quarantined').length;
  const sources_failed = outcomes.filter((o) => o.status === 'failed').length;
  const usable = findings.length;
  const contestedCount = findings.filter((f) => f.severity === 'warn').length;
  const coverage = plannedDimensions > 0 ? coveredDimensions / plannedDimensions : 0;
  const hostileSuppliers = [...new Set(outcomes.filter((o) => o.status === 'quarantined').map((o) => o.label))];

  // Coverage gate — the invariant: degraded/thin/hostile/non-dominant coverage can NEVER be GO.
  const coverageBlockers: string[] = [];
  if (coverage < 1) coverageBlockers.push(`partial coverage (${coveredDimensions}/${plannedDimensions} dimensions)`);
  if (!dominance.dominant) coverageBlockers.push('supply not external-dominant');
  if (sources_quarantined > 0) coverageBlockers.push(`${sources_quarantined} source(s) attempted injection`);
  if (contestedCount > 0) coverageBlockers.push(`${contestedCount} contested finding(s)`);
  if (usable < 2) coverageBlockers.push('thin coverage (<2 corroborating sources)');

  const notes: string[] = [];
  if (sources_quarantined > 0) {
    notes.push(`${sources_quarantined} source${sources_quarantined === 1 ? '' : 's'} attempted injection, quarantined (${hostileSuppliers.join(', ')})`);
  }
  if (sources_failed > 0) {
    notes.push(`${sources_failed} source${sources_failed === 1 ? '' : 's'} unavailable (negotiation/SLA failure) — coverage gap`);
  }
  if (ctx.droppedForDominance.length > 0) {
    notes.push(`friendly dimensions held out to keep supply external-dominant: ${ctx.droppedForDominance.join(', ')}`);
  }
  if (ctx.skippedForBudget.length > 0) {
    notes.push(`dimensions skipped (fan-out budget exhausted): ${ctx.skippedForBudget.join(', ')}`);
  }
  if (ctx.noExternalSupply) {
    notes.push('no external supplier available — run is NOT external-dominant (degraded, friendly-only)');
  } else if (!dominance.dominant) {
    notes.push(`supply not external-dominant: ${dominance.externalDistinct} external vs ${dominance.friendlyDistinct} friendly delivered`);
  }
  if (contestedCount > 0) {
    notes.push(`${contestedCount} finding${contestedCount === 1 ? '' : 's'} flagged contested by firewall — down-weighted`);
  }
  for (const o of outcomes) {
    if (o.reason && o.status !== 'admitted') notes.push(`${o.label}: ${o.reason}`);
  }

  // Content risk-scoring — separate from the coverage gate. The audit dimension is the load-bearing
  // safety signal; GO needs it explicitly scored clean, and ANY source scoring the token dangerous
  // blocks release outright. `clean`/`dangerous` come only from structured signals (readRisk), so an
  // ambiguous/unknown read can never manufacture a GO.
  const dangerousSources = findings.filter((f) => f.risk?.level === 'dangerous');
  const auditClean = findings.some((f) => f.category === 'audit' && f.risk?.level === 'clean');
  const riskBlockers: string[] = [];
  if (!auditClean) riskBlockers.push('audit source not content-scored clean (needs an explicit SAFE + low-risk read)');

  let verdict: VerdictLabel;
  let confidence: number;
  if (sources_quarantined > 0 && usable === 0) {
    verdict = 'no-go'; // only attacks, nothing usable
    confidence = 0.1;
    notes.push(`no usable findings — ${sources_quarantined} quarantined, ${sources_failed} unavailable`);
  } else if (usable === 0) {
    verdict = 'caution'; // pure coverage failure
    confidence = 0.1;
    notes.push('no usable findings — partial/zero coverage');
  } else if (dangerousSources.length > 0) {
    verdict = 'no-go'; // a source content-scored the token itself dangerous
    confidence = 0.15;
    notes.push(`NO-GO: content risk-scored dangerous by ${dangerousSources.map((f) => `${f.source_service}${f.risk?.badge ? ` (${f.risk.badge})` : ''}`).join(', ')}`);
  } else if (coverageBlockers.length === 0 && riskBlockers.length === 0) {
    verdict = 'go'; // external-dominant corroboration AND content-scored clean, no danger
    confidence = Math.min(GO_CONFIDENCE_CAP, 0.7 + 0.1 * usable);
    notes.push('GO: external-dominant corroboration + audit content-scored clean; no danger signals');
  } else {
    verdict = 'caution'; // gated from GO
    const admitted = outcomes.filter((o) => o.status === 'admitted');
    const avgWeight = admitted.length > 0 ? admitted.reduce((sum, o) => sum + o.weight, 0) / admitted.length : 1;
    const dominanceFactor = dominance.dominant ? 1 : 0.5;
    confidence = Math.min(CONFIDENCE_CAP, coverage * dominanceFactor * avgWeight);
    notes.push(`GO blocked: ${[...coverageBlockers, ...riskBlockers].join('; ')}`);
  }

  notes.push(
    `counterparties: ${dominance.counterparties.map((c) => `${c.label}[${c.cluster}]`).join(', ') || 'none'}`,
  );

  const base = {
    target,
    verdict,
    confidence: Number(confidence.toFixed(2)),
    sources_run,
    sources_quarantined,
    sources_failed,
    findings,
    contradictions: [] as Contradiction[],
    notes: notes.join('; '),
  };
  const evidence_hash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(base)));
  return { ...base, evidence_hash };
}
