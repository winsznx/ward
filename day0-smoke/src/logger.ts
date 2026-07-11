import type { Logger as SdkLogger } from '@croo-network/sdk';
import { DEBUG } from './env';

const useColor = process.stdout.isTTY === true;
const paint = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => paint('2', s);
const bold = (s: string) => paint('1', s);
const red = (s: string) => paint('31', s);
const green = (s: string) => paint('32', s);
const yellow = (s: string) => paint('33', s);
const cyan = (s: string) => paint('36', s);
const magenta = (s: string) => paint('35', s);

function ts(): string {
  return dim(new Date().toISOString());
}

function fmtMeta(meta?: Record<string, unknown>): string {
  if (!meta) return '';
  const parts = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${dim(k + '=')}${String(v)}`);
  return parts.length ? '  ' + parts.join('  ') : '';
}

export const BASESCAN_TX = (hash: string) => `https://basescan.org/tx/${hash}`;

export class Logger {
  constructor(private readonly tag: string) {}

  info(msg: string, meta?: Record<string, unknown>): void {
    console.log(`${ts()} ${cyan(`[${this.tag}]`)} ${msg}${fmtMeta(meta)}`);
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    console.warn(`${ts()} ${yellow(`[${this.tag}]`)} ${yellow('WARN')} ${msg}${fmtMeta(meta)}`);
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    console.error(`${ts()} ${red(`[${this.tag}]`)} ${red('ERROR')} ${msg}${fmtMeta(meta)}`);
  }

  /** A protocol state transition — the spine of the smoke test trace. */
  step(state: string, msg: string, meta?: Record<string, unknown>): void {
    console.log(`${ts()} ${cyan(`[${this.tag}]`)} ${magenta(bold(`→ ${state}`))} ${msg}${fmtMeta(meta)}`);
  }

  /** Print an on-chain transaction hash with a Basescan link for manual verification. */
  tx(label: string, hash: string | undefined): void {
    if (!hash) return;
    console.log(`${ts()} ${cyan(`[${this.tag}]`)} ${dim('tx')} ${bold(label)} ${hash}  ${dim(BASESCAN_TX(hash))}`);
  }

  banner(text: string, ok: boolean): void {
    const color = ok ? green : red;
    const line = '═'.repeat(Math.max(text.length + 4, 24));
    console.log('\n' + color(bold(line)));
    console.log(color(bold(`  ${text}`)));
    console.log(color(bold(line)) + '\n');
  }

  /** Adapter for the AgentClient `Logger` interface; SDK logs are nested under [tag·sdk]. */
  asSdkLogger(): SdkLogger {
    const child = new Logger(`${this.tag}·sdk`);
    return {
      info: (m, ...a) => child.info(m, a.length ? { args: JSON.stringify(a) } : undefined),
      warn: (m, ...a) => child.warn(m, a.length ? { args: JSON.stringify(a) } : undefined),
      error: (m, ...a) => child.error(m, a.length ? { args: JSON.stringify(a) } : undefined),
      debug: (m, ...a) => {
        if (DEBUG) child.info(`${dim('debug')} ${m}`, a.length ? { args: JSON.stringify(a) } : undefined);
      },
    };
  }
}
