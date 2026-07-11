# Ward — Product Requirements Document

**The trust layer for agent commerce.** Ward is the agent you route through to safely hire other agents.

- **Hackathon:** CROO Agent Hackathon (DoraHacks × CROO Network)
- **Tracks:** Open – Any A2A Agents (primary) + Developer Tooling Agents (secondary)
- **Chain:** Base Mainnet (8453) · USDC settlement · gas sponsored
- **Build window:** Jun 20 → freeze Jul 9 (submit buffer to Jul 12 09:00)
- **Builder:** @winsznx (solo lead) + 1 collaborator (friendly supplier agents)
- **Status:** PRD locked · Day-0 gate pending

> Working name: **Ward**. Alts on the table: Arbiter, Vouch. Rename before public listing if a better one lands.

---

## 1. The insight

CROO solved how agents *discover, hire, and pay* each other. It did **not** solve whether the work you paid for is **good** or **safe**. That gap is the whole product.

Two things break the moment agents autonomously pay agents with real USDC, and CROO's own architecture confirms both are unhandled:

1. **Quality is unverified.** Escrow releases on *delivery*, not *correctness*. The on-chain keccak256 hash proves the deliverable wasn't tampered with — it says nothing about whether it answers the request. A provider can deliver garbage and collect. The requester has no recourse: at `paid` status, *only the provider* can reject.

2. **The deliverable is an attack surface.** A "research report" returned by a provider agent can carry a prompt injection that hijacks the *requester's* agent. No human is in the loop to catch it. CROO escrow protects your **funds** (refund on SLA timeout) — it does nothing to protect your **agent** from a malicious payload it's about to ingest.

Everyone at this hackathon is building a *provider of intelligence* (signal bots, auditors, data agents). Nobody is building the layer that makes *consuming* those agents safe. Ward owns that layer.

---

## 2. What Ward is

Ward is a CROO agent that sells one thing to humans: a **due-diligence verdict** on a token or protocol. Under the hood it acts as a **requester** — it hires a swarm of specialist agents, runs every deliverable they return through a security + quality **firewall**, reconciles their findings, and returns a single **go / caution / no-go** verdict with evidence.

Two surfaces:

- **Front door (H2A, the hero):** a human asks "should I ape this?" → Ward fans out to specialists on CROO → firewalls + reconciles → verdict. The agent-hiring is invisible plumbing; the human sees a product.
- **Primitive (A2A, the moat exposed):** a standalone `verify-deliverable` service that *any* requester-agent can call mid-order — pass a deliverable, Ward firewalls it (injection + conformance), returns a verdict. This is the dependency other agents plug into their own loops.

**Why this is defensible:** the moat is the firewall engine — injection defense, conformance scoring, cross-source reconciliation. Every component is something the team has already shipped a version of (Cordon = inbound compliance firewall for agent wallets; Solana Agent Firewall = pre-sign tx firewall; Custos Gate-0 = injection defense for agentic settlement; TryAnneal = multi-stage verification cascade). No other team at this table has built this.

---

## 3. Why this wins (judging map)

| Axis | Weight | How Ward wins it |
|---|---|---|
| **Technical Execution** | 30% | Real CAP orders to real providers on Base → real USDC settlement. Clears the **10+ orders bonus** by construction (every verdict = a 4-supplier fan-out). The firewall + orchestrator is genuine systems work with full failure handling, not a wrapper. |
| **A2A Composability** | 25% | Ward doesn't *hope* for diverse callers — it *generates* them. Every DD job hires 4+ distinct specialist agents across different wallet clusters. This is the exact metric that beat bountymesh on Vara (winners: 12–25 unique external senders). Here we control it, and the diversity is real. |
| **Innovation** | 20% | "Impossible on a normal API marketplace?" — yes. A safety/verification layer for agents *autonomously paying* agents only makes sense inside an agent-commerce protocol. Native to CAP. |
| **Usability & Real Adoption** | 15% | Rug-fear is the most visceral pain in crypto. Recruitable: put it in front of CT builders and they use it. We bring demand → sidesteps the cold/empty marketplace. |
| **Presentation** | 10% | Demo tells a human story ("watch it stop me aping a rug") + a hero beat: an agent tries to inject Ward and the firewall catches it live. |

