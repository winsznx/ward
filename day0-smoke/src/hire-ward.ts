import { AgentClient, EventType, type Event } from '@croo-network/sdk';
import dotenv from 'dotenv';
import { Logger } from './logger';
import { installShutdown, sleep, watchConnection } from './runtime';

dotenv.config();

/**
 * A2A: a BUYER AGENT hires Ward. This is the mirror of Ward hiring Attestr/Degentel — same CAP
 * interface, so Ward's provider can't tell a human buyer from an agent buyer. Run it with a SECOND
 * CROO agent's key (NOT Ward's — you can't hire yourself, and it's one WebSocket per key):
 *
 *   CROO_BUYER_KEY=croo_sk_<a second, funded agent>  WARD_TARGET=0x…  npm run hire-ward
 *
 * The buyer agent negotiates Ward's Token DD Verdict service, pays the $1 escrow, and receives the
 * §9 verdict on-chain.
 */
const WARD_SERVICE_ID = '4bfc981e-4603-4f93-a7b3-09604288a852';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

function req(name: string, fallback?: string): string {
  const v = process.env[name]?.trim() || fallback;
  if (!v) {
    console.error(`missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const apiURL = req('CROO_API_URL', 'https://api.croo.network');
  const wsURL = req('CROO_WS_URL', 'wss://api.croo.network/ws');
  const rpcURL = req('BASE_RPC_URL', 'https://mainnet.base.org');
  const buyerKey = req('CROO_BUYER_KEY'); // a SECOND agent's key — NOT Ward's
  const serviceId = req('WARD_SERVICE_ID', WARD_SERVICE_ID);
  const tokenAddress = req('WARD_TARGET', USDC);
  const chain = req('WARD_CHAIN', 'base');

  const log = new Logger('buyer-agent');
  log.info('an AGENT is hiring Ward (agent-to-agent)', { ward: serviceId, token: tokenAddress, chain });

  const client = new AgentClient(
    { baseURL: apiURL, wsURL, rpcURL, logger: log.asSdkLogger() },
    buyerKey,
  );
  const stream = await client.connectWebSocket();
  log.step('WS_CONNECTED', 'buyer agent connected');

  const paying = new Set<string>();
  const done = new Set<string>();
  const finish = (code: number): never => {
    stream.close();
    process.exit(code);
  };

  const deadline = setTimeout(() => {
    log.error('timed out — is Ward online and is the buyer wallet funded (>= $1 USDC)?');
    finish(1);
  }, 20 * 60 * 1000);
  deadline.unref();

  stream.on(EventType.OrderCreated, (e: Event) => {
    const orderId = e.order_id;
    if (!orderId || paying.has(orderId)) return;
    paying.add(orderId);
    void (async () => {
      log.step('PAY', 'Ward accepted — paying the $1 escrow', { order: orderId });
      try {
        const { txHash } = await client.payOrder(orderId);
        log.tx('pay', txHash);
      } catch (err) {
        log.error(`payOrder failed: ${(err as Error).message}`);
        finish(1);
      }
    })();
  });

  stream.on(EventType.OrderCompleted, (e: Event) => {
    const orderId = e.order_id;
    if (!orderId || done.has(orderId)) return;
    done.add(orderId);
    clearTimeout(deadline);
    void (async () => {
      log.step('COMPLETED', 'Ward delivered — fetching the verdict', { order: orderId });
      try {
        const order = await client.getOrder(orderId);
        log.tx('deliver', order.deliverTxHash);
        // OrderCompleted can arrive a beat before the delivery projection is consistent — re-read a
        // bounded number of times so the verdict text isn't briefly empty.
        let raw = '';
        for (let attempt = 0; attempt < 6; attempt++) {
          const delivery = await client.getDelivery(orderId);
          raw = delivery.deliverableText ?? '';
          if (raw.trim().length > 0) break;
          await sleep(1500);
        }
        log.info('=== WARD VERDICT (received by the buyer agent) ===');
        try {
          console.log(JSON.stringify(JSON.parse(raw), null, 2));
        } catch {
          console.log(raw);
        }
        log.banner('A2A PROVEN — an agent hired Ward and received a verdict', true);
        finish(0);
      } catch (err) {
        log.error(`getDelivery failed: ${(err as Error).message}`);
        finish(1);
      }
    })();
  });

  const fail = (what: string) => (e: Event): never => {
    log.error(what, { negotiation: e.negotiation_id, order: e.order_id, reason: e.reason });
    return finish(1);
  };
  stream.on(EventType.OrderRejected, fail('order rejected by Ward'));
  stream.on(EventType.OrderExpired, fail('order expired (SLA) — escrow refunded'));
  stream.on(EventType.NegotiationRejected, fail('negotiation rejected'));

  watchConnection(stream, log);
  installShutdown(stream, log);

  log.step('NEGOTIATE', 'opening a negotiation against Ward', { service: serviceId });
  const neg = await client.negotiateOrder({
    serviceId,
    requirements: JSON.stringify({ tokenAddress, chain }),
  });
  log.step('NEGOTIATED', 'awaiting Ward accept', { negotiation: neg.negotiationId, status: neg.status });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
