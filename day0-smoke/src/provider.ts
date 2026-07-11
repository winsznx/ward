import { AgentClient, DeliverableType, EventType, type Event } from '@croo-network/sdk';
import { loadProviderEnv } from './env';
import { explainError } from './errors';
import { Logger } from './logger';
import { installShutdown, watchConnection } from './runtime';

const ECHO_RESULT = JSON.stringify({ echo: 'ok' });

async function main(): Promise<void> {
  const env = loadProviderEnv();
  const log = new Logger('provider');
  log.info('starting provider agent', { api: env.apiURL, ws: env.wsURL, rpc: env.rpcURL });

  const client = new AgentClient(
    { baseURL: env.apiURL, wsURL: env.wsURL, rpcURL: env.rpcURL, logger: log.asSdkLogger() },
    env.sdkKey,
  );

  // WS may redeliver events across reconnects; guard each side-effect once.
  const acceptedNegotiations = new Set<string>();
  const deliveredOrders = new Set<string>();

  const stream = await client.connectWebSocket();
  log.step('WS_CONNECTED', 'event stream open (auto-reconnect 1s→30s, one connection per key)');

  stream.onAny((e: Event) =>
    log.info('event', { type: e.type, negotiation: e.negotiation_id, order: e.order_id, status: e.status }),
  );

  stream.on(EventType.NegotiationCreated, async (e: Event) => {
    const negotiationId = e.negotiation_id;
    if (!negotiationId || acceptedNegotiations.has(negotiationId)) return;
    acceptedNegotiations.add(negotiationId);

    log.step('ACCEPT', 'negotiation received — accepting', { negotiation: negotiationId, service: e.service_id });
    try {
      const { order } = await client.acceptNegotiation(negotiationId);
      log.step('ORDER_CREATED', 'on-chain order created by backend', { order: order.orderId, status: order.status });
      log.tx('createOrder', order.createTxHash);
    } catch (err) {
      acceptedNegotiations.delete(negotiationId);
      log.error(explainError(err, 'acceptNegotiation'));
    }
  });

  stream.on(EventType.OrderPaid, async (e: Event) => {
    const orderId = e.order_id;
    if (!orderId || deliveredOrders.has(orderId)) return;
    deliveredOrders.add(orderId);

    log.step('DELIVER', 'order paid — delivering echo result', { order: orderId, result: ECHO_RESULT });
    try {
      const { delivery, txHash } = await client.deliverOrder(orderId, {
        deliverableType: DeliverableType.Text,
        deliverableText: ECHO_RESULT,
      });
      log.step('DELIVERED', 'delivery submitted on-chain', {
        order: orderId,
        delivery: delivery.deliveryId,
        contentHash: delivery.contentHash,
      });
      log.tx('deliver', txHash);
    } catch (err) {
      deliveredOrders.delete(orderId);
      log.error(explainError(err, 'deliverOrder'));
    }
  });

  stream.on(EventType.OrderCompleted, (e: Event) =>
    log.step('COMPLETED', 'order completed — escrow released to provider', { order: e.order_id }),
  );
  stream.on(EventType.OrderExpired, (e: Event) =>
    log.warn('order expired (SLA breach) — escrow refunds to requester', { order: e.order_id, reason: e.reason }),
  );
  stream.on(EventType.OrderRejected, (e: Event) =>
    log.warn('order rejected', { order: e.order_id, reason: e.reason }),
  );

  watchConnection(stream, log);
  installShutdown(stream, log);
  log.info('provider ready — waiting for negotiations (Ctrl-C to stop)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
