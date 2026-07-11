/**
 * Live judge layer — Groq-backed JudgeFn (OpenAI-compatible chat completions).
 *
 *   export GROQ_API_KEY=gsk_...
 *   # optional: export GROQ_MODEL=llama-3.3-70b-versatile
 *
 * Same contract as the Claude judge: it makes the imperative-to-reader vs
 * descriptive-of-subject call, and fails SAFE — any missing key / transport /
 * parse failure becomes `suspicious` (→ flag) with `error: true`, never a silent
 * `safe` pass. No SDK dependency; uses global fetch (Node 18+).
 */
import {
  JUDGE_SYSTEM_PROMPT,
  buildJudgeUserPrompt,
  type JudgeFn,
  type ScanContext,
  type Verdict,
} from "./firewall.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const MAX_TOKENS = 300;
const TIMEOUT_MS = 20_000;

const VERDICTS: readonly Verdict[] = ["safe", "suspicious", "hostile"];
const isVerdict = (v: unknown): v is Verdict => typeof v === "string" && (VERDICTS as readonly string[]).includes(v);

interface GroqResponse {
  choices?: { message?: { content?: string } }[];
}

export const groqJudge: JudgeFn = async (text: string, ctx: ScanContext) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return { verdict: "suspicious", rationale: "GROQ_API_KEY not set -> fail-safe", error: true };
  }
  const model = process.env.GROQ_MODEL ?? DEFAULT_MODEL;

  let raw = "";
  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        messages: [
          { role: "system", content: JUDGE_SYSTEM_PROMPT },
          { role: "user", content: buildJudgeUserPrompt(text, ctx) },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      return { verdict: "suspicious", rationale: `groq HTTP ${res.status}: ${bodyText.slice(0, 160)} -> fail-safe`, error: true };
    }
    const data = (await res.json()) as GroqResponse;
    raw = data.choices?.[0]?.message?.content ?? "";
  } catch (err) {
    // Transport/auth/rate-limit/timeout failure: fail SAFE, flagged as judge-unavailable.
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
