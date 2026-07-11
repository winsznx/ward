import dotenv from 'dotenv';
import { loadRegistry, type RegistryEntry } from './registry.js';

dotenv.config();

export const DEBUG = /^(1|true|yes)$/i.test(process.env.DEBUG ?? '');

export interface WardConfig {
  apiURL: string;
  wsURL: string;
  rpcURL: string;
  sdkKey: string;
  groqKey: string;
  /** DD target (token address / protocol) the human wants vetted. */
  target: string;
  /** the human's DD question. */
  request: string;
  chain: string;
  /** the active supplier registry (seeds + WARD_REGISTRY_JSON), target substituted. */
  registry: RegistryEntry[];
  /** optional: a real H2A order id where the human hired Ward. */
  humanOrderId: string | undefined;
  /** liveness/accept window: a supplier that doesn't accept (OrderCreated) within this is treated as dead. */
  acceptTimeoutMs: number;
  /** per-order delivery (SLA) window. */
  slaTimeoutMs: number;
  /** aggregate budget across the whole fan-out so one slow supplier can't hang the run. */
  fanoutBudgetMs: number;
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readRequired(names: string[]): Record<string, string> {
  const missing: string[] = [];
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (!value) missing.push(name);
    else out[name] = value;
  }
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variables: ${missing.join(', ')}\nCopy .env.example to .env and fill them in.`,
    );
  }
  return out;
}

function parseTimeout(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a positive number of ms, got "${raw}"`);
  return n;
}

export function loadConfig(): WardConfig {
  const env = readRequired([
    'CROO_API_URL',
    'CROO_WS_URL',
    'BASE_RPC_URL',
    'CROO_SDK_KEY',
    'GROQ_API_KEY',
    'WARD_DD_TARGET',
    'WARD_DD_REQUEST',
  ]);

  const chain = process.env.WARD_DD_CHAIN?.trim() || 'base';
  const target = env.WARD_DD_TARGET!;

  const registry = loadRegistry(process.env.WARD_REGISTRY_JSON, target, chain);
  if (registry.length === 0) {
    throw new ConfigError('No enabled suppliers — seed registry is disabled and WARD_REGISTRY_JSON is empty. Configure at least one supplier.');
  }

  return {
    apiURL: env.CROO_API_URL!,
    wsURL: env.CROO_WS_URL!,
    rpcURL: env.BASE_RPC_URL!,
    sdkKey: env.CROO_SDK_KEY!,
    groqKey: env.GROQ_API_KEY!,
    target,
    request: env.WARD_DD_REQUEST!,
    chain,
    registry,
    humanOrderId: process.env.WARD_HUMAN_ORDER_ID?.trim() || undefined,
    acceptTimeoutMs: parseTimeout('WARD_ACCEPT_TIMEOUT_MS', 90 * 1000),
    slaTimeoutMs: parseTimeout('WARD_SLA_TIMEOUT_MS', 8 * 60 * 1000),
    fanoutBudgetMs: parseTimeout('WARD_FANOUT_BUDGET_MS', 25 * 60 * 1000),
  };
}
