// Event Risk Engine (MVP2) — Nocturne. On load it runs a (throttled) scan, then renders the daily
// figures + the CRITICAL/HIGH/MEDIUM/LOW risk table, capacity outlook, inventory demand and per-event
// readiness. A manager should grasp "what's at risk, why, who, how urgent" in under 30 seconds. Data
// + logic unchanged.

import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import { RiskActions } from "@/components/RiskActions";
import { runScan } from "@/lib/risk/scan";
import { getRiskQueue, type StoredRisk } from "@/lib/risk/store";
import { getEventReadiness, getUnfinishedStops, getUpcomingCapacity, getUpcomingItemStops, type ReadinessView } from "@/lib/db/repo";
import { peakItemDemand } from "@/lib/inventory/inventory";
import { getEventTimeline } from "@/lib/history/store";
import { SEVERITY_RANK, type RiskSeverity } from "@/lib/risk/types";
import { todayInOpsTz, formatYmdLong } from "@/lib/dates";
import { FigureStrip, tableCls, theadCls, thCls, type Figure } from "@/components/console-primitives";

export const dynamic = "force-dynamic";

const SEV_TONE: Record<RiskSeverity, string> = { CRITICAL: "text-critical", HIGH: "text-attention", MEDIUM: "text-attention", LOW: "text-meta" };
const SEV_BAR: Record<RiskSeverity, string> = { CRITICAL: "border-l-2 border-critical", HIGH: "border-l-2 border-attention", MEDIUM: "border-l-2 border-attention/60", LOW: "border-l-2 border-transparent" };

