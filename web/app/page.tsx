"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// --- §9 verdict shape (from the orchestrator) ---
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

type StepEvent = { type: "state"; state: string; msg: string };
type TxEvent = { type: "tx"; label: string; hash: string };
type WarnEvent = { type: "warn"; msg: string };
type VerdictEvent = { type: "verdict"; verdict: Verdict };
type DoneEvent = { type: "done"; code: number };
type ErrEvent = { type: "error"; msg: string };
type WardEvent = StepEvent | TxEvent | WarnEvent | VerdictEvent | DoneEvent | ErrEvent;

type Line = { kind: "state" | "tx" | "warn"; text: string; hash?: string };

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const VERDICT_META: Record<Verdict["verdict"], { label: string; color: string; line: string }> = {
  go: { label: "GO", color: "text-go", line: "corroborated, clean, external-dominant" },
  caution: { label: "CAUTION", color: "text-caution", line: "thin coverage or contested signals — proceed carefully" },
  "no-go": { label: "NO-GO", color: "text-nogo", line: "hostile source or disqualifying findings" },
};

export default function Home() {
  const [target, setTarget] = useState(USDC);
  const [status, setStatus] = useState<"idle" | "running" | "done">("idle");
  const [lines, setLines] = useState<Line[]>([]);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  useEffect(() => () => esRef.current?.close(), []);

  const run = useCallback(() => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(target.trim())) {
      setLines([{ kind: "warn", text: "enter a valid 0x… 40-hex address" }]);
      return;
    }
    esRef.current?.close();
    setStatus("running");
    setLines([]);
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
      if (ev.type === "state") setLines((l) => [...l, { kind: "state", text: `${ev.state}  ${ev.msg}` }]);
      else if (ev.type === "tx") setLines((l) => [...l, { kind: "tx", text: ev.label, hash: ev.hash }]);
      else if (ev.type === "warn") setLines((l) => [...l, { kind: "warn", text: ev.msg }]);
      else if (ev.type === "error") setLines((l) => [...l, { kind: "warn", text: ev.msg }]);
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
    <main className="min-h-screen bg-vellum text-ink">
      {/* nav */}
      <nav className="border-b border-ash">
        <div className="mx-auto flex h-14 max-w-[1200px] items-center justify-between px-6">
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-[15px] font-medium tracking-[-0.067em]">WARD</span>
            <span className="eyebrow hidden sm:inline">the trust layer for agent commerce</span>
          </div>
          <a
            href="https://github.com/winsznx/ward"
            className="font-mono text-[13px] font-medium tracking-[-0.067em] text-sage hover:text-ink"
          >
            GITHUB ↗
          </a>
        </div>
      </nav>

      <div className="mx-auto max-w-[1200px] px-6">
        {/* hero */}
        <section className="pt-24 pb-14 text-center">
          <p className="eyebrow">WARD / DUE DILIGENCE FOR AGENT COMMERCE</p>
          <h1 className="font-display mx-auto mt-5 max-w-[900px] text-[clamp(48px,8vw,88px)]">
            Should you ape it?
          </h1>
          <div className="mx-auto mt-6 flex w-16 justify-center">
            <span className="accent-bar w-16" />
          </div>
          <p className="mx-auto mt-6 max-w-[560px] font-mono text-[14px] leading-[1.5] tracking-[-0.067em] text-lichen">
            Paste a token. Ward hires specialist agents on CROO, runs every deliverable through a
            security + quality firewall, and returns one <span className="text-ink">go / caution / no-go</span>{" "}
            verdict — with real on-chain evidence.
          </p>
        </section>

        {/* intake */}
        <section className="mx-auto max-w-[720px] pb-6">
          <div className="rounded-[8px] border border-ash bg-paper p-6">
            <p className="eyebrow mb-3">TOKEN / CONTRACT ADDRESS</p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && status !== "running" && run()}
                spellCheck={false}
                placeholder="0x…"
                className="min-w-0 flex-1 rounded-[3px] border border-ash bg-vellum px-3 py-2.5 font-mono text-[14px] tracking-[-0.067em] text-ink outline-none focus:border-olive-char"
              />
              <button
                onClick={run}
                disabled={status === "running"}
                className="shrink-0 rounded-[3px] bg-carbon px-5 py-2.5 font-mono text-[14px] font-medium uppercase tracking-[-0.067em] text-paper transition-opacity disabled:opacity-50"
              >
                {status === "running" ? "Vetting…" : "Vet it →"}
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {[
                { label: "USDC (safe)", addr: USDC },
                { label: "WETH", addr: "0x4200000000000000000000000000000000000006" },
              ].map((ex) => (
                <button
                  key={ex.addr}
                  onClick={() => setTarget(ex.addr)}
                  className="rounded-[3px] border border-khaki bg-bone px-2 py-1 font-mono text-[12px] font-medium tracking-[-0.067em] text-lichen hover:text-ink"
                >
                  {ex.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* process + verdict */}
        {status !== "idle" && (
          <section className="grid gap-6 pb-20 lg:grid-cols-[1fr_minmax(0,420px)]">
            {/* live trace — dark terminal panel */}
            <div className="rounded-[8px] border border-olive-char bg-carbon p-5">
              <div className="mb-3 flex items-center justify-between">
                <p className="font-mono text-[12px] font-medium uppercase tracking-[-0.067em] text-sage">
                  Ward · live fan-out
                </p>
                <span className="flex items-center gap-2 font-mono text-[12px] tracking-[-0.067em] text-moss">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      status === "running" ? "bg-highlighter blink" : "bg-moss"
                    }`}
                  />
                  {status === "running" ? "running" : "settled"}
                </span>
              </div>
              <div ref={logRef} className="max-h-[420px] overflow-y-auto font-mono text-[13px] leading-[1.6] tracking-[-0.067em]">
                {lines.map((l, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="select-none text-olive-char">›</span>
                    {l.kind === "tx" ? (
                      <a
                        href={`https://basescan.org/tx/${l.hash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-highlighter hover:underline"
                      >
                        tx {l.text} ↗ <span className="text-moss">{l.hash?.slice(0, 14)}…</span>
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

            {/* verdict card */}
            <div className="rounded-[8px] border border-ash bg-paper p-6">
              <p className="eyebrow mb-4">VERDICT</p>
              {!verdict ? (
                <p className="font-mono text-[13px] leading-[1.6] tracking-[-0.067em] text-lichen">
                  {status === "running"
                    ? "Hiring agents, firewalling deliverables, reconciling… the verdict lands when the order settles on Base."
                    : "No verdict — the run ended early. Check the trace."}
                </p>
              ) : (
                <VerdictView v={verdict} />
              )}
            </div>
          </section>
        )}
      </div>

      <footer className="mt-10 bg-carbon">
        <div className="mx-auto max-w-[1200px] px-6 py-14">
          <p className="font-mono text-[14px] font-medium tracking-[-0.067em] text-paper">WARD</p>
          <p className="mt-2 max-w-[520px] font-mono text-[13px] leading-[1.6] tracking-[-0.067em] text-sage">
            CROO lets agents hire agents. Ward makes it safe to — a firewall + orchestration layer that
            fires on every deliverable before it can touch a verdict. Base mainnet · USDC · MIT.
          </p>
        </div>
      </footer>
    </main>
  );
}

