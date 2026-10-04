// AI Org — the deterministic aggregator (mirrors command/service.ts `commandCenter`). It derives each
// AI employee's REAL status / metrics / last-run / recent activity by composing the EXISTING module
// reads — it never duplicates a module and never fabricates. A value a module can't resolve is left
// null (the UI shows "—"); a "coming" employee shows no metrics at all (enforced in buildEmployeeView).
//
// This is read-only + draft-only (v1). No send/execute/auto-apply path is wired here. Per-owner
// approval routing is a later change — the per-human cards are DISPLAY only.

import { todayInOpsTz } from "@/lib/dates";
import {
  AI_EMPLOYEES,
  HUMANS,
  agentIdsForBlade,
  getEmployee,
} from "./registry";
import {
  buildEmployeeView,
  pickKeySignal,
  priorityLabel,
  rollupHumans,
  type AiEmployeeView,
  type AiMetric,
  type BladeKey,
  type EmployeeSignal,
  type HumanCard,
} from "./types";

// Real module reads (every one already ships; AI Org only composes them).
import { salesLeads } from "@/lib/salesos/service";
import { lostQuotesOverview } from "@/lib/salesos/lostService";
import { opsOverview } from "@/lib/ops/service";
import { getRiskQueue } from "@/lib/risk/store";
import { getActiveVehicles } from "@/lib/vehicles";
import { getRoutesForDate, getOpenExceptions, getUpcomingItemStops } from "@/lib/db/repo";
import { listCoachableCalls, countUnanalyzedCoachableCalls } from "@/lib/db/repo";
import { peakItemDemand } from "@/lib/inventory/inventory";
import { computeConnections, summarize as summarizeConns, type Connection } from "@/lib/health/connections";
import { opportunityBoard } from "@/lib/opportunity/service";
import { marketingDashboard } from "@/lib/marketing/dashboard";
import { getShiftsForDate } from "@/lib/scheduling/store";
import { shiftGap } from "@/lib/scheduling/types";
import { recentSalesActivity } from "@/lib/salesos/audit";
import { runtimeStatus, type JobStatus } from "@/lib/runtime/jobs";
import { countPendingByAgent } from "./approvals";

// ── Public shapes ─────────────────────────────────────────────────────────────
export interface ActivityEntry {
  actor: string;
  label: string;
  ts: string;
  href: string | null;
}

export interface ExceptionEntry {
  key: string;
  pLabel: "P0" | "P1" | "P2" | "P3";
  priority: "critical" | "high" | "medium" | "info";
  title: string;
  detail: string;
  href: string;
  source: string;
}

export interface Outcome {
  label: string;
  value: string;
  source: string;
}

export interface AiOrgOverview {
  today: string;
  humans: HumanCard[];
  employees: AiEmployeeView[];
  activeWork: ActivityEntry[];
  exceptions: ExceptionEntry[];
  outcomes: Outcome[];
  counts: { live: number; seed: number; partial: number; coming: number };
  /** Honest run freshness for the Runs page (real runtime-jobs ledger). */
  runs: JobStatus[];
  /** Still-pending approvals per agent id (real; from the ai_approvals queue). */
  pendingByAgent: Record<string, number>;
  /** Open exceptions attributed to each agent id (real; the ranked attention feed routed by source). */
  exceptionsByAgent: Record<string, number>;
}

// Which agent owns each ranked-exception source (deterministic routing of the EXISTING attention feed —
// not a new signal). The Priority/Exception agent is the aggregate filter, so it carries the whole feed;
// Dispatch/Route carries the real driver field-exception count.
const EXCEPTION_OWNER_BY_SOURCE: Record<string, string> = {
  risk: "event-risk",
  sales: "lead-intelligence",
  finance: "business-intelligence",
  customer: "sales-coach",
};

