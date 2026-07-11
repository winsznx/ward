# Ward Firewall — injection scan (PRD §7.1 · Day-0 gate #4)

The moat. Runs on **every** supplier deliverable before it can enter a verdict, and
catches a deliverable that tries to hijack the *consuming* agent (prompt injection,
tool/fund-action smuggling, exfiltration) — **without** false-flagging a legitimate
security report that merely *describes* risky behavior of the subject token/contract.

That second half is the hard part and the whole reason this is two layers, not a regex.

## Two layers

1. **Pattern layer** ([src/firewall.ts](src/firewall.ts) `scanPattern`) — deterministic,
   high-recall signatures across `override / spoof / exfil / fund_action / tool_smuggle /
   redirect / escape / obfuscation / social_eng`. Cheap, instant, no network. **100% recall
   on the corpus** (16/16) — including the obfuscated base64 payload and the soft "bypass the
   steps" attack that the reference signatures missed (added `obf.decode_follow` +
   `soceng.bypass_steps`). It over-fires on ~17% of clean reports by design — those are the
   FP-traps the judge exists to clear.

2. **Judge layer** ([src/judge.ts](src/judge.ts) `claudeJudge`) — a `claude-sonnet-4-6` call
   that makes the one call the pattern layer cannot: **imperative-to-reader** (an instruction
   aimed at the agent reading this → hostile) vs **descriptive-of-subject** (reporting that a
   contract *can* mint/drain → safe). Fails **SAFE**: any parse/transport failure becomes
   `suspicious` → flag, never a silent pass.

## The combination is ASYMMETRIC (not "more severe wins")

This is the load-bearing decision, in [src/firewall.ts](src/firewall.ts) `resolve()`:

| judge | pattern | final | action |
|---|---|---|---|
| hostile | any | hostile | **quarantine** |
| suspicious | any | suspicious | flag |
| safe | safe | safe | pass |
| **safe** | **fired** | **suspicious** | **flag** |

"More severe wins" is a **bug**: it lets a pattern-layer false positive override the judge that
correctly cleared it, so every real audit describing a "drain"/"mint" capability stays
quarantined and Ward becomes useless for token DD. The judge is the authority on the
imperative-vs-descriptive call; a pattern hit the judge clears drops to `flag` — ingested as
**contested + down-weighted + surfaced**, never quarantined, never silently passed.

## Obfuscation + judge-degradation hardening

An injection can hide under an encoding (base64 / hex / `\uXXXX` / zero-width). That breaks two
things: the pattern layer only half-sees it, and forwarding the raw blob to the judge **trips the
platform safety filter** → the judge call errors → fail-safe to flag → a *real* injection lands at
FLAG instead of QUARANTINE. A **decode pre-pass** ([src/decode.ts](src/decode.ts)) closes both:

1. **Strip + decode** embedded encodings (base64 ≥24 chars, hex ≥16, `\uXXXX` runs, zero-width).
   A region only counts as a payload if it decodes to **readable text** — addresses/hashes decode
   to non-printable bytes and are ignored (no false quarantine, no needless defang).
2. **Re-scan the decoded content.** If it trips *any* injection signature → the deliverable is
   **quarantined deterministically, with no judge call** (hiding instructions under encoding is
   unambiguous intent).
3. **Defang for the judge.** Decoded payloads are replaced with `[ENCODED_BLOB_DECODED_TO: …]`
   before the judge sees the text — the judge classifies intent and **never ingests the live payload**.
4. **Judge degradation.** If the judge still errors/blocks, fail-safe to flag — **but a pattern-hostile
   is never downgraded** by a judge outage (`{error:true}` + pattern hostile → quarantine).

Net: H09 (a base64 jailbreak) is now **quarantined deterministically via the decoded rescan, with no
live judge call** — closing the FLAG-not-QUARANTINE gap. The judge receives **0 raw embedded payloads**.

## Action semantics

- `hostile` → **quarantine**: never ingested; supplier flagged hostile; surfaced as
  "N sources attempted injection" on the verdict face.