function VerdictView({ v }: { v: Verdict }) {
  const meta = VERDICT_META[v.verdict];
  return (
    <div>
      <div className={`font-display text-[64px] leading-none ${meta.color}`}>{meta.label}</div>
      <div className="mt-2 h-[5px] w-24 bg-highlighter" />
      <p className="mt-3 font-mono text-[13px] leading-[1.5] tracking-[-0.067em] text-lichen">{meta.line}</p>

      <dl className="mt-5 grid grid-cols-2 gap-y-2 font-mono text-[13px] tracking-[-0.067em]">
        <Stat k="confidence" val={v.confidence.toFixed(2)} />
        <Stat k="sources run" val={String(v.sources_run)} />
        <Stat k="quarantined" val={String(v.sources_quarantined)} />
        <Stat k="failed" val={String(v.sources_failed)} />
      </dl>

      {v.findings.length > 0 && (
        <div className="mt-5 border-t border-ash pt-4">
          <p className="eyebrow mb-2">FINDINGS</p>
          {v.findings.map((f, i) => (
            <div key={i} className="mb-2">
              <div className="flex items-center justify-between font-mono text-[13px] tracking-[-0.067em]">
                <span className="text-ink">{f.source_service}</span>
                <span className="rounded-[3px] border border-khaki bg-bone px-1.5 py-0.5 text-[11px] text-lichen">
                  firewall: {f.firewall.safety}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 font-mono text-[12px] leading-[1.5] tracking-[-0.067em] text-lichen">
                {f.signal}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-5 border-t border-ash pt-4">
        <p className="eyebrow mb-1">NOTES</p>
        <p className="font-mono text-[12px] leading-[1.5] tracking-[-0.067em] text-lichen">{v.notes}</p>
      </div>

      <p className="mt-4 truncate font-mono text-[11px] tracking-[-0.067em] text-sage">
        evidence {v.evidence_hash}
      </p>
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
