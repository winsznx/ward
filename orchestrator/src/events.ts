import { EventType, type Event, type EventStream } from '@croo-network/sdk';
import type { Logger } from './logger.js';

/** snake_case WS event payload normalized to a camel-cased view at the boundary (ground truth). */
export interface CrooEvent {
  type: string;
  negotiationId: string | undefined;
  orderId: string | undefined;
  serviceId: string | undefined;
  status: string | undefined;
  reason: string | undefined;
}

function normalize(e: Event): CrooEvent {
  return {
    type: e.type,
    negotiationId: e.negotiation_id,
    orderId: e.order_id,
    serviceId: e.service_id,
    status: e.status,
    reason: e.reason,
  };
}

export type RejectionKind = 'negotiation_rejected' | 'negotiation_expired' | 'order_rejected' | 'order_expired';

export class OrderTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderTimeoutError';
  }
}

export class OrderRejectedError extends Error {
  constructor(
    public readonly kind: RejectionKind,
    public readonly reasonText: string,
  ) {
    super(`${kind}${reasonText ? `: ${reasonText}` : ''}`);
    this.name = 'OrderRejectedError';
  }
}

interface Resolver<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

/**
 * Correlates WS events to the FSM's awaits with timeouts.
 *
 * - Idempotent: the SDK redelivers events across reconnect, so each (type,ids,status) is handled
 *   once — but it is marked `seen` only AFTER its handler settles, so if a settle throws the
 *   redelivery can still be processed (the SDK swallows handler throws).
 * - OrderCreated correlation does NOT depend on `negotiation_id` (optional on the SDK Event; the
 *   proven reference pays on any OrderCreated). The spine is SEQUENTIAL, so at most one negotiation
 *   awaits its order at a time: the next OrderCreated resolves the single pending waiter and the FSM
 *   confirms via getOrder(order.negotiationId). Order completions correlate by order_id (reliable).
 * - Race-safe: an event that arrives before the FSM registers its waiter is buffered and consumed
 *   once on the next await.
 */
export class EventRouter {
  private readonly seen = new Set<string>();

  // OrderCreated / negotiation outcome — single-in-flight (sequential spine).
  private readonly bufferedCreated: string[] = []; // order_ids from unconsumed OrderCreated (FIFO)
  private readonly negErrors = new Map<string, Error>(); // negotiationId -> rejection (correlated)
  private createdWaiter: (Resolver<string> & { negotiationId: string }) | null = null;

  // OrderCompleted — keyed by order_id (reliable on order events).
  private readonly completeResult = new Set<string>();
  private readonly completeError = new Map<string, Error>();
  private readonly completeWaiter = new Map<string, Resolver<void>>();

  constructor(
    stream: EventStream,
    private readonly log: Logger,
  ) {
    stream.onAny((e) => this.dispatch(normalize(e)));
  }

  private dispatch(ev: CrooEvent): void {
    const key = `${ev.type}:${ev.negotiationId ?? ''}:${ev.orderId ?? ''}:${ev.status ?? ''}`;
    if (this.seen.has(key)) return;
    this.log.info('event', { type: ev.type, negotiation: ev.negotiationId, order: ev.orderId, status: ev.status });

    try {
      switch (ev.type) {
        case EventType.OrderCreated:
          if (ev.orderId) this.onCreated(ev.orderId);
          break;
        case EventType.NegotiationRejected:
          this.onNegotiationFailed(ev.negotiationId, new OrderRejectedError('negotiation_rejected', ev.reason ?? ''));
          break;
        case EventType.NegotiationExpired:
          this.onNegotiationFailed(ev.negotiationId, new OrderRejectedError('negotiation_expired', ev.reason ?? ''));
          break;
        case EventType.OrderCompleted:
          if (ev.orderId) this.onComplete(ev.orderId, null);
          break;
        case EventType.OrderRejected:
          if (ev.orderId) this.onComplete(ev.orderId, new OrderRejectedError('order_rejected', ev.reason ?? ''));
          break;
        case EventType.OrderExpired:
          if (ev.orderId) this.onComplete(ev.orderId, new OrderRejectedError('order_expired', ev.reason ?? ''));
          break;
        default:
          break;
      }
    } catch (err) {
      // A settle callback threw — do NOT mark seen, so a redelivery can retry (the SDK swallows throws).
      this.log.warn('event dispatch error — allowing redelivery retry', { type: ev.type, error: (err as Error).message });
      return;
    }
    this.seen.add(key);
  }

  private onCreated(orderId: string): void {
    if (this.createdWaiter) {
      const w = this.createdWaiter;
      this.createdWaiter = null;
      w.resolve(orderId);
    } else {
      this.bufferedCreated.push(orderId);
    }
  }

  private onNegotiationFailed(negotiationId: string | undefined, err: Error): void {
    if (negotiationId === undefined) {
      // can't correlate — drop it; the affected supplier will hit its own accept-window timeout
      this.log.warn('negotiation failure with no negotiation_id — dropping (supplier falls to accept-window timeout)');
      return;
    }
    if (this.createdWaiter && this.createdWaiter.negotiationId === negotiationId) {
      const w = this.createdWaiter;
      this.createdWaiter = null;
      w.reject(err);
    } else {
      this.negErrors.set(negotiationId, err); // correlated; consumed only by the matching await
    }
  }

  /**
   * Drain buffered events before a new supplier negotiates. The fan-out is single-in-flight, so
   * anything still buffered (a late OrderCreated / negotiation failure from a prior, already-settled
   * supplier) is orphaned and must NOT leak forward to poison the next supplier's accept window.
   */
  beginSupplier(): void {
    if (this.bufferedCreated.length > 0 || this.negErrors.size > 0) {
      this.log.warn('discarding orphaned events from a prior supplier', {
        created: this.bufferedCreated.length,
        negErrors: this.negErrors.size,
      });
      this.bufferedCreated.length = 0;
      this.negErrors.clear();
    }
  }

  private onComplete(orderId: string, err: Error | null): void {
    const waiter = this.completeWaiter.get(orderId);
    if (waiter) {
      this.completeWaiter.delete(orderId);
      if (err) waiter.reject(err);
      else waiter.resolve();
      return;
    }
    if (err) this.completeError.set(orderId, err);
    else this.completeResult.add(orderId);
  }

  /** Resolve with the next created order's id, or reject on negotiation rejection/expiry/timeout. */
  awaitOrderCreated(negotiationId: string, timeoutMs: number): Promise<string> {
    const correlatedErr = this.negErrors.get(negotiationId);
    if (correlatedErr) {
      this.negErrors.delete(negotiationId);
      return Promise.reject(correlatedErr);
    }
    const buffered = this.bufferedCreated.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.createdWaiter = null;
        reject(new OrderTimeoutError(`timed out waiting for OrderCreated (negotiation ${negotiationId}) after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.createdWaiter = {
        negotiationId,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
  }

  awaitCompletion(orderId: string, timeoutMs: number): Promise<void> {
    if (this.completeResult.has(orderId)) {
      this.completeResult.delete(orderId); // single-consumption
      return Promise.resolve();
    }
    const bufferedErr = this.completeError.get(orderId);
    if (bufferedErr) {
      this.completeError.delete(orderId);
      return Promise.reject(bufferedErr);
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.completeWaiter.delete(orderId);
        reject(new OrderTimeoutError(`timed out waiting for OrderCompleted (order ${orderId}) after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.completeWaiter.set(orderId, {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }
}
