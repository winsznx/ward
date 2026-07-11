import type { SupplierOutcome } from './model.js';
import type { Cluster, RegistryEntry } from './registry.js';

export interface DimensionPlan {
  category: string;
  /** ordered candidates for this dimension: external-first, then reliability desc. [0] is PRIMARY. */
  candidates: RegistryEntry[];
  primaryCluster: Cluster;
}

export interface SwarmPlan {
  dimensions: DimensionPlan[];
  /** friendly dimensions dropped to keep the planned supply external-dominant (§10 invariant). */
  droppedForDominance: string[];
  /** true when no external supplier exists at all — the run cannot be external-dominant (flagged). */
  noExternalSupply: boolean;
}

function orderCandidates(entries: RegistryEntry[]): RegistryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.cluster !== b.cluster) return a.cluster === 'external' ? -1 : 1; // external primary
    return b.reliability - a.reliability; // then most reliable first
  });
}

/**
 * Build the fan-out plan: one dimension per category, candidates ordered external-first
 * (primary + alternates), then enforce the §10 invariant that EXTERNAL primaries strictly
 * outnumber FRIENDLY primaries by dropping the least-reliable friendly dimensions. Friendly is the
 * minority safety net, never the bulk of supply — this is what keeps the order graph from reading
 * as a friendly-heavy wash ring.
 */
export function buildPlan(registry: RegistryEntry[]): SwarmPlan {
  const byCategory = new Map<string, RegistryEntry[]>();
  for (const e of registry) {
    const list = byCategory.get(e.category) ?? [];
    list.push(e);
    byCategory.set(e.category, list);
  }

  let dimensions: DimensionPlan[] = [];
  for (const [category, entries] of byCategory) {
    const candidates = orderCandidates(entries);
    const primary = candidates[0];
    if (!primary) continue;
    dimensions.push({ category, candidates, primaryCluster: primary.cluster });
  }

  const droppedForDominance: string[] = [];
  // Count DISTINCT primary agentIds per cluster — the SAME identity assessDominance uses on the
  // delivered set. One agent can back several dimensions (e.g. Remi's 5 services), so dimension
  // count would over-state external dominance and certify a plan that can never deliver it.
  const distinctPrimaryAgents = (cluster: Cluster): number => {
    const ids = new Set<string>();
    for (const d of dimensions) {
      if (d.primaryCluster !== cluster) continue;
      const primary = d.candidates[0];
      if (primary) ids.add(primary.agentId);
    }
    return ids.size;
  };
  const noExternalSupply = distinctPrimaryAgents('external') === 0;

  if (!noExternalSupply) {
    // external distinct agents must STRICTLY outnumber friendly distinct agents: drop least-reliable
    // friendly dimensions until that holds (or no friendly dims remain).
    while (distinctPrimaryAgents('friendly') >= distinctPrimaryAgents('external')) {
      const friendlyDims = dimensions.filter((d) => d.primaryCluster === 'friendly');
      if (friendlyDims.length === 0) break;
      const victim = friendlyDims.reduce((min, d) =>
        (d.candidates[0]?.reliability ?? 0) < (min.candidates[0]?.reliability ?? 0) ? d : min,
      );
      droppedForDominance.push(victim.category);
      dimensions = dimensions.filter((d) => d !== victim);
    }
  }

  // deterministic order: external-primary dimensions first, then alphabetically by category.
  dimensions.sort((a, b) => {
    if (a.primaryCluster !== b.primaryCluster) return a.primaryCluster === 'external' ? -1 : 1;
    return a.category.localeCompare(b.category);
  });

  return { dimensions, droppedForDominance, noExternalSupply };
}

export interface Counterparty {
  agentId: string;
  label: string;
  cluster: Cluster;
}

export interface DominanceReport {
  externalDistinct: number;
  friendlyDistinct: number;
  /** external strictly outnumbers friendly among DELIVERED counterparties. */
  dominant: boolean;
  counterparties: Counterparty[];
}

/** Counterparties that DELIVERED firewall-admitted evidence — the set dominance is judged on
 *  (a supplier that ordered then failed, or was quarantined as hostile, must NOT count). */
export function deliveredCounterparties(outcomes: SupplierOutcome[]): Counterparty[] {
  return outcomes
    .filter((o) => o.status === 'admitted')
    .map((o) => ({ agentId: o.agentId, label: o.label, cluster: o.cluster }));
}

/** Every counterparty we created an on-chain order with — the directional order graph (for the trace). */
export function orderedCounterparties(outcomes: SupplierOutcome[]): Counterparty[] {
  return outcomes
    .filter((o) => o.ordered)
    .map((o) => ({ agentId: o.agentId, label: o.label, cluster: o.cluster }));
}

/** Assess external-dominance over the DELIVERED counterparty set (deduped by agentId). */
export function assessDominance(delivered: Counterparty[]): DominanceReport {
  const distinct = new Map<string, Counterparty>();
  for (const c of delivered) if (!distinct.has(c.agentId)) distinct.set(c.agentId, c);
  let externalDistinct = 0;
  let friendlyDistinct = 0;
  for (const c of distinct.values()) {
    if (c.cluster === 'external') externalDistinct += 1;
    else friendlyDistinct += 1;
  }
  return {
    externalDistinct,
    friendlyDistinct,
    dominant: externalDistinct > friendlyDistinct,
    counterparties: [...distinct.values()],
  };
}