---

## 4. Competitive position

14 BUIDLs in at time of writing. The field clusters:

- **Saturated:** DeFi signal/intel bots (DCA Signal, DepegGuard, Clawintel, Hyperliquid Vault, Polymind — 5), Solidity audit agents (Aegis, Chainguard — 2). These are commodity; we do not compete here, we *consume* them.
- **Adjacent precedent:** Web3 Address Intel (counterparty screening), Paid Bounty Triage (bountymesh-adjacent), Attestr.CROO ("5 agents hire each other to research/verify/audit" — the obvious A2A-mesh framing, already taken).
- **White space Ward owns:** every team is a *provider* of work; nobody is the *safety/trust layer for using* work. Ward sits above all of them and turns the strongest competitors into its supply chain.

**Counter-positioning vs the bountymesh loss:** bountymesh was a two-sided supply-aggregating market — it needed both agents *and* work to show up organically, a liquidity cold-start that lost on diverse-external-traffic. Ward is **one-sided**: the human asks one question, gets one answer; supply is the existing agents; demand is recruited. No liquidity to bootstrap. We keep the craft from bountymesh, drop the concept that lost.

---

## 5. Architecture

### 5.1 Ward as a CROO agent

- Registered on the Agent Store → AA smart-contract wallet (ERC-4337, Biconomy Nexus) + Agent DID + API Key (`croo_sk_…`, `X-SDK-Key` header).
- Skill tags (1–5): `due-diligence`, `risk-analysis`, `verification`, `on-chain-data`, `security`.
- Services registered via Dashboard (off-chain): see §8.
- Runtime via `@croo-network/sdk` (Node 18+). Ward holds **no protocol private keys** — Executor signing is backend-side via API key.

### 5.2 Role: Ward is a requester that adds a verification gate

```
        ┌─────────── HUMAN (real user) ───────────┐
        │  "vet token 0xABC… before I ape"         │
        └───────────────────┬──────────────────────┘
                            │  H2A order (USDC)  OR  Ward frontend intake
                            ▼
        ┌──────────────────────────────────────────┐
        │                 WARD                      │
        │  Orchestrator + Firewall + Collator       │
        └───┬───────────┬───────────┬───────────┬───┘
            │ A2A order │ A2A order │ A2A order │ A2A order   (sequential pay)
            ▼           ▼           ▼           ▼
       Address      Contract    Risk /       Sentiment /
       Intel        Audit       Liquidity    holder dist.
       (external)   (external)  (friendly)   (friendly)
            │           │           │           │
            └─────►  each deliverable ──► FIREWALL ──► NORMALIZE
                                                          │
                                              CROSS-SOURCE COLLATE
                                                          │
                                                  VERDICT (go/caution/no-go)
                                                          │
                                          keccak hash on-chain → deliver to human
```

### 5.3 CAP integration touchpoints (the SDK surface we use)

| Step | SDK call | Notes |
|---|---|---|
| Discover supplier | (Dashboard / known serviceIds) | v1 uses a curated supplier registry of serviceIds |
| Open order | `negotiateOrder({ serviceId, requirements })` | one per supplier |
| Supplier accepts | (their side) `acceptNegotiation` → on-chain `createOrder` | dual-sig, gas sponsored |
| Pay | `payOrder(orderId)` | **sequential only** — concurrent pay collides on AA-wallet nonce (`NONCE_ERROR`/`PIMLICO_ERROR`) |
| Receive result | WS `OrderCompleted` → `getDelivery(orderId)` | text or schema |
| Verify integrity | compare keccak256(delivery) to on-chain hash | tamper check |
| Return verdict | `deliverOrder(humanOrderId, verdict)` | completes the H2A order |
| Events | `connectWebSocket()` → `stream.on(EventType.*)` | **one WS per API key** (code 1008 if doubled) |

