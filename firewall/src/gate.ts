/**
 * Ward — Firewall gate: the orchestrator's FIREWALL stage (PRD §6).
 *
 * Sits between AWAIT_DELIVERY and NORMALIZE. Every supplier deliverable is
 * screened here BEFORE it can enter a verdict:
 *   - quarantine -> the finding is DROPPED (never ingested) and the supplier is
 *                   flagged hostile; surfaced as "N sources attempted injection".
 *   - flag       -> ingested as a CONTESTED finding, down-weighted and surfaced.
 *   - pass       -> ingested at full weight.
 *
 * Emits the §9 verdict fields the collator/composer needs (sources_run,
 * sources_quarantined, notes). Invariant (§6): a quarantine/contradiction is
 * never silently swallowed — it is shown on the face of the verdict.
 */
import { scan, type Action, type Indicator, type JudgeFn, type Verdict } from "./firewall.js";

export interface SupplierDeliverable {
  /** supplier label / agentId — used for hostile-flagging */
  source: string;
  service?: string;
  orderId?: string;
  /** §9 Finding.category */
  category?: string;
  /** the raw deliverable text to screen */
  text: string;
}

export interface AdmittedFinding {
  source: string;
  service: string | undefined;
  orderId: string | undefined;
  category: string | undefined;
  text: string;
  /** §9 Finding.firewall.safety */
  safety: Verdict;
  action: Extract<Action, "pass" | "flag">;
  /** flagged findings are contested: ingested but down-weighted and surfaced */
  contested: boolean;
  /** ingest weight — 1.0 for a clean pass, FLAG_WEIGHT for a contested flag */
  weight: number;
  indicators: Indicator[];
  judgeRationale: string | null;
}

export interface QuarantinedSource {
  source: string;
  orderId: string | undefined;
  verdict: Verdict;
  indicators: Indicator[];
  judgeRationale: string | null;
}

export interface FirewallScreenResult {
  /** what NORMALIZE/COLLATE ingests (passes + contested flags) */
  admitted: AdmittedFinding[];
  /** dropped, never ingested */
  quarantined: QuarantinedSource[];
  /** deduped supplier labels flagged hostile */
  hostileSuppliers: string[];
  sourcesRun: number;
  sourcesQuarantined: number;
  /** §9 verdict.notes lines */
  notes: string[];
}

/** Contested findings are ingested but heavily down-weighted in collation. */
export const FLAG_WEIGHT = 0.35;

export class FirewallGate {
  private readonly judge: JudgeFn | undefined;

  constructor(judge?: JudgeFn) {
    this.judge = judge;
  }

  async screen(deliverables: SupplierDeliverable[], request: string): Promise<FirewallScreenResult> {
    const scans = await Promise.all(
      deliverables.map(async (d) => ({ d, r: await scan(d.text, { request, source: d.source }, this.judge) })),
    );

    const admitted: AdmittedFinding[] = [];
    const quarantined: QuarantinedSource[] = [];
    const hostile = new Set<string>();

    for (const { d, r } of scans) {
      if (r.action === "quarantine") {
        hostile.add(d.source);
        quarantined.push({
          source: d.source,
          orderId: d.orderId,
          verdict: r.verdict,
          indicators: r.indicators,
          judgeRationale: r.judgeRationale,
        });
        continue; // NEVER ingest a quarantined deliverable
      }
      const contested = r.action === "flag";
      admitted.push({
        source: d.source,
        service: d.service,
        orderId: d.orderId,
        category: d.category,
        text: d.text,
        safety: r.verdict,
        action: r.action,
        contested,
        weight: contested ? FLAG_WEIGHT : 1,
        indicators: r.indicators,
        judgeRationale: r.judgeRationale,
      });
    }

    const notes: string[] = [];
    if (quarantined.length > 0) {
      notes.push(`${quarantined.length} source${quarantined.length === 1 ? "" : "s"} attempted injection, quarantined`);
    }
    const contestedCount = admitted.filter((a) => a.contested).length;
    if (contestedCount > 0) {
      notes.push(
        `${contestedCount} finding${contestedCount === 1 ? "" : "s"} flagged contested (down-weighted, surfaced)`,
      );
    }

    return {
      admitted,
      quarantined,
      hostileSuppliers: [...hostile],
      sourcesRun: deliverables.length,
      sourcesQuarantined: quarantined.length,
      notes,
    };
  }
}
