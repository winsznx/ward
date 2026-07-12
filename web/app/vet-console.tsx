"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Finding {
  source_service: string;
  category: string;
  signal: string;
  severity: string;
  firewall: { safety: string; conformance: number };
  order_id: string;
  settled: boolean;
}
interface Verdict {
  target: string;
  verdict: "go" | "caution" | "no-go";
  confidence: number;
  sources_run: number;
  sources_quarantined: number;
  sources_failed: number;
  findings: Finding[];
  contradictions: unknown[];
  notes: string;
  evidence_hash: string;
}
type WardEvent =
  | { type: "state"; state: string; msg: string }
  | { type: "tx"; label: string; hash: string }
  | { type: "warn"; msg: string }
  | { type: "verdict"; verdict: Verdict }
  | { type: "done"; code: number }
  | { type: "error"; msg: string };

type Line = { kind: "state" | "tx" | "warn"; text: string; hash?: string };

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PIPELINE = ["NEGOTIATE", "PAY", "AWAIT_DELIVERY", "FIREWALL", "NORMALIZE", "VERDICT", "SETTLE"];

// The live console spawns the orchestrator (Ward-as-requester) over SSE — that needs Ward's key and
// its WebSocket, which the online provider holds (one WS per key). So the deployed site runs a REPLAY
// of a real, on-chain run instead; set NEXT_PUBLIC_WARD_LIVE=1 locally (with the provider stopped) for
// the genuinely-live console.
const LIVE = process.env.NEXT_PUBLIC_WARD_LIVE === "1";

// A real settled Ward→Attestr run on Base (see EVIDENCE.md) — replayed beat by beat on the deployed site.
const REPLAY: { at: number; ev: WardEvent }[] = [
  { at: 300, ev: { type: "state", state: "INTAKE", msg: "token-DD intake · USDC on base" } },
  { at: 900, ev: { type: "state", state: "PLAN", msg: "external-dominant fan-out · audit(external:1)" } },
  { at: 1500, ev: { type: "state", state: "NEGOTIATE", msg: "opening negotiation · Attestr Contract & Address Risk Check" } },
  { at: 2300, ev: { type: "tx", label: "createOrder", hash: "0xc0c6d9aad5153858a890955c29d982d053ecb8827dc243e8a43d89bbd8f931d0" } },
  { at: 3000, ev: { type: "state", state: "PAY", msg: "paying 0.01 USDC into escrow (nonce-serialized)" } },
  { at: 3700, ev: { type: "tx", label: "pay", hash: "0x26df63c0b146c618d8056c6930cf77e0c98c4152e3bc86b060b8f49bb60e61f2" } },
  { at: 4500, ev: { type: "state", state: "AWAIT_DELIVERY", msg: "awaiting Attestr deliverable (SLA)" } },
  { at: 5600, ev: { type: "tx", label: "deliver", hash: "0xaeb0cc9d03a876bcee51e3fe988843e341fa7b5ad661ca427de9414f0878cccd" } },
  { at: 6300, ev: { type: "state", state: "FIREWALL", msg: "screening deliverable — pattern + Groq judge" } },
  { at: 7200, ev: { type: "warn", msg: "firewall: safe — 'mint functions with no supply caps' read as descriptive of subject, cleared (not an injection)" } },
  { at: 7900, ev: { type: "state", state: "NORMALIZE", msg: "badge SAFE → riskScore 12/100" } },
  { at: 8600, ev: { type: "state", state: "COLLATE", msg: "anti-sybil: 1 external delivered · dominant" } },
  { at: 9300, ev: { type: "state", state: "VERDICT", msg: "composing §9 verdict" } },
  {
    at: 10100,
    ev: {
      type: "verdict",
      verdict: {
        target: USDC,
        verdict: "caution",
        confidence: 0.8,
        sources_run: 1,
        sources_quarantined: 0,
        sources_failed: 0,
        findings: [
          {
            source_service: "Attestr Contract & Address Risk Check",
            category: "audit",
            signal: "SAFE · riskScore 12/100 — verified source, no mint backdoor, owner renounced. Report notes historical mint functions with supply caps.",
            severity: "low",
            firewall: { safety: "safe", conformance: 1 },
            order_id: "5c4d4cf9-7b33-415d-a40c-49781b686290",
            settled: true,
          },
        ],
        contradictions: [],
        notes: "GO blocked: thin coverage (<2 corroborating external sources). One clean audit source — needs liquidity + sentiment corroboration for GO.",
        evidence_hash: "0x195dea738dc36101dfe53199e115e300b52d771d69f7d0f79f74bdc8dcc24614",
      },
    },
  },
  { at: 10600, ev: { type: "state", state: "SETTLE", msg: "settled — verdict + evidence emitted" } },
  { at: 11100, ev: { type: "done", code: 0 } },
];

const VERDICT_META: Record<Verdict["verdict"], { label: string; color: string; line: string }> = {
  go: { label: "GO", color: "text-go", line: "corroborated, clean, external-dominant" },
  caution: { label: "CAUTION", color: "text-caution", line: "thin coverage or contested — proceed carefully" },
  "no-go": { label: "NO-GO", color: "text-nogo", line: "hostile source or disqualifying findings" },
};

