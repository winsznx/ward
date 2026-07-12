/** §9 data model + orchestrator FSM types. */
import type { Cluster } from './registry.js';

export type VerdictLabel = 'go' | 'caution' | 'no-go';
export type Severity = 'info' | 'warn' | 'critical';
export type FirewallSafety = 'safe' | 'suspicious' | 'hostile';

/** Content risk read of a firewall-admitted deliverable (distinct from firewall safety, which is about
 *  an injection AIMED at Ward). `clean`/`dangerous` are only asserted from an explicit structured signal
 *  (a risk badge/score); ambiguous content stays `unknown` so it can never manufacture a false GO. */
export type RiskLevel = 'clean' | 'caution' | 'dangerous' | 'unknown';
export interface RiskRead {
  level: RiskLevel;
  score?: number;
  badge?: string;
}

/** §9 Finding (normalized per source). */
export interface Finding {
  source_agent: string;
  source_service: string;
  category: string;
  signal: string;
  severity: Severity;
  firewall: { safety: FirewallSafety; conformance: number };
  /** content risk-scoring of the deliverable itself (the GO-gate's safety signal). */
  risk?: RiskRead;
  order_id: string;
  settled: boolean;
}

export interface Contradiction {
  a: string;
  b: string;
  field: string;
}

/** §9 Verdict object (returned to the human). */
export interface Verdict {
  target: string;
  verdict: VerdictLabel;
  confidence: number;
  sources_run: number;
  sources_quarantined: number;
  sources_failed: number;
  findings: Finding[];
  contradictions: Contradiction[];
  notes: string;
  evidence_hash: string;
}

/** PRD §6 state machine. */
export const State = {
  Intake: 'INTAKE',
  Plan: 'PLAN',
  Negotiate: 'NEGOTIATE',
  Pay: 'PAY',
  AwaitDelivery: 'AWAIT_DELIVERY',
  Firewall: 'FIREWALL',
  Normalize: 'NORMALIZE',
  Collate: 'COLLATE',
  Verdict: 'VERDICT',
  DeliverToHuman: 'DELIVER_TO_HUMAN',
  Integrity: 'INTEGRITY',
  Settle: 'SETTLE',
  Done: 'DONE',
  Halted: 'HALTED',
} as const;
export type StateName = (typeof State)[keyof typeof State];

export type SupplierStatus = 'admitted' | 'quarantined' | 'failed';

export interface OrderTx {
  createTxHash: string;
  payTxHash: string;
  deliverTxHash: string;
  clearTxHash: string;
}

/** Outcome of one supplier through NEGOTIATE→PAY→AWAIT_DELIVERY→FIREWALL→NORMALIZE. */
export interface SupplierOutcome {
  id: string;
  label: string;
  agentId: string;
  /** DD dimension covered (registry category). */
  dimension: string;
  category: string;
  /** external (rival) or friendly (minority safety net). */
  cluster: Cluster;
  status: SupplierStatus;
  orderId: string | undefined;
  /** whether a real on-chain order was created with this counterparty (orderId present). */
  ordered: boolean;
  tx: OrderTx;
  /** firewall ingest weight (1.0 clean pass, FLAG_WEIGHT for a contested flag). 1 for non-admitted. */
  weight: number;
  /** present iff status === 'admitted' */
  finding: Finding | undefined;
  /** failure / quarantine / coverage-gap reason — always set unless cleanly admitted */
  reason: string | undefined;
}

export const EMPTY_TX: OrderTx = { createTxHash: '', payTxHash: '', deliverTxHash: '', clearTxHash: '' };