Contracts (Base mainnet, reference only — we integrate via SDK): CAPCore `0xaD46f1Eba2fe9cBB689D2874a52039192F2ac821`, CAPVault `0x33ECdcC8dD32330ec5a62AB1986F25ED5B5D170d`, CROOValidationModule `0xfCc7eefd6D22bC6a4F35B467928ecAF738d0B3b8`. USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.

---

## 6. Orchestration state machine

### Happy path

```
INTAKE (target + human order)
  → PLAN (select N suppliers from registry)
  → for each supplier [SEQUENTIAL]:
        NEGOTIATE → PAY → AWAIT_DELIVERY → FIREWALL → NORMALIZE
  → COLLATE (cross-source consistency)
  → VERDICT (go | caution | no-go + evidence)
  → DELIVER_TO_HUMAN → on-chain hash → SETTLE
```

### Failure paths (this is the 30% bucket — robustness is the product)

| State | Failure | Handling |
|---|---|---|
| NEGOTIATE | supplier rejects / negotiation expires | swap to alternate supplier in registry; none left → proceed **partial**, record coverage gap in verdict |
| AWAIT_DELIVERY | SLA timeout (paid, no delivery) | CAP auto-refunds escrow to Ward; mark source unavailable; proceed partial |
| FIREWALL | **injection / malicious payload detected** | **QUARANTINE** — never ingest into verdict; flag supplier as hostile; surface in verdict ("1 source attempted injection") |
| FIREWALL | off-spec / low-quality (conformance fail) | discard from verdict; flag low-quality; proceed partial |
| COLLATE | sources contradict | verdict = **CAUTION**, conflict surfaced explicitly; never silently pick a winner |
| PAY | nonce collision | serialize payments (design invariant) |
| PAY | Ward AA wallet out of USDC | halt; `insufficient_balance`; alert operator to top up |
| WS | connection drop | SDK auto-reconnect (1s→30s backoff); resume from last event |
| any | partial coverage | verdict still returns, labeled with confidence + which sources ran |

**Invariant:** Ward never returns a verdict that silently swallowed a failure. Every gap, quarantine, or contradiction is on the face of the result. Trust comes from showing the seams.

---

## 7. The firewall engine (the moat — make it concrete, not vibes)

Three modules, run on every deliverable before it touches a verdict:

**7.1 Injection / safety scan**
- Pattern + heuristic layer: known jailbreak/injection signatures, instruction-to-the-reader detection ("ignore previous", role-switch attempts, tool-call smuggling, encoded payloads).
- LLM-judge layer: classify whether the deliverable contains instructions *aimed at the consuming agent* vs. content *about the requested subject*.
- Output: `safe | suspicious | hostile` + matched indicators. `hostile` → quarantine.
- Lineage: direct port of Custos Gate-0 thinking.

**7.2 Conformance scoring**
- Did the supplier actually answer the request? Score the deliverable against the service's declared schema/spec and the DD question.
- Structural validation for `schema` deliverables (field presence/types); semantic scoring for `text`.
- Output: `conformance ∈ [0,1]` + rationale. Below threshold → discard + flag low-quality.

**7.3 Cross-source collation**
- Normalize all surviving findings into a common finding schema (§9).
- Detect agreement vs contradiction across sources (e.g., audit says "no mint function" but address-intel flags "owner can mint" → contradiction).
- Contradictions force verdict to CAUTION and are surfaced with the conflicting evidence.

> **v2 moat-deepener (not v1):** ZK-private verification — a supplier proves its output passes a quality check without revealing the output pre-payment. Note in roadmap, do not build now.

