/**
 * Live judge layer — the production Claude-backed JudgeFn.
 *
 *   npm i @anthropic-ai/sdk
 *   export ANTHROPIC_API_KEY=sk-...
 *
 * Pass `claudeJudge` as the 3rd arg to `scan()` (or inject it into FirewallGate).
 * The judge makes the imperative-to-reader vs descriptive-of-subject call that
 * the deterministic pattern layer cannot. It fails SAFE: any parse/transport
 * failure becomes `suspicious` (→ flag), never a silent `safe` pass.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  JUDGE_SYSTEM_PROMPT,
  buildJudgeUserPrompt,
  type JudgeFn,
  type ScanContext,
  type Verdict,
} from "./firewall.js";

// Security-critical classification → Sonnet for accuracy (per PRD §12).
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 200;

// Lazily constructed so importing this module without ANTHROPIC_API_KEY does not
// throw (the deterministic runners import the package without a key).
let client: Anthropic | null = null;
function getClient(): Anthropic {
  client ??= new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return client;
}

const VERDICTS: readonly Verdict[] = ["safe", "suspicious", "hostile"];
const isVerdict = (v: unknown): v is Verdict => typeof v === "string" && (VERDICTS as readonly string[]).includes(v);

export const claudeJudge: JudgeFn = async (text: string, ctx: ScanContext) => {
  let raw = "";
  try {
    const msg = await getClient().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: JUDGE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildJudgeUserPrompt(text, ctx) }],
    });
    raw = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
  } catch (err) {
    // Transport/auth/rate-limit/policy-block failure: fail SAFE, flagged as judge-unavailable.
    return { verdict: "suspicious", rationale: `judge call failed (${(err as Error).message}) -> fail-safe`, error: true };
  }

  try {
    const parsed: unknown = JSON.parse(raw.replace(/```json|```/g, "").trim());
    const verdict =
      typeof parsed === "object" && parsed !== null && isVerdict((parsed as { verdict?: unknown }).verdict)
        ? (parsed as { verdict: Verdict }).verdict
        : "suspicious";
    const rationale =
      typeof parsed === "object" && parsed !== null ? String((parsed as { rationale?: unknown }).rationale ?? "") : "";
    return { verdict, rationale };
  } catch {
    // Unparseable judge output: fail SAFE, flagged as judge-unavailable.
    return { verdict: "suspicious", rationale: "judge parse failure -> fail-safe", error: true };
  }
};
