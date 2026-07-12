# Ward — on-chain evidence (Base mainnet, chainId 8453)

Real CAP orders settled on Base. USDC settlement, gas sponsored. Verify any tx on Basescan.

## Order #1 — Ward hires Attestr (Ward as requester, via `@croo-network/sdk`)

The Day-0 win: **Ward** (agent `4a7abd59-40d5-4c99-9ca3-ede49afae6e3`, AA wallet
`0xcfF1A926BCF1748b1D6b9BA7E4a0A7379568Acc6`) negotiated → paid → received → firewalled a real
deliverable from **Attestr** (`20ba0841-8411-4ee7-960e-5b1d376943d3`), then produced a §9 verdict.
Settled 2026-07-11 ~21:05 UTC via `npm run ward`.

- **Order id:** `5c4d4cf9-7b33-415d-a40c-49781b686290`
- **Service:** Attestr "Contract & Address Risk Check" · serviceId `23386450-8828-4e74-a61b-373a34035329` · $0.01
- **createOrder tx:** https://basescan.org/tx/0xc0c6d9aad5153858a890955c29d982d053ecb8827dc243e8a43d89bbd8f931d0
- **pay tx:** https://basescan.org/tx/0x26df63c0b146c618d8056c6930cf77e0c98c4152e3bc86b060b8f49bb60e61f2
- **deliver tx:** https://basescan.org/tx/0xaeb0cc9d03a876bcee51e3fe988843e341fa7b5ad661ca427de9414f0878cccd
- **Integrity:** L2 on-chain receipt confirmed (chainId 8453); L1 keccak256(delivery) == committed contentHash
- **Firewall (Groq judge):** `safe` — cleared Attestr's SAFE report (which mentions "mint functions with no supply caps") as *descriptive of subject*, not an injection. No quarantine.
- **§9 verdict:** `caution` (confidence 0.80) — `GO blocked: thin coverage (<2 corroborating sources)`
- **evidence_hash:** `0x195dea738dc36101dfe53199e115e300b52d771d69f7d0f79f74bdc8dcc24614`

Proves Day-0 **#1** (order settles on Base), **#2** (WS one-per-key), **#3** (sequential pay),
**#5** (real external supplier callable) + composability (Ward in Attestr's counterparty graph).

## Order #2 — direct human buy (confirms Attestr fulfills)

- **Order id:** `83411d07-decd-4aa5-a6b3-9a42ec32ca78` · chainOrderId `164055` · COMPLETED
- **clear/settle tx:** https://basescan.org/tx/0xc0ec383e72406be22135a784838e9f37ee1ade2c9c072dfb2d8705b6e672bd49
- LOCK → DELIVER → CLEAR (0.01 USDC settled to Attestr) in ~32s.

## Attestr deliverable shape (what the firewall screens / conformance validates)

```json
{ "address": "0x…", "badge": "SAFE" | "CAUTION" | "DANGEROUS", "riskScore": 0-100,
  "reasons": ["…"], "report": "## Risk Summary …markdown…", "analyzedAt": "ISO-8601" }
```

## Multi-supplier run — external-dominant corroboration (2 distinct agents)

Ward vets a token by fanning out to **distinct real CROO agents across DD dimensions**, not one supplier.
A live run against USDC hired two external agents; both delivered, both cleared the firewall, and the
coverage gate went **CLEAR** (full external-dominant corroboration):

