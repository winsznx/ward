import { DeliverableType, EventType, type Event } from '@croo-network/sdk';
import { loadConfig } from './config.js';
import { createClient } from './croo-client.js';
import { explainError } from './errors.js';
import { EventRouter } from './events.js';
import { FirewallGate } from '../../firewall/src/gate.js';
import { groqJudge } from '../../firewall/src/judge-groq.js';
import { runDD } from './fsm.js';
import { Logger } from './logger.js';
import { Mutex, installShutdown, watchConnection } from './runtime.js';

const ADDR_RE = /0x[0-9a-fA-F]{40}/;

/**
 * Pull the token/contract the buyer wants vetted out of whatever requirements shape they sent.
 * Ward's service schema is permissive, so accept tokenAddress|token|target|address|contract|text —
 * or a bare 0x… anywhere in the raw body. Returns undefined when there's no address to vet.
 */
function extractTarget(requirements: string | undefined): string | undefined {
  if (!requirements) return undefined;
  try {
    const o = JSON.parse(requirements) as Record<string, unknown>;
    for (const k of ['tokenAddress', 'token', 'target', 'address', 'contract', 'text']) {
      const v = o[k];
      if (typeof v === 'string') {
        const m = v.match(ADDR_RE);
        if (m) return m[0];
      }
    }
  } catch {
    // not JSON — fall through to a raw scan
  }
  const raw = requirements.match(ADDR_RE);
  return raw ? raw[0] : undefined;
}

/**
 * Ward's PROVIDER process. Holding this websocket open is what flips Ward from OFFLINE to online on
 * the CROO Store. When a human hires Ward's "Token DD Verdict" service it fulfils the H2A hero flow:
 * accept → on payment run the real multi-supplier DD on THIS SAME connection (one WS per key, 1008)
 * → deliver the §9 verdict on-chain.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = new Logger('ward-provider');
  log.info('Ward provider starting — this connection is what flips Ward ONLINE on the CROO Store', {
    api: cfg.apiURL,
    ws: cfg.wsURL,
  });

  const client = createClient(cfg, log);
  const payMutex = new Mutex(); // no-concurrent-pay (nonce) inside a DD run
  const ddMutex = new Mutex(); // one DD at a time — the shared EventRouter is single-in-flight
  const gate = new FirewallGate(groqJudge);

  const stream = await client.connectWebSocket();
  const router = new EventRouter(stream, log);
  log.step('ONLINE', 'websocket connected — Ward is now ONLINE and accepting Token DD Verdict orders');

  // Ward-as-provider bookkeeping. Ward never receives NegotiationCreated for its own OUTGOING supplier
  // negotiations (those are delivered to the supplier), so every NegotiationCreated here is a human
  // hiring Ward. Delivery is still gated on soldOrders so a supplier's OrderPaid (Ward paying Attestr,
  // where Ward is the buyer) can never be mistaken for one of Ward's own sold orders.
  const soldOrders = new Map<string, { target: string; negotiationId: string }>();
  const accepted = new Set<string>();
  const delivered = new Set<string>();

  stream.on(EventType.NegotiationCreated, async (e: Event) => {
    const negotiationId = e.negotiation_id;
    if (!negotiationId || accepted.has(negotiationId)) return;
    accepted.add(negotiationId);
    log.step('ACCEPT', 'a human wants a Token DD Verdict — accepting', { negotiation: negotiationId });
    try {
      const { negotiation, order } = await client.acceptNegotiation(negotiationId);
      const target = extractTarget(negotiation.requirements);
      soldOrders.set(order.orderId, { target: target ?? '', negotiationId });
      log.step('ORDER_CREATED', 'buyer order created on-chain', { order: order.orderId, target: target ?? '(none)' });
      log.tx('createOrder', order.createTxHash);
      if (!target) log.warn('requirements carry no 0x… address — will deliver an input-error note on payment', { order: order.orderId });
    } catch (err) {
      accepted.delete(negotiationId);
      log.error(explainError(err, 'acceptNegotiation'));
    }
  });

  stream.on(EventType.OrderPaid, async (e: Event) => {
    const orderId = e.order_id;
    if (!orderId) return;
    const sold = soldOrders.get(orderId);
    if (!sold || delivered.has(orderId)) return; // not one of Ward's sold orders (e.g. Ward paying a supplier)
    delivered.add(orderId);

    try {
      if (!sold.target) {
        await client.deliverOrder(orderId, {
          deliverableType: DeliverableType.Text,
          deliverableText: JSON.stringify({ error: 'requirements must include a token/contract address (0x…) to vet' }),
        });
        log.warn('delivered input-error note (no target in requirements)', { order: orderId });
        return;
      }

      log.step('FULFILL', 'buyer paid — running the DD to produce the verdict', { order: orderId, target: sold.target });
      const { verdict } = await ddMutex.run(() => runDD({ client, router, payMutex, gate, cfg, log }, sold.target));
      log.step('VERDICT', `DD complete: ${verdict.verdict.toUpperCase()} (confidence ${verdict.confidence.toFixed(2)})`, { order: orderId });

      const res = await client.deliverOrder(orderId, {
        deliverableType: DeliverableType.Text,
        deliverableText: JSON.stringify(verdict),
      });
      log.step('DELIVERED', 'verdict delivered on-chain — escrow releases to Ward on buyer confirmation', { order: orderId });
      log.tx('deliver', res.txHash);
    } catch (err) {
      delivered.delete(orderId);
      log.error(explainError(err, 'fulfill(order)'));
    }
  });

  stream.on(EventType.OrderCompleted, (e: Event) =>
    log.step('COMPLETED', 'order completed — escrow released to Ward', { order: e.order_id }),
  );
  stream.on(EventType.OrderExpired, (e: Event) =>
    log.warn('order expired (SLA breach) — escrow refunds to buyer', { order: e.order_id, reason: e.reason }),
  );

  watchConnection(stream, log);
  installShutdown(stream, log);
  log.info('Ward provider ready — holding the connection open (Ctrl-C to go offline)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
