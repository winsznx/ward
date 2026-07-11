import type { EventStream } from '@croo-network/sdk';
import type { Logger } from './logger.js';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serializes async work into a single chain. Enforces the no-concurrent-pay invariant:
 * two payOrder calls in flight collide on the AA-wallet nonce (NONCE_ERROR / PIMLICO_ERROR),
 * so every pay across every supplier must run strictly one at a time.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/**
 * The SDK does not reconnect on WS close code 1008 (duplicate SDK-Key) — it stores the error
 * instead (silent). Poll for it and fail loud: one WebSocket per key is a hard protocol
 * constraint, so a second process on the same key is an operator error.
 */
export function watchConnection(stream: EventStream, log: Logger): void {
  const timer = setInterval(() => {
    const err = stream.err();
    if (!err) return;
    clearInterval(timer);
    log.error(`websocket fatal: ${err.message}`);
    log.error(
      'This SDK key already has an open WebSocket (code 1008). Each agent key allows exactly ONE ' +
        'connection — stop the duplicate process or use a separate key per agent.',
    );
    stream.close();
    process.exit(1);
  }, 2000);
  timer.unref();
}

export function installShutdown(stream: EventStream, log: Logger): void {
  const shutdown = (sig: string): void => {
    log.info(`received ${sig} — closing websocket`);
    stream.close();
    process.exit(130);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
