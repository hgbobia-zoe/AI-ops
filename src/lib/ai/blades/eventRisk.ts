// AI Control Plane: Event Risk blade playbook ("Event Risk Review"). Same pattern as the Sales OS runner:
// open a real session, read the live risk queue the deterministic Risk Engine already scored, rank what
// needs attention in the coming days, record every step on the timeline, and leave a recommendation. It
// changes nothing: risks are acknowledged or resolved by a person on /risk. The session stays open so the
// operator can ask Viktor follow-ups in it. RULES CALCULATE, AI INTERPRETS.

import { getRiskQueue, type StoredRisk } from "@/lib/risk/store";
import { SEVERITY_RANK } from "@/lib/risk/types";
import { todayInOpsTz } from "@/lib/dates";
import { getEmployee } from "@/lib/aiorg/registry";
import { createSession, recordToolRun, appendEvent, setSessionResult, type AiSession } from "@/lib/ai/sessions";

const ACTIVE = new Set(["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"]);

export interface RiskReview {
  horizonDays: number;
  total: number; // active risks in the horizon
  bySeverity: Record<"CRITICAL" | "HIGH" | "MEDIUM" | "LOW", number>;
  unowned: number; // active and still OPEN (nobody has picked it up)
  top: { id: string; severity: string; title: string; date: string | null; recommendedAction: string | null; status: string }[];
}

function daysUntil(today: string, ymd: string): number {
  return Math.round((Date.parse(`${ymd}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** Rank active risks dated within the horizon (undated risks count: they are current). Severity first,
 *  then soonest. PURE given `today`. */
export function reviewRisks(risks: StoredRisk[], today: string, horizonDays = 7, topN = 5): RiskReview {
  const inScope = risks.filter((r) => {
    if (!ACTIVE.has(r.status)) return false;
    if (!r.date) return true;
    const d = daysUntil(today, r.date);
    return Number.isFinite(d) && d >= 0 && d <= horizonDays;
  });
  inScope.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (a.date ?? "9999").localeCompare(b.date ?? "9999"));
  const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const r of inScope) bySeverity[r.severity]++;
  return {
    horizonDays,
    total: inScope.length,
    bySeverity,
    unowned: inScope.filter((r) => r.status === "OPEN").length,
    top: inScope.slice(0, topN).map((r) => ({ id: r.id, severity: r.severity, title: r.title, date: r.date ?? null, recommendedAction: r.recommendedAction ?? null, status: r.status })),
  };
}

/** One plain sentence for the recommendation. PURE. */
export function riskRecommendation(rv: RiskReview): string {
  if (rv.total === 0) return `No active risks for the next ${rv.horizonDays} days.`;
  const lead = rv.top[0];
  const sev = [rv.bySeverity.CRITICAL && `${rv.bySeverity.CRITICAL} critical`, rv.bySeverity.HIGH && `${rv.bySeverity.HIGH} high`].filter(Boolean).join(", ");
  const head = `${rv.total} active risk${rv.total === 1 ? "" : "s"} in the next ${rv.horizonDays} days${sev ? ` (${sev})` : ""}, ${rv.unowned} not yet picked up.`;
  const first = `Start with: ${lead.title}${lead.date ? ` on ${lead.date}` : ""}${lead.recommendedAction ? `. Suggested: ${lead.recommendedAction}` : ""}.`;
  return `${head} ${first}`;
}

export function runEventRiskReview(opts: { actor?: string; horizonDays?: number } = {}): AiSession {
  const horizonDays = opts.horizonDays ?? 7;
  const today = todayInOpsTz();
  const session = createSession({
    agentId: "event-risk",
    blade: "event-risk",
    owner: getEmployee("event-risk")?.owner,
    startedBy: opts.actor,
    title: "Event Risk Review",
    objective: `Find the risks that need a person in the next ${horizonDays} days and say where to start.`,
    provider: "viktor-agent",
  });
  const sid = session.id;

  let risks: StoredRisk[] = [];
  try {
    risks = getRiskQueue(today);
    recordToolRun(sid, { toolId: "read_risk_queue", category: "DATA", perm: "READ", status: "ok", result: { count: risks.length } });
  } catch (e) {
    recordToolRun(sid, { toolId: "read_risk_queue", category: "DATA", perm: "READ", status: "error", error: String(e).slice(0, 200) });
    appendEvent(sid, { kind: "error", label: "Could not read the risk queue." });
    return session;
  }
  appendEvent(sid, { kind: "step", label: `Read ${risks.length} risks from the Event Risk Engine queue.` });

  const rv = reviewRisks(risks, today, horizonDays);
  recordToolRun(sid, { toolId: "rank_risks", category: "ANALYSIS", perm: "ANALYZE", status: "ok", result: { inScope: rv.total } });
  appendEvent(sid, { kind: "step", label: `Ranked ${rv.total} active risks in the next ${horizonDays} days by severity, then date.` });

  appendEvent(sid, { kind: "recommendation", label: riskRecommendation(rv), payload: { top: rv.top } });
  setSessionResult(sid, { ...rv });
  if (rv.total > 0) {
    appendEvent(sid, {
      kind: "action_available",
      label: "Acknowledge or resolve these on the Risk page. Ask Viktor here to draft a client or crew message for any of them; it will come back as an approval.",
    });
  }
  return session;
}
