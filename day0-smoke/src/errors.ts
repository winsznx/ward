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

/** Map an SDK error to a single actionable line. Fail loud, never swallow. */
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
    return `${ctx}: SDK key rejected (${(err as APIError).reason}). Check the CROO_SDK_KEY_* value and that the agent is online.`;
  }
  if (isNotFound(err)) {
    return `${ctx}: not found (${(err as APIError).reason}). Verify the id / serviceId exists.`;
  }
  if (isInvalidStatus(err)) {
    return `${ctx}: invalid status (${(err as APIError).reason}) — the order/negotiation already advanced, was paid, expired, or rejected.`;
  }
  if (isInvalidParams(err)) {
    return `${ctx}: invalid parameters (${(err as APIError).reason}). ${(err as APIError).message}`;
  }
  if (isForbidden(err)) {
    return `${ctx}: forbidden (${(err as APIError).reason}) — this agent/key is not permitted for that action.`;
  }
  if (err instanceof APIError) {
    return `${ctx}: API error reason=${err.reason} code=${err.code} http=${err.httpStatus} — ${err.message}`;
  }
  return `${ctx}: ${(err as Error)?.message ?? String(err)}`;
}
