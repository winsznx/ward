# Ward — Day-0 Gate #1: Real CAP order settles on Base

A minimal, production-grade TypeScript smoke test for the [CROO](https://croo.network)
agent-commerce protocol (`@croo-network/sdk`). It runs **two real agents** — a provider
and a requester — and drives **one real order** through `created → paid → completed` on
**Base mainnet (8453)** with **real USDC**, then retrieves the delivery and verifies its
integrity against the on-chain hash.

> This is gate #1 of the Ward PRD's Day-0 checklist: *prove the protocol works end-to-end
> for us, mainnet, real USDC.* No mocks, no stubs.

On success the requester prints:

```
══════════════════════════════
  DAY-0 #1 PASS
══════════════════════════════
```

---

## What it proves

| PRD Day-0 item | How this test proves it |
|---|---|
| #1 Real CAP order settles on Base | full `created→paid→completed` cycle with on-chain tx hashes (Basescan links) |
| #2 WS stable, one-per-key | each agent owns one `EventStream`; a `1008` duplicate-key close is detected and fails loud |
| #3 Sequential pay confirmed | `payOrder` calls are serialized through a `Mutex` (no-concurrent-pay nonce invariant) |
| integrity | `keccak256(delivery)` recomputed locally and matched to the committed `contentHash`, cross-checked on-chain |

---

## Prerequisites

1. **Node.js 18+** (`node --version`).
2. **Two CROO agents** registered in the [CROO Dashboard](https://croo.network), each with its
   own SDK-Key (`croo_sk_...`) on a **separate AA wallet**:
   - a **provider** agent that lists a service,
   - a **requester** agent.
3. The provider's service `serviceId` (the requester negotiates against it). For this echo
   smoke test the provider answers every order with the text `{"echo":"ok"}`, so use a
   cheap, short-SLA service (price can be a few cents; SLA min is 300s).
4. The **requester's AA wallet** funded with enough **USDC** to cover the order price + fee.
   Fund the **agent AA wallet address** shown in the Dashboard — *not* the controller address.

> Cost: this settles a real order. Keep the service price at cent level. One run ≈ one order.

---

## Setup

```bash
cd day0-smoke
npm install
cp .env.example .env
# edit .env — fill in the two SDK keys and the target serviceId
```

`.env`:

```ini
CROO_API_URL=https://api.croo.network
CROO_WS_URL=wss://api.croo.network/ws
BASE_RPC_URL=https://mainnet.base.org
CROO_SDK_KEY_PROVIDER=croo_sk_...
CROO_SDK_KEY_REQUESTER=croo_sk_...
CROO_TARGET_SERVICE_ID=svc_...
```

Optional pre-flight (no keys / no spend needed) — proves the keccak + on-chain
verification mechanics work against live Base mainnet:

```bash
npm run test:integrity
```

---

## Run

Two terminals, same `.env`:

```bash
# terminal 1 — provider (long-running; accepts negotiations, delivers on payment)
npm run provider

# terminal 2 — requester (drives one cycle, then exits 0 on PASS / 1 on FAIL)
npm run requester
```

The requester opens a negotiation → the provider accepts (backend submits `createOrder`
on-chain) → the requester pays → the provider delivers `{"echo":"ok"}` → the order
completes → the requester fetches the delivery, verifies integrity, and prints
`DAY-0 #1 PASS`. Every state transition and on-chain tx hash is logged with a Basescan link.

---

## How the integrity check works

The SDK ships **no** integrity helper — `delivery.contentHash` is computed by the backend
and the exact preimage is undocumented. This test verifies integrity in three layers
([src/integrity.ts](src/integrity.ts)):

- **L1 — committed-hash match (the gate):** recompute `keccak256(utf8(deliverableText))`
  locally and require it to equal `delivery.contentHash`. This binds the bytes you hold to
  the hash the protocol committed on-chain. If the backend hashes a different preimage, this
  fails loud (and tells you so) rather than printing a false PASS.
- **L2 — on-chain receipt:** read `order.deliverTxHash` via `BASE_RPC_URL`, confirm the tx is
  mined with `status=1` on chainId `8453`. (Under ERC-4337/Biconomy Nexus, `deliverTxHash`
  may be a `userOpHash` that doesn't resolve as an L1 tx — handled and reported, not fatal.)
- **L3 — hash-in-logs:** ABI-free scan of the deliver-tx logs for the committed hash bytes.
  Best-effort confirmation; reported, not required.

`DAY-0 #1 PASS` requires order `status === completed` **and** L1 to hold (and any readable
receipt to not be a failed tx).

---

## SDK methods used

| Method | Where | Purpose |
|---|---|---|
| `new AgentClient(config, sdkKey)` | both | client bound to one agent key |
| `connectWebSocket()` | both | open the event stream (auto-reconnect, one per key) |
| `stream.on(EventType.*, …)` / `onAny` | both | typed event dispatch |
| `negotiateOrder({serviceId, requirements})` | requester | open the order |
| `acceptNegotiation(negotiationId)` | provider | accept → backend `createOrder` on-chain |
| `payOrder(orderId)` | requester | pay (sequential; pre-checks USDC balance) |
| `deliverOrder(orderId, {deliverableType, deliverableText})` | provider | submit result |
| `getOrder(orderId)` | requester | pull tx hashes + final status |
| `getDelivery(orderId)` | requester | retrieve deliverable + `contentHash` |
| `APIError` + `isInsufficientBalance` / `isUnauthorized` / `isInvalidStatus` / … | both | typed, actionable errors |

---

## Layout

```
day0-smoke/
├── src/
│   ├── provider.ts     # accept negotiations → deliver {"echo":"ok"} on payment
│   ├── requester.ts    # negotiate → pay (sequential) → verify integrity → PASS/FAIL
│   ├── integrity.ts    # L1 keccak / L2 on-chain receipt / L3 log-scan verification
│   ├── errors.ts       # SDK typed-error → actionable message mapping
│   ├── runtime.ts      # pay Mutex, 1008 watchdog, graceful shutdown
│   ├── logger.ts       # state-transition + tx-hash logging (Basescan links)
│   └── env.ts          # fail-loud env loading/validation
├── verify-integrity.itest.ts   # integrity self-test vs live Base mainnet
├── .env.example
└── README.md
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Missing required environment variables: …` | copy `.env.example` → `.env` and fill it in |
| `insufficient balance — need X USDC …` | fund the requester **agent AA wallet** (Dashboard), not the controller |
| `SDK key rejected (SDK_KEY_INVALID)` | wrong/expired `CROO_SDK_KEY_*`, or agent offline |
| `websocket policy violation: duplicate SDK-Key` (code 1008) | a second process is using the same key — each agent key allows exactly one WebSocket |
| requester times out (10 min) | provider not running, or the target `serviceId` is offline |
| `invalid status (INVALID_STATUS)` | the order/negotiation already advanced, expired, or was rejected |

---

MIT
