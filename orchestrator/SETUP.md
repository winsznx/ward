# Ward — first live order (zero → settled)

The code is frozen and correct against a **verified** wire format. The only remaining work is CROO
account setup + a dollar of USDC — both yours to do. This is the **minimal** path: one cent-level
order that closes Day-0 #1/#2/#3/#5. The multi-supplier swarm run comes *after* Day-0 is green.

Ward here is only a **requester** (it hires a supplier). It does **not** need to register a service
of its own, and this order needs **no second party** — Ward hires Attestr, firewalls the deliverable,
and prints a §9 verdict to the console.

## 1. What to obtain (all in the CROO dashboard / your wallet)

1. **One registered "Ward" agent.** Registering it gives you:
   - an **AA smart-contract wallet address** (ERC-4337 / Biconomy Nexus) — this is what you FUND,
   - an API key **`croo_sk_…`** (issue it for the agent) → `CROO_SDK_KEY`.
2. **~$1 USDC on Base**, sent to the agent's **AA wallet address** (shown in the dashboard) —
   **NOT** the controller/EOA address. Funding the controller is the documented footgun.
3. **One supplier's real `serviceId` GUID.** Use Attestr's cheapest — agentId
   `20ba0841-8411-4ee7-960e-5b1d376943d3`, "Contract Risk Check" (~$0.01). Get the GUID from the
   agent's page, or (logged in) `GET /backend/v1/agents/20ba0841-8411-4ee7-960e-5b1d376943d3/services`.
4. A **`GROQ_API_KEY`** (console.groq.com) — the firewall judge is required (pattern-only
   over-quarantines descriptive audit reports).

## 2. `.env` (fill the 4 blanks)

```ini
CROO_API_URL=https://api.croo.network
CROO_WS_URL=wss://api.croo.network/ws
BASE_RPC_URL=https://mainnet.base.org
CROO_SDK_KEY=croo_sk_...            # your Ward agent key
GROQ_API_KEY=gsk_...
WARD_DD_TARGET=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913   # a KNOWN-GOOD first target (Base USDC)
WARD_DD_REQUEST=Should I ape this token? Vet ownership, mint authority, liquidity.
# VERIFIED LIVE 2026-07-11: Ward negotiated this serviceId as requester -> HTTP 200 (Attestr accepted the shape).
WARD_REGISTRY_JSON=[{"id":"attestr-risk","label":"Attestr Contract & Address Risk Check","agentId":"20ba0841-8411-4ee7-960e-5b1d376943d3","serviceId":"23386450-8828-4e74-a61b-373a34035329","category":"audit","cluster":"external","requirementsTemplate":{"text":"{{target}}"},"priceCeiling":0.05,"reliability":0.5}]
# Fund Ward's AA wallet (NOT the controller) with ~$1 USDC on Base: 0xcfF1A926BCF1748b1D6b9BA7E4a0A7379568Acc6
# Real Attestr deliverable shape (what the firewall screens / conformance validates):
#   { address, badge: "SAFE"|"CAUTION"|"DANGEROUS", riskScore: 0-100, reasons: string[], report: "<markdown>", analyzedAt }
```

Vetting Base USDC first is deliberate — a known-good target should yield a clean, benign deliverable
(firewall passes → `caution` verdict with one clean source), which validates the happy path before
you point Ward at anything sketchy.

## 3. Run order

```bash
npm install
npm run probe     # FREE — key + serviceId only, NO funding. Must be green first.
```

Probe failure decoder:
- `CODEC` → wire shape wrong (shouldn't happen now; would mean a regression).
- `…_NOT_FOUND` → the `serviceId` GUID is wrong — recopy it from the dashboard.
- `INVALID_PARAMETERS` → the `requirementsTemplate` doesn't match Attestr's schema — adjust the
  object (its exact fields are unknown to us; the probe error is how you learn them).
- `SDK_KEY_INVALID` → wrong/expired `CROO_SDK_KEY`.

```bash
# only after the probe is green:
#   fund the agent's AA wallet with ~$1 USDC on Base
npm run ward      # negotiate → pay → await → firewall → §9 verdict. First real settled order.
```

## 4. What the settled order proves — and what to capture

Closes **Day-0 #1** (real order settles on Base), **#2** (WS stable, one-per-key), **#3** (sequential
pay), **#5** (a real external supplier is callable). It also surfaces the **first live deliverable** —
whose exact shape is currently UNKNOWN and is what the firewall + the future conformance scorer must
parse. **Capture that deliverable** (it's logged); it's the input the next real prompt is built on.

Everything else (multi-supplier swarm, conformance scoring, contradictions) stays frozen until this
one order settles.
