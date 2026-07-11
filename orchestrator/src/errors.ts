import { ethers } from 'ethers';
import {
  APIError,
  InsufficientBalanceError,
  isForbidden,
  isInsufficientBalance,
  isInvalidParams,
  isInvalidStatus,
  isNotFound,
  isUnauthorized,
} from '@croo-network/sdk';

const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

function formatToken(token: string, baseUnits: bigint): string {
  if (token.toLowerCase() === BASE_USDC) return `${ethers.formatUnits(baseUnits, 6)} USDC`;
  return `${baseUnits.toString()} (base units of ${token})`;
}

/** True when the error is the local RPC balance precheck failing (BASE_RPC_URL down/unreachable). */
export function isRpcPrecheckFailure(err: unknown): boolean {
  if (err instanceof APIError || isInsufficientBalance(err)) return false;
  const code = (err as { code?: string })?.code;
  const msg = ((err as Error)?.message ?? '').toLowerCase();
  return (
    code === 'NETWORK_ERROR' ||
    code === 'SERVER_ERROR' ||
    code === 'TIMEOUT' ||
    msg.includes('failed to detect network') ||
    msg.includes('could not detect network') ||
    msg.includes('econnrefused') ||
    msg.includes('getaddrinfo')
  );
}

/** Map an SDK / RPC error to a single actionable line. Fail loud, never swallow. */
export function explainError(err: unknown, ctx: string): string {
  if (isInsufficientBalance(err)) {
    const e = err as InsufficientBalanceError;
    return (
      `${ctx}: insufficient balance — need ${formatToken(e.token, e.required)}, ` +
      `have ${formatToken(e.token, e.balance)}. ` +
      `Top up the agent's AA wallet address (shown in the Dashboard), NOT the controller address.`
    );
  }
  if (isUnauthorized(err)) {
    return `${ctx}: SDK key rejected (${(err as APIError).reason}). Check CROO_SDK_KEY and that the agent is online.`;
  }
  if (isNotFound(err)) {
    return `${ctx}: not found (${(err as APIError).reason}). Verify the agentId / serviceIndex / order id exists.`;
  }
  if (isInvalidStatus(err)) {
    return `${ctx}: invalid status (${(err as APIError).reason}) — the order/negotiation already advanced, was paid, expired, or rejected.`;
  }
  if (isInvalidParams(err)) {
    return `${ctx}: invalid parameters (${(err as APIError).reason}). ${(err as APIError).message} — check the requirements object matches the supplier's schema (type-exact).`;
  }
  if (isForbidden(err)) {
    return `${ctx}: forbidden (${(err as APIError).reason}) — this agent/key is not permitted for that action.`;
  }
  if (err instanceof APIError) {
    return `${ctx}: API error reason=${err.reason} code=${err.code} http=${err.httpStatus} — ${err.message}`;
  }
  if (isRpcPrecheckFailure(err)) {
    return `${ctx}: BASE_RPC_URL appears unreachable — payOrder runs a local ERC-20 balance precheck over RPC and threw before reaching the server (${(err as Error).message}). Use a reliable RPC endpoint.`;
  }
  return `${ctx}: ${(err as Error)?.message ?? String(err)}`;
}
