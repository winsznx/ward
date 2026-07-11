import { AgentClient, type Config, type Negotiation } from '@croo-network/sdk';
import type { WardConfig } from './config.js';
import type { Logger } from './logger.js';

export function createClient(cfg: WardConfig, log: Logger): AgentClient {
  const config: Config = {
    baseURL: cfg.apiURL, // bare origin — the SDK appends /backend/v1 (ground truth)
    wsURL: cfg.wsURL, // path is ignored; auth is ?key= query param
    rpcURL: cfg.rpcURL,
    logger: log.asSdkLogger(),
  };
  return new AgentClient(config, cfg.sdkKey);
}

export interface NegotiateRequest {
  /** the SERVICE's GUID (the negotiate target). */
  serviceId: string;
  /** type-exact requirements object matching the service's schema — JSON-encoded for the wire. */
  requirements: Record<string, unknown>;
  metadata?: string;
}

/**
 * Real `/orders/negotiate` contract — VERIFIED live against api.croo.network (2026-07, shape probes,
 * no spend): the proto body is `{ serviceId: string, requirements: string, metadata: string }`.
 * `requirements` is a JSON-encoded STRING (an object → 400 CODEC); `agentId`/`serviceIndex` are NOT
 * schema fields and are silently ignored. This is exactly the SDK's published type, so we call it
 * directly — no cast, no upstream-type correction needed.
 */
export function negotiateService(client: AgentClient, req: NegotiateRequest): Promise<Negotiation> {
  const body = { serviceId: req.serviceId, requirements: JSON.stringify(req.requirements) };
  return client.negotiateOrder(req.metadata !== undefined ? { ...body, metadata: req.metadata } : body);
}
