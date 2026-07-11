import { APIError } from '@croo-network/sdk';
import { loadConfig } from './config.js';
import { createClient, negotiateService } from './croo-client.js';
import { explainError } from './errors.js';
import { Logger } from './logger.js';

/**
 * FREE liveness + wire-shape probe. Negotiates against each configured supplier and reports the
 * result — but NEVER pays, so no USDC is spent and no funded wallet is required (only a valid
 * CROO_SDK_KEY). This validates, before any funded run:
 *   - the negotiate wire shape ({ serviceId, requirements: JSON string }),
 *   - that each serviceId is real (NOT_FOUND ⇒ wrong GUID),
 *   - that each requirements object matches the service schema (INVALID_PARAMETERS ⇒ wrong shape),
 *   - that the key is accepted and each supplier is reachable.
 * Run this FIRST; fund the wallet only once it's green.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = new Logger('probe');
  log.info('FREE negotiate probe — validates the real wire shape live. No pay, no USDC spent.', {
    target: cfg.target,
    suppliers: cfg.registry.length,
  });
  const client = createClient(cfg, log);

  let accepted = 0;
  let rejected = 0;
  for (const entry of cfg.registry) {
    log.step('NEGOTIATE', `probing ${entry.label}`, { serviceId: entry.serviceId, cluster: entry.cluster });
    try {
      const neg = await negotiateService(client, { serviceId: entry.serviceId, requirements: entry.requirementsTemplate });
      accepted += 1;
      log.info(`✓ ${entry.label}: negotiation accepted (wire shape + serviceId + key all valid)`, {
        negotiation: neg.negotiationId,
        provider: neg.providerAgentId,
        status: neg.status,
      });
    } catch (err) {
      rejected += 1;
      log.error(`✗ ${entry.label}: ${explainError(err, 'negotiateOrder')}`);
      if (err instanceof APIError) {
        log.warn(`   reason=${err.reason} code=${err.code} http=${err.httpStatus} — ${err.reason === 'CODEC' ? 'WIRE SHAPE WRONG (this is the bug the probe exists to catch)' : err.reason.endsWith('_NOT_FOUND') ? 'serviceId GUID likely wrong' : err.reason === 'INVALID_PARAMETERS' ? 'requirements object does not match the service schema' : 'see reason'}`);
      }
    }
  }

  const ok = accepted > 0 && rejected === 0;
  log.banner(`PROBE: ${accepted} accepted, ${rejected} rejected of ${cfg.registry.length}`, ok);
  log.info('Negotiate is free (pay only happens after accept) — nothing was spent. Fund the AA wallet and run `npm run ward` only after this is green.');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
