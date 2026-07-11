# Ward Orchestrator — spine

The orchestrator state machine (PRD §6). A single command runs a real token-DD job:
**INTAKE → PLAN → (per supplier: NEGOTIATE → PAY → AWAIT_DELIVERY → FIREWALL → NORMALIZE) → COLLATE →
VERDICT → DELIVER_TO_HUMAN → INTEGRITY → SETTLE** — fanning out to **N distinct real suppliers** on
Base mainnet across DD dimensions (external-dominant), screening every deliverable through the
firewall, and aggregating a §9 verdict with each source's order id + on-chain tx hashes.

The fan-out generates the diverse external A2A traffic the composability axis rewards — and it is
genuine directional consumption, never a self-trade ring (anti-sybil enforced and logged).
Conformance scoring and cross-source contradiction detection are later prompts — stubbed
transparently, never silently.

## Run

```bash
npm install
cp .env.example .env        # fill CROO_SDK_KEY (funded AA wallet), GROQ_API_KEY, the supplier, the DD target
npm run ward                # INTAKE → … → SETTLE; prints the full state-transition trace + §9 verdict
npm run test:offline        # offline proof of verdict/event-router/config logic (no keys)
npm run typecheck           # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
```

The run prints a `→ STATE` line at every transition, the supplier order's create/pay/deliver tx
hashes (Basescan links), and the final §9 verdict JSON.

## FSM design

[src/fsm.ts](src/fsm.ts) is an explicit state machine. `runWard()` drives the global states;
`runSupplier()` drives the per-supplier sub-states. Each state logs `→ STATE` via the promoted logger.

- **INTAKE** — the human's target + DD request (env). Connect the WS, arm the 1008 watchdog.
- **PLAN** — [plan.ts](src/plan.ts): group the registry by DD dimension, order candidates external-first
  (primary + alternates), and hold out the least-reliable friendly dimensions so external strictly
  dominates supply (§10).
- **per supplier (sequential, isolated):** for each dimension, try the primary then alternates until one delivers:
  - **NEGOTIATE** — `negotiateService({ serviceId, requirements })` (requirements is JSON-stringified for the wire), then await `OrderCreated`
    within the **accept window** (the liveness gate — a dead agent never accepts and costs nothing).
  - **PAY** — `payOrder` through the **single pay-mutex** (no concurrent pays — AA-wallet nonce), after a price-ceiling guard.
  - **AWAIT_DELIVERY** — await `OrderCompleted` (SLA window), then `getOrder` (tx hashes) + `getDelivery` + status-based integrity.
  - **FIREWALL** — `FirewallGate.screen([deliverable])` before anything enters a verdict.
  - **NORMALIZE** — surviving deliverable → §9 `Finding`; the dimension is now covered (stop trying alternates).
- **COLLATE** — pass-through; aggregate the multi-source §9 fields (`sources_run/quarantined/failed`, per-source findings, deduped `hostileSuppliers`).
- **VERDICT** — assemble the §9 object + `evidence_hash`, with the explicit GO-gate (below).
- **DELIVER_TO_HUMAN** — if `WARD_HUMAN_ORDER_ID` is set, `deliverOrder(humanOrderId, verdict)` to complete the H2A order; else emit to the operator console.
- **INTEGRITY** — status-based gate on the H2A settlement (keccak advisory).
- **SETTLE** — print the §9 verdict + per-source trace; `WARD VERDICT: …`.

Promoted from `day0-smoke` as shared infra (not rebuilt): the `AgentClient` wrapper, the
**pay-mutex** ([runtime.ts](src/runtime.ts) `Mutex`), the **1008 watchdog** (`watchConnection`,
polls `stream.err()`), the **status-based integrity** module, the typed-error helpers, and the
snake_case-event ↔ camelCase-REST normalization (now in [events.ts](src/events.ts) `EventRouter`).

## Firewall integration

Every supplier deliverable goes through `FirewallGate.screen()` ([firewall/](../firewall/)) at the
**FIREWALL** state, before NORMALIZE:

- **quarantine** → the finding is **dropped** (never normalized), the supplier is **flagged hostile**,
  `sources_quarantined` is incremented, and the verdict surfaces `"N sources attempted injection, quarantined"`.
- **flag** → ingested as a **contested** finding (`severity: warn`, confidence down-weighted).
- **pass** → ingested at full weight.

The production Groq judge is wired (`GROQ_API_KEY` required) — pattern-only mode would
over-quarantine descriptive audit reports, so the judge is mandatory for a correct verdict.

## Swarm: registry, dominance, alternates, budget