export function VetConsole() {
  const [target, setTarget] = useState(USDC);
  const [status, setStatus] = useState<"idle" | "running" | "done">("idle");
  const [lines, setLines] = useState<Line[]>([]);
  const [reached, setReached] = useState<Set<string>>(new Set());
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  const clearReplay = useCallback(() => {
    timersRef.current.forEach((t) => clearTimeout(t));
    timersRef.current = [];
  }, []);

  useEffect(
    () => () => {
      esRef.current?.close();
      timersRef.current.forEach((t) => clearTimeout(t));
    },
    [],
  );

  const dispatch = useCallback((ev: WardEvent) => {
    if (ev.type === "state") {
      setReached((r) => new Set(r).add(ev.state));
      setLines((l) => [...l, { kind: "state", text: `${ev.state}  ${ev.msg}` }]);
    } else if (ev.type === "tx") setLines((l) => [...l, { kind: "tx", text: ev.label, hash: ev.hash }]);
    else if (ev.type === "warn" || ev.type === "error") setLines((l) => [...l, { kind: "warn", text: "msg" in ev ? ev.msg : "" }]);
    else if (ev.type === "verdict") setVerdict(ev.verdict);
    else if (ev.type === "done") setStatus("done");
  }, []);

  const run = useCallback(() => {
    if (LIVE && !/^0x[0-9a-fA-F]{40}$/.test(target.trim())) {
      setStatus("running");
      setLines([{ kind: "warn", text: "enter a valid 0x… 40-hex address" }]);
      setStatus("done");
      return;
    }
    esRef.current?.close();
    clearReplay();
    setStatus("running");
    setLines([]);
    setReached(new Set());
    setVerdict(null);

    if (!LIVE) {
      for (const step of REPLAY) {
        timersRef.current.push(
          setTimeout(() => {
            dispatch(step.ev);
            if (step.ev.type === "done") esRef.current = null;
          }, step.at),
        );
      }
      return;
    }

    const es = new EventSource(`/api/vet?target=${encodeURIComponent(target.trim())}`);
    esRef.current = es;
    es.onmessage = (e) => {
      let ev: WardEvent;
      try {
        ev = JSON.parse(e.data) as WardEvent;
      } catch {
        return;
      }
      dispatch(ev);
      if (ev.type === "done") es.close();
    };
    es.onerror = () => {
      setStatus("done");
      es.close();
    };
  }, [target, dispatch, clearReplay]);

  const liveLabel = LIVE ? "running" : "replay · recorded";

  return (
    <div className="rounded-[8px] border border-ash bg-paper">
      {/* intake */}
      <div className="border-b border-ash p-6">
        <p className="eyebrow mb-3">Token / contract address</p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && status !== "running" && run()}
            spellCheck={false}
            placeholder="0x…"
            aria-label="token contract address"
            readOnly={!LIVE}
            className="min-w-0 flex-1 rounded-[3px] border border-ash bg-vellum px-3.5 py-3 font-mono text-[14px] tracking-[-0.067em] text-ink outline-none transition-colors focus:border-olive-char"
          />
          <button
            onClick={run}
            disabled={status === "running"}
            className="shrink-0 rounded-[3px] bg-carbon px-6 py-3 font-mono text-[14px] font-medium uppercase tracking-[0.02em] text-paper transition-opacity hover:opacity-90 disabled:opacity-45"
          >
            {status === "running" ? (LIVE ? "Vetting…" : "Replaying…") : LIVE ? "Vet it →" : "Replay a real vet →"}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {LIVE ? (
            <>
              <span className="eyebrow mr-1 !text-sage">try</span>
              {[
                { label: "USDC · safe", addr: USDC },
                { label: "WETH", addr: "0x4200000000000000000000000000000000000006" },
              ].map((ex) => (
                <button
                  key={ex.addr}
                  onClick={() => setTarget(ex.addr)}
                  className="rounded-[3px] border border-khaki bg-bone px-2.5 py-1 font-mono text-[12px] font-medium tracking-[-0.067em] text-lichen transition-colors hover:text-ink"
                >
                  {ex.label}
                </button>
              ))}
              <span className="ml-auto font-mono text-[12px] tracking-[-0.067em] text-sage">≈ $0.01 · settles on Base</span>
            </>
          ) : (
            <>
              <span className="rounded-[3px] border border-khaki bg-bone px-2.5 py-1 font-mono text-[12px] font-medium tracking-[-0.067em] text-lichen">
                recorded on-chain run · USDC
              </span>
              <a
                href="https://agent.croo.network/agents/4a7abd59-40d5-4c99-9ca3-ede49afae6e3"
                target="_blank"
                rel="noreferrer"
                className="ml-auto flex items-center gap-1.5 font-mono text-[12px] font-medium tracking-[-0.067em] text-ink hover:text-lichen"
              >
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-go" />
                run a real vet — Hire on CROO ↗
              </a>
            </>
          )}
        </div>
      </div>

      {status === "idle" ? (
        <div className="flex items-center gap-3 px-6 py-5">
          <span className="h-1.5 w-1.5 rounded-full bg-moss" />
          <p className="font-mono text-[13px] tracking-[-0.067em] text-lichen">
            Ward negotiates, pays, and firewalls a real order on-chain — the verdict lands when it settles.
          </p>
        </div>
      ) : (
        <div className="grid gap-px bg-ash lg:grid-cols-[1fr_minmax(0,380px)]">
          {/* live trace — dark terminal */}
          <div className="bg-carbon p-5">
            <div className="mb-3 flex items-center justify-between">
              <p className="font-mono text-[12px] font-medium uppercase tracking-[0.04em] text-sage">Ward · live fan-out</p>
              <span className="flex items-center gap-2 font-mono text-[12px] tracking-[-0.067em] text-moss">
                <span className={`inline-block h-2 w-2 rounded-full ${status === "running" ? "bg-highlighter blink" : "bg-moss"}`} />
                {status === "running" ? liveLabel : "settled"}
              </span>
            </div>
            {/* pipeline chips */}
            <div className="mb-4 flex flex-wrap gap-1.5">
              {PIPELINE.map((s) => {
                const hit = reached.has(s);
                return (
                  <span
                    key={s}
                    className={`rounded-[3px] px-1.5 py-0.5 font-mono text-[10px] tracking-[-0.02em] ${
                      hit ? "bg-highlighter text-ink" : "text-olive-char"
                    }`}
                  >
                    {s.replace("_", " ").toLowerCase()}
                  </span>
                );
              })}
            </div>
            <div ref={logRef} className="term-scroll max-h-[300px] overflow-y-auto font-mono text-[12.5px] leading-[1.65] tracking-[-0.067em]">
              {lines.map((l, i) => (
                <div key={i} className="flex gap-2">
                  <span className="select-none text-olive-char">›</span>
                  {l.kind === "tx" ? (
                    <a href={`https://basescan.org/tx/${l.hash}`} target="_blank" rel="noreferrer" className="text-highlighter hover:underline">
                      tx {l.text} ↗ <span className="text-moss">{l.hash?.slice(0, 16)}…</span>
                    </a>
                  ) : l.kind === "warn" ? (
                    <span className="text-khaki">{l.text}</span>
                  ) : (
                    <span className="text-ash">{l.text}</span>
                  )}
                </div>
              ))}
              {status === "running" && <span className="text-moss blink">▍</span>}
            </div>
          </div>

          {/* verdict */}
          <div className="bg-paper p-6">
            <p className="eyebrow mb-4">Verdict</p>
            {!verdict ? (
              <p className="font-mono text-[13px] leading-[1.6] tracking-[-0.067em] text-lichen">
                {status === "running"
                  ? "Hiring agents, firewalling deliverables, reconciling… lands when the order settles on Base."
                  : "No verdict — the run ended early. Check the trace."}
              </p>
            ) : (
              <VerdictView v={verdict} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function VerdictView({ v }: { v: Verdict }) {
  const meta = VERDICT_META[v.verdict];
  return (
    <div>
      <div className={`font-display text-[56px] leading-none ${meta.color}`}>{meta.label}</div>
      <div className="mt-2 h-[5px] w-20 bg-highlighter grow-x" />
      <p className="mt-3 font-mono text-[13px] leading-[1.5] tracking-[-0.067em] text-lichen">{meta.line}</p>

      <dl className="mt-5 grid grid-cols-2 gap-y-2.5 font-mono text-[13px] tracking-[-0.067em]">
        <Stat k="confidence" val={v.confidence.toFixed(2)} />
        <Stat k="sources run" val={String(v.sources_run)} />
        <Stat k="quarantined" val={String(v.sources_quarantined)} />
        <Stat k="failed" val={String(v.sources_failed)} />
      </dl>

      {v.findings.length > 0 && (
        <div className="mt-5 border-t border-ash pt-4">
          <p className="eyebrow mb-2">Findings</p>
          {v.findings.map((f, i) => (
            <div key={i} className="mb-2">
              <div className="flex items-center justify-between gap-2 font-mono text-[13px] tracking-[-0.067em]">
                <span className="truncate text-ink">{f.source_service}</span>
                <span className="shrink-0 rounded-[3px] border border-khaki bg-bone px-1.5 py-0.5 text-[11px] text-lichen">
                  firewall: {f.firewall.safety}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 font-mono text-[12px] leading-[1.5] tracking-[-0.067em] text-lichen">{f.signal}</p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-5 border-t border-ash pt-4">
        <p className="eyebrow mb-1">Notes</p>
        <p className="font-mono text-[12px] leading-[1.5] tracking-[-0.067em] text-lichen">{v.notes}</p>
      </div>
      <p className="mt-4 truncate font-mono text-[11px] tracking-[-0.067em] text-sage">evidence {v.evidence_hash}</p>
    </div>
  );
}

function Stat({ k, val }: { k: string; val: string }) {
  return (
    <div>
      <dt className="text-sage">{k}</dt>
      <dd className="text-ink">{val}</dd>
    </div>
  );
}