const money = (n: number | null | undefined): string => (n == null ? "—" : (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US"));

/** Health lookup for an employee's declared data source, mapped from computeConnections(). */
function healthFor(conns: Connection[], key?: string): EmployeeSignal["health"] {
  if (!key) return null;
  const c = conns.find((x) => x.key === key);
  if (!c) return null;
  return { status: c.status, label: c.headline };
}

/** Build the AI Org overview. `showMoney` redacts $-bearing metrics for roles that can't see financials.
 *  Every read is guarded so one dead source degrades a single employee honestly, never the whole page. */
export async function aiOrg(opts: { showMoney?: boolean } = {}): Promise<AiOrgOverview> {
  const today = todayInOpsTz();
  const showMoney = opts.showMoney ?? false;

  const conns = computeConnections();

  // Shared, slightly heavier reads — resolved once and shared across the employees that need them.
  const ops = await safe(() => opsOverview(), null);

  // Per-employee signals, each wrapped so a failing read yields an honest "—" (null metrics), not a crash.
  const signals: Record<string, EmployeeSignal> = {};

  // ── Jessie — Sales ──
  const leads = safeSync(() => salesLeads(), null);
  if (leads) {
    signals["lead-intelligence"] = { metrics: [m("Open leads", leads.totalOpen), m("Act now", leads.actNowCount, leads.actNowCount ? "attention" : "default")], active: leads.totalOpen > 0, health: healthFor(conns, "bookings") };
    const openQuotes = leads.counts.awaiting + leads.counts.follow_up;
    signals["quote-analyst"] = { metrics: [m("Open quotes", openQuotes), m("Unsent", leads.counts.unsent, leads.counts.unsent ? "attention" : "default")], active: openQuotes + leads.counts.unsent > 0, health: healthFor(conns, "bookings") };
    signals["outreach"] = { metrics: [m("Draftable now", leads.actNowCount, leads.actNowCount ? "attention" : "default"), m("Comms", leads.hasCommsIntegration ? "wired" : "off", leads.hasCommsIntegration ? "positive" : "default")], active: leads.actNowCount > 0, health: healthFor(conns, "openphone") };
  }
  const lost = safeSync(() => lostQuotesOverview(), null);
  if (lost) {
    const wr = lost.stats.winRate;
    signals["lost-quote"] = { metrics: [m("Lost", lost.stats.lost), m("Win rate", wr == null ? "—" : `${Math.round(wr * 100)}%`), m("Untagged", lost.reasons.untaggedCount, lost.reasons.untaggedCount ? "attention" : "default")], active: lost.stats.lost > 0 };
  }
  const coachable = safeSync(() => listCoachableCalls(500), null);
  const unanalyzed = safeSync(() => countUnanalyzedCoachableCalls(), null);
  signals["sales-coach"] = {
    metrics: coachable == null ? null : [m("Calls w/ transcript", coachable.length), m("Backlog", unanalyzed ?? 0, (unanalyzed ?? 0) > 0 ? "attention" : "default")],
    active: (coachable?.length ?? 0) > 0,
    health: healthFor(conns, "openphone"),
  };

  // ── Lisa — Back Office ──
  const shifts = safeSync(() => getShiftsForDate(today), null);
  if (shifts) {
    const active = shifts.filter((s) => s.status !== "cancelled");
    const seatsOpen = active.reduce((n, s) => n + shiftGap(s), 0);
    const unpublished = active.filter((s) => s.assignees.length > 0 && !s.connecteamShiftId).length;
    signals["staffing"] = { metrics: [m("Shifts today", active.length), m("Seats open", seatsOpen, seatsOpen ? "attention" : "default")], active: active.length > 0, health: healthFor(conns, "connecteam") };
    signals["scheduling"] = { metrics: [m("Shifts today", active.length), m("Unpublished", unpublished, unpublished ? "attention" : "default")], active: active.length > 0, health: healthFor(conns, "connecteam") };
  }
  const connSummary = summarizeConns(conns);
  signals["back-office"] = {
    metrics: [m("OK", connSummary.ok, "positive"), m("Attention", connSummary.attention, connSummary.attention ? "attention" : "default"), m("Off", connSummary.off)],
    active: connSummary.attention > 0 || connSummary.off > 0,
  };

  // ── Princess — Marketing ──
  const board = safeSync(() => opportunityBoard(today), null);
  if (board) {
    signals["event-radar"] = { metrics: [m("Opportunities", board.metrics.discovered), m("Qualified", board.metrics.qualified), m("Entering outreach", board.metrics.enteringOutreach)], active: board.metrics.discovered > 0 };
  }
  const mkt = safeSync(() => marketingDashboard(today), null);
  if (mkt) {
    signals["content"] = { metrics: [m("Overdue", mkt.content.overdue.length, mkt.content.overdue.length ? "attention" : "default"), m("Upcoming", mkt.content.upcoming.length)], active: mkt.content.overdue.length + mkt.content.upcoming.length > 0 };
    signals["campaign-analyst"] = { metrics: [m("Live", mkt.campaigns.byStatus.live ?? 0), m("Total", mkt.campaigns.total)], active: mkt.campaigns.total > 0 };
  }

  // ── Hermann + Cindy — Ops / Exec ──
  if (ops) {
    const s = ops.summary;
    signals["executive-briefing"] = { metrics: [m("Needs attention", s.total), m("Critical/High", s.critical + s.high, s.critical + s.high ? "attention" : "default")], lastDetail: ops.brief, active: s.total > 0 };
    signals["priority-exception"] = { metrics: [m("P0", s.critical, s.critical ? "critical" : "default"), m("P1", s.high, s.high ? "attention" : "default"), m("Total", s.total)], lastDetail: ops.brief, active: s.critical + s.high > 0 };
    // Business Intelligence — $-gated; labor-verified always honest.
    const fin = ops.finance;
    const biMetrics: AiMetric[] = [m("Labor", ops.laborVerified ? "verified" : "unverified", ops.laborVerified ? "positive" : "attention")];
    if (showMoney && fin) {
      biMetrics.unshift(m("Signed (wk)", money(fin.revenue.signed)));
      biMetrics.push(m("Contribution", fin.contribution.value == null ? "Unavailable" : money(fin.contribution.value)));
    }
    signals["business-intelligence"] = { metrics: biMetrics, active: true, health: healthFor(conns, "connecteam") };
  }
  const risks = safeSync(() => getRiskQueue(today), null);
  if (risks) {
    const crit = risks.filter((r) => r.severity === "CRITICAL").length;
    const high = risks.filter((r) => r.severity === "HIGH").length;
    signals["event-risk"] = { metrics: [m("Critical", crit, crit ? "critical" : "default"), m("High", high, high ? "attention" : "default"), m("Open", risks.length)], active: risks.length > 0 };
  }
  const dispatch = safeSync(() => {
    const routes = getActiveVehicles().flatMap((t) => getRoutesForDate(t.truckId, today));
    const exceptions = getOpenExceptions().length;
    return { routes: routes.length, exceptions };
  }, null);
  if (dispatch) {
    signals["dispatch-route"] = { metrics: [m("Routes today", dispatch.routes), m("Exceptions", dispatch.exceptions, dispatch.exceptions ? "attention" : "default")], active: dispatch.routes > 0 || dispatch.exceptions > 0, health: healthFor(conns, "routes") };
  }
  const itemPeaks = safeSync(() => peakItemDemand(getUpcomingItemStops(today)), null);
  if (itemPeaks) {
    const topPeak = itemPeaks.reduce((mx, p) => Math.max(mx, p.peakQty), 0);
    signals["inventory-exception"] = { metrics: [m("Items tracked", itemPeaks.length), m("Top concurrent", topPeak)], active: itemPeaks.length > 0 };
  }

  // Build the derived views (coming employees get no metrics, enforced in buildEmployeeView).
  const employees = AI_EMPLOYEES.map((e) => buildEmployeeView(e, signals[e.id] ?? {}));

  // Recent AI / audit activity (sales audit is the live, attributed trail today).
  const activity = safeSync(() => recentSalesActivity(40), []) ?? [];
  const activeWork: ActivityEntry[] = activity.map((a) => ({
    actor: a.actor,
    label: a.actionLabel,
    ts: a.ts,
    href: a.leadId ? `/salesos/${a.leadId}` : null,
  }));
  const todaysActivity = activity.filter((a) => (a.ts ?? "").slice(0, 10) === today).length;

  // Exceptions — the ranked attention feed, P-labeled over the existing critical/high/medium/info scale.
  const exceptions: ExceptionEntry[] = (ops?.items ?? []).map((i) => ({
    key: i.key,
    pLabel: priorityLabel(i.priority),
    priority: i.priority,
    title: i.title,
    detail: i.detail,
    href: i.href,
    source: i.source,
  }));

  // Attribute the ranked exception feed to its owning agent (deterministic routing of real items).
  const exceptionsByAgent: Record<string, number> = {};
  for (const x of exceptions) {
    const owner = EXCEPTION_OWNER_BY_SOURCE[x.source];
    if (owner) exceptionsByAgent[owner] = (exceptionsByAgent[owner] ?? 0) + 1;
  }
  if (exceptions.length) exceptionsByAgent["priority-exception"] = exceptions.length;
  if (dispatch && dispatch.exceptions) exceptionsByAgent["dispatch-route"] = dispatch.exceptions;

  // Per-human card counts. openApprovals (v2) = real pending ai_approvals summed over this human's
  // employees; openExceptions = this human's employees currently needing attention; aiActivityToday =
  // today's attributed sales activity (Jessie's domain), 0 elsewhere.
  const pendingByAgent = safeSync(() => countPendingByAgent(), {}) ?? {};
  const perHuman: Record<string, { openApprovals: number; openExceptions: number; aiActivityToday: number }> = {};
  for (const h of HUMANS) {
    const mine = employees.filter((v) => v.owner === h.name);
    perHuman[h.name] = {
      openApprovals: mine.reduce((n, v) => n + (pendingByAgent[v.id] ?? 0), 0),
      openExceptions: mine.filter((v) => v.state === "attention").length,
      aiActivityToday: h.name === "Jessie" ? todaysActivity : 0,
    };
  }
  const humans = rollupHumans(HUMANS, employees, perHuman);

  // Outcomes — only where a real measured value exists (never fabricated).
  const outcomes: Outcome[] = [];
  if (lost && lost.stats.winRate != null) outcomes.push({ label: "Win rate", value: `${Math.round(lost.stats.winRate * 100)}%`, source: "Lost Quote" });
  if (risks) outcomes.push({ label: "Open risks", value: String(risks.length), source: "Event Risk" });
  {
    const tot = connSummary.ok + connSummary.attention + connSummary.off;
    if (tot > 0) outcomes.push({ label: "Connections healthy", value: `${Math.round((connSummary.ok / tot) * 100)}%`, source: "Back Office" });
  }

  const counts = { live: 0, seed: 0, partial: 0, coming: 0 };
  for (const e of AI_EMPLOYEES) counts[e.backing]++;

  const runs = safeSync(() => runtimeStatus(), []) ?? [];

  return { today, humans, employees, activeWork, exceptions, outcomes, counts, runs, pendingByAgent, exceptionsByAgent };
}

// ── Per-blade view (the BladeAgents strip's data) ─────────────────────────────
/** One agent's compact cell for the in-blade strip: its derived view (honesty already enforced by
 *  buildEmployeeView), the ONE key signal to show, and the real pending-approval / open-exception counts. */
export interface BladeAgentCell {
  view: AiEmployeeView;
  keySignal: AiMetric | null;
  pendingApprovals: number;
  openExceptions: number;
}

export interface BladeAgentsView {
  blade: BladeKey;
  agents: BladeAgentCell[];
}

/** The AI employees that work inside one blade, filtered from the SAME aiOrg aggregation (no new reads,
 *  no fabrication — a "coming" agent still carries no metrics). `showMoney` redacts $-bearing signals. */
export async function bladeAgents(blade: BladeKey, opts: { showMoney?: boolean } = {}): Promise<BladeAgentsView> {
  const org = await aiOrg(opts);
  const byId = new Map(org.employees.map((e) => [e.id, e]));
  const agents: BladeAgentCell[] = [];
  for (const id of agentIdsForBlade(blade)) {
    const view = byId.get(id);
    if (!view) continue;
    agents.push({
      view,
      keySignal: pickKeySignal(view.metrics),
      pendingApprovals: org.pendingByAgent[id] ?? 0,
      openExceptions: org.exceptionsByAgent[id] ?? 0,
    });
  }
  return { blade, agents };
}

/** One employee's full view + config, for the detail page. Null when the id is unknown. */
export async function aiEmployeeDetail(
  id: string,
  opts: { showMoney?: boolean } = {},
): Promise<{ view: AiEmployeeView; config: ReturnType<typeof getEmployee> } | null> {
  const config = getEmployee(id);
  if (!config) return null;
  const org = await aiOrg(opts);
  const view = org.employees.find((e) => e.id === id);
  if (!view) return null;
  return { view, config };
}

function m(label: string, value: string | number, tone: AiMetric["tone"] = "default"): AiMetric {
  return { label, value, tone };
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
function safeSync<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