- **Registry** ([registry.ts](src/registry.ts)): each entry = `{ id, agentId, serviceId, category, cluster,
  requirementsTemplate, priceCeiling, reliability, enabled }`. Seeds Attestr (audit) + Remi (sentiment) from
  the Discord registry; friendly suppliers + recruited externals come via `WARD_REGISTRY_JSON` (their
  agentIds aren't public). Seeds are overridable by id; disable any by id with `WARD_DISABLE_SUPPLIERS`.
- **Liveness**: these are flaky hackathon agents (Attestr 500-on-accept, Remi wrong-address PIMLICO errors).
  The cheapest honest liveness check the SDK allows is the **negotiate→`OrderCreated` accept window** — a dead
  agent never accepts, so Ward pays nothing and falls to the alternate. (`negotiate` is free; `payOrder` only
  runs after acceptance.) The "500 on accept" failure maps exactly to this gate.
- **External-dominance** (§10): the planner enforces external > friendly by **distinct agentId** among
  planned primaries (one agent can back several dimensions), and `assessDominance()` re-checks the
  **delivered (firewall-admitted)** counterparty set — a supplier that ordered-then-failed, or was
  quarantined as hostile, never counts as external corroboration. A non-dominant run is surfaced on the
  verdict and can never be GO. The on-chain **order graph** (every counterparty we paid) is logged
  separately each run (anti-sybil trace).
- **Alternates**: each dimension has primary + ordered alternates; a reject / liveness-fail / SLA-timeout /
  quarantine / over-ceiling on the primary falls to the next candidate, then proceeds partial with the gap noted.
- **Aggregate timeout budget**: `WARD_FANOUT_BUDGET_MS` bounds the whole fan-out; each per-supplier wait is
  re-bounded against the remaining budget, and dimensions are skipped (surfaced) once it's exhausted — one slow
  supplier can't hang the run.

## GO-gate (verdict invariant)

GO requires **all** coverage blockers clear: full dimension coverage, external-dominant supply, zero
quarantine, zero contested findings, ≥2 corroborating sources. Any of those → `caution`; a hostile-only run
(usable == 0 with a quarantine) → `no-go`. Content risk-scoring is an additional gate (later prompt), so GO is
unreachable for now **by construction** — but the coverage gate is live and unit-tested, so partial / thin /
hostile / friendly-heavy coverage provably never yields GO.

## Failure paths (PRD §6)

| State | Failure | Handling (implemented) |
|---|---|---|
| NEGOTIATE | supplier rejects / expires / offline (no `OrderCreated` in accept window) | liveness fail → **fall to alternate** → else partial, gap noted |
| NEGOTIATE | order price exceeds the supplier's `priceCeiling` | don't pay → fall to alternate |
| PAY | Ward AA wallet out of USDC | `isInsufficientBalance` → **HALT** (no verdict), actionable top-up alert |
| PAY | `BASE_RPC_URL` down | `payOrder` throws on its local balance precheck → surfaced clearly (`isRpcPrecheckFailure`) |
| AWAIT_DELIVERY | SLA timeout (paid, no delivery) | CAP auto-refunds escrow → source unavailable → fall to alternate → partial |
| FIREWALL | injection detected | **quarantine** → dropped + supplier flagged hostile → fall to alternate |
| FAN-OUT | aggregate budget exhausted | remaining dimensions **skipped** and surfaced on the verdict |
| run | per-supplier failure | **isolated** — one supplier's failure degrades coverage, never aborts the run |

**Invariant:** Ward never returns a verdict that silently swallowed a failure — every gap,
quarantine, and reason is on the face of the §9 object (`notes`, `sources_quarantined`, `sources_failed`).

## SDK note — `negotiateOrder` (read this)

The real `/orders/negotiate` contract was **verified live** against `api.croo.network` (2026-07,
unauthenticated protobuf shape probes — wrong-typed fields 400 at the codec *before* auth, so the
schema is decidable with no key and no spend). Result: the body is `{ serviceId, requirements: string,
metadata }` — **exactly the SDK's published type**. `requirements` is a **JSON-encoded string** (an
object → `400 CODEC`); `agentId`/`serviceIndex` are **not** schema fields and are silently ignored.

An earlier internal note claimed `{ agentId, serviceIndex, requirements: object }` — that was wrong,
and it briefly drove a type-corrected cast here. Both are gone: [croo-client.ts](src/croo-client.ts)
`negotiateService()` calls the SDK's real typed method directly (no cast, no suppression anywhere in
the package), and the registry targets `serviceId`. **Validate before funding:** `npm run probe`
negotiates against each configured supplier with only a key — no pay, no USDC — and reports whether
the wire shape + serviceId + requirements schema are all accepted. Fund the wallet only once it's green.

## Stubbed (later prompts, marked transparently)

- **Conformance scoring (§7.2)** — `Finding.firewall.conformance` is a pass-through `1.0`; `severity`
  is firewall-derived only (no content risk scoring yet).
- **Cross-source contradiction detection (§7.3)** — COLLATE aggregates multi-source §9 fields but
  `contradictions: []` (the contradiction engine is the next prompt).
- **Content-scored GO** — the coverage GO-gate is live, but GO additionally requires content
  risk-scoring (above), so the verdict tops out at `caution` until §7.2/§7.3 land.

MIT
