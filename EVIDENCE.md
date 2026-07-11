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

## Reproduce

`orchestrator/` → fill `.env` (see `SETUP.md`) → `npm run probe` (free) → fund Ward's AA wallet →
`npm run ward`. Verified live 2026-07-11.
