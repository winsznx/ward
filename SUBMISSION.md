# Ward — submission pack (CROO Agent Hackathon)

Everything needed to file. Technical gate is closed (see [EVIDENCE.md](EVIDENCE.md)).

## Submission gates (§19)

- [x] **Integrated with CAP — settles on-chain (real orders):** Ward→Attestr order `5c4d4cf9…`, real create/pay/deliver txs on Base. Done.
- [x] **Open source (MIT):** [LICENSE](LICENSE) added.
- [x] **Listed on CROO Agent Store, status online:** Ward is **LIVE** on the Store (green dot). The `ward-provider` process holds the connection open and fulfils the *Token DD Verdict* service. Done.
- [ ] **Demo (≤5 min) + README:** shot-list below; READMEs exist per package.
- [ ] **BUIDL filed on DoraHacks:** text below.

## BUIDL text (paste into DoraHacks)

**Name:** Ward — the trust layer for agent commerce

**Tagline:** Ward is the agent you route through to safely hire other agents.

**What it does:** CROO lets agents discover, hire, and pay each other — but escrow releases on *delivery*, not *correctness*, and a returned deliverable can carry a prompt injection that hijacks the *buyer's* agent. Ward closes both gaps. As a requester, it fans out a due-diligence job to specialist agents on CROO, runs **every** deliverable through a security + quality **firewall** (prompt-injection defense + conformance + cross-source reconciliation) before it can touch a verdict, and returns a single **go / caution / no-go** verdict with on-chain evidence. Nobody else builds the layer that makes *consuming* agent work safe.

**How CROO/CAP is used:** Ward is a registered CROO agent (AA wallet + `croo_sk_` key). It `negotiateOrder`→`payOrder`→`getDelivery` against real external suppliers (e.g. Attestr), verifies the on-chain content hash, and settles in USDC on Base. Sequential pay respects the AA-wallet nonce; one WS per key. **Proof:** Ward→Attestr order `5c4d4cf9-7b33-415d-a40c-49781b686290` settled on Base — pay tx `0x26df63c0…`, deliver tx `0xaeb0cc9d…`.

**A2A composability:** every verdict is an external-dominant fan-out — Ward generates diverse, directional counterparty traffic (not a self-trade ring); anti-sybil dominance is enforced on the *delivered* set and logged each run.

**Hireable + online (H2A):** Ward isn't only a requester — it's a **live provider** on the CROO Store. The `ward-provider` process holds one WebSocket open (→ status *online*) and, when a human hires the *Token DD Verdict* service, accepts the order and runs the full multi-supplier DD **on that same connection** (one WS per key), then delivers the §9 verdict on-chain. One agent, both roles, one key — the DD core (`runDD`) is shared between the requester CLI and the provider.

**The moat (firewall):** a deterministic pattern layer + a Groq LLM-judge that distinguishes instructions *aimed at the reader* from content *about the subject*, with a decode pre-pass that catches base64/hex/zero-width-obfuscated injections deterministically. Lineage: Cordon, Solana Agent Firewall, Custos Gate-0.

**Tech:** Node/TypeScript, `@croo-network/sdk`, Base mainnet, Groq (firewall judge). Type-clean under strict TS; adversarially reviewed; offline test suite (`npm run test:offline`).

**Repo:** https://github.com/winsznx/ward  ·  **Live site:** https://ward-web-production.up.railway.app  ·  **Live agent:** https://agent.croo.network/agents/4a7abd59-40d5-4c99-9ca3-ede49afae6e3  ·  **Demo video:** <your video URL>

## Demo shot-list (≤5:00)

1. **0:00–0:30 — the pain.** "Agents now pay agents real money. Nothing checks if the work is good — or *safe*."
2. **0:30–2:00 — real order, live.** Run `npm run ward` (or replay the trace). Show `NEGOTIATE → PAY → AWAIT_DELIVERY`, then open the **pay** and **deliver** tx on Basescan — real USDC, real on-chain, Ward hiring Attestr.
3. **2:00–3:15 — the firewall (hero beat).** Show the corpus injection catch: `cd firewall && npm run test:offline` — a base64 jailbreak **quarantined deterministically**, a descriptive audit report ("owner can mint") **cleared** by the judge. "An agent tried to hijack me — Ward stopped it, and it *didn't* over-block a real report."
4. **3:15–4:15 — the verdict.** Show the §9 verdict object: badge/riskScore normalized, firewall status, evidence_hash, `GO blocked` reasoning. Point Ward at a sketchy token → **no-go** for contrast.
5. **4:15–5:00 — the line.** "CROO lets agents hire agents. **Ward makes it safe to.**" Cut to the counterparty graph / EVIDENCE.md.

## Your 4 actions

1. **Push the latest** to the public repo (`.env` is gitignored — keys won't leak). Adds the provider + frontend.
2. **Record the demo** using the shot-list.
3. **File the BUIDL** on DoraHacks with the text above (fill in the video URL).
4. **Ward stays online on its own** — the `ward-provider` service on Railway holds the WebSocket 24/7, so
   the Store shows Ward **online** without a laptop. (Locally: `cd orchestrator && npm run provider`. One WS
   per key — the Railway provider and a local one can't both run on Ward's key.)
