/**
 * Deterministic pattern-layer proof (no API key). Pattern verdict maps to:
 * hostile|suspicious => BLOCK, safe => PASS. For injection detection, suspicious
 * is treated as "not cleared" (a real attack must not pass the pattern pre-filter).
 *
 *   npm run pattern
 */
import { scanPattern } from "./firewall.js";
import { CORPUS } from "../../internal/firewall-ref/corpus.js";

interface Row {
  id: string;
  kind: string;
  label: string;
  verdict: string;
  blocked: boolean;
  topHits: string;
}

const rows: Row[] = CORPUS.map((s) => {
  const { verdict, indicators } = scanPattern(s.text);
  const blocked = verdict !== "safe";
  const topHits = indicators.slice(0, 3).map((i) => `${i.id}[${i.severity}]`).join(", ") || "—";
  return { id: s.id, kind: s.kind, label: s.label, verdict, blocked, topHits };
});

const hostile = rows.filter((r) => r.label === "hostile");
const clean = rows.filter((r) => r.label === "clean");

const caught = hostile.filter((r) => r.blocked).length;
const missed = hostile.filter((r) => !r.blocked);
const fp = clean.filter((r) => r.blocked);
const cleanPass = clean.length - fp.length;

const pad = (s: string, n: number): string => s.padEnd(n);
console.log("\n=== WARD FIREWALL — PATTERN LAYER (deterministic) ===\n");
console.log(pad("ID", 5) + pad("LABEL", 9) + pad("VERDICT", 11) + pad("BLOCKED", 9) + "TOP SIGNATURES");
console.log("-".repeat(96));
for (const r of rows) {
  console.log(pad(r.id, 5) + pad(r.label, 9) + pad(r.verdict, 11) + pad(r.blocked ? "BLOCK" : "pass", 9) + r.topHits);
}

console.log("\n--- HOSTILE (recall) ---");
console.log(`caught ${caught}/${hostile.length} = ${((caught / hostile.length) * 100).toFixed(0)}% recall`);
if (missed.length) console.log("MISSED (false negatives): " + missed.map((r) => `${r.id} (${r.kind})`).join("; "));

console.log("\n--- CLEAN (precision / false positives) ---");
console.log(
  `cleared ${cleanPass}/${clean.length}; false positives ${fp.length}/${clean.length} = ${((fp.length / clean.length) * 100).toFixed(0)}% FP`,
);
if (fp.length) console.log("FALSE POSITIVES: " + fp.map((r) => `${r.id} (${r.kind}) -> ${r.topHits}`).join("; "));

const tp = caught;
const fn = missed.length;
const fpc = fp.length;
const precision = tp / (tp + fpc) || 0;
const recall = tp / (tp + fn) || 0;
const f1 = (2 * precision * recall) / (precision + recall) || 0;
console.log("\n--- pattern-layer scores (BLOCK = positive) ---");
console.log(`precision ${(precision * 100).toFixed(0)}%  recall ${(recall * 100).toFixed(0)}%  F1 ${(f1 * 100).toFixed(0)}%`);
console.log("\n(FPs here are the security reports that DESCRIBE malicious behavior —");
console.log(" exactly what the judge layer exists to clear back down to flag.)\n");
