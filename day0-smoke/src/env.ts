import dotenv from 'dotenv';

dotenv.config();

export interface Endpoints {
  apiURL: string;
  wsURL: string;
  rpcURL: string;
}

export interface ProviderEnv extends Endpoints {
  sdkKey: string;
}

export interface RequesterEnv extends Endpoints {
  sdkKey: string;
  targetServiceId: string;
}

export const DEBUG = /^(1|true|yes)$/i.test(process.env.DEBUG ?? '');

class MissingEnvError extends Error {
  constructor(missing: string[]) {
    super(
      `Missing required environment variables: ${missing.join(', ')}\n` +
        `Copy .env.example to .env and fill them in.`,
    );
    this.name = 'MissingEnvError';
  }
}

function read(names: string[]): Record<string, string> {
  const missing: string[] = [];
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (!value) {
      missing.push(name);
    } else {
      out[name] = value;
    }
  }
  if (missing.length > 0) throw new MissingEnvError(missing);
  return out;
}

function endpoints(env: Record<string, string>): Endpoints {
  return {
    apiURL: env.CROO_API_URL!,
    wsURL: env.CROO_WS_URL!,
    rpcURL: env.BASE_RPC_URL!,
  };
}

export function loadProviderEnv(): ProviderEnv {
  const env = read(['CROO_API_URL', 'CROO_WS_URL', 'BASE_RPC_URL', 'CROO_SDK_KEY_PROVIDER']);
  return { ...endpoints(env), sdkKey: env.CROO_SDK_KEY_PROVIDER! };
}

export function loadRequesterEnv(): RequesterEnv {
  const env = read([
    'CROO_API_URL',
    'CROO_WS_URL',
    'BASE_RPC_URL',
    'CROO_SDK_KEY_REQUESTER',
    'CROO_TARGET_SERVICE_ID',
  ]);
  return {
    ...endpoints(env),
    sdkKey: env.CROO_SDK_KEY_REQUESTER!,
    targetServiceId: env.CROO_TARGET_SERVICE_ID!,
  };
}