| dimension | agent | order | create · pay · deliver |
| --- | --- | --- | --- |
| audit | Attestr Contract & Address Risk Check | `426a58d4…` | [create](https://basescan.org/tx/0x922ba428b9e0dd2e7ef56f14cf99442492654ed6ae9434c01acfe76757521f50) · [pay](https://basescan.org/tx/0x5e8746f0011290f03befcb2dcfb66ac278f7f2753699dd4b554477e211d9a4c7) · [deliver](https://basescan.org/tx/0xd57f608c478eb3f226cde6caf5ec831e6d1347b4cfeea399aed7777e3231cd55) |
| liquidity | Degentel LP — Yield Finder | `3d6bf3fd…` | [create](https://basescan.org/tx/0x3fa2d083acfa4d23ae173b0bc6890573d969e4e2d74515ab0f095642a312e0a3) · [pay](https://basescan.org/tx/0xbb8d1881e6e75b1214a67f9e13ed4b1f2b7612076e1d962d097a1fe3d530b3a9) · [deliver](https://basescan.org/tx/0x21f5c014745fd814e9203347898769401a2c877cafd70f9a3d9e879945b1d490) |

- **Counterparty set:** 2 distinct on-chain agents, both external → **external-dominant** (not a reciprocal self-trade ring).
- **Firewall:** both deliverables cleared (`safe`) — Attestr's SAFE audit and Degentel's live pool/route/TVL data.
- **Verdict at the time:** `caution` (0.80) — coverage **CLEAR**, GO then gated on content risk-scoring.
  That gate is now **implemented** (conservative `readRisk`): the audit source's SAFE badge + low riskScore
  scores the token **clean**, so a fresh run of this same input now returns **GO (0.90)**; a DANGEROUS audit
  read, or any source scoring the token dangerous, flips it to **no-go**. GO requires an explicit clean read
  — ambiguous content stays caution, never a false GO.
- **evidence_hash:** `0xe7e3384d65605387f94c4f757cb215bc9e572d6df4aa1a1ee5a6bb72bc6ed60e`

Suppliers are discovered from the CROO Store's public catalog (`GET /backend/v1/public/agents`) and wired
into the registry by serviceId; per-supplier failures isolate (a flaky agent falls back, never aborts the run).

## Ward is a live provider (status: online, hireable)

Ward isn't only a requester — it's **listed and online** on the CROO Agent Store, hireable by any human or agent:

- **Public agent page:** https://agent.croo.network/agents/4a7abd59-40d5-4c99-9ca3-ede49afae6e3 (status **LIVE**)
- **Service:** *Token DD Verdict* — requirements `{ tokenAddress, chain }`, deliverable `{ verdict, confidence, notes, evidence_hash }`, price $1.00, SLA < 30 min.
- **What flips it online:** the `ward-provider` process (`orchestrator/src/provider.ts`, `npm run provider`) holds **one** WebSocket open on Ward's key. Connect log:
  `→ ONLINE websocket connected — Ward is now ONLINE and accepting Token DD Verdict orders`

**H2A fulfilment (one agent, both roles, one key).** On `NegotiationCreated` the provider accepts; on `OrderPaid` it extracts the token from the buyer's requirements and runs the **full multi-supplier DD on that same connection** (the DD core `runDD` is shared with the requester CLI — no second WebSocket, respecting one-WS-per-key/1008), then `deliverOrder`s the §9 verdict on-chain. Requirement templates are substituted **per order**, so Ward vets whatever token the buyer sends.

### H2A order — a human hired Ward, Ward fulfilled (the hero flow, live)

A human (a separate funded wallet `0xF9793…`) hired Ward's *Token DD Verdict* service for USDC. Ward's
online provider accepted, ran the **full 2-supplier DD on the same connection**, and delivered the §9
verdict on-chain — one agent acting as **provider and requester at once**:

- **Buyer order (Ward as seller):** `7c1775f3-892e-41da-8d9f-359d9f5b3598` · $1.00 · requirements `{ chain: base, tokenAddress: 0x8335…2913 }`
  - [createOrder](https://basescan.org/tx/0x6e97150fa254bf59f78d67dc387fbb3e4da6ee1f103694e6ff008922f08018c7) (buyer paid $1.01) → verdict [deliver](https://basescan.org/tx/0xd095c365100561ace703a8c5c7d07cd1d7dbcdc7c67e70ffbb35d9d839d6aefa)
- **Ward's sub-orders (Ward as requester), fulfilling the buyer:**
  - audit · Attestr `04e399b0` — [create](https://basescan.org/tx/0x6b8a7ff99ade942a45cc028132792bec64fb74448728947ae2a6647b98788800) · [pay](https://basescan.org/tx/0xb96fb1cf71a80aae54c8dc6acf6c52a44c6ab39538ba18b1a2ca01327a126073) · [deliver](https://basescan.org/tx/0xf882f3194c1c92d3bf59134623e327a7c85c21e64e6cff01cb57509cf291dcc2) — firewall **safe**
  - liquidity · Degentel `0f2d1c13` — [create](https://basescan.org/tx/0x8eafd733febf1840d5c2030b61f8ffeb59492d9f77fab3fab68dfb85b11d083c) · [pay](https://basescan.org/tx/0x6b4d51becc03e39055a5df0f0cc354cfa37db140b541fa20eb914d2df920a5f0) · [deliver](https://basescan.org/tx/0xb08a4cf312d5fbeb5808cc3611a58a9c351a8d53889f08cf84a88db08721c9c8) — firewall **safe**
- **Verdict:** `caution` (0.80) — 2 distinct external delivered, `dominant=true`, coverage covered 2/2.

This is the H2A hero end to end: **human → Ward → (Attestr + Degentel) → firewall → §9 verdict**, all on Ward's single WebSocket.

### A2A order — an agent hired Ward (both directions of A2A, live)

A **separate CROO buyer agent** (its own key + funded AA wallet) hired Ward **programmatically** via the SDK
(`day0-smoke/src/hire-ward.ts` → `npm run hire-ward`) — the mirror of Ward hiring its own suppliers. Ward
accepted, ran the full 2-supplier DD, and delivered the verdict back to the buyer agent on-chain:

- **A2A order (agent → Ward):** `17abf3a3-85ee-4de1-993d-380d4afcdee9` · target USDC · negotiation `3f5ac4ea`
  - buyer agent paid Ward → [pay](https://basescan.org/tx/0x5f99ef889796535c462ded37bedc477989c2952a32adbcb311a8e8693372e652)
  - Ward delivered the verdict → [deliver](https://basescan.org/tx/0xff008bb33450f6b429032e9481daa2ea1dfbceb0f77c09986e61f4d6807371d2)
- Ward's sub-orders fulfilling it: **Attestr** (audit) + **Degentel** (liquidity) — 2 distinct external, `dominant=true`.
- **Verdict: GO (confidence 0.90)** — the **first live GO**. With content risk-scoring deployed, Attestr's SAFE
  badge + low riskScore scored USDC **clean**, corroborated by Degentel; no danger signals → GO.

This closes the loop — **Ward hires agents *and* agents hire Ward**, plus the human path — every combination
settled on Base:

| direction | who hires whom | order | verdict |
| --- | --- | --- | --- |
| A2A (requester) | Ward → Attestr, Degentel | `426a58d4`, `3d6bf3fd` | — (supplier deliverables) |
| H2A | human → Ward | `7c1775f3` | caution 0.80 (pre content-scoring) |
| A2A (provider) | agent → Ward | `17abf3a3` | **GO 0.90** |

Any agent — via the `@croo-network/sdk` **or** CROO's MCP server (`negotiate_order`/`pay_order`/`get_delivery`) —
hires Ward the same way; Ward is a CROO service, reachable through either front-end with no Ward-specific integration.

## Reproduce

`orchestrator/` → fill `.env` (see `SETUP.md`) → `npm run probe` (free) → fund Ward's AA wallet →
`npm run ward`. Verified live 2026-07-11.
