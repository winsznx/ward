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
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [lines]);
  useEffect(() => () => esRef.current?.close(), []);

  const run = useCallback(() => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(target.trim())) {
      setStatus("running");
      setLines([{ kind: "warn", text: "enter a valid 0x… 40-hex address" }]);
      setStatus("done");
      return;
    }
    esRef.current?.close();
    setStatus("running");
    setLines([]);
    setReached(new Set());
    setVerdict(null);

    const es = new EventSource(`/api/vet?target=${encodeURIComponent(target.trim())}`);
    esRef.current = es;
    es.onmessage = (e) => {
      let ev: WardEvent;
      try {
        ev = JSON.parse(e.data) as WardEvent;
      } catch {
        return;
      }
      if (ev.type === "state") {
        setReached((r) => new Set(r).add(ev.state));
        setLines((l) => [...l, { kind: "state", text: `${ev.state}  ${ev.msg}` }]);
      } else if (ev.type === "tx") setLines((l) => [...l, { kind: "tx", text: ev.label, hash: ev.hash }]);
      else if (ev.type === "warn" || ev.type === "error")
        setLines((l) => [...l, { kind: "warn", text: "msg" in ev ? ev.msg : "" }]);
      else if (ev.type === "verdict") setVerdict(ev.verdict);
      else if (ev.type === "done") {
        setStatus("done");
        es.close();
      }
    };
    es.onerror = () => {
      setStatus("done");
      es.close();
    };
  }, [target]);

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
            className="min-w-0 flex-1 rounded-[3px] border border-ash bg-vellum px-3.5 py-3 font-mono text-[14px] tracking-[-0.067em] text-ink outline-none transition-colors focus:border-olive-char"
          />
          <button
            onClick={run}
            disabled={status === "running"}
            className="shrink-0 rounded-[3px] bg-carbon px-6 py-3 font-mono text-[14px] font-medium uppercase tracking-[0.02em] text-paper transition-opacity hover:opacity-90 disabled:opacity-45"
          >
            {status === "running" ? "Vetting…" : "Vet it →"}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
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
                {status === "running" ? "running" : "settled"}
              </span>
            </div>
            {/* pipeline chips */}
            <div className="mb-4 flex flex-wrap gap-1.5">
              {PIPELINE.map((s) => {
                const hit = reached.has(s) || (s === "AWAIT_DELIVERY" && reached.has("AWAIT_DELIVERY"));
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
