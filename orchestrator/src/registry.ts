
export type Cluster = 'external' | 'friendly';

/** A hireable supplier (real CROO Store agent) covering one DD dimension. */
export interface RegistryEntry {
  /** stable id, e.g. 'attestr-risk' */
  id: string;
  label: string;
  /** provider agent id/address — used ONLY for the counterparty/dominance identity, never in the negotiate body */
  agentId: string;
  /** the SERVICE's GUID — the real negotiate target (verified: negotiate takes serviceId, not agentId/serviceIndex) */
  serviceId: string;
  /** DD dimension this supplier covers */
  category: string;
  /** external (rival) dominates supply; friendly is the minority safety net (§10) */
  cluster: Cluster;
  /** type-exact requirements for the service schema; {{target}}/{{chain}} substituted */
  requirementsTemplate: Record<string, unknown>;
  /** max USDC we'll pay this supplier (guard) */
  priceCeiling: number;
  /** 0..1 prior — flaky hackathon agents score low; orders primary vs alternate */
  reliability: number;
  enabled: boolean;
}

/**
 * Seed registry from internal/Ward_SUPPLIER_REGISTRY.md (Discord cross-testing). These are flaky
 * (Attestr 500 on accept; Remi wrong-address PIMLICO errors) and PERISHABLE. They ship DISABLED
 * because the service GUIDs are truncated in the registry note — fill the real serviceId from the
 * agent page and enable via WARD_REGISTRY_JSON (override by id). agentId is kept for the dominance
 * identity; the negotiate call targets serviceId.
 */
const SEEDS: readonly RegistryEntry[] = [
  {
    id: 'attestr-risk',
    label: 'Attestr Contract Risk Check',
    agentId: '20ba0841-8411-4ee7-960e-5b1d376943d3',
    serviceId: '', // fill the service GUID from the agent page, then enable
    category: 'audit',
    cluster: 'external',
    requirementsTemplate: { tokenAddress: '{{target}}', chain: '{{chain}}' },
    priceCeiling: 0.05,
    reliability: 0.5,
    enabled: false,
  },
  {
    id: 'remi-sentiment',
    label: 'Remi Sentiment Scan',
    agentId: 'bc5f02b4-92dc-4dbc-8ff3-a4f898ad4e19',
    serviceId: '', // Remi "Sentiment Scan" GUID is 7fa50ca7-… (truncated in the note) — fill + enable
    category: 'sentiment',
    cluster: 'external',
    requirementsTemplate: { token: '{{target}}', chain: '{{chain}}' },
    priceCeiling: 0.2,
    reliability: 0.5,
    enabled: false,
  },
];

class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

function isCluster(v: unknown): v is Cluster {
  return v === 'external' || v === 'friendly';
}

/** Parse + validate one operator-supplied registry entry (from WARD_REGISTRY_JSON). */
function parseEntry(raw: unknown, idx: number): RegistryEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RegistryError(`WARD_REGISTRY_JSON[${idx}] must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const str = (k: string): string => {
    const v = o[k];
    if (typeof v !== 'string' || v.trim() === '') throw new RegistryError(`WARD_REGISTRY_JSON[${idx}].${k} must be a non-empty string`);
    return v;
  };
  const num = (k: string, fallback: number): number => {
    const v = o[k];
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new RegistryError(`WARD_REGISTRY_JSON[${idx}].${k} must be a number`);
    return v;
  };
  if (!isCluster(o.cluster)) throw new RegistryError(`WARD_REGISTRY_JSON[${idx}].cluster must be 'external' or 'friendly'`);
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') {
    throw new RegistryError(`WARD_REGISTRY_JSON[${idx}].enabled must be a boolean`);
  }
  const reqs = o.requirementsTemplate;
  if (typeof reqs !== 'object' || reqs === null || Array.isArray(reqs)) {
    throw new RegistryError(`WARD_REGISTRY_JSON[${idx}].requirementsTemplate must be an object`);
  }
  return {
    id: str('id'),
    label: str('label'),
    agentId: str('agentId'),
    serviceId: str('serviceId'),
    category: str('category'),
    cluster: o.cluster,
    requirementsTemplate: reqs as Record<string, unknown>,
    priceCeiling: num('priceCeiling', 1),
    reliability: num('reliability', 0.5),
    enabled: o.enabled === undefined ? true : o.enabled,
  };
}

/**
 * Build the active registry: seeds (overridable by id) + operator entries from WARD_REGISTRY_JSON,
 * with the DD target/chain substituted into each requirements template. Returns enabled entries only.
 */
export function loadRegistry(rawJson: string | undefined): RegistryEntry[] {
  const byId = new Map<string, RegistryEntry>();
  for (const seed of SEEDS) byId.set(seed.id, { ...seed, requirementsTemplate: { ...seed.requirementsTemplate } });

  if (rawJson && rawJson.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch (err) {
      throw new RegistryError(`WARD_REGISTRY_JSON is not valid JSON: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed)) throw new RegistryError('WARD_REGISTRY_JSON must be a JSON array of supplier entries');
    parsed.forEach((raw, i) => {
      const entry = parseEntry(raw, i);
      byId.set(entry.id, entry); // same id overrides a seed
    });
  }

  const disabled = new Set((process.env.WARD_DISABLE_SUPPLIERS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

  // Templates keep {{target}}/{{chain}} raw — substituted per DD run (the provider fulfills arbitrary tokens).
  return [...byId.values()].filter((e) => e.enabled && !disabled.has(e.id));
}