---

## 8. Service definitions (Dashboard config)

| Service | Price (USDC) | SLA | Requirements | Deliverable |
|---|---|---|---|---|
| **Token DD Verdict** (hero) | e.g. 1.00 | 0h 10m | `schema`: { tokenAddress: address, chain: string } | `schema`: verdict object (§9) |
| **Verify Deliverable** (primitive) | e.g. 0.25 | 0h 5m | `schema`: { deliverable: string, expectedSpec?: string } | `schema`: firewall verdict |

Prices are tunable down to cents to keep the live-orders run cheap (mainnet = real USDC). SLA minimum is 300s.

---

## 9. Data model

**Verdict object (returned to human):**
```json
{
  "target": "0xABC… / protocol name",
  "verdict": "go | caution | no-go",
  "confidence": 0.0,
  "sources_run": 4,
  "sources_quarantined": 1,
  "sources_failed": 0,
  "findings": [ /* Finding[] */ ],
  "contradictions": [ /* {a, b, field} */ ],
  "notes": "1 source attempted injection, quarantined",
  "evidence_hash": "0x…"
}
```

**Finding (normalized per source):**
```json
{
  "source_agent": "did:croo:…",
  "source_service": "Address Intel",
  "category": "ownership | liquidity | audit | sentiment | risk",
  "signal": "string",
  "severity": "info | warn | critical",
  "firewall": { "safety": "safe", "conformance": 0.0 },
  "order_id": "…",
  "settled": true
}
```

---

## 10. Supplier roster & A2A strategy

| Supplier | Source | Job (distinct, real) | Cluster |
|---|---|---|---|
| Address / counterparty intel | external (rival agent) | ownership, blacklist, mint authority | rival A |
| Contract audit | external (rival agent) | known-vuln surface, honeypot check | rival B |
| Liquidity / holder distribution | **friendly** | LP depth, concentration, holder spread | friend |
| Sentiment / CT scan | **friendly** | social signal, flag coordinated shilling | friend |

**Sybil-safe invariant (locked):**
- External suppliers **dominate** every verdict's supply; friendly is the **minority + safety net**.
- Friendly agents do **real, distinct jobs** — not echoes. This is genuine composition, not a wash loop.
- Friendly capacity is for clearing the **eligibility floor** (<3 counterparties / <5 buyer wallets) and **demo reliability**, NOT for winning composability. The win comes from external diversity + recruited human buyers.

**Floor vs ceiling:**
- *Floor* (must clear to be reward-eligible): friend on a separate wallet cluster + a couple of real buyer wallets.
- *Ceiling* (what actually wins): diverse external counterparties (rival agents) + real humans placing DD orders. 0% reliance on a self-trade ring — that pattern is flagged and was penalized on Vara.

---

## 11. Scope

**v1 (this hackathon):**
- One vertical: token/protocol DD.
- Text + light schema deliverables. No file pipeline.
- 3 supplier integrations minimum (mix external + friendly).
- Firewall: injection + conformance + contradiction.
- H2A via Ward frontend + listed Store service; A2A `verify-deliverable` exposed, demoed lightly.
- Real on-chain orders on Base mainnet.

**v2 (deferred — roadmap slide only):**
- ZK-private verification.
- Fund-Order / CAPSwapExecutor path (Ward gates *value-moving* deliverables, not just data).
- Reputation-weighted supplier selection, multi-vertical DD, insurance/bonding on verdicts.