function scoreColor(score: number, riskLevel: string): string {
  if (riskLevel === "CRITICAL") return "text-critical";
  if (riskLevel === "HIGH") return "text-attention";
  return score >= 85 ? "text-positive" : score >= 60 ? "text-attention" : "text-critical";
}
function daysUntilLabel(date: string, today: string): string {
  const d = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (Number.isNaN(d)) return "";
  if (d < 0) return `${-d}d ago`;
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return `in ${d}d`;
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

  const c = {
    CRITICAL: queue.filter((r) => r.severity === "CRITICAL").length,
    HIGH: queue.filter((r) => r.severity === "HIGH").length,
    MEDIUM: queue.filter((r) => r.severity === "MEDIUM" || r.severity === "LOW").length,
    READY: readiness.filter((r) => r.riskLevel === "READY").length,
  };
  const figures: Figure[] = [
    { label: "Critical", value: c.CRITICAL, tone: c.CRITICAL ? "critical" : "default" },
    { label: "High", value: c.HIGH, tone: c.HIGH ? "attention" : "default" },
    { label: "Medium/Low", value: c.MEDIUM },
    { label: "Ready", value: c.READY, tone: c.READY ? "positive" : "default", sep: true },
  ];
  const unverified = queue.some((r) => r.riskType === "staffing_unverified");

  return (
    <main className="p-6">
      <AutoRefresh seconds={60} />
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-medium tracking-tight">Event Risk</h1>
          <p className="text-[12.5px] text-meta">Operationally ready for the next 14 days? {queue.length} open risk{queue.length === 1 ? "" : "s"}.</p>
        </div>
        <FigureStrip figures={figures} />
      </header>

      {unverified && <p className="mb-5 text-[12.5px] text-attention">Staffing data is unavailable (Connecteam) for one or more days — those checks are marked unverified, not confirmed clear. Reconnect Connecteam and re-scan.</p>}

      {/* Risk table */}
      {queue.length === 0 ? (
        <p className="mb-8 text-[13px] text-positive">No open risks in the next 14 days.</p>
      ) : (
        <div className="mb-8 overflow-x-auto border border-border">
          <table className={tableCls}>
            <colgroup>
              <col style={{ width: "104px" }} />
              <col />
              <col style={{ width: "150px" }} />
              <col style={{ width: "200px" }} />
              <col style={{ width: "180px" }} />
            </colgroup>
            <thead className={theadCls}>
              <tr>
                <th className={thCls}>Severity</th>
                <th className={thCls}>Risk</th>
                <th className={thCls}>Event</th>
                <th className={thCls}>Recommended action</th>
                <th className={thCls}></th>
              </tr>
            </thead>
            <tbody>
              {queue.map((r) => (
                <tr key={r.id} className={`border-t border-[var(--row-rule)] hover:bg-[var(--row-hover)] ${r.severity === "CRITICAL" ? "bg-[#1d1822]" : ""}`}>
                  <td className={`px-2.5 py-2.5 ${SEV_BAR[r.severity]}`}>
                    <span className={`text-[11px] font-semibold uppercase tracking-[0.06em] ${SEV_TONE[r.severity]}`}>{r.severity}</span>
                    {r.status !== "OPEN" && <div className="text-[10.5px] uppercase text-meta">{r.status}</div>}
                  </td>
                  <td className="px-2.5 py-2.5">
                    <div className="text-[14px] font-medium">{r.title}</div>
                    <div className="truncate text-[12px] text-meta" title={r.description}>{r.category} · {r.description}</div>
                  </td>
                  <td className="px-2.5 py-2.5 text-[13px] tabular-nums text-tertiary-text">{r.date ? <>{formatYmdLong(r.date)}<div className="text-[12px] text-meta">{daysUntilLabel(r.date, today)}</div></> : "—"}</td>
                  <td className="px-2.5 py-2.5 text-[13px]">{r.recommendedAction || "—"}</td>
                  <td className="px-2.5 py-2.5"><RiskActions id={r.id} status={r.status} actionTarget={r.actionTarget} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Capacity outlook */}
      {capacity.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-1.5 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Capacity outlook</h2>
          <div className="border border-border">
            {capacity.map((cp) => (
              <div key={cp.date} className="flex items-center gap-3 border-t border-[var(--row-rule)] px-3 py-2 text-[13px] first:border-t-0" title={cp.reasons.join("; ")}>
                <span className="w-28 tabular-nums text-tertiary-text">{cp.date}</span>
                <span className={`w-28 text-[11px] font-medium uppercase tracking-[0.06em] ${cp.verdict === "CONSTRAINED" ? "text-critical" : cp.verdict === "TIGHT" ? "text-attention" : "text-meta"}`}>{cp.verdict}</span>
                {cp.reasons.length ? <span className="truncate text-meta">{cp.reasons[0]}</span> : null}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Inventory demand */}
      {itemDemand.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-1.5 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Inventory demand <span className="text-[11px] normal-case text-meta">· capacity unverified</span></h2>
          <div className="overflow-x-auto border border-border">
            <table className={tableCls}>
              <thead className={theadCls}>
                <tr>
                  <th className={thCls}>Item</th>
                  <th className={`${thCls} text-right`}>Peak booked / day</th>
                  <th className={thCls}>Peak date</th>
                </tr>
              </thead>
              <tbody>
                {itemDemand.map((it) => (
                  <tr key={it.name} className="border-t border-[var(--row-rule)] hover:bg-[var(--row-hover)]">
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

      {/* Needs rescheduling */}
      {unfinished.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-1.5 text-[13px] font-medium uppercase tracking-[0.1em] text-critical">Needs rescheduling · {unfinished.length}</h2>
          <div className="border border-critical/25">
            {unfinished.map((s) => (
              <div key={s.stopId} className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--row-rule)] bg-[#251b22] px-3 py-2.5 text-[13px] first:border-t-0">
                <div>
                  <div className="font-medium">Stop #{s.sequence} · {s.custName || "—"}</div>
                  <div className="text-[12px] text-meta">{s.truckId} · {formatYmdLong(s.date)} · {s.state}</div>
                </div>
                <Link href="/dispatch" className="rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">Open dispatch</Link>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Event readiness */}
      {readiness.length > 0 && (
        <section>
          <h2 className="mb-1.5 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Event readiness</h2>
          <div className="border border-border">
            {readiness.map((e) => (
              <details key={e.eventId} className="border-t border-[var(--row-rule)] first:border-t-0 [&_summary]:list-none">
                <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5 text-[13.5px] hover:bg-[var(--row-hover)]">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{e.label || `Event ${e.eventId}`}</div>
                    <div className="text-[12px] text-meta">{e.date ? formatYmdLong(e.date) : "—"} · why ▾</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {e.riskLevel !== "READY" && <span className={`text-[11px] font-semibold uppercase ${SEV_TONE[e.riskLevel as RiskSeverity] ?? "text-meta"}`}>{e.riskLevel}</span>}
                    <span className={`text-[15px] font-medium tabular-nums ${scoreColor(e.score, e.riskLevel)}`}>{e.score}</span>
                  </div>
                </summary>
                <div className="border-t border-[var(--row-rule)] px-3 py-2.5">
                  <ReadinessChecklist event={e} queue={queue} />
                  <HistoryTrend eventId={e.eventId} />
                </div>
              </details>
            ))}
          </div>
        </section>
      )}
    </main>
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
        return (
          <li key={area.label} className="flex items-start gap-2">
            <span className={`mt-1 size-1.5 shrink-0 rounded-full ${worst ? (worst.severity === "CRITICAL" ? "bg-critical" : "bg-attention") : "bg-positive"}`} />
            <span className={worst ? "" : "text-meta"}>
              {area.label}
              {worst ? <span className="text-meta">{" — "}{worst.title}{hits.length > 1 ? ` (+${hits.length - 1})` : ""}</span> : <span className="text-positive/70"> — OK</span>}
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
    <div className="mt-2 border-t border-[var(--row-rule)] pt-2 text-[12px] text-meta">
      <span className="font-medium text-tertiary-text">Trend:</span>{" "}
      {snapshots.map((sn, i) => (
        <span key={sn.id}>{i > 0 && " → "}{sn.daysOut >= 0 ? `${sn.daysOut}d out` : "event day"}: {sn.riskLevel}{sn.readinessScore != null ? ` (${sn.readinessScore})` : ""}</span>
      ))}
    </div>
  );
}
