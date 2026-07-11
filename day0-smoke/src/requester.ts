import { AgentClient, EventType, OrderStatus, type Delivery, type Event, type Order } from '@croo-network/sdk';
import { loadRequesterEnv } from './env';
import { explainError } from './errors';
import { verifyDeliveryIntegrity, reportIntegrity } from './integrity';
import { Logger } from './logger';
import { installShutdown, Mutex, sleep, watchConnection } from './runtime';

const OVERALL_TIMEOUT_MS = 10 * 60 * 1000;
const SETTLE_RETRIES = 5;
const SETTLE_DELAY_MS = 1500;

/**
 * OrderCompleted can arrive a beat before the order/delivery projection is fully consistent
 * (deliverTxHash / contentHash briefly empty). Re-fetch a bounded number of times so an
 * eventually-consistent read does not produce a false FAIL on a genuinely settled order.
 */
async function fetchSettled(
  client: AgentClient,
  orderId: string,
  log: Logger,
): Promise<{ order: Order; delivery: Delivery }> {
  let order = await client.getOrder(orderId);
  let delivery = await client.getDelivery(orderId);
  for (let attempt = 1; attempt < SETTLE_RETRIES; attempt++) {
    const settled =
      order.status === OrderStatus.Completed &&
      (delivery.contentHash ?? '').length > 0 &&
      (order.deliverTxHash ?? '').length > 0;
    if (settled) break;
    log.info('order/delivery projection not fully settled — retrying', {
      attempt,
      status: order.status,
      hasContentHash: Boolean(delivery.contentHash),
      hasDeliverTx: Boolean(order.deliverTxHash),
    });
    await sleep(SETTLE_DELAY_MS);
    order = await client.getOrder(orderId);
    delivery = await client.getDelivery(orderId);
  }
  return { order, delivery };
}

async function main(): Promise<void> {
  const env = loadRequesterEnv();
  const log = new Logger('requester');
  log.info('starting requester agent', { api: env.apiURL, ws: env.wsURL, rpc: env.rpcURL, service: env.targetServiceId });

  const client = new AgentClient(
    { baseURL: env.apiURL, wsURL: env.wsURL, rpcURL: env.rpcURL, logger: log.asSdkLogger() },
    env.sdkKey,
  );

  const payMutex = new Mutex();
  const payingOrders = new Set<string>();
  const finalizedOrders = new Set<string>();

  const stream = await client.connectWebSocket();
  log.step('WS_CONNECTED', 'event stream open');

  const finish = (code: number): never => {
    stream.close();
    process.exit(code);
  };

  const deadline = setTimeout(() => {
    log.error('timed out waiting for created→paid→completed (is the provider running and the service online?)');
    log.banner('DAY-0 #1 FAIL', false);
    finish(1);
  }, OVERALL_TIMEOUT_MS);
  deadline.unref();

  stream.onAny((e: Event) =>
    log.info('event', { type: e.type, negotiation: e.negotiation_id, order: e.order_id, status: e.status }),
  );

  stream.on(EventType.OrderCreated, (e: Event) => {
    const orderId = e.order_id;
    if (!orderId || payingOrders.has(orderId)) return;
    payingOrders.add(orderId);
    // Sequential pay: serialize every payOrder through the mutex. Concurrent pays
    // collide on the AA-wallet nonce (NONCE_ERROR / PIMLICO_ERROR).
    void payMutex.run(async () => {
      log.step('PAY', 'order created — paying (sequential, nonce-safe)', { order: orderId });
      try {
        const { order, txHash } = await client.payOrder(orderId);
        log.step('PAID', 'payment submitted on-chain', { order: orderId, status: order.status });
        log.tx('pay', txHash);
      } catch (err) {
        payingOrders.delete(orderId);
        log.error(explainError(err, 'payOrder'));
        log.banner('DAY-0 #1 FAIL', false);
        finish(1);
      }
    });
  });

  stream.on(EventType.OrderCompleted, async (e: Event) => {
    const orderId = e.order_id;
    if (!orderId || finalizedOrders.has(orderId)) return;
    finalizedOrders.add(orderId);
    clearTimeout(deadline);

    log.step('COMPLETED', 'order completed — fetching delivery', { order: orderId });
    try {
      const { order, delivery } = await fetchSettled(client, orderId, log);

      log.step('DELIVERY', 'delivery retrieved', { type: delivery.deliverableType, status: delivery.status });
      log.info('deliverable text', { text: delivery.deliverableText });
      log.tx('createOrder', order.createTxHash);
      log.tx('pay', order.payTxHash);
      log.tx('deliver', order.deliverTxHash);
      if (order.clearTxHash) log.tx('clear/settle', order.clearTxHash);

      const integrity = await verifyDeliveryIntegrity(order, delivery, env.rpcURL);
      reportIntegrity(log, order, integrity);

      const completed = order.status === OrderStatus.Completed;
      if (completed && integrity.ok) {
        log.banner('DAY-0 #1 PASS', true);
        log.info('real CAP order settled on Base mainnet — created → paid → completed; delivery retrieved', {
          order: orderId,
          price: order.price,
          token: order.paymentToken,
        });
        log.info(
          `integrity: backend contentHash present; on-chain receipt ${integrity.onChainReceiptStatus}; ` +
            `L1 keccak ${integrity.preimageMatches ? 'matched' : 'advisory (backend preimage undocumented)'}`,
        );
        finish(0);
      } else {
        log.error('gate not satisfied', {
          orderStatus: order.status,
          integrityOk: integrity.ok,
          committedHash: integrity.committedPresent,
          receipt: integrity.onChainReceiptStatus,
        });
        log.banner('DAY-0 #1 FAIL', false);
        finish(1);
      }
    } catch (err) {
      log.error(explainError(err, 'getDelivery/verify'));
      log.banner('DAY-0 #1 FAIL', false);
      finish(1);
    }
  });

  const failFast = (what: string) => (e: Event) => {
    log.error(what, { negotiation: e.negotiation_id, order: e.order_id, reason: e.reason });
    log.banner('DAY-0 #1 FAIL', false);
    finish(1);
  };
  stream.on(EventType.NegotiationRejected, failFast('negotiation rejected'));
  stream.on(EventType.NegotiationExpired, failFast('negotiation expired'));
  stream.on(EventType.OrderRejected, failFast('order rejected by provider'));
  stream.on(EventType.OrderExpired, failFast('order expired (SLA breach) — escrow refunded'));

  watchConnection(stream, log);
  installShutdown(stream, log);

  log.step('NEGOTIATE', 'opening negotiation against target service', { service: env.targetServiceId });
  try {
    const neg = await client.negotiateOrder({
      serviceId: env.targetServiceId,
      requirements: JSON.stringify({ task: 'day-0 smoke', echo: 'ok' }),
    });
    log.step('NEGOTIATED', 'negotiation opened — awaiting provider accept', {
      negotiation: neg.negotiationId,
      status: neg.status,
    });
  } catch (err) {
    log.error(explainError(err, 'negotiateOrder'));
    log.banner('DAY-0 #1 FAIL', false);
    finish(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