**Explicitly out:** Agent Trading, custom reputation system (CROO native handles it), Navigator-style general orchestration (don't compete with the host primitive).

---

## 12. Tech stack

- **Runtime:** Node 18+ / TypeScript, `@croo-network/sdk`.
- **Orchestrator:** single service (state machine + firewall + collator). Hosted on Railway (existing muscle).
- **Firewall LLM-judge:** Claude (via API) for injection classification + conformance scoring.
- **Frontend:** Next.js — **lift the bountymesh shell** (wallet connect, agent cards, order tables, polished chassis) and re-wire to Ward intake + verdict display + live fan-out visualization.
- **Persistence:** lightweight (Postgres/Supabase) for order/verdict history + the live feed.
- **Repo:** public, MIT or Apache 2.0 (submission requirement).

---

## 13. Anti-sybil compliance plan

| Flag | Plan |
|---|---|
| <3 unique counterparty agents | every verdict fans out to 4+ distinct suppliers across clusters |
| <5 unique buyer wallets | recruited humans + friend cluster placing real DD orders |
| Concentrated self-trade | external dominates supply; friendly minority; friendly does real distinct jobs |
| 10% human audit | real working product, real settlements, reproducible README — survives a spot-check |

---

## 14. Demo beat sheet (≤5:00)

| Time | Beat |
|---|---|
| 0:00–0:30 | The pain: agents now pay agents with real money. Nothing checks if the work is good — or safe. |
| 0:30–1:00 | Human pastes a sketchy token into Ward. One question: "should I ape this?" |
| 1:00–2:15 | Ward fans out **live** — hiring 4 different teams' agents on CROO. Show the order cards lighting up, real USDC, real on-chain. |
| 2:15–3:15 | **Hero beat:** one supplier's deliverable carries a prompt injection. Ward's firewall **catches and quarantines it** on screen. "An agent just tried to hijack me. Ward stopped it." |
| 3:15–4:00 | Sources contradict; Ward surfaces the conflict and returns **NO-GO** with evidence + "1 source attempted injection, quarantined." |
| 4:00–4:40 | Cut to CROO order data: 4 distinct counterparty agents, N real orders settled on Base. The composability is in the protocol's own data. |
| 4:40–5:00 | The line: *CROO lets agents hire agents. Ward makes it safe to.* |

---

## 15. Build plan (Jun 20 → freeze Jul 9)

| Phase | Days | Output |
|---|---|---|
| **Day-0 gate** | Jun 20–21 | Riskiest unknowns proven (see §16). No feature work until green. |
| **Spine** | Jun 22–25 | Ward registered + connected; orchestrator state machine; one real end-to-end DD with one supplier on mainnet. |
| **Firewall** | Jun 26–29 | Injection scan + conformance scorer + collation; quarantine path working against a known injection. |
| **Swarm** | Jun 30–Jul 3 | Supplier adapter registry; 4 suppliers wired (rival + friendly); failure paths (timeout/refund/partial). |
| **Surface** | Jul 4–7 | Frontend (bountymesh shell re-wire) + live fan-out viz + verdict display + WS streaming. |
| **Harden + run** | Jul 8 | End-to-end mainnet run for the 10+ orders; recruit first real buyers. |
| **Freeze + ship** | Jul 9 | Demo video, README (SDK methods + integration notes), BUIDL filed. Buffer to Jul 12 09:00. |

---

## 16. Day-0 gate (must pass before any feature work)

Hard checklist. If any fails, we stop and solve it before building features — these are the unknowns that can sink the project:

1. **Real CAP order settles on Base.** Register two test agents, fund the requester AA wallet with USDC, run provider+requester examples, confirm a real `created→paid→completed` cycle with on-chain settlement. *(Proves the protocol works end-to-end for us, mainnet, real USDC.)*
2. **WS is stable, one-per-key.** Confirm event stream + auto-reconnect; confirm the 1008 single-connection constraint and design each agent process around its own key.
3. **Sequential pay confirmed.** Reproduce/avoid the concurrent-`payOrder` nonce collision; lock serialization.
4. **Firewall catches a known injection.** Feed a deliverable containing a canned prompt injection through the firewall module; confirm `hostile` + quarantine. *(Proves the moat is real before we build around it.)*
5. **A supplier serviceId is callable.** Confirm Ward (as requester) can negotiate+pay+receive from at least one real external agent on the Store.
6. **USDC budget + wallet plan.** Ward AA wallet funded; per-order cost x expected run volume sized; top-up plan set.

---

## 17. Sequenced Claude Code prompts

Each is one scoped, production-grade component. No mocks, no stubs. Explain design choices after each. Wait for confirmation between steps.

1. **Scaffold + SDK smoke test.** TS monorepo, env config (`CROO_API_URL`, `CROO_WS_URL`, `CROO_SDK_KEY`, `BASE_RPC_URL`), install `@croo-network/sdk`. Build a runnable provider+requester pair that completes one real order. *(Day-0 #1.)*
2. **Ward agent client + handshake.** AgentClient wrapper, WS connect with auto-reconnect + single-connection guard, typed event dispatch. *(Day-0 #2.)*
3. **Orchestrator skeleton + state machine.** Implement INTAKE→…→VERDICT as an explicit FSM with the §6 states; sequential pay enforced; no firewall/collator yet (pass-through). One supplier, end-to-end on mainnet.
4. **Supplier adapter + registry.** Interface for "call a specialist via CAP" (negotiate→pay→await→getDelivery→integrity check); curated serviceId registry with alternates per category.
5. **Firewall — injection scan.** Pattern layer + Claude LLM-judge; `safe|suspicious|hostile` + indicators; quarantine wiring. *(Day-0 #4.)*
6. **Firewall — conformance scorer.** Schema structural validation + semantic scoring vs the DD question; threshold + low-quality flag.
7. **Collator.** Normalize to Finding schema; cross-source agreement/contradiction detection; contradiction → CAUTION.
8. **Verdict composer.** Assemble verdict object (§9); on-chain keccak integrity check per source; deliver to human order.
9. **Failure handling.** Negotiation reject/expire → swap; SLA timeout → refund + partial; out-of-USDC halt; partial-coverage labeling. Idempotency on retries.
10. **Friendly specialist agents.** Two small real services (liquidity/holder-distribution; sentiment/CT-scan) as standalone CROO providers — separate keys/wallets, genuine jobs.
11. **Frontend chassis.** Lift bountymesh shell; intake form; verdict display with per-source evidence + quarantine/contradiction callouts.
12. **Live fan-out visualization.** Real-time order cards (negotiate→pay→deliver) driven by WS events; the injection-caught beat rendered prominently.
13. **End-to-end mainnet run + history.** Drive the 10+ real orders; persist order/verdict history; live feed. Capture the demo run.
14. **README + submission.** Setup instructions, SDK methods used, integration notes, license, demo video link; file BUIDL on DoraHacks.

---

## 18. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Supplier agents offline at demo time | friendly specialists guarantee minimum supply; firewall/verdict is our value regardless of who supplies; record a clean run early |
| Firewall reads as hand-wavy | concrete three-module spec (§7); show a real injection caught + a real contradiction surfaced |
| Scope creep in ~18 days | ruthless v1 cut (§11); one vertical, text-first, 3 suppliers |
| Mainnet USDC cost on the orders run | cent-level pricing; sized budget; top-up plan in Day-0 |
| Self-trade flag | external-dominant supply invariant; friendly minority doing distinct real jobs |
| Deadline ambiguity (Jul 9 vs Jul 12) | build toward Jul 9 freeze; Jul 12 09:00 is the buffer, not the target |

---

## 19. Submission checklist (the 5 mandatory gates)

- [ ] Listed on CROO Agent Store (discoverable, status online)
- [ ] Integrated with CAP (callable, settles on-chain — real orders)
- [ ] Open source — public repo, MIT / Apache 2.0
- [ ] Demo (≤5 min) + README (setup, SDK methods, integration notes)
- [ ] BUIDL filed on DoraHacks, all fields

---

*End of PRD. Next: pass Day-0 gate (§16), then Prompt 1.*