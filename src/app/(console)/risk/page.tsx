// Event Risk Engine (MVP2) — Nocturne redesign. On load it runs a (throttled) scan, then renders a
// clearly-scoped summary (open RISK counts vs scored-event READINESS, both over an explicit 14-day
// horizon), the filterable risk board (RiskBoard), capacity outlook, inventory demand, stops needing
// rescheduling, and per-event readiness. A manager grasps "what's at risk, why, who, how urgent" fast.
//
// RULES CALCULATE, AI INTERPRETS: this page only renders what the engine persisted. Risk rules, the
// scored queue, the lifecycle and the audit history are all unchanged — only the presentation moved to
// the shared design system. Status colour rides a small indicator + text (no large dark-red fields),
// and day-level risks read as operational dates, never as a specific event.

import Link from "next/link";
import { AlertTriangle, CalendarClock, ShieldAlert } from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { RiskBoard } from "@/components/risk/RiskBoard";
import { runScan } from "@/lib/risk/scan";
import { getRiskQueue, type StoredRisk } from "@/lib/risk/store";
import { getEventReadiness, getUnfinishedStops, getUpcomingCapacity, getUpcomingItemStops, type ReadinessView } from "@/lib/db/repo";
import { peakItemDemand } from "@/lib/inventory/inventory";
import { getEventTimeline, getRiskHistory, type ChangeRow } from "@/lib/history/store";
import { SEVERITY_RANK } from "@/lib/risk/types";
import { isUnverified, severityTone } from "@/lib/risk/present";
import { todayInOpsTz, formatYmdLong } from "@/lib/dates";
import { PageHeader } from "@/components/ui/page-header";
import { BladeMain } from "@/components/ui/layouts";
import { Metric, MetricGrid } from "@/components/ui/metric";
import { StatusBanner } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status";
import { Button } from "@/components/ui/button";
import { StatusMark, tableCls, theadCls, thCls } from "@/components/console-primitives";
import { BladeAgents } from "@/components/aiorg/BladeAgents";

export const dynamic = "force-dynamic";

const HORIZON_DAYS = 14;

function readinessStatusTone(level: string): "positive" | "attention" | "critical" | "neutral" {
  if (level === "READY") return "positive";
  if (level === "CRITICAL") return "critical";
  if (level === "HIGH" || level === "MEDIUM") return "attention";
  return "neutral";
}

