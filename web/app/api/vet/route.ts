import { spawn } from "node:child_process";
import path from "node:path";

// Spawns the real Ward orchestrator (child_process) — Node runtime, always dynamic.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORCH_DIR = path.join(process.cwd(), "..", "orchestrator");
const TSX_BIN = path.join(ORCH_DIR, "node_modules", ".bin", "tsx");
const TARGET_RE = /^0x[0-9a-fA-F]{40}$/;

export async function GET(request: Request): Promise<Response> {
  const target = (new URL(request.url).searchParams.get("target") ?? "").trim();
  if (!TARGET_RE.test(target)) {
    return new Response(JSON.stringify({ error: "target must be a 0x… 40-hex address" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (obj: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true; // controller already closed by the client
        }
      };

      send({ type: "state", state: "START", msg: `vetting ${target}` });

      // The orchestrator loads orchestrator/.env; WARD_DD_TARGET passed here overrides it
      // (dotenv does not override an already-set process env var).
      const child = spawn(TSX_BIN, ["src/index.ts"], {
        cwd: ORCH_DIR,
        env: { ...process.env, WARD_DD_TARGET: target, NO_COLOR: "1", FORCE_COLOR: "0" },
      });

      let buf = "";
      let inVerdict = false;
      let vbuf = "";

      const handleLine = (line: string): void => {
        // The §9 verdict is pretty-printed JSON; its outer close is a column-0 "}".
        // (Brace-counting fails: a finding's `signal` is a JSON string with an unbalanced "{".)
        if (inVerdict) {
          if (line === "}") {
            inVerdict = false;
            try {
              send({ type: "verdict", verdict: JSON.parse(vbuf + "}") });
            } catch {
              /* incomplete / not JSON — ignore */
            }
            vbuf = "";
          } else {
            vbuf += line + "\n";
          }
          return;
        }
        if (line.includes("VERDICT OBJECT")) {
          inVerdict = true;
          vbuf = "";
          return;
        }
        let m = line.match(/\btx\s+(\S+)\s+(0x[0-9a-fA-F]{64})/);
        if (m) {
          send({ type: "tx", label: m[1], hash: m[2] });
          return;
        }
        m = line.match(/\]\s+→\s+([A-Z_]+)\s+(.+?)(?:\s{2,}\S+=.*)?$/);
        if (m) {
          send({ type: "state", state: m[1], msg: m[2].trim() });
          return;
        }
        m = line.match(/\bWARN\b\s+(.+)$/);
        if (m) {
          send({ type: "warn", msg: m[1].replace(/\s{2,}\S+=.*$/, "").trim() });
        }
      };

      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const l = buf.slice(0, i);
          buf = buf.slice(i + 1);
          handleLine(l);
        }
      });
      child.stderr.on("data", (d: Buffer) => send({ type: "warn", msg: String(d).slice(0, 200) }));
      child.on("close", (code) => {
        if (buf) handleLine(buf);
        send({ type: "done", code });
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      child.on("error", (err: Error) => {
        send({ type: "error", msg: err.message });
        send({ type: "done", code: 1 });
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });

      request.signal.addEventListener("abort", () => {
        closed = true;
        child.kill("SIGTERM");
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