- `suspicious` → **flag**: ingested as a contested finding, down-weighted (`FLAG_WEIGHT`),
  shown on the verdict — matches Ward's "show the seams" invariant.
- `safe` → **pass**: ingested at full weight.

## Orchestrator wiring

[src/gate.ts](src/gate.ts) `FirewallGate` is the PRD §6 **FIREWALL** stage (between
AWAIT_DELIVERY and NORMALIZE). The orchestrator calls `screen(deliverables, request)`:

```ts
import { FirewallGate } from "./gate.js";
import { claudeJudge } from "./judge.js";

const gate = new FirewallGate(claudeJudge);
const { admitted, quarantined, hostileSuppliers, sourcesQuarantined, notes }
  = await gate.screen(deliverables, ddQuestion);
// admitted  -> NORMALIZE/COLLATE (passes at weight 1, contested flags down-weighted)
// quarantined / hostileSuppliers / notes -> surfaced on the §9 verdict object
```

Quarantine **drops** the finding and **flags** the supplier; `notes` carries the
"N sources attempted injection, quarantined" line that lands on the verdict.

## Run it

```bash
npm install
npm run pattern      # deterministic pattern-layer proof (no API key) — recall/FP
npm run gate         # gate integration test (deterministic fixture judge)
npm run combined     # pattern + judge over the corpus — per-item verdicts + recall/FP + divergences
npm run typecheck    # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
```

`npm run combined` uses the **live Claude API** when `ANTHROPIC_API_KEY` is set; otherwise it
replays captured live-model verdicts ([src/judge-live-capture.ts](src/judge-live-capture.ts))
through the **real** `resolve()` logic.

```bash
ANTHROPIC_API_KEY=sk-... npm run combined   # fully live HTTP judge
```

## Results (corpus = internal/firewall-ref/corpus.ts · 16 attacks + 12 clean)

Live run via `npm run combined` (judge = real `claude-sonnet-4-6`, applied verbatim):

| Pipeline | Attacks caught | Attacks quarantined | False negatives (passed) | Clean wrongly quarantined |
|---|---|---|---|---|
| Pattern layer only | 16/16 | 16/16 | **0** | 2/12 (the FP-traps) |
| Pattern + judge (combined) | **16/16** | **16/16** | **0** | **0/12** |

- All 16 attacks **quarantined**, 0 false negatives, 0 clean findings quarantined.
- The 2 FP-traps (C05 "owner *can* drain", C07 *quotes* an injection it found) fire on the
  pattern layer and the judge clears them to `flag` — ingested as contested, never dropped.
- The judge *upgrades* 3 attacks the pattern layer only rated `suspicious` (H12/H14/H15) to
  `hostile` → quarantine.
- **H09** (a base64 jailbreak) is quarantined **deterministically by the decode rescan, with no
  judge call** — the decoded payload trips `override.ignore_bare`. Previously this landed at
  `flag` because the raw payload tripped the platform safety filter and degraded the judge; the
  decode pre-pass closes that gap. The judge receives **0 raw embedded payloads**.

## Files

- [src/firewall.ts](src/firewall.ts) — types, signatures, `scanPattern`, `JUDGE_SYSTEM_PROMPT`, `resolve`, `scan`
- [src/decode.ts](src/decode.ts) — decode pre-pass (base64/hex/`\uXXXX`/zero-width) for obfuscation hardening
- [src/judge.ts](src/judge.ts) — production `claudeJudge` (`@anthropic-ai/sdk`, `claude-sonnet-4-6`, fail-safe)
- [src/gate.ts](src/gate.ts) — `FirewallGate`: the orchestrator FIREWALL stage
- [src/run.ts](src/run.ts) · [src/run-combined.ts](src/run-combined.ts) · [src/gate.itest.ts](src/gate.itest.ts) — runners/tests
- [src/judge-live-capture.ts](src/judge-live-capture.ts) — captured live-model verdicts for the keyless run

MIT