export default async function EventRiskPage(): Promise<React.JSX.Element> {
  try {
    await runScan();
  } catch (e) {
    console.error("[risk] scan failed:", e);
  }
  const today = todayInOpsTz();
  const queue = getRiskQueue();
  const readiness = getEventReadiness();
  const unfinished = getUnfinishedStops();
  const capacity = getUpcomingCapacity(today).filter((v) => v.verdict !== "AVAILABLE");
  const itemDemand = peakItemDemand(getUpcomingItemStops(today)).slice(0, 8);
  const historyMap = getRiskHistory(queue.map((r) => r.signature));
  const history: Record<string, ChangeRow[]> = {};
  for (const [sig, rows] of historyMap) history[sig] = rows;
  const evaluatedAt = queue.reduce<string | null>((max, r) => (max && max >= r.lastSeenAt ? max : r.lastSeenAt), null);

  const counts = {
    CRITICAL: queue.filter((r) => r.severity === "CRITICAL").length,
    HIGH: queue.filter((r) => r.severity === "HIGH").length,
    MEDLOW: queue.filter((r) => r.severity === "MEDIUM" || r.severity === "LOW").length,
  };
  const readyCount = readiness.filter((r) => r.riskLevel === "READY").length;
  const unverifiedCount = queue.filter(isUnverified).length;

  return (
    <BladeMain>
      <AutoRefresh seconds={60} />
      <PageHeader
        title="Event Risk"
        icon={<ShieldAlert className="size-5" />}
        subtitle={`Operational readiness across the next ${HORIZON_DAYS} days. Risks are open issues the engine detected; readiness scores scored events over the same window.`}
      />

      <BladeAgents blade="event-risk" className="mb-5" />

      {/* Summary — risk counts and readiness are DIFFERENT units; keep them visibly separate. */}
      <section className="mb-5 space-y-2">
        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-meta">
          Open risks · issues over the next {HORIZON_DAYS} days
        </div>
        <MetricGrid>
          <Metric label="Critical" value={counts.CRITICAL} tone={counts.CRITICAL ? "critical" : undefined} sub="blocking issues" />
          <Metric label="High" value={counts.HIGH} tone={counts.HIGH ? "attention" : undefined} sub="urgent issues" />
          <Metric label="Medium / Low" value={counts.MEDLOW} sub="watch items" />
          <Metric label="Open risks (total)" value={queue.length} sub={`${unverifiedCount} unverified`} />
        </MetricGrid>
        <div className="pt-1 text-[11px] font-medium uppercase tracking-[0.08em] text-meta">
          Readiness · scored events over the next {HORIZON_DAYS} days
        </div>
        <MetricGrid>
          <Metric
            label="Events ready"
            value={readiness.length ? `${readyCount} / ${readiness.length}` : "—"}
            tone={readiness.length && readyCount === readiness.length ? "positive" : readiness.length ? "attention" : undefined}
            sub={readiness.length ? "events scored clear" : "no scored events"}
          />
        </MetricGrid>
      </section>

      {unverifiedCount > 0 && (
        <StatusBanner
          tone="attention"
          title="Some checks are unverified, not confirmed clear"
          className="mb-5"
          action={
            <Button size="sm" variant="outline" render={<a href="https://app.connecteam.com" target="_blank" rel="noopener noreferrer" />}>
              Open Connecteam
            </Button>
          }
        >
          Staffing data was unavailable (Connecteam) for one or more days, so {unverifiedCount} check
          {unverifiedCount === 1 ? "" : "s"} are marked unverified — an unknown, not a clean result. Reconnect Connecteam and the next scan re-assesses them.
        </StatusBanner>
      )}

      {/* The risk board */}
      <section className="mb-8">
        <RiskBoard risks={queue} history={history} today={today} evaluatedAt={evaluatedAt} />
      </section>

      {/* Capacity outlook */}
      {capacity.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2 flex items-center gap-2 text-[13px] font-medium">
            <CalendarClock className="size-4 text-meta" aria-hidden /> Capacity outlook
            <span className="text-[11.5px] font-normal text-meta">· days over the next {HORIZON_DAYS} that are not fully available</span>
          </h2>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[520px] border-collapse text-[13px]">
              <tbody>
                {capacity.map((cp) => (
                  <tr key={cp.date} className="border-b border-rule/60 last:border-0 hover:bg-row-hover" title={cp.reasons.join("; ")}>
                    <td className="w-40 px-3 py-2 tabular-nums text-tertiary-text">{formatYmdLong(cp.date)}</td>
                    <td className="w-44 px-3 py-2">
                      <StatusMark
                        tone={cp.verdict === "CONSTRAINED" ? "critical" : cp.verdict === "TIGHT" ? "attention" : "idle"}
                        label={cp.verdict === "CONSTRAINED" ? "Constrained" : cp.verdict === "TIGHT" ? "Tight" : cp.verdict}
                      />
                    </td>
                    <td className="px-3 py-2 text-meta">{cp.reasons.length ? cp.reasons[0] : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Inventory demand */}
      {itemDemand.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2 text-[13px] font-medium">
            Inventory demand <span className="text-[11.5px] font-normal text-meta">· peak booked per day over the horizon — capacity unverified (no stock feed)</span>
          </h2>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className={`${tableCls} min-w-[480px]`}>
              <thead className={theadCls}>
                <tr>
                  <th className={thCls}>Item</th>
                  <th className={`${thCls} text-right`}>Peak booked / day</th>
                  <th className={thCls}>Peak date</th>
                </tr>
              </thead>
              <tbody>
                {itemDemand.map((it) => (
                  <tr key={it.name} className="border-t border-rule hover:bg-row-hover">
                    <td className="px-2.5 py-2.5">{it.name}</td>
                    <td className="px-2.5 py-2.5 text-right font-medium tabular-nums">{it.peakQty}</td>
                    <td className="px-2.5 py-2.5 text-meta">{it.peakDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Needs rescheduling — restrained tint (left edge + indicator), not a dark-red field. */}
      {unfinished.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2 flex items-center gap-2 text-[13px] font-medium">
            <AlertTriangle className="size-4 text-status-warning" aria-hidden /> Needs rescheduling
            <span className="text-[11.5px] font-normal text-meta">· {unfinished.length} incomplete stop{unfinished.length === 1 ? "" : "s"} on closed routes</span>
          </h2>
          <div className="overflow-hidden rounded-lg border border-border">
            {unfinished.map((s) => (
              <div
                key={s.stopId}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-l-2 border-rule/60 border-l-status-warning px-3 py-2.5 text-[13px] last:border-b-0"
              >
                <div>
                  <div className="font-medium">Stop #{s.sequence} · {s.custName || "—"}</div>
                  <div className="text-[12px] text-meta">{s.truckId} · {formatYmdLong(s.date)} · {s.state}</div>
                </div>
                <Button size="xs" variant="outline" render={<Link href={`/dispatch?date=${s.date}`} />}>
                  Open dispatch
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Event readiness */}
      {readiness.length > 0 && (
        <section>
          <h2 className="mb-2 text-[13px] font-medium">
            Event readiness <span className="text-[11.5px] font-normal text-meta">· {readiness.length} scored event{readiness.length === 1 ? "" : "s"}</span>
          </h2>
          <div className="overflow-hidden rounded-lg border border-border">
            {readiness.map((e) => (
              <details key={e.eventId} className="border-b border-rule/60 last:border-0 [&_summary]:list-none">
                <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5 text-[13.5px] hover:bg-row-hover">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{e.label || `Event ${e.eventId}`}</div>
                    <div className="text-[12px] text-meta">{e.date ? formatYmdLong(e.date) : "—"} · show checklist</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusBadge tone={readinessStatusTone(e.riskLevel)} size="sm">
                      {e.riskLevel === "READY" ? "Ready" : e.riskLevel}
                    </StatusBadge>
                    <span className="text-[15px] font-medium tabular-nums text-foreground" aria-label={`Readiness score ${e.score}`}>
                      {e.score}
                    </span>
                  </div>
                </summary>
                <div className="border-t border-rule/60 bg-row px-3 py-2.5">
                  <ReadinessChecklist event={e} queue={queue} />
                  <HistoryTrend eventId={e.eventId} />
                </div>
              </details>
            ))}
          </div>
        </section>
      )}
    </BladeMain>
  );
}

const CHECK_AREAS: { label: string; types: Set<string> }[] = [
  { label: "Driver & helper (event day)", types: new Set(["route_no_driver", "driver_not_scheduled", "driver_shift_gap", "driver_double_booked", "driver_tight_buffer", "driver_shortage"]) },
  { label: "Prep & load crew (day before)", types: new Set(["warehouse_shortage"]) },
  { label: "Setup / install crew", types: new Set(["setup_crew_shortage"]) },
  { label: "Unload & clean (after pickup)", types: new Set(["unload_shortage"]) },
  { label: "Schedule & info", types: new Set(["route_schedule_unverified", "staffing_unverified"]) },
];

function ReadinessChecklist({ event, queue }: { event: ReadinessView; queue: StoredRisk[] }): React.JSX.Element {
  const affecting = queue.filter((r) => r.date === event.date && (!r.routeId || r.routeId === event.routeId));
  return (
    <ul className="space-y-1.5 text-[13px]">
      {CHECK_AREAS.map((area) => {
        const hits = affecting.filter((r) => area.types.has(r.riskType)).sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
        const worst = hits[0];
        const tone = worst ? severityTone(worst.severity) : "positive";
        const dot = tone === "critical" ? "bg-status-blocked" : tone === "attention" ? "bg-status-warning" : tone === "neutral" ? "bg-status-neutral" : "bg-status-ready";
        return (
          <li key={area.label} className="flex items-start gap-2">
            <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
            <span className={worst ? "" : "text-meta"}>
              {area.label}
              {worst ? <span className="text-meta">{" — "}{worst.title}{hits.length > 1 ? ` (+${hits.length - 1})` : ""}</span> : <span className="text-meta"> — clear</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function HistoryTrend({ eventId }: { eventId: string }): React.JSX.Element | null {
  const { snapshots } = getEventTimeline(eventId);
  if (snapshots.length < 2) return null;
  return (
    <div className="mt-2 border-t border-rule/60 pt-2 text-[12px] text-meta">
      <span className="font-medium text-tertiary-text">Trend:</span>{" "}
      {snapshots.map((sn, i) => (
        <span key={sn.id}>{i > 0 && " → "}{sn.daysOut >= 0 ? `${sn.daysOut}d out` : "event day"}: {sn.riskLevel}{sn.readinessScore != null ? ` (${sn.readinessScore})` : ""}</span>
      ))}
    </div>
  );
}
